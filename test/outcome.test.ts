// Ordering, determinism, truncation, the /load report, conformance to the contracts outcome schema,
// version metadata and the purity of the domain layer.
import { readdirSync, readFileSync } from 'node:fs';

import { Ajv2020 } from 'ajv/dist/2020.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CONTRACTS_VERSION, RULES, VALIDATOR_VERSION, validate, type ValidationOutcome } from '../src/index.js';
import { dayFormats, input, lessons } from './support/school.js';

const SCHEMAS = new URL('../src/generated/schemas/', import.meta.url);
const load = (p: string): object => JSON.parse(readFileSync(new URL(p, SCHEMAS), 'utf8')) as object;
const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
ajv.addSchema(load('events/defs.v1.json'));
ajv.addSchema(load('events/conflict.v1.json'));
const outcomeSchema = ajv.compile(load('validator/validation.outcome.v1.json'));
const conflictEnum = (load('events/conflict.v1.json') as { properties: { rule: { enum: string[] } } }).properties.rule.enum;

const noisy = () => input({ snapshot: { capacity: { passport: 40 } }, day_formats: dayFormats().slice(0, 7) });
const conforms = (o: ValidationOutcome): void => {
  expect(outcomeSchema(o), JSON.stringify(outcomeSchema.errors)).toBe(true);
};

describe('outcome', () => {
  it('every rule code is in the contracts conflict enum', () => {
    for (const r of RULES) expect(conflictEnum).toContain(r);
  });

  it('ACCEPTED, REJECTED and INVALID_INPUT conform to validation.outcome.v1.json', () => {
    conforms(validate(input()));
    conforms(validate(noisy()));
    conforms(validate({ nope: true }));
  });

  it('is deterministic and independent of the order of the input arrays', () => {
    const base = noisy();
    const expected = JSON.stringify(validate(base));
    fc.assert(
      fc.property(fc.array(fc.nat(), { minLength: 4, maxLength: 4 }), ([a = 0, b = 0, c = 0, d = 0]) => {
        const shuffle = <T>(xs: readonly T[], seed: number): T[] =>
          [...xs].map((x, i) => ({ x, k: (i * 7919 + seed * 104729) % 1000003 })).sort((p, q) => p.k - q.k).map((p) => p.x);
        const s = base.snapshot;
        const permuted = {
          ...base,
          snapshot: { ...s, classes: shuffle(s.classes, a), teachers: shuffle(s.teachers, b), rows: shuffle(s.rows, c) },
          timetable: { lessons: shuffle(base.timetable.lessons, d), day_formats: shuffle(base.timetable.day_formats, a + d) },
        };
        const o = validate(permuted);
        expect(o.status === 'INVALID_INPUT' ? o : o.conflicts).toEqual((JSON.parse(expected) as { conflicts: unknown }).conflicts);
      }),
      { numRuns: 50 },
    );
  });

  it('sorts by rule registry order, then day, class, teacher', () => {
    const o = validate(noisy());
    if (o.status !== 'REJECTED') throw new Error('expected REJECTED');
    const ranks = o.conflicts.map((c) => RULES.indexOf(c.rule));
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
  });

  it('max_conflicts truncates after sorting and keeps the full total', () => {
    const full = validate(noisy());
    const cut = validate(noisy(), { max_conflicts: 2 });
    if (full.status !== 'REJECTED' || cut.status !== 'REJECTED') throw new Error('expected REJECTED');
    expect(cut.conflicts).toEqual(full.conflicts.slice(0, 2));
    expect(cut.conflicts_total).toBe(full.conflicts_total);
  });

  it('carries versions and the capacity model', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VALIDATOR_VERSION).toBe(pkg.version);
    expect(validate(input()).meta).toEqual({ validator_version: VALIDATOR_VERSION, contracts_version: CONTRACTS_VERSION, model: '1.1' });
    expect(validate({}).meta.model).toBeNull();
  });
});

describe('load report', () => {
  it('reports per-day loads, reasons and the peak even when accepted', () => {
    const o = validate(input());
    if (o.status !== 'ACCEPTED') throw new Error('expected ACCEPTED');
    expect(o.load.days[0]).toMatchObject({ day: 1, students_in_person: 45, teachers_on_site: 2, ok: true });
    expect(o.load.days[0]?.conditions.passport).toEqual({ load: 50, limit: 200, ok: true });
    expect(o.load.summary.peak).toEqual([{ condition: 'passport', day: 1, load: 50, limit: 200 }]);
    const c2d5 = o.load.class_days.find((cd) => cd.class_id === 'c-2' && cd.day === 5);
    expect(c2d5).toEqual({ class_id: 'c-2', day: 5, in_person: false, lessons: 0, reason: 'no_lessons' });
    expect(o.load.class_days.find((cd) => cd.class_id === 'c-1' && cd.day === 1)?.reason).toBe('priority');
    expect(o.load.summary.remote_class_days).toBe(1);
    expect(o.load.summary.classes_without_in_person_days).toEqual([]);
  });

  it('explains remote days: day limit vs no-shelter vs free choice', () => {
    const remoteDay1 = dayFormats().map((f) => (f.day === 1 ? { ...f, in_person: false } : f));
    const tight = validate(input({ snapshot: { capacity: { passport: 29 } }, day_formats: remoteDay1 })); // c-1 alone would need 25 + 3 + 2 = 30
    if (tight.status === 'INVALID_INPUT') throw new Error('unexpected');
    expect(tight.load.class_days.find((cd) => cd.class_id === 'c-1' && cd.day === 1)?.reason).toBe('day_limit');
    const roomy = validate(input({ day_formats: remoteDay1 }));
    if (roomy.status === 'INVALID_INPUT') throw new Error('unexpected');
    expect(roomy.load.class_days.find((cd) => cd.class_id === 'c-2' && cd.day === 1)?.reason).toBe('priority');
    const alert = validate(input({ snapshot: { kind: 'alert', capacity: { seats: 100, passport: 200 } }, day_formats: remoteDay1 }));
    if (alert.status === 'INVALID_INPUT') throw new Error('unexpected');
    expect(alert.load.class_days.find((cd) => cd.class_id === 'c-1' && cd.day === 1)?.reason).toBe('no_shelter');
    expect(alert.load.summary.peak.map((p) => p.condition)).toEqual(['passport', 'seats']);
  });

  it('lists classes that never study in person', () => {
    const fs = dayFormats().map((f) => (f.class_id === 'c-2' ? { ...f, in_person: false } : f));
    const ls = lessons().filter((l) => l.class_id !== 'c-2' || l.subject_id !== 's-math');
    const o = validate(input({ lessons: ls, day_formats: fs }));
    if (o.status === 'INVALID_INPUT') throw new Error('unexpected');
    expect(o.load.summary.classes_without_in_person_days).toEqual(['c-2']);
  });
});

describe('architecture', () => {
  it('the domain imports neither the boundary, the CLI nor Node APIs', () => {
    const dir = new URL('../src/domain/', import.meta.url);
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      expect(src, f).not.toMatch(/from ['"](node:|\.\.\/boundary|\.\.\/cli)/);
      expect(src, f).not.toMatch(/\b(Date|Math\.random|process|console)\b/);
    }
  });
});
