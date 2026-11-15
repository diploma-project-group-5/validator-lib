// An independent oracle for teacher groups: union-find (the library uses a breadth-first search).
import type { Lesson } from '../../src/index.js';

/** The classes of `classIds` linked to `class_id` by a teacher shared in `linking`, transitively. */
export function linkedClasses(linking: readonly Lesson[], classIds: readonly string[], class_id: string): Set<string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    return p === x ? x : find(p);
  };
  const byTeacher = new Map<string, string>();
  for (const l of linking) {
    const other = byTeacher.get(l.teacher_id);
    if (other === undefined) byTeacher.set(l.teacher_id, l.class_id);
    else parent.set(find(l.class_id), find(other));
  }
  return new Set(classIds.filter((id) => find(id) === find(class_id)));
}
