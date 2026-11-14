// Substitution check (ADR 2026-11-09-validator-lib-substitution-check): the shared contracts vectors,
// the boundary invariants of the new fields, newConflicts() and the properties of the effective week.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { newConflicts, validate, type Conflict, type ValidationInput } from '../src/index.js';
import { sortConflicts } from '../src/domain/order.js';
import { conforms } from './support/conforms.js';
import { validSchool } from './support/generators.js';
import { dayFormats, input } from './support/school.js';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(require.resolve('@lad/contracts/package.json')), 'vectors');
const list = (dir: string): string[] => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.json')).sort();
const read = (dir: string, file: string): unknown => JSON.parse(readFileSync(join(ROOT, dir, file), 'utf8'));

type Expected =
  | { readonly status: 'ACCEPTED' | 'REJECTED'; readonly conflicts: readonly Conflict[] }
  | { readonly status: 'INVALID_INPUT'; readonly issue_codes: readonly string[] };

describe('contracts substitution vectors', () => {
  const files = list('substitution');
  it('exist', () => {
    expect(files.length).toBeGreaterThanOrEqual(41);
  });

  it.each(files)('%s', (file) => {
    const v = read('substitution', file) as { input: unknown; expected: Expected };
    const outcome = validate(v.input);
    conforms(outcome);
    expect(outcome.status).toBe(v.expected.status);
    if (v.expected.status === 'INVALID_INPUT') {
      expect(outcome.status === 'INVALID_INPUT' ? [...new Set(outcome.issues.map((i) => i.code))].sort() : []).toEqual(
        [...v.expected.issue_codes].sort(),
      );
    } else {
      expect(outcome.status === 'INVALID_INPUT' ? null : outcome.conflicts).toEqual(sortConflicts(v.expected.conflicts));
    }
  });
});

