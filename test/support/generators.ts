// Shared fast-check generators for the property tests.
import fc from 'fast-check';

import type { CurriculumRow, DayFormat, Lesson, ValidationInput } from '../../src/index.js';

/** A school where every row has its own teacher and lessons fill each class's slots in order. */
export const validSchool = fc
  .record({
    classes: fc.integer({ min: 1, max: 6 }),
    days: fc.integer({ min: 1, max: 6 }),
    perDay: fc.integer({ min: 1, max: 10 }),
    subjects: fc.integer({ min: 1, max: 4 }),
    alert: fc.boolean(),
    seed: fc.nat(),
  })
  .map(({ classes, days, perDay, subjects, alert, seed }): ValidationInput => {
    const schoolDays = Array.from({ length: days }, (_, i) => i + 1);
    const rows: CurriculumRow[] = [];
    const ls: Lesson[] = [];
    for (let c = 0; c < classes; c += 1) {
      const slots = schoolDays.flatMap((day) => Array.from({ length: perDay }, (_, n) => ({ day, lesson_no: n + 1 })));
      let next = 0;
      for (let s = 0; s < Math.min(subjects, slots.length); s += 1) {
        const share = Math.max(1, Math.floor(slots.length / subjects)); // the schema needs hours >= 1
        const hours = 1 + ((seed + c + s) % share);
        rows.push({ class_id: `c-${String(c)}`, subject_id: `s-${String(s)}`, teacher_id: `t-${String(c)}-${String(s)}`, hours });
        for (let h = 0; h < hours; h += 1) {
          const slot = slots[next];
          next += 1;
          if (slot !== undefined) ls.push({ class_id: `c-${String(c)}`, subject_id: `s-${String(s)}`, teacher_id: `t-${String(c)}-${String(s)}`, ...slot });
        }
      }
    }
    const busy = new Set(ls.map((l) => `${l.class_id}|${String(l.day)}`));
    const fs: DayFormat[] = [];
    for (let c = 0; c < classes; c += 1) {
      for (const day of schoolDays) fs.push({ class_id: `c-${String(c)}`, day, in_person: busy.has(`c-${String(c)}|${String(day)}`) && (seed + day) % 2 === 0 });
    }
    return {
      schema_version: '1.0',
      snapshot: {
        kind: alert ? 'alert' : 'main',
        school_days: schoolDays,
        lessons_per_day: perDay,
        staff: 2,
        capacity: alert ? { seats: 10_000, passport: 10_000 } : { passport: 10_000 },
        classes: Array.from({ length: classes }, (_, c) => ({ id: `c-${String(c)}`, students: 20 + c, priority: c % 2 === 0 })),
        subjects: Array.from({ length: subjects }, (_, s) => ({ id: `s-${String(s)}`, priority_area: s === 0, no_shelter: false })),
        teachers: rows.map((r) => ({ id: r.teacher_id, weekly_limit: r.hours, unavailable_days: [] })),
        rows,
      },
      timetable: { lessons: ls, day_formats: fs },
    };
  });

/**
 * An arbitrary school for the /load reasons, valid at the boundary but not necessarily by the rules:
 * teachers shared across classes (and now and then one unknown to the snapshot), any day formats,
 * no-shelter subjects, a capacity from tight to roomy.
 */
