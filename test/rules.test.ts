// One test per rule (ADR 2026-11-09 §4): a single mutation of the valid school yields exactly that
// rule's conflict(s). Rules are written from the spec text (§04), not from the solver's model.
import { describe, expect, it } from 'vitest';

import { validate, type Conflict, type CurriculumRow, type Teacher, type ValidationOutcome } from '../src/index.js';
import { dayFormats, input, lesson, lessons } from './support/school.js';

const conflicts = (o: ValidationOutcome): readonly Conflict[] => {
  if (o.status === 'INVALID_INPUT') throw new Error(`invalid input: ${JSON.stringify(o.issues)}`);
  return o.conflicts;
};
const rules = (o: ValidationOutcome): string[] => [...new Set(conflicts(o).map((c) => c.rule))];

const setFormat = (class_id: string, day: number, in_person: boolean) =>
  dayFormats().map((f) => (f.class_id === class_id && f.day === day ? { ...f, in_person } : f));

describe('the valid school', () => {
  it('is ACCEPTED with no conflicts', () => {
    const o = validate(input());
    expect(o.status).toBe('ACCEPTED');
    expect(conflicts(o)).toEqual([]);
  });
});

describe('references to the active snapshot', () => {
  it('class_not_active: a lesson of a class that is not in the snapshot (archived)', () => {
    const o = validate(input({ lessons: [...lessons(), lesson('c-9', 1, 5, 's-math', 't-1')] }));
    expect(conflicts(o)).toEqual([{ rule: 'class_not_active', class_id: 'c-9' }]);
  });

  it('subject_not_active', () => {
    const ls = lessons().map((l, i) => (i === 0 ? { ...l, subject_id: 's-old' } : l));
    const o = validate(input({ lessons: ls }));
    expect(conflicts(o)).toContainEqual({ rule: 'subject_not_active', class_id: 'c-1', subject_id: 's-old' });
    expect(rules(o)).toEqual(['subject_not_active', 'plan_hours_mismatch']); // c-1 math now 4 of 5
  });

  it('teacher_not_active (a deleted teacher)', () => {
    const ls = lessons().map((l, i) => (i === 0 ? { ...l, teacher_id: 't-gone' } : l));
    expect(rules(validate(input({ lessons: ls })))).toEqual(['teacher_not_active']);
  });
});

describe('grid', () => {
  it('day_not_school_day', () => {
    const ls = lessons().map((l, i) => (i === 4 ? { ...l, day: 6 } : l)); // c-1 math day 5 -> Saturday
    const o = validate(input({ lessons: ls }));
    expect(conflicts(o)).toContainEqual({ rule: 'day_not_school_day', class_id: 'c-1', day: 6 });
    expect(rules(o)).toEqual(['day_not_school_day', 'in_person_without_lessons']); // c-1 day 5 lost its lesson
  });

  it('lesson_no_out_of_range: lesson_no above lessons_per_day', () => {
    const ls = lessons().map((l, i) => (i === 0 ? { ...l, lesson_no: 7 } : l));
    expect(conflicts(validate(input({ lessons: ls })))).toEqual([
      { rule: 'lesson_no_out_of_range', class_id: 'c-1', day: 1, lesson_no: 7, limit: 6 },
    ]);
  });

  it('exactly lessons_per_day is fine', () => {
    const ls = lessons().map((l, i) => (i === 0 ? { ...l, lesson_no: 6 } : l));
    expect(validate(input({ lessons: ls })).status).toBe('ACCEPTED');
  });
});

describe('day formats', () => {
  it('day_format_missing', () => {
    const fs = dayFormats().filter((f) => !(f.class_id === 'c-1' && f.day === 3));
    expect(conflicts(validate(input({ day_formats: fs })))).toEqual([
      { rule: 'day_format_missing', class_id: 'c-1', day: 3 },
    ]);
  });

  it('day_format_duplicate (identical or contradictory)', () => {
    const fs = [...dayFormats(), { class_id: 'c-1', day: 2, in_person: false }];
    expect(conflicts(validate(input({ day_formats: fs })))).toEqual([
      { rule: 'day_format_duplicate', class_id: 'c-1', day: 2 },
    ]);
  });

  it('in_person_without_lessons', () => {
    expect(conflicts(validate(input({ day_formats: setFormat('c-2', 5, true) })))).toEqual([
      { rule: 'in_person_without_lessons', class_id: 'c-2', day: 5 },
    ]);
  });

  it('a remote day with lessons is fine (distance learning)', () => {
    // Both classes remote on day 2, so t-1 keeps one format that day.
    const fs = dayFormats().map((f) => (f.day === 2 ? { ...f, in_person: false } : f));
    expect(validate(input({ day_formats: fs })).status).toBe('ACCEPTED');
  });
});

describe('overlaps', () => {
  it('class_double_booked', () => {
    const ls = [...lessons().filter((_, i) => i !== 0), lesson('c-1', 1, 3, 's-math', 't-1')];
    const o = validate(input({ lessons: ls }));
    expect(conflicts(o)).toContainEqual({ rule: 'class_double_booked', class_id: 'c-1', day: 1, lesson_no: 3 });
  });

  it('teacher_double_booked', () => {
    // c-2 math day 1 moves from lesson 2 to lesson 1: t-1 teaches c-1 and c-2 at once.
    const ls = lessons().map((l) => (l.class_id === 'c-2' && l.day === 1 && l.subject_id === 's-math' ? { ...l, lesson_no: 1 } : l));
    expect(conflicts(validate(input({ lessons: ls })))).toEqual([
      { rule: 'teacher_double_booked', teacher_id: 't-1', day: 1, lesson_no: 1 },
    ]);
  });
});

