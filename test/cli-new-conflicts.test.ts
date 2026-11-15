// JSONL batch mode for the substitution check (--mode new-conflicts): the solver's golden tests send
// every proposal through newConflicts here instead of re-implementing the rules (ADR 2026-11-15).
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkOf,
  exitCode,
  MAX_LINE_BYTES,
  parseArgs,
  runLines,
  runNewConflictLines,
  summaryLine,
} from '../src/cli/run.js';
import { newConflicts, SnapshotMismatchError } from '../src/compare.js';
import type { ValidationInput } from '../src/index.js';
import { sortConflicts } from '../src/domain/order.js';
import { meta } from '../src/validate.js';
import { input } from './support/school.js';

const require = createRequire(import.meta.url);
const APPROVE = join(dirname(require.resolve('@lad/contracts/package.json')), 'vectors', 'substitution-approve');
const vectors = readdirSync(APPROVE)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => ({ file: f, ...(JSON.parse(readFileSync(join(APPROVE, f), 'utf8')) as { baseline: unknown; effective: unknown; expected: { added: unknown[] } }) }));

/** The base school with t-1 absent from c-1's first lesson on day 1 and t-2 standing in. */
const covered = (): ValidationInput => {
  const base = input();
  return {
    ...base,
    timetable: {
      ...base.timetable,
      lessons: base.timetable.lessons.map((l) =>
        l.class_id === 'c-1' && l.day === 1 && l.lesson_no === 1 ? { ...l, teacher_id: 't-2', origin: 'substitution' as const } : l,
      ),
    },
    absences: [{ teacher_id: 't-1', day: 1, lesson_nos: [1] }],
  };
};

const line = (case_id: unknown, baseline: unknown, effective: unknown): string => JSON.stringify({ case_id, baseline, effective });

const run = async (lines: string[]) => {
  const raw: string[] = [];
  const counts = await runNewConflictLines(lines, (l) => raw.push(l));
  return { raw, out: raw.map((l) => JSON.parse(l) as Record<string, unknown>), counts };
};