export const loadSchool = fc
  .record({
    classes: fc.array(fc.record({ students: fc.integer({ min: 1, max: 40 }), priority: fc.boolean() }), { minLength: 1, maxLength: 5 }),
    days: fc.integer({ min: 1, max: 3 }),
    teachers: fc.integer({ min: 1, max: 4 }),
    // Per class-day: lessons as (teacher, subject) indices; the subject s-1 is not held in the shelter.
    plan: fc.array(fc.array(fc.tuple(fc.nat(), fc.boolean()), { maxLength: 3 }), { minLength: 15, maxLength: 15 }),
    formats: fc.array(fc.boolean(), { minLength: 15, maxLength: 15 }),
    alert: fc.boolean(),
    staff: fc.integer({ min: 0, max: 5 }),
    passport: fc.integer({ min: 0, max: 200 }),
    seats: fc.integer({ min: 0, max: 150 }),
  })
  .map(({ classes, days, teachers, plan, formats, alert, staff, passport, seats }): ValidationInput => {
    const schoolDays = Array.from({ length: days }, (_, i) => i + 1);
    const ls: Lesson[] = [];
    const fs: DayFormat[] = [];
    classes.forEach((_, c) => {
      for (const day of schoolDays) {
        const i = c * 3 + day - 1;
        (plan[i] ?? []).forEach(([t, ns], n) => {
          // About one lesson in ten has a teacher missing from the snapshot (teacher_not_active).
          const teacher_id = t % 10 === 9 ? 't-gone' : `t-${String(t % teachers)}`;
          ls.push({ class_id: `c-${String(c)}`, day, lesson_no: n + 1, subject_id: ns ? 's-1' : 's-0', teacher_id });
        });
        fs.push({ class_id: `c-${String(c)}`, day, in_person: formats[i] ?? false });
      }
    });
    return {
      schema_version: '1.0',
      snapshot: {
        kind: alert ? 'alert' : 'main',
        school_days: schoolDays,
        lessons_per_day: 3,
        staff,
        capacity: alert ? { seats, passport } : { passport },
        classes: classes.map((c, i) => ({ id: `c-${String(i)}`, ...c })),
        subjects: [
          { id: 's-0', priority_area: true, no_shelter: false },
          { id: 's-1', priority_area: false, no_shelter: true },
        ],
        teachers: Array.from({ length: teachers }, (_, t) => ({ id: `t-${String(t)}`, weekly_limit: 50, unavailable_days: [] })),
        rows: [],
      },
      timetable: { lessons: ls, day_formats: fs },
    };
  });

/**
 * A dense, untidy school for comparing buildLoad with the v0.3.0 oracle (not necessarily valid at the
 * boundary): up to 12 classes on up to 6 school days in any order, 1-3 teachers (large teacher groups),
 * lessons of a teacher missing from the snapshot (t-gone), of an unknown class (c-u) and of an unknown subject,
 * lessons on a day that is not a school day, duplicate and missing day formats, models 1.1 and 1.2.
 */
export const denseSchool = fc
  .record({
    classes: fc.array(fc.record({ students: fc.integer({ min: 0, max: 40 }), priority: fc.boolean() }), { minLength: 1, maxLength: 12 }),
    days: fc.uniqueArray(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 6 }),
    teachers: fc.integer({ min: 1, max: 3 }),
    lessons: fc.array(fc.record({ c: fc.nat(12), day: fc.integer({ min: 1, max: 7 }), t: fc.nat(9), s: fc.nat(9) }), { maxLength: 90 }),
    formats: fc.array(fc.record({ c: fc.nat(11), day: fc.integer({ min: 1, max: 7 }), in_person: fc.boolean() }), { maxLength: 70 }),
    alert: fc.boolean(),
    staff: fc.integer({ min: 0, max: 5 }),
    passport: fc.integer({ min: 0, max: 400 }),
    seats: fc.integer({ min: 0, max: 300 }),
  })
  .map(({ classes, days, teachers, lessons, formats, alert, staff, passport, seats }): ValidationInput => {
    // Index 12 is a class missing from the snapshot.
    const classId = (c: number) => (c < classes.length ? `c-${String(c)}` : 'c-u');
    const subjectId = (s: number) => (s < 6 ? 's-0' : s < 8 ? 's-1' : s === 8 ? 's-2' : 's-x');
    return {
      schema_version: '1.0',
      snapshot: {
        kind: alert ? 'alert' : 'main',
        school_days: days,
        lessons_per_day: 10,
        staff,
        capacity: alert ? { seats, passport } : { passport },
        classes: classes.map((c, i) => ({ id: `c-${String(i)}`, ...c })),
        subjects: [
          { id: 's-0', priority_area: false, no_shelter: false },
          { id: 's-1', priority_area: false, no_shelter: true },
          { id: 's-2', priority_area: true, no_shelter: false },
        ],
        teachers: Array.from({ length: teachers }, (_, t) => ({ id: `t-${String(t)}`, weekly_limit: 50, unavailable_days: [] })),
        rows: [],
      },
      timetable: {
        lessons: lessons.map(({ c, day, t, s }, n) => ({
          class_id: classId(c),
          day,
          lesson_no: 1 + (n % 10),
          subject_id: subjectId(s),
          teacher_id: t === 9 ? 't-gone' : `t-${String(t % teachers)}`,
        })),
        day_formats: formats.map(({ c, day, in_person }) => ({ class_id: classId(c), day, in_person })),
      },
    };
  });