describe('teachers', () => {
  it('teacher_mixed_format: in-person and remote classes on the same day', () => {
    // Day 1: t-1 teaches c-1 (in person) and c-2 (now remote).
    expect(conflicts(validate(input({ day_formats: setFormat('c-2', 1, false) })))).toEqual([
      { rule: 'teacher_mixed_format', teacher_id: 't-1', day: 1 },
    ]);
  });

  it('teacher_unavailable_day', () => {
    const ls = lessons().map((l) => (l.class_id === 'c-1' && l.subject_id === 's-pe' && l.day === 2 ? { ...l, day: 5 } : l));
    expect(conflicts(validate(input({ lessons: ls })))).toEqual([
      { rule: 'teacher_unavailable_day', teacher_id: 't-2', day: 5 },
    ]);
  });

  it('teacher_weekly_limit: exactly at the limit passes, +1 fails', () => {
    const at = input();
    const teachersAt = at.snapshot.teachers.map((t: Teacher) => (t.id === 't-1' ? { ...t, weekly_limit: 9 } : t));
    expect(validate(input({ snapshot: { teachers: teachersAt } })).status).toBe('ACCEPTED');
    const teachersOver = at.snapshot.teachers.map((t: Teacher) => (t.id === 't-1' ? { ...t, weekly_limit: 8 } : t));
    expect(conflicts(validate(input({ snapshot: { teachers: teachersOver } })))).toEqual([
      { rule: 'teacher_weekly_limit', teacher_id: 't-1', value: 9, limit: 8 },
    ]);
  });
});

describe('curriculum', () => {
  it('lesson_not_in_plan', () => {
    const ls = [...lessons(), lesson('c-2', 5, 1, 's-pe', 't-2')].map((l) => (l.day === 5 && l.class_id === 'c-2' ? { ...l, day: 1, lesson_no: 4 } : l));
    // c-2 pe day 1 is extra: pair exists in plan, so this is an hours mismatch, not "not in plan".
    expect(rules(validate(input({ lessons: ls })))).toEqual(['plan_hours_mismatch']);
    const art = { id: 's-art', priority_area: false, no_shelter: false };
    const base = input();
    const o = validate(input({ snapshot: { subjects: [...base.snapshot.subjects, art] }, lessons: [...lessons(), lesson('c-1', 2, 4, 's-art', 't-1')] }));
    expect(conflicts(o)).toEqual([{ rule: 'lesson_not_in_plan', class_id: 'c-1', subject_id: 's-art' }]);
  });

  it('teacher_not_in_plan', () => {
    const ls = lessons().map((l) => (l.class_id === 'c-1' && l.subject_id === 's-pe' && l.day === 1 ? { ...l, teacher_id: 't-1', lesson_no: 4 } : l));
    expect(conflicts(validate(input({ lessons: ls })))).toEqual([
      { rule: 'teacher_not_in_plan', class_id: 'c-1', subject_id: 's-pe', teacher_id: 't-1' },
    ]);
  });

  it('plan_hours_mismatch: missing and extra lessons, including a row with no lessons', () => {
    const missing = lessons().filter((l) => !(l.class_id === 'c-2' && l.subject_id === 's-pe'));
    expect(conflicts(validate(input({ lessons: missing })))).toEqual([
      { rule: 'plan_hours_mismatch', class_id: 'c-2', subject_id: 's-pe', value: 0, limit: 2 },
    ]);
  });
});

describe('capacity (model 1.1)', () => {
  it('capacity_exceeded at +1, not at the limit', () => {
    // Day 1: 25 + 20 students + 3 staff + 2 teachers = 50.
    expect(validate(input({ snapshot: { capacity: { passport: 50 } } })).status).toBe('ACCEPTED');
    const o = validate(input({ snapshot: { capacity: { passport: 49 } } }));
    expect(conflicts(o)).toContainEqual({ rule: 'capacity_exceeded', day: 1, condition: 'passport', value: 50, limit: 49 });
    expect(rules(o)).toEqual(['capacity_exceeded']);
  });
});

describe('alert timetable (model 1.2)', () => {
  const alert = (seats: number, passport: number) => ({ kind: 'alert' as const, capacity: { seats, passport } });
  const noPe = lessons().filter((l) => l.subject_id !== 's-pe');
  const rowsNoPe = input().snapshot.rows.filter((r: CurriculumRow) => r.subject_id !== 's-pe');

  it('reports seats and passport separately', () => {
    // Day 1 without PE: 45 students + 3 staff + 1 teacher = 49 people, 45 seats needed.
    const o = validate(input({ snapshot: { ...alert(44, 48), rows: rowsNoPe }, lessons: noPe }));
    const day1 = conflicts(o).filter((c) => c.day === 1);
    expect(day1).toEqual([
      { rule: 'capacity_exceeded', day: 1, condition: 'passport', value: 49, limit: 48 },
      { rule: 'capacity_exceeded', day: 1, condition: 'seats', value: 45, limit: 44 },
    ]);
  });

  it('no_shelter_in_person: only in model 1.2', () => {
    const o = validate(input({ snapshot: alert(100, 200) }));
    expect(conflicts(o)).toContainEqual({ rule: 'no_shelter_in_person', class_id: 'c-1', subject_id: 's-pe', day: 1 });
    expect(rules(o)).toEqual(['no_shelter_in_person']);
    expect(validate(input()).status).toBe('ACCEPTED'); // same lessons, model 1.1
  });

  it('no_shelter lessons on remote days are fine, and an all-remote week fits any shelter', () => {
    const allRemote = dayFormats().map((f) => ({ ...f, in_person: false }));
    expect(validate(input({ snapshot: alert(0, 3), day_formats: allRemote })).status).toBe('ACCEPTED');
  });
});
