// Capacity formula (spec §04, ADR 2026-11-09): the shared contracts vectors must give the same
// verdict here as in the solver, plus the mandatory boundary cases from the testing rules.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { dayLoad, type DayLoad, type DayLoadInput } from '../src/index.js';

const require = createRequire(import.meta.url);
const VECTORS = join(dirname(require.resolve('@lad/contracts/package.json')), 'vectors', 'capacity');
const files = readdirSync(VECTORS).filter((f) => f.endsWith('.json'));

describe('contracts capacity vectors', () => {
  it('exist, including the mandatory ones', () => {
    for (const name of ['m11-at-limit', 'm11-over-by-one', 'm11-teacher-counted-once',
      'm11-teacher-without-in-person-lessons', 'm11-vs-m12-same-day-11', 'm11-vs-m12-same-day-12',
      'm12-seats-over-by-one', 'm12-passport-over-by-one']) {
      expect(files).toContain(`${name}.json`);
    }
  });

  it.each(files)('%s', (file) => {
    const vector = JSON.parse(readFileSync(join(VECTORS, file), 'utf8')) as DayLoadInput & { expected: DayLoad };
    const { expected, ...given } = vector;
    expect(dayLoad(given)).toEqual(expected);
  });
});

const day11 = (passport: number, inPerson = true): DayLoadInput => ({
  model: '1.1',
  staff: 5,
  capacity: { passport },
  day: {
    classes: [{ id: 'c-1', students: 30, in_person: inPerson }],
    lessons: [
      { class_id: 'c-1', teacher_id: 't-1' },
      { class_id: 'c-1', teacher_id: 't-1' },
    ],
  },
});

describe('boundaries', () => {
  it('exactly at the limit passes, one over fails (1.1)', () => {
    expect(dayLoad(day11(36)).ok).toBe(true); // 30 + 5 + 1
    expect(dayLoad(day11(35)).ok).toBe(false);
  });

  it('counts a teacher with several in-person lessons once', () => {
    expect(dayLoad(day11(100)).teachers_on_site).toBe(1);
  });

  it('a remote class brings neither students nor its teachers', () => {
    const load = dayLoad(day11(5, false));
    expect(load).toMatchObject({ students_in_person: 0, teachers_on_site: 0, ok: true });
    expect(load.conditions.passport.load).toBe(5);
  });

  it('model 1.2 checks seats (students only) and passport (everyone) separately', () => {
    const base = { model: '1.2' as const, staff: 5, day: day11(0).day };
    const seats = dayLoad({ ...base, capacity: { seats: 29, passport: 100 } });
    expect(seats.conditions.seats).toEqual({ load: 30, limit: 29, ok: false });
    expect(seats.conditions.passport.ok).toBe(true);
    const passport = dayLoad({ ...base, capacity: { seats: 30, passport: 35 } });
    expect(passport.conditions.seats?.ok).toBe(true);
    expect(passport.conditions.passport).toEqual({ load: 36, limit: 35, ok: false });
  });

  it('model 1.1 has no seats condition', () => {
    expect(dayLoad(day11(100)).conditions.seats).toBeUndefined();
  });
});

describe('model and capacity must agree', () => {
  it('model 1.2 without seats is a caller bug, not a silent pass', () => {
    const bad = { model: '1.2', staff: 0, capacity: { passport: 100 }, day: { classes: [{ id: 'c', students: 50, in_person: true }], lessons: [] } };
    expect(() => dayLoad(bad as unknown as DayLoadInput)).toThrow(TypeError);
  });
});

describe('dayLoad from a JavaScript caller', () => {
  it('model 1.2 without seats throws instead of skipping the seats condition', () => {
    const bad = { model: '1.2', capacity: { passport: 10 }, staff: 0, day: { classes: [], lessons: [] } } as unknown as DayLoadInput;
    expect(() => dayLoad(bad)).toThrow(new TypeError('model 1.2 needs capacity.seats'));
  });
});
