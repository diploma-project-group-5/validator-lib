// What a substitution adds (ADR 2026-11-09-validator-lib-substitution-check, :approve). timetable validates
// the week without the proposal (baseline) and with it (effective) in one call. A conflict is new if it is
// not in the baseline — every field equal, values included — or if more violations stand behind it than
// before: the outcome reports a place once, so a second lesson on a teacher's unavailable day would
// otherwise look like the conflict the week already had.
import { parseInput } from './boundary/parse.js';
import type { Conflict, InputIssue, Meta } from './domain/types.js';
import { meta, outcomeOf, type CheckedOutcome } from './validate.js';

export type SubstitutionCheck =
  | {
      readonly status: 'INVALID_INPUT';
      readonly week: 'baseline' | 'effective';
      readonly issues: readonly InputIssue[];
      readonly meta: Meta;
    }
  | {
      readonly status: 'CHECKED';
      /** Conflicts the proposal adds or worsens, in outcome order; empty = the proposal may be approved. */
      readonly added: readonly Conflict[];
      /** Problems the week already had on the fresh snapshot: show them as warnings. */
      readonly baseline: CheckedOutcome;
      readonly effective: CheckedOutcome;
    };

/**
 * Thrown by newConflicts for two weeks on different snapshots (or models): a caller bug, not bad data. A
 * RangeError with the same name and message as before 0.4.0; the CLI batch mode tells it apart from a bug of its
 * own by this class.
 */
export class SnapshotMismatchError extends RangeError {
  constructor() {
    // The name stays RangeError: callers that matched the error before 0.4.0 see the same one.
    super('baseline and effective must be checked against the same snapshot');
  }
}

export function newConflicts(baselineRaw: unknown, effectiveRaw: unknown): SubstitutionCheck {
  const b = parseInput(baselineRaw);
  if (!b.ok) return { status: 'INVALID_INPUT', week: 'baseline', issues: b.issues, meta: meta(null) };
  const e = parseInput(effectiveRaw);
  if (!e.ok) return { status: 'INVALID_INPUT', week: 'effective', issues: e.issues, meta: meta(null) };
  if (JSON.stringify(b.value.snapshot) !== JSON.stringify(e.value.snapshot)) {
    // A caller bug: two weeks on different snapshots (or models) are not comparable.
    throw new SnapshotMismatchError();
  }
  const before = outcomeOf(b.value);
  const after = outcomeOf(e.value);
  // Conflicts with a value (capacity, weekly limit, plan hours) are compared by place: new only if worse, so a
  // substitution that eases a load the stale week already exceeded is not blocked.
  const worstBefore = new Map<string, number>();
  // Every baseline conflict is recorded; only measured ones are ever looked up (a rule never shares a place).
  for (const c of before.outcome.conflicts) worstBefore.set(place(c), severity(c));
  const added = after.outcome.conflicts.filter((c) => {
    if (measured(c)) {
      const was = worstBefore.get(place(c));
      return was === undefined || severity(c) > was;
    }
    const k = JSON.stringify(c);
    return (after.counts.get(k) ?? 0) > (before.counts.get(k) ?? 0);
  });
  return { status: 'CHECKED', added, baseline: before.outcome, effective: after.outcome };
}

const measured = (c: Conflict): boolean => c.value !== undefined;

/** The conflict without its measured value: rule, location and limit. */
const place = (c: Conflict): string => JSON.stringify({ ...c, value: null });

/**
 * How far a measured conflict is from its limit. Plan hours can miss in either direction; capacity
 * and the weekly limit only exceed it, so for them this is the excess (same place -> same limit).
 */
const severity = (c: Conflict): number => Math.abs((c.value ?? 0) - (c.limit ?? 0));
