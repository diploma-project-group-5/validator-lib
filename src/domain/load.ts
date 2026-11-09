// Values for GET /timetables/{id}/load (spec §07): shelter load per day against the limits and a
// reason for each class-day format. Reasons explain; they never change the verdict.
import { dayLoad } from './capacity.js';
import { formatsOf, isInPerson, modelCapacity, modelOf } from './rules.js';
import type { ClassDayLoad, Condition, FormatReason, LoadReport, ValidationInput } from './types.js';

export function buildLoad(input: ValidationInput): LoadReport {
  const { snapshot, timetable } = input;
  const model = modelOf(input);
  const pair = modelCapacity(input);
  const formats = formatsOf(input);
  const subjects = new Map(snapshot.subjects.map((s) => [s.id, s]));
  const known = new Set(snapshot.classes.map((c) => c.id));
  const lessons = timetable.lessons.filter((l) => known.has(l.class_id));

  const loadOf = (day: number, flip?: string) =>
    dayLoad({
      ...pair,
      staff: snapshot.staff,
      day: {
        classes: snapshot.classes.map((c) => ({
          id: c.id,
          students: c.students,
          in_person: c.id === flip ? true : isInPerson(formats, c.id, day),
        })),
        lessons: lessons.filter((l) => l.day === day),
      },
    });

  const days = snapshot.school_days.map((day) => ({ day, ...loadOf(day) }));

  const class_days: ClassDayLoad[] = [];
  for (const c of snapshot.classes) {
    for (const day of snapshot.school_days) {
      const own = lessons.filter((l) => l.class_id === c.id && l.day === day);
      const in_person = isInPerson(formats, c.id, day);
      let reason: FormatReason;
      if (in_person) {
        const priorityLesson = own.some((l) => subjects.get(l.subject_id)?.priority_area === true);
        reason = c.priority || priorityLesson ? 'priority' : 'capacity_available';
      } else if (own.length === 0) {
        reason = 'no_lessons';
      } else if (model === '1.2' && own.some((l) => subjects.get(l.subject_id)?.no_shelter === true)) {
        reason = 'no_shelter';
      } else {
        reason = loadOf(day, c.id).ok ? 'priority' : 'day_limit';
      }
      class_days.push({ class_id: c.id, day, in_person, lessons: own.length, reason });
    }
  }

  const peak: { condition: Condition; day: number; load: number; limit: number }[] = [];
  for (const condition of ['passport', 'seats'] as const) {
    let best: { condition: Condition; day: number; load: number; limit: number } | undefined;
    for (const d of days) {
      const c = d.conditions[condition];
      if (c !== undefined && (best === undefined || c.load > best.load)) {
        best = { condition, day: d.day, load: c.load, limit: c.limit };
      }
    }
    if (best !== undefined) peak.push(best);
  }

  const withInPerson = new Set(class_days.filter((cd) => cd.in_person).map((cd) => cd.class_id));
  return {
    days,
    class_days,
    summary: {
      remote_class_days: class_days.filter((cd) => !cd.in_person).length,
      peak,
      classes_without_in_person_days: snapshot.classes.map((c) => c.id).filter((id) => !withInPerson.has(id)),
    },
  };
}