describe('contracts approve pairs (newConflicts)', () => {
  const files = list('substitution-approve');
  it('exist', () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it.each(files)('%s', (file) => {
    const v = read('substitution-approve', file) as { baseline: unknown; effective: unknown; expected: { added: Conflict[] } };
    const r = newConflicts(v.baseline, v.effective);
    expect(r.status).toBe('CHECKED');
    if (r.status !== 'CHECKED') return;
    expect(r.added).toEqual(sortConflicts(v.expected.added));
    conforms(r.baseline);
    conforms(r.effective);
  });
});

/** The base school of test/support/school.ts with t-2's PE lesson of c-1 on day 1 turned into self-study. */
const marked = (): ValidationInput => {
  const base = input();
  const lessons = base.timetable.lessons.filter((l) => !(l.class_id === 'c-1' && l.day === 1 && l.lesson_no === 3));
  return {
    ...base,
    timetable: {
      lessons,
      day_formats: base.timetable.day_formats,
      not_held: [{ class_id: 'c-1', day: 1, lesson_no: 3, subject_id: 's-pe', kind: 'self_study' }],
    },
    absences: [{ teacher_id: 't-2', day: 1, lesson_nos: [3] }],
  };
};

describe('boundary invariants of the effective week', () => {
  it('the marked base week is valid', () => {
    expect(validate(marked()).status).toBe('ACCEPTED');
  });

  it.each([
    ['missing', undefined],
    ['empty', []],
  ])('absences %s: the mark is a caller bug pointing at the entry', (_name, absences) => {
    const o = validate({ ...marked(), absences });
    expect(o).toMatchObject({ status: 'INVALID_INPUT', issues: [{ part: 'timetable', code: 'requires_absences', path: '/timetable/not_held/0' }] });
    expect(o.status === 'INVALID_INPUT' ? o.issues : []).toHaveLength(1);
  });

  it('an absence of another teacher or slot does not justify the mark', () => {
    for (const absence of [
      { teacher_id: 't-1', day: 1, lesson_nos: [3] },
      { teacher_id: 't-2', day: 2, lesson_nos: [3] },
      { teacher_id: 't-2', day: 1, lesson_nos: [4] },
    ]) {
      expect(validate({ ...marked(), absences: [absence] })).toMatchObject({ status: 'INVALID_INPUT', issues: [{ code: 'requires_absences' }] });
    }
  });

  it('an origin=substitution lesson needs its plan teacher absent in that slot', () => {
    const base = input();
    const lessons = base.timetable.lessons.map((l, i) => (i === 2 ? { ...l, teacher_id: 't-2', origin: 'substitution' as const } : l));
    const o = validate({ ...base, timetable: { ...base.timetable, lessons } });
    expect(o).toMatchObject({ status: 'INVALID_INPUT', issues: [{ code: 'requires_absences', path: '/timetable/lessons/2/origin' }] });
  });

  it('origin=plan needs no absences', () => {
    const base = input();
    const lessons = base.timetable.lessons.map((l) => ({ ...l, origin: 'plan' as const }));
    expect(validate({ ...base, timetable: { ...base.timetable, lessons } }).status).toBe('ACCEPTED');
  });

  it('cancelled outside school days is not_held_day', () => {
    const m = marked();
    const o = validate({ ...m, timetable: { ...m.timetable, not_held: [{ class_id: 'c-1', day: 6, lesson_no: 3, subject_id: 's-pe', kind: 'cancelled' }] } });
    expect(o).toMatchObject({ status: 'INVALID_INPUT', issues: [{ code: 'not_held_day', path: '/timetable/not_held/0/day' }] });
  });

  it('a not_held slot past lessons_per_day and an absence lesson past it are limits', () => {
    const m = marked();
    const o = validate({
      ...m,
      timetable: { ...m.timetable, not_held: [{ class_id: 'c-1', day: 1, lesson_no: 9, subject_id: 's-pe', kind: 'self_study' }] },
      absences: [{ teacher_id: 't-2', day: 1, lesson_nos: [9] }],
    });
    expect(o).toMatchObject({
      status: 'INVALID_INPUT',
      issues: [
        { part: 'input', code: 'limit', path: '/absences/0/lesson_nos/0' },
        { part: 'timetable', code: 'limit', path: '/timetable/not_held/0/lesson_no' },
      ],
    });
  });

  it('a duplicate slot is caught whatever the subject or kind', () => {
    const m = marked();
    const first = m.timetable.not_held?.[0];
    if (first === undefined) throw new Error('fixture');
    for (const second of [{ ...first, kind: 'cancelled' as const }, { ...first, subject_id: 's-math' }]) {
      const o = validate({ ...m, timetable: { ...m.timetable, not_held: [first, second] } });
      expect(o.status === 'INVALID_INPUT' ? o.issues : []).toContainEqual({ part: 'timetable', code: 'duplicate_slot', path: '/timetable/not_held/1' });
    }
  });

  it.each([
    ['empty lesson_nos', { absences: [{ teacher_id: 't-2', day: 1, lesson_nos: [] }] }, '/absences/0/lesson_nos', 'minItems'],
    ['repeated lesson_nos', { absences: [{ teacher_id: 't-2', day: 1, lesson_nos: [3, 3] }] }, '/absences/0/lesson_nos', 'uniqueItems'],
    ['absence day 7', { absences: [{ teacher_id: 't-2', day: 7, lesson_nos: [3] }] }, '/absences/0/day', 'maximum'],
    ['unknown origin', { lessonOrigin: 'moved' }, '/timetable/lessons/0/origin', 'enum'],
    ['unknown kind', { notHeldKind: 'moved' }, '/timetable/not_held/0/kind', 'enum'],
    ['extra not_held field', { notHeldExtra: true }, '/timetable/not_held/0', 'additionalProperties'],
  ] as const)('schema rejects %s', (_name, change, path, keyword) => {
    const m = marked();
    const nh = m.timetable.not_held?.[0];
    if (nh === undefined) throw new Error('fixture');
    const raw: Record<string, unknown> = {
      ...m,
      ...('absences' in change ? { absences: change.absences } : {}),
      timetable: {
        lessons: m.timetable.lessons.map((l, i) => ('lessonOrigin' in change && i === 0 ? { ...l, origin: change.lessonOrigin } : l)),
        day_formats: m.timetable.day_formats,
        not_held: [
          {
            ...nh,
            ...('notHeldKind' in change ? { kind: change.notHeldKind } : {}),
            ...('notHeldExtra' in change ? { note: 'x' } : {}),
          },
        ],
      },
    };
    const o = validate(raw);
    expect(o.status).toBe('INVALID_INPUT');
    expect(o.status === 'INVALID_INPUT' ? o.issues : []).toContainEqual(expect.objectContaining({ path, keyword }));
  });

  it('not_held of an unknown class or subject: exact cascade on a clean week', () => {
    const m = marked();
    const nh = m.timetable.not_held?.[0];
    if (nh === undefined) throw new Error('fixture');
    const run = (patch: object): unknown => {
      const o = validate({ ...m, timetable: { ...m.timetable, not_held: [{ ...nh, ...patch }] } });
      return o.status === 'REJECTED' ? o.conflicts : o;
    };
    expect(run({ class_id: 'c-x' })).toEqual([
      { rule: 'class_not_active', class_id: 'c-x' },
      { rule: 'plan_hours_mismatch', class_id: 'c-1', subject_id: 's-pe', value: 1, limit: 2 },
    ]);
    expect(run({ subject_id: 's-x' })).toEqual([
      { rule: 'subject_not_active', class_id: 'c-1', subject_id: 's-x' },
      { rule: 'plan_hours_mismatch', class_id: 'c-1', subject_id: 's-pe', value: 1, limit: 2 },
    ]);
  });

  it('not_held of a subject outside the plan is lesson_not_in_plan (a stale template)', () => {
    const m = marked();
    const rows = m.snapshot.rows.filter((r) => !(r.class_id === 'c-1' && r.subject_id === 's-pe'));
    const o = validate({ ...m, snapshot: { ...m.snapshot, rows } });
    expect(o.status === 'REJECTED' ? o.conflicts.map((c) => c.rule) : o.status).toContain('lesson_not_in_plan');
  });

  it('issues carry pointers, never values', () => {
    const o = validate({ ...marked(), absences: [] });
    expect(o.status).toBe('INVALID_INPUT');
    expect(JSON.stringify(o)).not.toMatch(/self_study|s-pe|t-2/);
  });
});

describe('newConflicts', () => {
  const effective = marked();

  it('a valid proposal on a valid week adds nothing', () => {
    expect(newConflicts(input(), effective)).toMatchObject({ status: 'CHECKED', added: [] });
  });

  it('reports which week is broken instead of throwing', () => {
    expect(newConflicts({ nope: true }, effective)).toMatchObject({ status: 'INVALID_INPUT', week: 'baseline' });
    expect(newConflicts(input(), { ...effective, absences: undefined })).toMatchObject({ status: 'INVALID_INPUT', week: 'effective' });
  });

  it('two weeks on different snapshots are a caller bug', () => {
    const other = { ...effective, snapshot: { ...effective.snapshot, staff: effective.snapshot.staff + 1 } };
    expect(() => newConflicts(input(), other)).toThrow(RangeError);
  });

  it('M3: a valid week compared with itself adds nothing', () => {
    fc.assert(
      fc.property(validSchool, (school) => {
        expect(newConflicts(school, school)).toMatchObject({ status: 'CHECKED', added: [] });
      }),
      { numRuns: 50, seed: 20261109 },
    );
  });

  it('a noisy week compared with itself adds nothing either', () => {
    const noisy = input({ snapshot: { capacity: { passport: 40 } }, day_formats: dayFormats().slice(0, 7) });
    expect(newConflicts(noisy, noisy)).toMatchObject({ status: 'CHECKED', added: [] });
  });
});

describe('properties of the effective week', () => {
  const settings = { numRuns: 150, seed: 20261109 };
  const noisy = (): ValidationInput => input({ snapshot: { capacity: { passport: 40 } }, day_formats: dayFormats().slice(0, 7) });

  it('M1: origin=plan on every lesson and empty new arrays change nothing, also on a rejected week', () => {
    for (const school of [noisy(), ...fc.sample(validSchool, { numRuns: 60, seed: 20261109 })]) {
      const marked = {
        ...school,
        timetable: { ...school.timetable, lessons: school.timetable.lessons.map((l) => ({ ...l, origin: 'plan' as const })), not_held: [] },
      };
      expect(validate(marked)).toEqual(validate(school));
    }
  });

  it('M2: absences on lessons the teacher does not teach change nothing', () => {
    fc.assert(
      fc.property(validSchool, fc.nat(), (school, pick) => {
        const t = school.snapshot.teachers[pick % Math.max(1, school.snapshot.teachers.length)];
        if (t === undefined) return;
        const busy = new Set(school.timetable.lessons.filter((l) => l.teacher_id === t.id).map((l) => `${String(l.day)}|${String(l.lesson_no)}`));
        const absences = [1, 2, 3, 4, 5, 6].flatMap((day) => {
          const free = Array.from({ length: school.snapshot.lessons_per_day }, (_, i) => i + 1).filter((n) => !busy.has(`${String(day)}|${String(n)}`));
          return free.length > 0 ? [{ teacher_id: t.id, day, lesson_nos: free }] : [];
        });
        expect(validate({ ...school, absences })).toEqual(validate(school));
      }),
      settings,
    );
  });

  it('P3: lessons of absent teachers turned into self_study / cancelled (each its own kind) keep a valid week valid', () => {
    fc.assert(
      fc.property(validSchool, fc.array(fc.tuple(fc.nat(), fc.constantFrom('self_study' as const, 'cancelled' as const)), { minLength: 1, maxLength: 8 }), (school, picks) => {
        const all = school.timetable.lessons;
        if (all.length === 0) return;
        const kinds = new Map(picks.map(([p, kind]) => [p % all.length, kind]));
        const lessons = all.filter((_, i) => !kinds.has(i));
        const not_held = all.flatMap((l, i) => {
          const kind = kinds.get(i);
          return kind === undefined ? [] : [{ class_id: l.class_id, day: l.day, lesson_no: l.lesson_no, subject_id: l.subject_id, kind }];
        });
        const absences = all.filter((_, i) => kinds.has(i)).map((l) => ({ teacher_id: l.teacher_id, day: l.day, lesson_nos: [l.lesson_no] }));
        expect(validate({ ...school, timetable: { ...school.timetable, lessons, not_held }, absences }).status).toBe('ACCEPTED');
      }),
      settings,
    );
  });

  it('P3h: a weekday made a holiday keeps a valid week valid', () => {
    fc.assert(
      fc.property(validSchool, fc.nat(), (school, pick) => {
        const days = school.snapshot.school_days;
        if (days.length < 2) return;
        const h = days[pick % days.length];
        if (h === undefined) return;
        const not_held = school.timetable.lessons
          .filter((l) => l.day === h)
          .map((l) => ({ class_id: l.class_id, day: l.day, lesson_no: l.lesson_no, subject_id: l.subject_id, kind: 'holiday' as const }));
        const week = {
          ...school,
          snapshot: { ...school.snapshot, school_days: days.filter((d) => d !== h) },
          timetable: {
            lessons: school.timetable.lessons.filter((l) => l.day !== h),
            day_formats: school.timetable.day_formats.filter((f) => f.day !== h),
            not_held,
          },
          holidays: [h],
        };
        expect(validate(week).status).toBe('ACCEPTED');
      }),
      settings,
    );
  });

  it('P4: a free substitute from outside the plan keeps a valid week valid; a busy one is double-booked', () => {
    fc.assert(
      fc.property(validSchool, fc.nat(), (school, pick) => {
        const all = school.timetable.lessons;
        const i = pick % Math.max(1, all.length);
        const target = all[i];
        if (target === undefined) return;
        const absences = [{ teacher_id: target.teacher_id, day: target.day, lesson_nos: [target.lesson_no] }];
        const sub = (teacher_id: string, extra: { id: string; weekly_limit: number; unavailable_days: number[] }[]) =>
          validate({
            ...school,
            snapshot: { ...school.snapshot, teachers: [...school.snapshot.teachers, ...extra] },
            timetable: { ...school.timetable, lessons: all.map((l, j) => (j === i ? { ...l, teacher_id, origin: 'substitution' as const } : l)) },
            absences,
          });
        expect(sub('t-sub', [{ id: 't-sub', weekly_limit: 1, unavailable_days: [] }]).status).toBe('ACCEPTED');
        // A teacher who already teaches another class in that slot.
        const busy = all.find((l) => l.class_id !== target.class_id && l.day === target.day && l.lesson_no === target.lesson_no);
        if (busy !== undefined) {
          const o = sub(busy.teacher_id, []);
          expect(o.status === 'REJECTED' ? o.conflicts.map((c) => c.rule) : o.status).toContain('teacher_double_booked');
        }
      }),
      settings,
    );
  });
});

// newConflicts on measured conflicts: found by mutation testing (plan hours either way, one place per conflict).
describe('newConflicts: measured conflicts', () => {
  const without = (drop: (l: { class_id: string; day: number; subject_id: string }) => boolean): ValidationInput => {
    const base = input();
    return { ...base, timetable: { ...base.timetable, lessons: base.timetable.lessons.filter((l) => !drop(l)) } };
  };
  const plus = (extra: ValidationInput['timetable']['lessons']): ValidationInput => {
    const base = input();
    return { ...base, timetable: { ...base.timetable, lessons: [...base.timetable.lessons, ...extra] } };
  };
  const fewerMath = without((l) => l.class_id === 'c-1' && l.subject_id === 's-math' && l.day >= 4); // c-1 math: 3 of 5
  const checked = (b: ValidationInput, e: ValidationInput) => {
    const r = newConflicts(b, e);
    if (r.status !== 'CHECKED') throw new Error('expected CHECKED');
    return r;
  };

  it('plan hours closer to the plan from the other side is an improvement, not a new conflict', () => {
    // baseline 3 of 5 (2 short); effective 6 of 5 (1 over).
    const sixMath = plus([{ class_id: 'c-1', day: 1, lesson_no: 4, subject_id: 's-math', teacher_id: 't-1' }]);
    expect(checked(fewerMath, sixMath).added).toEqual([]);
  });

  it('a measured conflict at a new place is new even if the old place was worse', () => {
    // baseline: c-1 math 2 short; effective: c-1 math fine, c-2 math 2 over.
    const c2 = plus([
      { class_id: 'c-2', day: 1, lesson_no: 4, subject_id: 's-math', teacher_id: 't-1' },
      { class_id: 'c-2', day: 1, lesson_no: 5, subject_id: 's-math', teacher_id: 't-1' },
    ]);
    expect(checked(fewerMath, c2).added).toEqual([
      { rule: 'plan_hours_mismatch', class_id: 'c-2', subject_id: 's-math', value: 6, limit: 4 },
    ]);
  });

  it('two weeks on different snapshots are a caller bug', () => {
    const other = { ...input(), snapshot: { ...input().snapshot, staff: 4 } };
    expect(() => newConflicts(input(), other)).toThrow(new RangeError('baseline and effective must be checked against the same snapshot'));
  });
});
