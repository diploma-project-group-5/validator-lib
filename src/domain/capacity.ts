// The capacity formula (spec §04): one function for the verdict, for /load and for the shared
// contracts vectors, whose `expected` has exactly this shape.
//  1.1: students of in-person classes + non-teaching staff + teachers on site <= passport
//  1.2: (1) students of in-person classes <= seats AND (2) everyone (as in 1.1) <= passport
// A teacher is on site if they teach at least one lesson of an in-person class that day,
// counted once however many such lessons they have. Remote classes bring neither students nor teachers.
import type { CapacityAlert, Cond, DayLoad, DayLoadInput } from './types.js';

const cond = (load: number, limit: number): Cond => ({ load, limit, ok: load <= limit });

export function dayLoad(v: DayLoadInput): DayLoad {
  const inPerson = new Set<string>();
  let students = 0;
  for (const c of v.day.classes) {
    if (c.in_person) {
      inPerson.add(c.id);
      students += c.students;
    }
  }
  const teachers = new Set<string>();
  for (const l of v.day.lessons) {
    if (inPerson.has(l.class_id)) teachers.add(l.teacher_id);
  }
  const passport = cond(students + v.staff + teachers.size, v.capacity.passport);
  let seats: Cond | undefined;
  if (v.model === '1.2') {
    // The type forbids it; a JS caller can still pass it. Never skip the seats condition silently.
    if (typeof (v.capacity as Partial<CapacityAlert>).seats !== 'number') throw new TypeError('model 1.2 needs capacity.seats');
    seats = cond(students, v.capacity.seats);
  }
  return {
    students_in_person: students,
    teachers_on_site: teachers.size,
    conditions: seats === undefined ? { passport } : { passport, seats },
    ok: passport.ok && (seats?.ok ?? true),
  };
}
