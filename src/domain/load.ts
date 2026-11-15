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
//
// Without the quadratic search of 0.3.0 (0.3.1, the same report): the lessons are split by day and by class-day
// in one pass, the teacher groups of a day are found once in linear time, and the reason of each group is
// computed once for all its classes. Each group still costs one dayLoad (the one capacity formula, never a
// second incremental one), so a day costs O(groups x (classes + lessons)).
import { dayLoad } from './capacity.js';
import { formatsOf, isInPerson, key, modelCapacity, modelOf } from './rules.js';
import type { ClassDayLoad, Condition, FormatReason, Lesson, LoadReport, ValidationInput } from './types.js';

/** The lessons of known classes on one school day; `linking`: those of teachers known to the snapshot. */
interface DayLessons {
  readonly day: number;
  readonly lessons: Lesson[];
  readonly linking: Lesson[];
}

export function buildLoad(input: ValidationInput): LoadReport {
  const { snapshot, timetable } = input;
  const model = modelOf(input);
  const pair = modelCapacity(input);
  const formats = formatsOf(input);
  const subjects = new Map(snapshot.subjects.map((s) => [s.id, s]));
  const classIds = snapshot.classes.map((c) => c.id);
  const known = new Set(classIds);
  // The teachers that teacher_mixed_format looks at: a lesson of an unknown teacher links no classes.
  const teachers = new Set(snapshot.teachers.map((t) => t.id));

  // One pass over the lessons: by school day (school_days order; the boundary keeps the days unique) and by class-day.
  const byDay = new Map(snapshot.school_days.map((day): [number, DayLessons] => [day, { day, lessons: [], linking: [] }]));
  const own = new Map<string, Lesson[]>();
  for (const l of timetable.lessons) {
    const d = byDay.get(l.day);
    if (d === undefined || !known.has(l.class_id)) continue;
    d.lessons.push(l);
    if (teachers.has(l.teacher_id)) d.linking.push(l);
    const k = key(l.class_id, l.day);
    const list = own.get(k);
    if (list === undefined) own.set(k, [l]);
    else list.push(l);
  }
  const schoolDays = [...byDay.values()];

  /** Load of a day if the classes of `extra` came in person on top of the in-person ones. */
  const loadOf = (d: DayLessons, extra: ReadonlySet<string> = new Set()) =>
    dayLoad({
      ...pair,
      staff: snapshot.staff,
      day: {
        classes: snapshot.classes.map((c) => ({
          id: c.id,
          students: c.students,
          in_person: extra.has(c.id) || isInPerson(formats, c.id, d.day),
        })),
        lessons: d.lessons,
      },
    });

  /** Reason of a remote class-day with lessons, the same for its whole teacher group (rules 2-4 above). */
  const groupReason = (d: DayLessons, group: ReadonlySet<string>): FormatReason => {
    const noShelter = d.lessons.some((l) => group.has(l.class_id) && subjects.get(l.subject_id)?.no_shelter === true);
    if (model === '1.2' && noShelter) return 'no_shelter';
    return loadOf(d, group).ok ? 'capacity_available' : 'day_limit';
  };

  const days = schoolDays.map((d) => ({ day: d.day, ...loadOf(d) }));
  const explained = schoolDays.map((d) => {
    const { label, groups } = teacherGroups(classIds, d.linking);
    return { d, label, reasons: new Map(groups.map((g) => [g, groupReason(d, g)])) };
  });

  const class_days: ClassDayLoad[] = [];
  for (const c of snapshot.classes) {
    for (const { d, label, reasons } of explained) {
      const lessons = own.get(key(c.id, d.day)) ?? [];
      const in_person = isInPerson(formats, c.id, d.day);
      let reason: FormatReason;
      if (in_person) {
        const priorityLesson = lessons.some((l) => subjects.get(l.subject_id)?.priority_area === true);
        reason = c.priority || priorityLesson ? 'priority' : 'capacity_available';
      } else if (lessons.length === 0) {
        reason = 'no_lessons';
      } else {
        reason = must(reasons.get(must(label.get(c.id))));
      }
      class_days.push({ class_id: c.id, day: d.day, in_person, lessons: lessons.length, reason });
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

/**
 * Teacher groups of one day: `classIds` split into the classes linked by a teacher shared in `linking`,
 * transitively (breadth-first search). `label` gives each class its group. Exported for the tests only.
 */
export function teacherGroups(
  classIds: readonly string[],
  linking: readonly Lesson[],
): { label: ReadonlyMap<string, ReadonlySet<string>>; groups: readonly ReadonlySet<string>[] } {
  // Per class, the class sets of its teachers: one shared Set per teacher, so no teacher lookup in the search.
  const ofTeacher = new Map<string, Set<string>>();
  const classLinks = new Map<string, Set<ReadonlySet<string>>>();
  for (const l of linking) {
    let classes = ofTeacher.get(l.teacher_id);
    if (classes === undefined) {
      classes = new Set();
      ofTeacher.set(l.teacher_id, classes);
    }
    classes.add(l.class_id);
    let links = classLinks.get(l.class_id);
    if (links === undefined) {
      links = new Set();
      classLinks.set(l.class_id, links);
    }
    links.add(classes);
  }

  const label = new Map<string, ReadonlySet<string>>();
  const groups: ReadonlySet<string>[] = [];
  for (const start of classIds) {
    if (label.has(start)) continue;
    const group = new Set([start]);
    const queue = [start];
    for (const x of queue) {
      label.set(x, group);
      const links = classLinks.get(x);
      if (links !== undefined) {
        for (const classes of links) {
          for (const y of classes) {
            if (!group.has(y)) {
              group.add(y);
              queue.push(y);
            }
          }
        }
      }
    }
    groups.push(group);
  }
  return { label, groups };
}

function must<T>(value: T | undefined): T {
  // Stryker disable next-line all: unreachable, teacherGroups labels every class and buildLoad gives every group a reason
  if (value === undefined) throw new Error('a class without a teacher group or a group without a reason');
  return value;
}