describe('--mode new-conflicts: runNewConflictLines', () => {
  it('answers each case exactly as newConflicts does, plus case_id and line_no', async () => {
    const { raw } = await run([line('ok', input(), covered())]);
    expect(raw).toEqual([JSON.stringify({ case_id: 'ok', line_no: 1, ...newConflicts(input(), covered()) })]);
  });

  it('matches every contracts approve pair', async () => {
    expect(vectors.length).toBeGreaterThanOrEqual(6);
    const { out, counts } = await run(vectors.map((v) => line(v.file, v.baseline, v.effective)));
    expect(out.map((o) => [o['case_id'], o['status'], o['added']])).toEqual(
      vectors.map((v) => [v.file, 'CHECKED', sortConflicts(v.expected.added as never)]),
    );
    const withAdded = vectors.filter((v) => v.expected.added.length > 0).length;
    expect(withAdded).toBeGreaterThan(0);
    expect(counts).toEqual({ lines: vectors.length, accepted: vectors.length - withAdded, rejected: withAdded, invalid: 0 });
  });

  it('keeps input order and line numbers, skipping blank lines', async () => {
    const { out, counts } = await run([line('a', input(), covered()), '', '  ', line('b', input(), input())]);
    expect(out.map((o) => [o['case_id'], o['line_no'], o['status']])).toEqual([
      ['a', 1, 'CHECKED'],
      ['b', 4, 'CHECKED'],
    ]);
    expect(counts).toEqual({ lines: 2, accepted: 2, rejected: 0, invalid: 0 });
  });

  it('a broken line becomes INVALID_INPUT (no week) and processing continues', async () => {
    const { out, counts } = await run(['{not json', line('ok', input(), covered())]);
    expect(out[0]).toEqual({
      case_id: null,
      line_no: 1,
      status: 'INVALID_INPUT',
      issues: [{ part: 'input', code: 'schema', path: '' }],
      meta: meta(null),
    });
    expect(out[1]).toMatchObject({ case_id: 'ok', status: 'CHECKED', added: [] });
    expect(counts).toEqual({ lines: 2, accepted: 1, rejected: 0, invalid: 1 });
  });

  it('refuses an oversized line without parsing it; a line of exactly the limit is parsed', async () => {
    const { out } = await run(['x'.repeat(MAX_LINE_BYTES + 1), 'x'.repeat(MAX_LINE_BYTES)]);
    expect(out.map((o) => o['issues'])).toEqual([
      [{ part: 'input', code: 'limit', path: '' }],
      [{ part: 'input', code: 'schema', path: '' }],
    ]);
  });

  it('blames the broken week through newConflicts; a missing week is a broken one', async () => {
    const broken = { ...covered(), absences: undefined };
    const { out } = await run([
      JSON.stringify({ case_id: 'no-baseline', effective: covered() }),
      line('bad-effective', input(), broken),
      JSON.stringify({ case_id: 'no-effective', baseline: input() }),
      '[1]',
    ]);
    expect(out.map((o) => [o['case_id'], o['status'], o['week']])).toEqual([
      ['no-baseline', 'INVALID_INPUT', 'baseline'],
      ['bad-effective', 'INVALID_INPUT', 'effective'],
      ['no-effective', 'INVALID_INPUT', 'effective'],
      [null, 'INVALID_INPUT', 'baseline'],
    ]);
    expect(out[1]).toEqual({ case_id: 'bad-effective', line_no: 2, ...newConflicts(input(), broken) });
  });

  it('JSON that is not an object is a case without weeks: baseline is blamed first, no crash', async () => {
    const { out, counts } = await run(['null', '7', '"s"', '[1]']);
    expect(out.map((o) => [o['case_id'], o['status'], o['week']])).toEqual([
      [null, 'INVALID_INPUT', 'baseline'],
      [null, 'INVALID_INPUT', 'baseline'],
      [null, 'INVALID_INPUT', 'baseline'],
      [null, 'INVALID_INPUT', 'baseline'],
    ]);
    expect(counts.invalid).toBe(4);
  });

  it('two weeks on different snapshots: INVALID_INPUT for this case, not a crash', async () => {
    const other = covered();
    const moved = { ...other, snapshot: { ...other.snapshot, staff: other.snapshot.staff + 1 } };
    const { out, counts } = await run([line('mismatch', input(), moved), line('ok', input(), covered())]);
    expect(out[0]).toEqual({
      case_id: 'mismatch',
      line_no: 1,
      status: 'INVALID_INPUT',
      issues: [{ part: 'snapshot', code: 'schema', path: '/snapshot' }],
      meta: meta(null),
    });
    expect(out[1]).toMatchObject({ case_id: 'ok', status: 'CHECKED' });
    expect(counts.invalid).toBe(1);
  });

  it('never echoes input values in issues', async () => {
    const secret = 'Іваненко-Петро';
    const bad = { ...input(), snapshot: { ...input().snapshot, staff: secret } };
    const moved = { ...input(), snapshot: { ...input().snapshot, staff: 99, teachers: [] } };
    const { raw } = await run([line('a', bad, input()), line('b', input(), { ...moved, note: secret }), `{"x": "${secret}"`]);
    for (const l of raw) expect(l).not.toContain(secret);
  });

  it('keeps a case_id of up to 128 characters only, and only a string', async () => {
    const { out } = await run([line('x'.repeat(128), input(), input()), line('x'.repeat(129), input(), input()), line(7, input(), input())]);
    expect(out.map((o) => (typeof o['case_id'] === 'string' ? o['case_id'].length : o['case_id']))).toEqual([128, null, null]);
  });

  it('lets any other error escape: it is a bug, not bad data', () => {
    const boom = (): never => {
      throw new RangeError('boom');
    };
    expect(() => checkOf(line('a', input(), input()), boom)).toThrow('boom');
    const mismatch = (): never => {
      throw new SnapshotMismatchError();
    };
    expect(checkOf(line('a', input(), input()), mismatch)).toEqual({
      case_id: 'a',
      check: { status: 'INVALID_INPUT', issues: [{ part: 'snapshot', code: 'schema', path: '/snapshot' }], meta: meta(null) },
    });
  });
});

