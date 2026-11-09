// The single entry point (ADR 2026-11-09 §3). Total on hostile input: any input yields an outcome;
// an exception means a bug in this library, never bad data.
import { parseInput } from './boundary/parse.js';
import { buildLoad } from './domain/load.js';
import { sortConflicts } from './domain/order.js';
import { evaluate, modelOf } from './domain/rules.js';
import type { Conflict, Meta, Model, ValidationInput, ValidationOutcome } from './domain/types.js';
import { CONTRACTS_VERSION } from './generated/contracts-version.js';
import { VALIDATOR_VERSION } from './version.js';

export interface ValidateOptions {
  /** Keep at most this many conflicts (after sorting); conflicts_total is always the full count. */
  readonly max_conflicts?: number;
}

export type CheckedOutcome = Exclude<ValidationOutcome, { readonly status: 'INVALID_INPUT' }>;

export const meta = (model: Model | null): Meta => ({
  validator_version: VALIDATOR_VERSION,
  contracts_version: CONTRACTS_VERSION,
  model,
});

/** The full outcome of an input that passed the boundary, plus the violation count behind each conflict. */
export function outcomeOf(input: ValidationInput): { outcome: CheckedOutcome; counts: Map<string, number> } {
  const load = buildLoad(input);
  const { conflicts, counts } = evaluate(input);
  const all: Conflict[] = sortConflicts(conflicts);
  const m = meta(modelOf(input));
  const outcome: CheckedOutcome =
    all.length === 0
      ? { status: 'ACCEPTED', conflicts: [], conflicts_total: 0, load, meta: m }
      : { status: 'REJECTED', conflicts: all, conflicts_total: all.length, load, meta: m };
  return { outcome, counts };
}

export function validate(raw: unknown, opts: ValidateOptions = {}): ValidationOutcome {
  const cap = opts.max_conflicts;
  if (cap !== undefined && !(Number.isInteger(cap) && cap >= 0)) {
    // A caller bug, not bad data: an empty conflicts[] with a non-zero total would mislead the UI.
    throw new RangeError('max_conflicts must be a non-negative integer');
  }
  const parsed = parseInput(raw);
  if (!parsed.ok) return { status: 'INVALID_INPUT', issues: parsed.issues, meta: meta(null) };
  const { outcome } = outcomeOf(parsed.value);
  if (outcome.status === 'ACCEPTED' || cap === undefined) return outcome;
  return { ...outcome, conflicts: outcome.conflicts.slice(0, cap) };
}
