// The boundary: untrusted input -> ValidationInput or INVALID_INPUT issues (ADR 2026-11-09 §6).
// Shape comes from the contracts schemas (one source of truth); semantic snapshot invariants that a
// schema cannot express are checked here too. Issues carry JSON pointers, never input values.
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import type { InputIssue, IssuePart, ValidationInput } from '../domain/types.js';
import { conflictSchema, defsSchema, inputSchema } from '../generated/schemas.js';

const MAX_ISSUES = 20;

let compiled: ValidateFunction | undefined;
function validator(): ValidateFunction {
  if (compiled === undefined) {
    const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
    ajv.addSchema(defsSchema);
    ajv.addSchema(conflictSchema);
    compiled = ajv.compile(inputSchema);
  }
  return compiled;
}

export type Parsed = { readonly ok: true; readonly value: ValidationInput } | { readonly ok: false; readonly issues: InputIssue[] };

const partOf = (path: string): IssuePart =>
  path.startsWith('/snapshot') ? 'snapshot' : path.startsWith('/timetable') ? 'timetable' : 'input';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function schemaIssues(errors: readonly ErrorObject[]): InputIssue[] {
  const issues = new Map<string, InputIssue>();
  for (const e of errors) {
    // `if`/`then` and `oneOf` repeat the same failure several times: keep one issue per path + code.
    const path = e.instancePath;
    const code = e.keyword === 'maxItems' || e.keyword === 'maximum' ? 'limit' : 'schema';
    const issue: InputIssue = { part: partOf(path), code, path, keyword: e.keyword };
    issues.set(`${path}|${code}`, issue);
  }
  return [...issues.values()];
}

function snapshotIssues(input: ValidationInput): InputIssue[] {
  const { snapshot } = input;
  const issues: InputIssue[] = [];
  const unique = (list: readonly { id: string }[], name: string): Set<string> => {
    const seen = new Set<string>();
    list.forEach((item, i) => {
      if (seen.has(item.id)) issues.push({ part: 'snapshot', code: 'duplicate_id', path: `/snapshot/${name}/${String(i)}/id` });
      seen.add(item.id);
    });
    return seen;
  };
  const classes = unique(snapshot.classes, 'classes');
  const subjects = unique(snapshot.subjects, 'subjects');
  const teachers = unique(snapshot.teachers, 'teachers');
  const pairs = new Set<string>();
  snapshot.rows.forEach((r, i) => {
    const at = `/snapshot/rows/${String(i)}`;
    if (!classes.has(r.class_id)) issues.push({ part: 'snapshot', code: 'unknown_reference', path: `${at}/class_id` });
    if (!subjects.has(r.subject_id)) issues.push({ part: 'snapshot', code: 'unknown_reference', path: `${at}/subject_id` });
    if (!teachers.has(r.teacher_id)) issues.push({ part: 'snapshot', code: 'unknown_reference', path: `${at}/teacher_id` });
    const pair = `${r.class_id}\u0000${r.subject_id}`;
    // One teacher per class x subject in the MVP (no split groups): a second row is a broken snapshot.
    if (pairs.has(pair)) issues.push({ part: 'snapshot', code: 'duplicate_row', path: at });
    pairs.add(pair);
  });
  return issues;
}

/**
 * Invariants of the effective week (ADR 2026-11-09-validator-lib-substitution-check). Every mark carries its
 * cause, so a stray mark — in a :publish input or from a bug in building the week — cannot silently switch a
 * rule off: a substitute lesson and a self_study / cancelled slot need the plan teacher of that class and
 * subject absent in exactly that slot; a holiday slot needs its weekday in `holidays`.
 */
function weekIssues(input: ValidationInput): InputIssue[] {
  const { snapshot, timetable } = input;
  const issues: InputIssue[] = [];
  const at = (path: string, code: InputIssue['code']): void => {
    issues.push({ part: path.startsWith('/timetable') ? 'timetable' : 'input', code, path });
  };
  const k = (...parts: (string | number)[]): string => parts.join('\u0000');
  const L = snapshot.lessons_per_day;
  const schoolDays = new Set(snapshot.school_days);
  const teachers = new Set(snapshot.teachers.map((t) => t.id));
  const planTeacher = new Map(snapshot.rows.map((r) => [k(r.class_id, r.subject_id), r.teacher_id]));

  const absentSlots = new Set<string>();
  (input.absences ?? []).forEach((a, i) => {
    if (!teachers.has(a.teacher_id)) at(`/absences/${String(i)}/teacher_id`, 'unknown_reference');
    a.lesson_nos.forEach((no, j) => {
      if (no > L) at(`/absences/${String(i)}/lesson_nos/${String(j)}`, 'limit');
      absentSlots.add(k(a.teacher_id, a.day, no));
    });
  });
  const holidays = new Set(input.holidays ?? []);
  (input.holidays ?? []).forEach((d, i) => {
    if (schoolDays.has(d)) at(`/holidays/${String(i)}`, 'not_held_day');
  });
  /** The plan teacher is absent in this slot. Without a plan row the rules report lesson_not_in_plan instead. */
  const caused = (class_id: string, subject_id: string, day: number, no: number): boolean => {
    const t = planTeacher.get(k(class_id, subject_id));
    return t === undefined || absentSlots.has(k(t, day, no));
  };

  timetable.lessons.forEach((l, i) => {
    if (l.origin === 'substitution' && !caused(l.class_id, l.subject_id, l.day, l.lesson_no)) {
      at(`/timetable/lessons/${String(i)}/origin`, 'requires_absences');
    }
  });
  const slots = new Set<string>();
  (timetable.not_held ?? []).forEach((n, i) => {
    const path = `/timetable/not_held/${String(i)}`;
    if (n.lesson_no > L) at(`${path}/lesson_no`, 'limit');
    if (n.kind === 'holiday') {
      if (!holidays.has(n.day)) at(`${path}/day`, 'requires_holidays');
    } else if (!schoolDays.has(n.day)) {
      at(`${path}/day`, 'not_held_day');
    } else if (!caused(n.class_id, n.subject_id, n.day, n.lesson_no)) {
      at(path, 'requires_absences');
    }
    const slot = k(n.class_id, n.day, n.lesson_no);
    if (slots.has(slot)) at(path, 'duplicate_slot');
    slots.add(slot);
  });
  return issues;
}

export function parseInput(raw: unknown): Parsed {
  if (!isObject(raw)) return { ok: false, issues: [{ part: 'input', code: 'schema', path: '', keyword: 'type' }] };
  if (raw['schema_version'] !== '1.0') {
    return { ok: false, issues: [{ part: 'input', code: 'unsupported_version', path: '/schema_version' }] };
  }
  const snapshot = raw['snapshot'];
  if (isObject(snapshot) && isObject(snapshot['capacity'])) {
    const alert = snapshot['kind'] === 'alert';
    const hasSeats = 'seats' in snapshot['capacity'];
    if ((snapshot['kind'] === 'main' && hasSeats) || (alert && !hasSeats)) {
      return { ok: false, issues: [{ part: 'snapshot', code: 'kind_capacity_mismatch', path: '/snapshot/capacity' }] };
    }
  }
  const check = validator();
  if (!check(raw)) return { ok: false, issues: schemaIssues(check.errors ?? []).slice(0, MAX_ISSUES) };
  const value = raw as unknown as ValidationInput; // shape proven by the contracts schema above
  const issues = [...snapshotIssues(value), ...weekIssues(value)];
  return issues.length > 0 ? { ok: false, issues: issues.slice(0, MAX_ISSUES) } : { ok: true, value };
}
