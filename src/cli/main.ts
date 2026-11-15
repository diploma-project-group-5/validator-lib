#!/usr/bin/env node
// lad-validate [--mode validate] [--fail-on-reject] [--max-conflicts N] < in.jsonl > out.jsonl
// lad-validate --mode new-conflicts [--fail-on-reject] < in.jsonl > out.jsonl
// lad-validate --version
// Exit codes: 0 processed; 1 --fail-on-reject and a case was not ACCEPTED (new-conflicts: added a conflict or was
// invalid); 2 usage error; 3 I/O or internal error.
import { createInterface } from 'node:readline';

import { exitCode, parseArgs, runLines, runNewConflictLines, summaryLine, versionLine } from './run.js';

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
  const write = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  const opts = args.maxConflicts === undefined ? {} : { max_conflicts: args.maxConflicts };
  const counts = args.mode === 'new-conflicts' ? await runNewConflictLines(lines, write) : await runLines(lines, write, opts);
  process.stderr.write(`${summaryLine(counts, args.mode)}\n`);
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
