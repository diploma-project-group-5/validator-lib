#!/usr/bin/env node
// lad-validate [--fail-on-reject] [--max-conflicts N] < in.jsonl > out.jsonl
// lad-validate --version
// Exit codes: 0 processed; 1 --fail-on-reject and a case was not ACCEPTED; 2 usage error; 3 I/O or internal error.
import { createInterface } from 'node:readline';

import { exitCode, parseArgs, runLines, versionLine } from './run.js';

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === 'string') {
    process.stderr.write(`lad-validate: ${args}\n`);
    return 2;
  }
  if (args.version) {
    process.stdout.write(`${versionLine()}\n`);
    return 0;
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const opts = args.maxConflicts === undefined ? {} : { max_conflicts: args.maxConflicts };
  const counts = await runLines(lines, (line) => process.stdout.write(`${line}\n`), opts);
  process.stderr.write(
    `lad-validate: ${String(counts.lines)} cases, ${String(counts.accepted)} accepted, ` +
      `${String(counts.rejected)} rejected, ${String(counts.invalid)} invalid\n`,
  );
  return exitCode(counts, args);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // An internal error: report its class only, never the data that triggered it.
    process.stderr.write(`lad-validate: internal error (${error instanceof Error ? error.name : 'unknown'})\n`);
    process.exitCode = 3;
  },
);
