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
