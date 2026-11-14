// JSONL batch mode used by bench and the solver golden tests (ADR 2026-11-09 §5).
import { describe, expect, it } from 'vitest';

import { exitCode, MAX_LINE_BYTES, parseArgs, runLines, versionLine } from '../src/cli/run.js';
import { VALIDATOR_VERSION } from '../src/version.js';
import { input } from './support/school.js';

const run = async (lines: string[], opts = {}) => {
  const out: Record<string, unknown>[] = [];
  const counts = await runLines(lines, (l) => out.push(JSON.parse(l) as Record<string, unknown>), opts);
  return { out, counts };
};

describe('runLines', () => {
  it('answers every line in order, keeping case_id and line numbers, skipping blanks', async () => {
    const ok = JSON.stringify({ case_id: 'a', input: input() });
    const bad = JSON.stringify({ case_id: 'b', input: input({ snapshot: { capacity: { passport: 10 } } }) });
    const { out, counts } = await run([ok, '', bad]);
    expect(out.map((o) => [o['case_id'], o['line_no'], o['status']])).toEqual([
      ['a', 1, 'ACCEPTED'],
      ['b', 3, 'REJECTED'],
    ]);
    expect(counts).toEqual({ lines: 2, accepted: 1, rejected: 1, invalid: 0 });
  });

  it('a broken line becomes INVALID_INPUT and processing continues', async () => {
    const { out, counts } = await run(['{not json', JSON.stringify({ case_id: 'x' }), JSON.stringify({ case_id: 'ok', input: input() })]);
    expect(out.map((o) => o['status'])).toEqual(['INVALID_INPUT', 'INVALID_INPUT', 'ACCEPTED']);
    expect(out[0]?.['case_id']).toBeNull();
    expect(out[1]?.['case_id']).toBe('x');
    expect(counts.invalid).toBe(2);
  });

  it('refuses oversized lines without parsing them', async () => {
    const { out } = await run(['x'.repeat(MAX_LINE_BYTES + 1)]);
    expect(out[0]).toMatchObject({ status: 'INVALID_INPUT', issues: [{ part: 'input', code: 'limit', path: '' }] });
  });

  it('ignores an over-long or non-string case_id', async () => {
    const { out } = await run([JSON.stringify({ case_id: 'x'.repeat(200), input: input() }), JSON.stringify({ case_id: 7, input: input() })]);
    expect(out.map((o) => o['case_id'])).toEqual([null, null]);
  });

  it('passes max_conflicts through', async () => {
    const line = JSON.stringify({ case_id: 'c', input: input({ snapshot: { capacity: { passport: 10 } } }) });
    const { out } = await run([line], { max_conflicts: 1 });
    expect((out[0]?.['conflicts'] as unknown[]).length).toBe(1);
    expect(out[0]?.['conflicts_total']).toBeGreaterThan(1);
  });
});

describe('arguments and exit codes', () => {
  it('parses flags and rejects unknown ones', () => {
    expect(parseArgs([])).toEqual({ version: false, failOnReject: false });
    expect(parseArgs(['--fail-on-reject', '--max-conflicts', '5'])).toEqual({ version: false, failOnReject: true, maxConflicts: 5 });
    expect(parseArgs(['--max-conflicts', '-1'])).toMatch(/non-negative/);
    expect(parseArgs(['--nope'])).toMatch(/unknown argument/);
    expect(parseArgs(['--version'])).toMatchObject({ version: true });
  });

  it('exit 1 only with --fail-on-reject and a non-accepted case', () => {
    const counts = { lines: 2, accepted: 1, rejected: 1, invalid: 0 };
    expect(exitCode(counts, { version: false, failOnReject: false })).toBe(0);
    expect(exitCode(counts, { version: false, failOnReject: true })).toBe(1);
    expect(exitCode({ ...counts, rejected: 0, accepted: 2 }, { version: false, failOnReject: true })).toBe(0);
  });

  it('--version prints both versions', () => {
    expect(JSON.parse(versionLine())).toEqual({
      name: '@lad/validator-lib',
      validator_version: VALIDATOR_VERSION,
      contracts_version: expect.any(String) as unknown,
    });
  });
});

// Limits and edge cases at their exact boundary: found by mutation testing.
describe('JSONL edge cases', () => {
  it('a line that is not JSON gets exactly one input:schema issue', async () => {
    const { out } = await run(['{not json']);
    expect(out[0]?.['issues']).toEqual([{ part: 'input', code: 'schema', path: '' }]);
  });

  it('keeps a case_id of exactly 128 characters and drops 129', async () => {
    const at = (n: number) => JSON.stringify({ case_id: 'x'.repeat(n), input: input() });
    const { out } = await run([at(128), at(129)]);
    expect(out.map((o) => (typeof o['case_id'] === 'string' ? o['case_id'].length : null))).toEqual([128, null]);
  });

  it('a line of exactly MAX_LINE_BYTES is parsed, not refused by size', async () => {
    const { out } = await run(['x'.repeat(MAX_LINE_BYTES)]);
    expect(out[0]?.['issues']).toEqual([{ part: 'input', code: 'schema', path: '' }]);
  });

  it('skips a whitespace-only line but keeps counting line numbers', async () => {
    const { out, counts } = await run(['   ', JSON.stringify({ case_id: 'a', input: input() })]);
    expect(out.map((o) => o['line_no'])).toEqual([2]);
    expect(counts.lines).toBe(1);
  });

  it('accepts --max-conflicts 0', () => {
    expect(parseArgs(['--max-conflicts', '0'])).toEqual({ version: false, failOnReject: false, maxConflicts: 0 });
  });

  it('--fail-on-reject also fails when the only problem is an invalid line', () => {
    expect(exitCode({ lines: 1, accepted: 0, rejected: 0, invalid: 1 }, { version: false, failOnReject: true })).toBe(1);
  });
});
