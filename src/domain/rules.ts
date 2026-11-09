// The hard rules of spec §04 checked on a finished timetable (ADR 2026-11-09 §4).
// Written from the spec text, independently of the solver's CP-SAT model.
//
// Cascade suppression keeps one cause from reporting many symptoms:
//  - a lesson of an unknown class takes part in no other rule;
//  - a lesson of an unknown subject skips the curriculum and no-shelter rules;
//  - a lesson of an unknown teacher skips the teacher rules, but still counts in capacity;
//  - a lesson on a non-school day skips the daily rules, but counts in weekly totals and plan hours.
import { dayLoad } from './capacity.js';
import type { CapacityAlert, CapacityPassport, Conflict, ConflictRule, Lesson, Model, ValidationInput } from './types.js';

export const RULES: readonly ConflictRule[] = [
  'class_not_active',
  'subject_not_active',
  'teacher_not_active',
  'day_not_school_day',
  'lesson_no_out_of_range',
  'day_format_missing',
  'day_format_duplicate',
  'in_person_without_lessons',
  'class_double_booked',
  'teacher_double_booked',
  'teacher_mixed_format',
  'teacher_unavailable_day',
  'teacher_weekly_limit',
  'lesson_not_in_plan',
  'teacher_not_in_plan',
  'plan_hours_mismatch',
  'capacity_exceeded',
  'no_shelter_in_person',
];

export const modelOf = (input: ValidationInput): Model => (input.snapshot.kind === 'alert' ? '1.2' : '1.1');

/** Model and capacity as one agreeing pair (the boundary has already proven kind <-> capacity). */
export function modelCapacity(
  input: ValidationInput,
): { model: '1.1'; capacity: CapacityPassport } | { model: '1.2'; capacity: CapacityAlert } {
  const { capacity } = input.snapshot;
  if (input.snapshot.kind === 'alert') {
    if (!('seats' in capacity)) throw new TypeError('alert snapshot without seats passed the boundary');
    return { model: '1.2', capacity };
  }
  return { model: '1.1', capacity: { passport: capacity.passport } };
}

const key = (...parts: (string | number)[]): string => parts.join('\u0000');

/** Formats of class-days: true if any record says in person (conservative for capacity). */
export function formatsOf(input: ValidationInput): Map<string, boolean> {
  const formats = new Map<string, boolean>();
  for (const f of input.timetable.day_formats) {
    const k = key(f.class_id, f.day);
    formats.set(k, (formats.get(k) ?? false) || f.in_person);
  }
  return formats;
}

export const isInPerson = (formats: Map<string, boolean>, class_id: string, day: number): boolean =>
  formats.get(key(class_id, day)) ?? false;

