// A small, hand-checked valid school and timetable. Each rule test applies one mutation to it.
import type { DayFormat, Lesson, Snapshot, ValidationInput } from '../../src/index.js';

export const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  kind: 'main',
  school_days: [1, 2, 3, 4, 5],
  lessons_per_day: 6,
  staff: 3,
  capacity: { passport: 200 },
  classes: [
    { id: 'c-1', students: 25, priority: true },
    { id: 'c-2', students: 20, priority: false },
  ],
  subjects: [
    { id: 's-math', priority_area: true, no_shelter: false },
    { id: 's-pe', priority_area: false, no_shelter: true },
  ],
  teachers: [
    { id: 't-1', weekly_limit: 20, unavailable_days: [] },
    { id: 't-2', weekly_limit: 20, unavailable_days: [5] },
  ],
  rows: [
    { class_id: 'c-1', subject_id: 's-math', teacher_id: 't-1', hours: 5 },
    { class_id: 'c-1', subject_id: 's-pe', teacher_id: 't-2', hours: 2 },
    { class_id: 'c-2', subject_id: 's-math', teacher_id: 't-1', hours: 4 },
    { class_id: 'c-2', subject_id: 's-pe', teacher_id: 't-2', hours: 2 },
  ],
  ...over,
});

const L = (class_id: string, day: number, lesson_no: number, subject_id: string, teacher_id: string): Lesson => ({
  class_id,
  day,
  lesson_no,
  subject_id,
  teacher_id,
});

export const lessons = (): Lesson[] => [
  ...[1, 2, 3, 4, 5].map((d) => L('c-1', d, 1, 's-math', 't-1')),
  ...[1, 2, 3, 4].map((d) => L('c-2', d, 2, 's-math', 't-1')),
  L('c-1', 1, 3, 's-pe', 't-2'),
  L('c-1', 2, 3, 's-pe', 't-2'),
  L('c-2', 3, 3, 's-pe', 't-2'),
  L('c-2', 4, 3, 's-pe', 't-2'),
];

/** Every class-day in person, except c-2 on day 5 (no lessons that day). */
export const dayFormats = (): DayFormat[] =>
  ['c-1', 'c-2'].flatMap((class_id) =>
    [1, 2, 3, 4, 5].map((day) => ({ class_id, day, in_person: !(class_id === 'c-2' && day === 5) })),
  );

export const input = (
  over: { snapshot?: Partial<Snapshot>; lessons?: Lesson[]; day_formats?: DayFormat[] } = {},
): ValidationInput => ({
  schema_version: '1.0',
  snapshot: snapshot(over.snapshot),
  timetable: { lessons: over.lessons ?? lessons(), day_formats: over.day_formats ?? dayFormats() },
});

export { L as lesson };
