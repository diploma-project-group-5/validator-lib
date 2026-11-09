// Outcome schema check shared by tests: every outcome must conform to contracts validation.outcome.v1.
import { readFileSync } from 'node:fs';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { expect } from 'vitest';

import type { ValidationOutcome } from '../../src/index.js';

const SCHEMAS = new URL('../../src/generated/schemas/', import.meta.url);
const load = (p: string): object => JSON.parse(readFileSync(new URL(p, SCHEMAS), 'utf8')) as object;
const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
ajv.addSchema(load('events/defs.v1.json'));
ajv.addSchema(load('events/conflict.v1.json'));
const outcomeSchema = ajv.compile(load('validator/validation.outcome.v1.json'));

export const conforms = (o: ValidationOutcome): void => {
  expect(outcomeSchema(o), JSON.stringify(outcomeSchema.errors)).toBe(true);
};
