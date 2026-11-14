// Ordering, determinism, truncation, the /load report, conformance to the contracts outcome schema,
// and version metadata (the purity of the domain layer: architecture.test.ts).
import { readFileSync } from 'node:fs';

import { Ajv2020 } from 'ajv/dist/2020.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CONTRACTS_VERSION,
  RULES,
  VALIDATOR_VERSION,
  validate,
  type Conflict,
  type DayFormat,
  type Lesson,
  type Snapshot,
  type ValidationInput,
  type ValidationOutcome,
} from '../src/index.js';
import { sortConflicts } from '../src/domain/order.js';
import { dayFormats, input, lesson, lessons } from './support/school.js';

const SCHEMAS = new URL('../src/generated/schemas/', import.meta.url);
const load = (p: string): object => JSON.parse(readFileSync(new URL(p, SCHEMAS), 'utf8')) as object;
const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
ajv.addSchema(load('events/defs.v1.json'));
ajv.addSchema(load('events/conflict.v1.json'));
const outcomeSchema = ajv.compile(load('validator/validation.outcome.v1.json'));
const conflictEnum = (load('events/conflict.v1.json') as { properties: { rule: { enum: string[] } } }).properties.rule.enum;

const noisy = () => input({ snapshot: { capacity: { passport: 40 } }, day_formats: dayFormats().slice(0, 7) });
/**
 * One school day, classes of 10 students, no staff, an empty plan: hand-checked loads for the /load reasons.
 * `formats` gives one record per class; `extra` adds format records (duplicates) and classes without any record.
 */
const tiny = (o: {
  lessons: Lesson[];
  formats: Record<string, boolean>;
  kind?: Snapshot['kind'];
  capacity: Snapshot['capacity'];
  extra?: { formats?: DayFormat[]; classes?: string[] };
}): ValidationInput => ({
  schema_version: '1.0',
  snapshot: {
    kind: o.kind ?? 'main',
    school_days: [1],
    lessons_per_day: 6,
    staff: 0,
    capacity: o.capacity,
    classes: [...Object.keys(o.formats), ...(o.extra?.classes ?? [])].map((id) => ({ id, students: 10, priority: false })),
    subjects: [
      { id: 's-x', priority_area: false, no_shelter: false },
      { id: 's-ns', priority_area: false, no_shelter: true },
    ],
    teachers: ['t1', 't2', 't3', 't4'].map((id) => ({ id, weekly_limit: 10, unavailable_days: [] })),
    rows: [],
  },
  timetable: {
    lessons: o.lessons,
    day_formats: [...Object.entries(o.formats).map(([class_id, in_person]) => ({ class_id, day: 1, in_person })), ...(o.extra?.formats ?? [])],
  },
});
/** Day-1 reasons by class (formats in person / remote are in the class_days). Throws on INVALID_INPUT. */
const reasonsOf = (i: ValidationInput): Record<string, string> => {
  const o = validate(i);
  if (o.status === 'INVALID_INPUT') throw new Error(JSON.stringify(o.issues));
  return Object.fromEntries(o.load.class_days.map((cd) => [cd.class_id, `${cd.in_person ? 'in_person' : 'remote'}:${cd.reason}`]));
};
const chain = (passport: number): ValidationInput =>
  tiny({
    lessons: [lesson('a', 1, 1, 's-x', 't1'), lesson('b', 1, 2, 's-x', 't1'), lesson('b', 1, 3, 's-x', 't2'), lesson('c', 1, 1, 's-x', 't2'), lesson('d', 1, 1, 's-x', 't4')],
    formats: { a: false, b: false, c: false, d: true },
    capacity: { passport },
  });
const conforms = (o: ValidationOutcome): void => {
  expect(outcomeSchema(o), JSON.stringify(outcomeSchema.errors)).toBe(true);
};

