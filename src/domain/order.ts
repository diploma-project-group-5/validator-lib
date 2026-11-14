// Total, locale-free order of conflicts: registry index, then day, class, teacher, subject,
// lesson number, condition. A missing field sorts first. Same input -> identical output bytes.
import { RULES } from './rules.js';
import type { Conflict } from './types.js';

const rank = new Map(RULES.map((r, i) => [r, i]));

const cmpNum = (a: number | undefined, b: number | undefined): number =>
  a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a - b;
const cmpStr = (a: string | undefined, b: string | undefined): number =>
  // Stryker disable next-line EqualityOperator: a === b is answered first, so a <= b equals a < b here
  a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1;

export function compareConflicts(a: Conflict, b: Conflict): number {
  return (
    (rank.get(a.rule) ?? 0) - (rank.get(b.rule) ?? 0) ||
    cmpNum(a.day, b.day) ||
    cmpStr(a.class_id, b.class_id) ||
    cmpStr(a.teacher_id, b.teacher_id) ||
    cmpStr(a.subject_id, b.subject_id) ||
    cmpNum(a.lesson_no, b.lesson_no) ||
    cmpStr(a.condition, b.condition)
  );
}

export const sortConflicts = (conflicts: readonly Conflict[]): Conflict[] => [...conflicts].sort(compareConflicts);
