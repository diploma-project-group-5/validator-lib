// JSONL batch mode (ADR 2026-11-09 §5), for bench and the solver's golden tests.
// In:  one {"case_id": "...", "input": ValidationInput} per line (blank lines are skipped).
// Out: one {"case_id", "line_no", ...ValidationOutcome} per input line, in input order.
// A broken line becomes INVALID_INPUT and processing continues. stdout carries no input values
// beyond case_id; stderr gets counts only.
import { validate, type ValidateOptions } from '../validate.js';
import type { ValidationOutcome } from '../domain/types.js';
import { CONTRACTS_VERSION } from '../generated/contracts-version.js';
import { VALIDATOR_VERSION } from '../version.js';

export const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_CASE_ID = 128;

export interface Counts {
  lines: number;
  accepted: number;
  rejected: number;
  invalid: number;
}

const meta = { validator_version: VALIDATOR_VERSION, contracts_version: CONTRACTS_VERSION, model: null };

function caseIdOf(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null || !('case_id' in parsed)) return null;
  const id = parsed.case_id;
  return typeof id === 'string' && id.length <= MAX_CASE_ID ? id : null;
}

export function outcomeOf(line: string, opts: ValidateOptions): { case_id: string | null; outcome: ValidationOutcome } {
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    return { case_id: null, outcome: { status: 'INVALID_INPUT', issues: [{ part: 'input', code: 'limit', path: '' }], meta } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Not JSON (or nested beyond the parser's limits): a broken line, not a crash.
    return { case_id: null, outcome: { status: 'INVALID_INPUT', issues: [{ part: 'input', code: 'schema', path: '' }], meta } };
  }
  const case_id = caseIdOf(parsed);
  const input = typeof parsed === 'object' && parsed !== null && 'input' in parsed ? parsed.input : undefined;
  return { case_id, outcome: validate(input, opts) };
}

export async function runLines(
  lines: AsyncIterable<string> | Iterable<string>,
  write: (line: string) => void,
  opts: ValidateOptions = {},
): Promise<Counts> {
  const counts: Counts = { lines: 0, accepted: 0, rejected: 0, invalid: 0 };
  let line_no = 0;
  for await (const raw of lines) {
    line_no += 1;
    if (raw.trim() === '') continue;
    counts.lines += 1;
    const { case_id, outcome } = outcomeOf(raw, opts);
    if (outcome.status === 'ACCEPTED') counts.accepted += 1;
    else if (outcome.status === 'REJECTED') counts.rejected += 1;
    else counts.invalid += 1;
    write(JSON.stringify({ case_id, line_no, ...outcome }));
  }
  return counts;
}

export interface CliArgs {
  readonly version: boolean;
  readonly failOnReject: boolean;
  readonly maxConflicts?: number;
}

export function parseArgs(argv: readonly string[]): CliArgs | string {
  let version = false;
  let failOnReject = false;
  let maxConflicts: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--version') version = true;
    else if (a === '--fail-on-reject') failOnReject = true;
    else if (a === '--max-conflicts') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 0) return '--max-conflicts needs a non-negative integer';
      maxConflicts = n;
      i += 1;
    } else return `unknown argument: ${String(a)}`;
  }
  return maxConflicts === undefined ? { version, failOnReject } : { version, failOnReject, maxConflicts };
}

export const versionLine = (): string =>
  JSON.stringify({ name: '@lad/validator-lib', validator_version: VALIDATOR_VERSION, contracts_version: CONTRACTS_VERSION });

/** 0 all processed; 1 --fail-on-reject and something was not ACCEPTED. */
export const exitCode = (counts: Counts, args: CliArgs): number =>
  args.failOnReject && counts.rejected + counts.invalid > 0 ? 1 : 0;