describe('SnapshotMismatchError', () => {
  it('is the RangeError newConflicts has always thrown', () => {
    const e = new SnapshotMismatchError();
    expect(e).toBeInstanceOf(RangeError);
    expect(e.name).toBe('RangeError');
    expect(e.message).toBe('baseline and effective must be checked against the same snapshot');
    const moved = { ...input(), snapshot: { ...input().snapshot, staff: 99 } };
    expect(() => newConflicts(input(), moved)).toThrow(SnapshotMismatchError);
  });
});

describe('--mode: arguments, exit codes and the summary', () => {
  it('parses --mode and leaves the default arguments unchanged', () => {
    expect(parseArgs([])).toEqual({ version: false, failOnReject: false });
    expect(parseArgs(['--mode', 'new-conflicts'])).toEqual({ version: false, failOnReject: false, mode: 'new-conflicts' });
    expect(parseArgs(['--mode', 'validate', '--max-conflicts', '2'])).toEqual({
      version: false,
      failOnReject: false,
      mode: 'validate',
      maxConflicts: 2,
    });
    expect(parseArgs(['--mode', 'new-conflicts', '--fail-on-reject'])).toEqual({ version: false, failOnReject: true, mode: 'new-conflicts' });
  });

  it('rejects a missing or unknown mode and --max-conflicts outside validate mode', () => {
    expect(parseArgs(['--mode'])).toBe('--mode needs one of: validate, new-conflicts');
    expect(parseArgs(['--mode', 'nope'])).toBe('--mode needs one of: validate, new-conflicts');
    expect(parseArgs(['--max-conflicts', '2', '--mode', 'new-conflicts'])).toBe('--max-conflicts applies to --mode validate only');
    expect(parseArgs(['--mode', 'new-conflicts', '--max-conflicts', '0'])).toBe('--max-conflicts applies to --mode validate only');
  });

  it('--mode consumes its value: the next flag is still parsed', () => {
    expect(parseArgs(['--mode', 'new-conflicts', '--version'])).toEqual({ version: true, failOnReject: false, mode: 'new-conflicts' });
  });

  it('--fail-on-reject fails on a case with new conflicts or an invalid one', () => {
    const args = { version: false, failOnReject: true, mode: 'new-conflicts' } as const;
    expect(exitCode({ lines: 2, accepted: 2, rejected: 0, invalid: 0 }, args)).toBe(0);
    expect(exitCode({ lines: 2, accepted: 1, rejected: 1, invalid: 0 }, args)).toBe(1);
    expect(exitCode({ lines: 2, accepted: 1, rejected: 0, invalid: 1 }, args)).toBe(1);
  });

  it('summarises counts per mode; the validate wording is unchanged', () => {
    const counts = { lines: 4, accepted: 1, rejected: 2, invalid: 1 };
    expect(summaryLine(counts, undefined)).toBe('lad-validate: 4 cases, 1 accepted, 2 rejected, 1 invalid');
    expect(summaryLine(counts, 'validate')).toBe('lad-validate: 4 cases, 1 accepted, 2 rejected, 1 invalid');
    expect(summaryLine(counts, 'new-conflicts')).toBe('lad-validate: 4 cases, 1 without new conflicts, 2 with new conflicts, 1 invalid');
  });

  it('the default mode answers JSON that is not an object with INVALID_INPUT, no crash', async () => {
    const out: string[] = [];
    await runLines(['null', '7', '"s"'], (l) => out.push(l));
    expect(out.map((l) => JSON.parse(l) as Record<string, unknown>).map((o) => [o['case_id'], o['status']])).toEqual([
      [null, 'INVALID_INPUT'],
      [null, 'INVALID_INPUT'],
      [null, 'INVALID_INPUT'],
    ]);
  });

  it('the default mode still validates timetables', async () => {
    const out: string[] = [];
    await runLines([JSON.stringify({ case_id: 'v', input: input() })], (l) => out.push(l));
    expect(JSON.parse(out[0] ?? '{}')).toMatchObject({ case_id: 'v', line_no: 1, status: 'ACCEPTED' });
  });
});