export function checkRules(input: ValidationInput): Conflict[] {
  const { snapshot, timetable } = input;
  const out: Conflict[] = [];
  const once = new Set<string>();
  const add = (c: Conflict): void => {
    const k = JSON.stringify(c);
    if (!once.has(k)) {
      once.add(k);
      out.push(c);
    }
  };

  const classes = new Map(snapshot.classes.map((c) => [c.id, c]));
  const subjects = new Map(snapshot.subjects.map((s) => [s.id, s]));
  const teachers = new Map(snapshot.teachers.map((t) => [t.id, t]));
  const rows = new Map(snapshot.rows.map((r) => [key(r.class_id, r.subject_id), r]));
  const schoolDays = new Set(snapshot.school_days);
  const L = snapshot.lessons_per_day;
  const formats = formatsOf(input);

  // 1-5: references and grid; collect the lessons that the other rules may look at.
  const known: Lesson[] = []; // class known
  for (const l of timetable.lessons) {
    if (!classes.has(l.class_id)) {
      add({ rule: 'class_not_active', class_id: l.class_id });
      continue;
    }
    if (!subjects.has(l.subject_id)) add({ rule: 'subject_not_active', class_id: l.class_id, subject_id: l.subject_id });
    if (!teachers.has(l.teacher_id)) add({ rule: 'teacher_not_active', teacher_id: l.teacher_id });
    if (!schoolDays.has(l.day)) add({ rule: 'day_not_school_day', class_id: l.class_id, day: l.day });
    if (l.lesson_no > L) {
      add({ rule: 'lesson_no_out_of_range', class_id: l.class_id, day: l.day, lesson_no: l.lesson_no, limit: L });
    }
    known.push(l);
  }
  const daily = known.filter((l) => schoolDays.has(l.day));

  // 6-8: day formats of every active class x school day.
  const formatCount = new Map<string, number>();
  for (const f of timetable.day_formats) {
    if (!classes.has(f.class_id)) {
      add({ rule: 'class_not_active', class_id: f.class_id });
      continue;
    }
    if (!schoolDays.has(f.day)) {
      add({ rule: 'day_not_school_day', class_id: f.class_id, day: f.day });
      continue;
    }
    const k = key(f.class_id, f.day);
    formatCount.set(k, (formatCount.get(k) ?? 0) + 1);
  }
  const lessonsPerClassDay = new Map<string, number>();
  for (const l of daily) {
    const k = key(l.class_id, l.day);
    lessonsPerClassDay.set(k, (lessonsPerClassDay.get(k) ?? 0) + 1);
  }
  for (const c of snapshot.classes) {
    for (const d of snapshot.school_days) {
      const k = key(c.id, d);
      const n = formatCount.get(k) ?? 0;
      if (n === 0) add({ rule: 'day_format_missing', class_id: c.id, day: d });
      if (n > 1) add({ rule: 'day_format_duplicate', class_id: c.id, day: d });
      if (isInPerson(formats, c.id, d) && (lessonsPerClassDay.get(k) ?? 0) === 0) {
        add({ rule: 'in_person_without_lessons', class_id: c.id, day: d });
      }
    }
  }

  // 9-10: overlaps.
  const classSlots = new Map<string, number>();
  const teacherSlots = new Map<string, number>();
  for (const l of daily) {
    const cs = key(l.class_id, l.day, l.lesson_no);
    classSlots.set(cs, (classSlots.get(cs) ?? 0) + 1);
    if ((classSlots.get(cs) ?? 0) > 1) add({ rule: 'class_double_booked', class_id: l.class_id, day: l.day, lesson_no: l.lesson_no });
    if (!teachers.has(l.teacher_id)) continue;
    const ts = key(l.teacher_id, l.day, l.lesson_no);
    teacherSlots.set(ts, (teacherSlots.get(ts) ?? 0) + 1);
    if ((teacherSlots.get(ts) ?? 0) > 1) {
      add({ rule: 'teacher_double_booked', teacher_id: l.teacher_id, day: l.day, lesson_no: l.lesson_no });
    }
  }

  // 11-13: teachers (one format per day, unavailable days, weekly limit).
  const teacherFormats = new Map<string, Set<boolean>>();
  const weekly = new Map<string, number>();
  for (const l of known) {
    const t = teachers.get(l.teacher_id);
    if (t === undefined) continue;
    weekly.set(t.id, (weekly.get(t.id) ?? 0) + 1);
    if (!schoolDays.has(l.day)) continue;
    if (t.unavailable_days.includes(l.day)) add({ rule: 'teacher_unavailable_day', teacher_id: t.id, day: l.day });
    if (!formats.has(key(l.class_id, l.day))) continue; // day_format_missing already reports it
    const k = key(t.id, l.day);
    const seen = teacherFormats.get(k) ?? new Set<boolean>();
    seen.add(isInPerson(formats, l.class_id, l.day));
    teacherFormats.set(k, seen);
  }
  for (const [k, seen] of teacherFormats) {
    if (seen.size > 1) {
      const [teacher_id = '', day = ''] = k.split('\u0000');
      add({ rule: 'teacher_mixed_format', teacher_id, day: Number(day) });
    }
  }
  for (const t of snapshot.teachers) {
    const n = weekly.get(t.id) ?? 0;
    if (n > t.weekly_limit) add({ rule: 'teacher_weekly_limit', teacher_id: t.id, value: n, limit: t.weekly_limit });
  }

  // 14-16: curriculum (rows are validated at the boundary: they only reference known ids).
  const perPair = new Map<string, number>();
  for (const l of known) {
    if (!subjects.has(l.subject_id)) continue;
    const pk = key(l.class_id, l.subject_id);
    const row = rows.get(pk);
    if (row === undefined) {
      add({ rule: 'lesson_not_in_plan', class_id: l.class_id, subject_id: l.subject_id });
      continue;
    }
    perPair.set(pk, (perPair.get(pk) ?? 0) + 1);
    if (teachers.has(l.teacher_id) && l.teacher_id !== row.teacher_id && !planTeacherExempt(l)) {
      add({ rule: 'teacher_not_in_plan', class_id: l.class_id, subject_id: l.subject_id, teacher_id: l.teacher_id });
    }
  }
  for (const r of snapshot.rows) {
    const n = perPair.get(key(r.class_id, r.subject_id)) ?? 0;
    if (n !== r.hours) add({ rule: 'plan_hours_mismatch', class_id: r.class_id, subject_id: r.subject_id, value: n, limit: r.hours });
  }

  // 17: capacity of every school day.
  const model = modelOf(input);
  const pair = modelCapacity(input);
  for (const d of snapshot.school_days) {
    const load = dayLoad({
      ...pair,
      staff: snapshot.staff,
      day: {
        classes: snapshot.classes.map((c) => ({ id: c.id, students: c.students, in_person: isInPerson(formats, c.id, d) })),
        lessons: daily.filter((l) => l.day === d),
      },
    });
    for (const [condition, c] of [['passport', load.conditions.passport], ['seats', load.conditions.seats]] as const) {
      if (c !== undefined && !c.ok) add({ rule: 'capacity_exceeded', day: d, condition, value: c.load, limit: c.limit });
    }
  }

  // 18: "not held in the shelter" — model 1.2 only: such lessons only on remote days.
  if (model === '1.2') {
    for (const l of daily) {
      if (subjects.get(l.subject_id)?.no_shelter === true && isInPerson(formats, l.class_id, l.day)) {
        add({ rule: 'no_shelter_in_person', class_id: l.class_id, subject_id: l.subject_id, day: l.day });
      }
    }
  }
  return out;
}

/**
 * Stage-2 extension point: a substitution lesson may be taught by a teacher outside the plan
 * ("не за фахом", spec §04). There are no substitutions in stage 1, so nothing is exempt.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the stage-2 hook takes the lesson
function planTeacherExempt(_lesson: Lesson): boolean {
  return false;
}
