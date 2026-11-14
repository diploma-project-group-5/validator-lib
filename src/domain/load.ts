// Values for GET /timetables/{id}/load (spec §07): shelter load per day against the limits and a
// reason for each class-day format. Reasons explain; they never change the verdict.
//
// A remote day is never 'priority' (that reason explains in-person days only). It is explained by what would
// happen if the class came in person together with its teacher group: the classes linked to it that day by a
// shared teacher, transitively, because a teacher has one format per day (teacher_mixed_format).
//  1. no lessons that day                                  -> no_lessons
//  2. model 1.2 and a lesson of the group not in shelter   -> no_shelter
//  3. in-person classes + the group fit the day limits     -> capacity_available (room left, not used)
//  4. otherwise                                            -> day_limit
import { dayLoad } from './capacity.js';
import { formatsOf, isInPerson, modelCapacity, modelOf } from './rules.js';
import type { ClassDayLoad, Condition, FormatReason, Lesson, LoadReport, ValidationInput } from './types.js';

export function buildLoad(input: ValidationInput): LoadReport {
  const { snapshot, timetable } = input;
  const model = modelOf(input);
  const pair = modelCapacity(input);
  const formats = formatsOf(input);
  const subjects = new Map(snapshot.subjects.map((s) => [s.id, s]));
  const known = new Set(snapshot.classes.map((c) => c.id));
  const lessons = timetable.lessons.filter((l) => known.has(l.class_id));

  // The teachers that teacher_mixed_format looks at: a lesson of an unknown teacher links no classes.
  const teachers = new Set(snapshot.teachers.map((t) => t.id));
  const linking = lessons.filter((l) => teachers.has(l.teacher_id));

  /** Load of a day if the classes of `extra` came in person on top of the in-person ones. */
  const loadOf = (day: number, extra: ReadonlySet<string> = new Set()) =>
    dayLoad({
      ...pair,
      staff: snapshot.staff,
      day: {
        classes: snapshot.classes.map((c) => ({
          id: c.id,
          students: c.students,
          in_person: extra.has(c.id) || isInPerson(formats, c.id, day),
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
      } else {
        const group = teacherGroup(linking.filter((l) => l.day === day), c.id);
        const noShelter = lessons.some((l) => l.day === day && group.has(l.class_id) && subjects.get(l.subject_id)?.no_shelter === true);
        if (model === '1.2' && noShelter) reason = 'no_shelter';
        else reason = loadOf(day, group).ok ? 'capacity_available' : 'day_limit';
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

/** `classId` and the classes linked to it by a shared teacher in `dayLessons` (one day), transitively. */
function teacherGroup(dayLessons: readonly Lesson[], classId: string): ReadonlySet<string> {
  const group = new Set([classId]);
  const queue = [classId];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const current = next;
    const shared = new Set(dayLessons.filter((l) => l.class_id === current).map((l) => l.teacher_id));
    for (const l of dayLessons) {
      if (shared.has(l.teacher_id) && !group.has(l.class_id)) {
        group.add(l.class_id);
        queue.push(l.class_id);
      }
    }
  }
  return group;
}