describe('outcome', () => {
  it('every rule code is in the contracts conflict enum', () => {
    for (const r of RULES) expect(conflictEnum).toContain(r);
  });

  it('ACCEPTED, REJECTED and INVALID_INPUT conform to validation.outcome.v1.json', () => {
    conforms(validate(input()));
    conforms(validate(noisy()));
    conforms(validate({ nope: true }));
  });

  it('is deterministic and independent of the order of the input arrays', () => {
    const base = noisy();
    const expected = JSON.stringify(validate(base));
    fc.assert(
      fc.property(fc.array(fc.nat(), { minLength: 4, maxLength: 4 }), ([a = 0, b = 0, c = 0, d = 0]) => {
        const shuffle = <T>(xs: readonly T[], seed: number): T[] =>
          [...xs].map((x, i) => ({ x, k: (i * 7919 + seed * 104729) % 1000003 })).sort((p, q) => p.k - q.k).map((p) => p.x);
        const s = base.snapshot;
        const permuted = {
          ...base,
          snapshot: { ...s, classes: shuffle(s.classes, a), teachers: shuffle(s.teachers, b), rows: shuffle(s.rows, c) },
          timetable: { lessons: shuffle(base.timetable.lessons, d), day_formats: shuffle(base.timetable.day_formats, a + d) },
        };
        const o = validate(permuted);
        expect(o.status === 'INVALID_INPUT' ? o : o.conflicts).toEqual((JSON.parse(expected) as { conflicts: unknown }).conflicts);
      }),
      { numRuns: 50 },
    );
  });

  it('sorts by rule registry order, then day, class, teacher', () => {
    const o = validate(noisy());
    if (o.status !== 'REJECTED') throw new Error('expected REJECTED');
    const ranks = o.conflicts.map((c) => RULES.indexOf(c.rule));
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
  });

  it('max_conflicts truncates after sorting and keeps the full total', () => {
    const full = validate(noisy());
    const cut = validate(noisy(), { max_conflicts: 2 });
    if (full.status !== 'REJECTED' || cut.status !== 'REJECTED') throw new Error('expected REJECTED');
    expect(cut.conflicts).toEqual(full.conflicts.slice(0, 2));
    expect(cut.conflicts_total).toBe(full.conflicts_total);
  });

  it('carries versions and the capacity model', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VALIDATOR_VERSION).toBe(pkg.version);
    expect(validate(input()).meta).toEqual({ validator_version: VALIDATOR_VERSION, contracts_version: CONTRACTS_VERSION, model: '1.1' });
    expect(validate({}).meta.model).toBeNull();
  });
});

