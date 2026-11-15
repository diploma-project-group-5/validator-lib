// JSONL batch modes (ADR 2026-11-09 §5), for bench and the solver's golden tests. Blank lines are skipped;
// every other input line gets one output line, in input order.
// --mode validate (default):
//   In:  {"case_id": "...", "input": ValidationInput}
//   Out: {"case_id", "line_no", ...ValidationOutcome}
// --mode new-conflicts (the substitution check of :approve, ADR 2026-11-09-validator-lib-substitution-check):
//   In:  {"case_id": "...", "baseline": ValidationInput, "effective": ValidationInput}
//   Out: {"case_id", "line_no", ...SubstitutionCheck}
// A broken line becomes INVALID_INPUT and processing continues. stdout carries no input values
// beyond case_id; stderr gets counts only.
import { newConflicts, SnapshotMismatchError, type SubstitutionCheck } from '../compare.js';
import { validate, type ValidateOptions } from '../validate.js';
import type { InputIssue, Meta, ValidationOutcome } from '../domain/types.js';
import { CONTRACTS_VERSION } from '../generated/contracts-version.js';
import { VALIDATOR_VERSION } from '../version.js';

export const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_CASE_ID = 128;

/** In --mode new-conflicts, accepted = CHECKED with nothing added, rejected = CHECKED with added conflicts. */
export interface Counts {
  lines: number;
  accepted: number;
  rejected: number;
  invalid: number;
}

const meta: Meta = { validator_version: VALIDATOR_VERSION, contracts_version: CONTRACTS_VERSION, model: null };

/** A line that is not a case at all: too big or not JSON. */
const brokenLine = (issue: InputIssue) => ({ status: 'INVALID_INPUT', issues: [issue], meta }) as const;

type Line = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly issue: InputIssue };

function parseLine(line: string): Line {
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) return { ok: false, issue: { part: 'input', code: 'limit', path: '' } };
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch {
    // Not JSON (or nested beyond the parser's limits): a broken line, not a crash.
    return { ok: false, issue: { part: 'input', code: 'schema', path: '' } };
  }
}

/** A top-level field of a parsed line; undefined if absent or the line is no object (JSON.parse never gives undefined). */
const field = (parsed: unknown, key: 'case_id' | 'input' | 'baseline' | 'effective'): unknown =>
  (parsed as Record<string, unknown> | null)?.[key];

function caseIdOf(parsed: unknown): string | null {
  const id = field(parsed, 'case_id');
  return typeof id === 'string' && id.length <= MAX_CASE_ID ? id : null;
}

export function outcomeOf(line: string, opts: ValidateOptions): { case_id: string | null; outcome: ValidationOutcome } {
  const parsed = parseLine(line);
  if (!parsed.ok) return { case_id: null, outcome: brokenLine(parsed.issue) };
  return { case_id: caseIdOf(parsed.value), outcome: validate(field(parsed.value, 'input'), opts) };
}

/** What --mode new-conflicts answers for one line: newConflicts' result, or a broken case (which has no week). */
export type NewConflictsLine = SubstitutionCheck | ReturnType<typeof brokenLine>;

/**
 * Two weeks on different snapshots: neither week alone is broken, the pair is — so no `week`. The contracts issue
 * codes have no dedicated one; `schema` at /snapshot is the closest (README, CLI).
 */
const mismatch = brokenLine({ part: 'snapshot', code: 'schema', path: '/snapshot' });

export function checkOf(line: string, check: typeof newConflicts = newConflicts): { case_id: string | null; check: NewConflictsLine } {
  const parsed = parseLine(line);
  if (!parsed.ok) return { case_id: null, check: brokenLine(parsed.issue) };
  const case_id = caseIdOf(parsed.value);
  try {
    return { case_id, check: check(field(parsed.value, 'baseline'), field(parsed.value, 'effective')) };
  } catch (error) {
    if (error instanceof SnapshotMismatchError) return { case_id, check: mismatch };
    throw error; // anything else is a bug here, not bad data
  }
}

