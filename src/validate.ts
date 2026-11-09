// The single entry point (ADR 2026-11-09 §3). Total on hostile input: any input yields an outcome;
// an exception means a bug in this library, never bad data.
import { parseInput } from './boundary/parse.js';
import { buildLoad } from './domain/load.js';
import { sortConflicts } from './domain/order.js';
import { checkRules, modelOf } from './domain/rules.js';
import type { Meta, Model, ValidationOutcome } from './domain/types.js';
import { CONTRACTS_VERSION } from './generated/contracts-version.js';
import { VALIDATOR_VERSION } from './version.js';

export interface ValidateOptions {
  /** Keep at most this many conflicts (after sorting); conflicts_total is always the full count. */
  readonly max_conflicts?: number;
}

const meta = (model: Model | null): Meta => ({
  validator_version: VALIDATOR_VERSION,
  contracts_version: CONTRACTS_VERSION,
  model,
});

export function validate(raw: unknown, opts: ValidateOptions = {}): ValidationOutcome {
  const cap = opts.max_conflicts;
  if (cap !== undefined && !(Number.isInteger(cap) && cap >= 0)) {
    // A caller bug, not bad data: an empty conflicts[] with a non-zero total would mislead the UI.
    throw new RangeError('max_conflicts must be a non-negative integer');
  }
  const parsed = parseInput(raw);
  if (!parsed.ok) return { status: 'INVALID_INPUT', issues: parsed.issues, meta: meta(null) };
  const input = parsed.value;
  const load = buildLoad(input);
  const all = sortConflicts(checkRules(input));
  const m = meta(modelOf(input));
  if (all.length === 0) return { status: 'ACCEPTED', conflicts: [], conflicts_total: 0, load, meta: m };
  const conflicts = cap === undefined ? all : all.slice(0, cap);
  return { status: 'REJECTED', conflicts, conflicts_total: all.length, load, meta: m };
}
