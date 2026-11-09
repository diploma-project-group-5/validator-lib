// Property and metamorphic tests (ADR 2026-11-09 §7): a timetable valid by construction is ACCEPTED,
// cascades report one cause, quality rules of the solver are not checked, limits behave monotonically.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { validate } from '../src/index.js';
import { validSchool } from './support/generators.js';
import { dayFormats, input, lesson, lessons } from './support/school.js';

describe('properties', () => {
  it('P1: a timetable valid by construction is ACCEPTED', () => {
    fc.assert(
      fc.property(validSchool, (school) => {
        const o = validate(school);
        expect(o.status, JSON.stringify(o.status === 'REJECTED' ? o.conflicts.slice(0, 3) : o)).toBe('ACCEPTED');
      }),
      { numRuns: 150 },
    );
  });

  it('a larger passport never adds capacity conflicts (monotone)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 80 }), fc.integer({ min: 0, max: 40 }), (passport, extra) => {
        const count = (p: number) => {
          const o = validate(input({ snapshot: { capacity: { passport: p } } }));
          return o.status === 'REJECTED' ? o.conflicts.filter((c) => c.rule === 'capacity_exceeded').length : 0;
        };
        expect(count(passport + extra)).toBeLessThanOrEqual(count(passport));
      }),
      { numRuns: 60 },
    );
  });

  it('model 1.2 with unlimited seats gives the model 1.1 passport verdict (no no-shelter lessons)', () => {
    const noShelter = input().snapshot.subjects.map((s) => ({ ...s, no_shelter: false }));
    for (const passport of [40, 49, 50, 200]) {
      const m11 = validate(input({ snapshot: { capacity: { passport }, subjects: noShelter } }));
      const m12 = validate(input({ snapshot: { kind: 'alert', capacity: { seats: 1e5, passport }, subjects: noShelter } }));
      expect(m12.status).toBe(m11.status);
      if (m11.status === 'REJECTED' && m12.status === 'REJECTED') expect(m12.conflicts).toEqual(m11.conflicts);
    }
  });

  it('another lesson of a teacher already on site does not change the day load', () => {
    const before = validate(input());
    const extra = [...lessons(), lesson('c-1', 1, 4, 's-math', 't-1')];
    const after = validate(input({ lessons: extra }));
    if (before.status === 'INVALID_INPUT' || after.status === 'INVALID_INPUT') throw new Error('unexpected');
    expect(after.load.days[0]).toEqual(before.load.days[0]);
  });
});

describe('cascades and scope', () => {
  it('an unknown teacher still counts in capacity', () => {
    const ls = lessons().map((l, i) => (i === 0 ? { ...l, teacher_id: 't-gone' } : l));
    const o = validate(input({ lessons: ls, snapshot: { capacity: { passport: 50 } } }));
    // Day 1: 45 students + 3 staff + t-gone + t-1 + t-2 = 51 > 50.
    if (o.status !== 'REJECTED') throw new Error('expected REJECTED');
    expect(o.conflicts).toContainEqual({ rule: 'capacity_exceeded', day: 1, condition: 'passport', value: 51, limit: 50 });
  });

  it('a lesson on a non-school day still counts in the weekly limit and plan hours', () => {
    const teachers = input().snapshot.teachers.map((t) => (t.id === 't-1' ? { ...t, weekly_limit: 8 } : t));
    const ls = lessons().map((l, i) => (i === 4 ? { ...l, day: 6 } : l));
    const o = validate(input({ snapshot: { teachers }, lessons: ls }));
    if (o.status !== 'REJECTED') throw new Error('expected REJECTED');
    expect(o.conflicts).toContainEqual({ rule: 'teacher_weekly_limit', teacher_id: 't-1', value: 9, limit: 8 });
    expect(o.conflicts.some((c) => c.rule === 'plan_hours_mismatch')).toBe(false);
  });

  it("the solver's quality cap (lessons of one row per day) is not a rule", () => {
    // Four c-1 math lessons on day 1 (slots 1, 4, 5, 6; t-1 teaches c-2 in slot 2): legal for the
    // spec, although the solver's per-day row cap would never build it.
    const move: Record<number, number> = { 3: 4, 4: 5, 5: 6 };
    const ls = lessons().map((l) => {
      const to = move[l.day];
      return l.class_id === 'c-1' && l.subject_id === 's-math' && to !== undefined ? { ...l, day: 1, lesson_no: to } : l;
    });
    const fs = dayFormats();
    const o = validate(input({ lessons: ls, day_formats: fs }));
    // c-1 now has no lessons on days 3-5 while they are in person: only that is reported.
    if (o.status !== 'REJECTED') throw new Error('expected REJECTED');
    expect([...new Set(o.conflicts.map((c) => c.rule))]).toEqual(['in_person_without_lessons']);
    const remote = fs.map((f) => (f.class_id === 'c-1' && f.day >= 3 ? { ...f, in_person: false } : f));
    expect(validate(input({ lessons: ls, day_formats: remote })).status).toBe('ACCEPTED');
  });

  it('max_conflicts must be a non-negative integer (a caller bug otherwise)', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => validate(input(), { max_conflicts: bad })).toThrow(RangeError);
    }
    expect(validate(input(), { max_conflicts: 0 }).status).toBe('ACCEPTED');
  });
});