type Verdict = Exclude<keyof Counts, 'lines'>;

async function runEach(
  lines: AsyncIterable<string> | Iterable<string>,
  write: (line: string) => void,
  answer: (line: string) => { readonly case_id: string | null; readonly verdict: Verdict; readonly body: object },
): Promise<Counts> {
  const counts: Counts = { lines: 0, accepted: 0, rejected: 0, invalid: 0 };
  let line_no = 0;
  for await (const raw of lines) {
    line_no += 1;
    if (raw.trim() === '') continue;
    counts.lines += 1;
    const { case_id, verdict, body } = answer(raw);
    counts[verdict] += 1;
    write(JSON.stringify({ case_id, line_no, ...body }));
  }
  return counts;
}

const VERDICT = { ACCEPTED: 'accepted', REJECTED: 'rejected', INVALID_INPUT: 'invalid' } as const;

export const runLines = (
  lines: AsyncIterable<string> | Iterable<string>,
  write: (line: string) => void,
  opts: ValidateOptions = {},
): Promise<Counts> =>
  runEach(lines, write, (raw) => {
    const { case_id, outcome } = outcomeOf(raw, opts);
    return { case_id, verdict: VERDICT[outcome.status], body: outcome };
  });

export const runNewConflictLines = (lines: AsyncIterable<string> | Iterable<string>, write: (line: string) => void): Promise<Counts> =>
  runEach(lines, write, (raw) => {
    const { case_id, check } = checkOf(raw);
    const verdict = check.status === 'INVALID_INPUT' ? 'invalid' : check.added.length > 0 ? 'rejected' : 'accepted';
    return { case_id, verdict, body: check };
  });

export const MODES = ['validate', 'new-conflicts'] as const;
export type Mode = (typeof MODES)[number];

export interface CliArgs {
  readonly version: boolean;
  readonly failOnReject: boolean;
  /** Absent: validate. */
  readonly mode?: Mode;
  readonly maxConflicts?: number;
}

const isMode = (a: string | undefined): a is Mode => MODES.some((m) => m === a);

export function parseArgs(argv: readonly string[]): CliArgs | string {
  let version = false;
  let failOnReject = false;
  let mode: Mode | undefined;
  let maxConflicts: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--version') version = true;
    else if (a === '--fail-on-reject') failOnReject = true;
    else if (a === '--mode') {
      const m = argv[i + 1];
      if (!isMode(m)) return `--mode needs one of: ${MODES.join(', ')}`;
      mode = m;
      i += 1;
    } else if (a === '--max-conflicts') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 0) return '--max-conflicts needs a non-negative integer';
      maxConflicts = n;
      i += 1;
    } else return `unknown argument: ${String(a)}`;
  }
  if (mode === 'new-conflicts' && maxConflicts !== undefined) return '--max-conflicts applies to --mode validate only';
  return {
    version,
    failOnReject,
    ...(mode === undefined ? {} : { mode }),
    ...(maxConflicts === undefined ? {} : { maxConflicts }),
  };
}

export const versionLine = (): string =>
  JSON.stringify({ name: '@lad/validator-lib', validator_version: VALIDATOR_VERSION, contracts_version: CONTRACTS_VERSION });

/** The stderr line: counts only, never input values. */
export const summaryLine = (counts: Counts, mode: Mode | undefined): string => {
  const [ok, bad] = mode === 'new-conflicts' ? ['without new conflicts', 'with new conflicts'] : ['accepted', 'rejected'];
  return (
    `lad-validate: ${String(counts.lines)} cases, ${String(counts.accepted)} ${ok}, ` +
    `${String(counts.rejected)} ${bad}, ${String(counts.invalid)} invalid`
  );
};

/** 0 all processed; 1 --fail-on-reject and something was not ACCEPTED (new-conflicts: added something or invalid). */
export const exitCode = (counts: Counts, args: CliArgs): number =>
  args.failOnReject && counts.rejected + counts.invalid > 0 ? 1 : 0;