describe('load report', () => {
  it('reports per-day loads, reasons and the peak even when accepted', () => {
    const o = validate(input());
    if (o.status !== 'ACCEPTED') throw new Error('expected ACCEPTED');
    expect(o.load.days[0]).toMatchObject({ day: 1, students_in_person: 45, teachers_on_site: 2, ok: true });
    expect(o.load.days[0]?.conditions.passport).toEqual({ load: 50, limit: 200, ok: true });
    expect(o.load.summary.peak).toEqual([{ condition: 'passport', day: 1, load: 50, limit: 200 }]);
    const c2d5 = o.load.class_days.find((cd) => cd.class_id === 'c-2' && cd.day === 5);
    expect(c2d5).toEqual({ class_id: 'c-2', day: 5, in_person: false, lessons: 0, reason: 'no_lessons' });
    expect(o.load.class_days.find((cd) => cd.class_id === 'c-1' && cd.day === 1)?.reason).toBe('priority');
    expect(o.load.summary.remote_class_days).toBe(1);
    expect(o.load.summary.classes_without_in_person_days).toEqual([]);
  });

  it('explains remote days: day limit vs no-shelter vs free choice', () => {
    const remoteDay1 = dayFormats().map((f) => (f.day === 1 ? { ...f, in_person: false } : f));
    const tight = validate(input({ snapshot: { capacity: { passport: 29 } }, day_formats: remoteDay1 })); // c-1 alone would need 25 + 3 + 2 = 30
    if (tight.status === 'INVALID_INPUT') throw new Error('unexpected');
    expect(tight.load.class_days.find((cd) => cd.class_id === 'c-1' && cd.day === 1)?.reason).toBe('day_limit');
    const roomy = validate(input({ day_formats: remoteDay1 }));
    if (roomy.status === 'INVALID_INPUT') throw new Error('unexpected');
    // c-2 shares t-1 with c-1 on day 1, so both would go in person together: 45 + 3 + 2 = 50 <= 200.
    // A remote day is never labelled 'priority': the shelter had room, it was just not used.
    expect(roomy.load.class_days.find((cd) => cd.class_id === 'c-2' && cd.day === 1)?.reason).toBe('capacity_available');
    const alert = validate(input({ snapshot: { kind: 'alert', capacity: { seats: 100, passport: 200 } }, day_formats: remoteDay1 }));
    if (alert.status === 'INVALID_INPUT') throw new Error('unexpected');
    expect(alert.load.class_days.find((cd) => cd.class_id === 'c-1' && cd.day === 1)?.reason).toBe('no_shelter');
    // c-2 has only math (in the shelter) on day 1, but its teacher t-1 also teaches c-1, which has PE
    // (not in the shelter): one format per teacher keeps c-2 remote with c-1.
    expect(alert.load.class_days.find((cd) => cd.class_id === 'c-2' && cd.day === 1)?.reason).toBe('no_shelter');
    expect(alert.load.summary.peak.map((p) => p.condition)).toEqual(['passport', 'seats']);
  });

  it('never labels a remote day "priority" when the shelter is roomy and nothing is a priority', () => {
    // Reproduction of bug 2: passport 2000, no priority classes or areas, day 1 remote for everyone.
    const noPriority = input().snapshot;
    const o = validate(
      input({
        snapshot: {
          capacity: { passport: 2000 },
          classes: noPriority.classes.map((c) => ({ ...c, priority: false })),
          subjects: noPriority.subjects.map((s) => ({ ...s, priority_area: false })),
        },
        day_formats: dayFormats().map((f) => (f.day === 1 ? { ...f, in_person: false } : f)),
      }),
    );
    if (o.status === 'INVALID_INPUT') throw new Error('unexpected');
    const remote = o.load.class_days.filter((cd) => !cd.in_person && cd.lessons > 0);
    expect(remote.map((cd) => [cd.class_id, cd.day, cd.reason])).toEqual([
      ['c-1', 1, 'capacity_available'],
      ['c-2', 1, 'capacity_available'],
    ]);
  });

  it('a remote day fits exactly at the limit with its teacher group, one place less is the day limit', () => {
    // Day 1 remote: c-1 and c-2 share t-1, so the group is both classes: 45 students + 3 staff + t-1 + t-2 = 50.
    const remoteDay1 = dayFormats().map((f) => (f.day === 1 ? { ...f, in_person: false } : f));
    const reasonOf = (passport: number): string | undefined => {
      const o = validate(input({ snapshot: { capacity: { passport } }, day_formats: remoteDay1 }));
      if (o.status === 'INVALID_INPUT') throw new Error('unexpected');
      return o.load.class_days.find((cd) => cd.class_id === 'c-2' && cd.day === 1)?.reason;
    };
    expect(reasonOf(50)).toBe('capacity_available');
    // c-2 alone would fit (20 + 3 + t-1 = 24), but not without c-1.
    expect(reasonOf(49)).toBe('day_limit');
  });

  it('the teacher group is transitive and is counted on top of the in-person classes', () => {
    // Day 1: t1 teaches a and b, t2 teaches b and c (a, b, c remote); d is in person with t4. Staff 0.
    // a's group is {a, b, c}: with d that is 40 students + t1 + t2 + t4 = 43.
    // Without transitivity {a, b} + d = 33; without the in-person classes {a, b, c} = 32; a alone + d = 22.
    const reasonOfA = (passport: number): string | undefined => {
      const o = validate(chain(passport));
      if (o.status === 'INVALID_INPUT') throw new Error('unexpected');
      return o.load.class_days.find((cd) => cd.class_id === 'a')?.reason;
    };
    expect(reasonOfA(43)).toBe('capacity_available');
    expect(reasonOfA(42)).toBe('day_limit');
  });

  it('a lesson of an unknown teacher links no classes (as in teacher_mixed_format)', () => {
    // a and b are remote; their only lessons are with t-gone, which is not in the snapshot. Staff 0.
    // a alone in person: 10 + t-gone = 11; linked with b it would be 21.
    const o = validate(
      tiny({
        lessons: [lesson('a', 1, 1, 's-x', 't-gone'), lesson('b', 1, 2, 's-x', 't-gone')],
        formats: { a: false, b: false },
        capacity: { passport: 11 },
      }),
    );
    if (o.status === 'INVALID_INPUT') throw new Error('unexpected');
    expect(o.load.class_days.find((cd) => cd.class_id === 'a')?.reason).toBe('capacity_available');
  });

  it('model 1.2: a no-shelter lesson in the teacher group keeps the class remote; model 1.1 ignores it', () => {
    // a has only s-x but shares t1 with b, which has s-ns (not in the shelter); c is on its own.
    const ls = [lesson('a', 1, 1, 's-x', 't1'), lesson('b', 1, 2, 's-x', 't1'), lesson('b', 1, 3, 's-ns', 't2'), lesson('c', 1, 1, 's-x', 't3')];
    const formats = { a: false, b: false, c: false };
    const m12 = validate(tiny({ lessons: ls, formats, kind: 'alert', capacity: { seats: 1000, passport: 1000 } }));
    const m11 = validate(tiny({ lessons: ls, formats, capacity: { passport: 1000 } }));
    if (m12.status === 'INVALID_INPUT' || m11.status === 'INVALID_INPUT') throw new Error('unexpected');
    const reasons = (o: typeof m11): Record<string, string> => Object.fromEntries(o.load.class_days.map((cd) => [cd.class_id, cd.reason]));
    expect(reasons(m12)).toEqual({ a: 'no_shelter', b: 'no_shelter', c: 'capacity_available' });
    expect(reasons(m11)).toEqual({ a: 'capacity_available', b: 'capacity_available', c: 'capacity_available' });
  });

  it('model 1.2: the seats and passport conditions of the group are checked separately', () => {
    // a and b share t1, both remote, math only. Group: seats = 20 students; passport = 20 + t1 = 21.
    const pair = [lesson('a', 1, 1, 's-x', 't1'), lesson('b', 1, 2, 's-x', 't1')];
    const at = (seats: number, passport: number) =>
      reasonsOf(tiny({ lessons: pair, formats: { a: false, b: false }, kind: 'alert', capacity: { seats, passport } })).a;
    expect(at(20, 1000)).toBe('remote:capacity_available');
    expect(at(19, 1000)).toBe('remote:day_limit');
    expect(at(1000, 21)).toBe('remote:capacity_available');
    expect(at(1000, 20)).toBe('remote:day_limit');
  });

  it('a class with lessons but no format record is remote, explained and part of the teacher group', () => {
    // b shares t1 with a and has no day_formats record (day_format_missing): treated as remote.
    // Group {a, b}: 20 students + t1 = 21.
    const at = (passport: number) =>
      reasonsOf(
        tiny({
          lessons: [lesson('a', 1, 1, 's-x', 't1'), lesson('b', 1, 2, 's-x', 't1')],
          formats: { a: false },
          capacity: { passport },
          extra: { classes: ['b'] },
        }),
      );
    expect(at(21)).toEqual({ a: 'remote:capacity_available', b: 'remote:capacity_available' });
    expect(at(20)).toEqual({ a: 'remote:day_limit', b: 'remote:day_limit' });
  });

  it('duplicate format records, remote and in person, make an in-person day (conservative for capacity)', () => {
    const r = reasonsOf(
      tiny({
        lessons: [lesson('a', 1, 1, 's-x', 't1'), lesson('b', 1, 2, 's-x', 't2')],
        formats: { a: false, b: false },
        capacity: { passport: 1000 },
        extra: { formats: [{ class_id: 'a', day: 1, in_person: true }] },
      }),
    );
    expect(r).toEqual({ a: 'in_person:capacity_available', b: 'remote:capacity_available' });
  });

  it('model 1.2: an in-person class of the group with a no-shelter lesson keeps a remote class remote (on purpose)', () => {
    // b is in person with PE while sharing t1 with remote a: invalid (teacher_mixed_format, no_shelter_in_person).
    // The group is built over all classes of the day, in person too: a cannot come in person with b as it is.
    const r = reasonsOf(
      tiny({
        lessons: [lesson('a', 1, 1, 's-x', 't1'), lesson('b', 1, 2, 's-x', 't1'), lesson('b', 1, 3, 's-ns', 't2')],
        formats: { a: false, b: true },
        kind: 'alert',
        capacity: { seats: 1000, passport: 1000 },
      }),
    );
    expect(r.a).toBe('remote:no_shelter');
  });

  it('a remote class without lessons is no_lessons, whatever the rest of the day', () => {
    const r = reasonsOf(tiny({ lessons: [lesson('b', 1, 1, 's-x', 't1'), lesson('c', 1, 2, 's-x', 't1')], formats: { a: false, b: false, c: false }, capacity: { passport: 0 } }));
    expect(r).toEqual({ a: 'remote:no_lessons', b: 'remote:day_limit', c: 'remote:day_limit' });
  });

  it('lessons of an inactive class do not bridge a teacher group', () => {
    // z is not in the snapshot (class_not_active). Through z, t1 and t2 would link a with b.
    // a alone in person: 10 + t1 = 11; with b it would be 20 + t1 + t2 = 22.
    const r = reasonsOf(
      tiny({
        lessons: [lesson('a', 1, 1, 's-x', 't1'), lesson('z', 1, 2, 's-x', 't1'), lesson('z', 1, 3, 's-x', 't2'), lesson('b', 1, 1, 's-x', 't2')],
        formats: { a: false, b: false },
        capacity: { passport: 11 },
      }),
    );
    expect(r.a).toBe('remote:capacity_available');
  });

  it('in-person days keep their reasons', () => {
    const o = validate(input());
    if (o.status === 'INVALID_INPUT') throw new Error('unexpected');
    // c-1 is a priority class; c-2 is not, but math is a priority area.
    expect(o.load.class_days.find((cd) => cd.class_id === 'c-2' && cd.day === 1)?.reason).toBe('priority');
    const plain = input().snapshot;
    const none = validate(
      input({
        snapshot: { classes: plain.classes.map((c) => ({ ...c, priority: false })), subjects: plain.subjects.map((s) => ({ ...s, priority_area: false })) },
      }),
    );
    if (none.status === 'INVALID_INPUT') throw new Error('unexpected');
    expect(none.load.class_days.find((cd) => cd.class_id === 'c-1' && cd.day === 1)?.reason).toBe('capacity_available');
  });

  it('lists classes that never study in person', () => {
    const fs = dayFormats().map((f) => (f.class_id === 'c-2' ? { ...f, in_person: false } : f));
    const ls = lessons().filter((l) => l.class_id !== 'c-2' || l.subject_id !== 's-math');
    const o = validate(input({ lessons: ls, day_formats: fs }));
    if (o.status === 'INVALID_INPUT') throw new Error('unexpected');
    expect(o.load.summary.classes_without_in_person_days).toEqual(['c-2']);
  });
});

// A missing field sorts first, strings compare by code unit (order.ts): found by mutation testing.
describe('conflict order with missing fields', () => {
  it('sorts a missing day, class or lesson number before present ones', () => {
    const c = (over: Partial<Conflict>): Conflict => ({ rule: 'class_double_booked', ...over });
    const sorted = sortConflicts([c({ day: 2, class_id: 'b', lesson_no: 2 }), c({ day: 2, class_id: 'b' }), c({ day: 2, class_id: 'a' }), c({ day: 2 }), c({})]);
    expect(sorted).toEqual([c({}), c({ day: 2 }), c({ day: 2, class_id: 'a' }), c({ day: 2, class_id: 'b' }), c({ day: 2, class_id: 'b', lesson_no: 2 })]);
  });

  it('sorts days and lesson numbers ascending whatever the input order', () => {
    const c = (day: number, lesson_no: number): Conflict => ({ rule: 'class_double_booked', class_id: 'a', day, lesson_no });
    const want = [c(1, 1), c(1, 3), c(2, 2), c(3, 1)];
    expect(sortConflicts([c(3, 1), c(1, 3), c(2, 2), c(1, 1)])).toEqual(want);
    expect(sortConflicts([...want].reverse())).toEqual(want);
  });
});
