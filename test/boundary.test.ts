// Malformed or hostile input never throws and never echoes input values (ADR 2026-11-09 §6).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { validate, type InputIssue, type ValidationOutcome } from '../src/index.js';
import { input, snapshot } from './support/school.js';

const issues = (o: ValidationOutcome): readonly InputIssue[] => {
  if (o.status !== 'INVALID_INPUT') throw new Error(`expected INVALID_INPUT, got ${o.status}`);
  return o.issues;
};
const codes = (o: ValidationOutcome): string[] => issues(o).map((i) => `${i.part}:${i.code}`);
const MARKER = 'Іваненко-Олена-Петрівна';

describe('INVALID_INPUT', () => {
  it('rejects non-objects and unsupported versions', () => {
    expect(codes(validate(null))).toEqual(['input:schema']);
    expect(codes(validate([]))).toEqual(['input:schema']);
    expect(codes(validate({ ...input(), schema_version: '2.0' }))).toEqual(['input:unsupported_version']);
  });

  it('kind and capacity must match', () => {
    expect(codes(validate(input({ snapshot: { capacity: { seats: 10, passport: 20 } } })))).toEqual([
      'snapshot:kind_capacity_mismatch',
    ]);
    expect(codes(validate(input({ snapshot: { kind: 'alert', capacity: { passport: 20 } } })))).toEqual([
      'snapshot:kind_capacity_mismatch',
    ]);
  });

  it('duplicate ids, unknown references and duplicate rows break the snapshot', () => {
    const s = snapshot();
    const dupClass = input({ snapshot: { classes: [...s.classes, { id: 'c-1', students: 5, priority: false }] } });
    expect(issues(validate(dupClass))).toEqual([{ part: 'snapshot', code: 'duplicate_id', path: '/snapshot/classes/2/id' }]);
    const badRow = input({ snapshot: { rows: [...s.rows, { class_id: 'c-1', subject_id: 's-x', teacher_id: 't-1', hours: 1 }] } });
    expect(issues(validate(badRow))).toEqual([{ part: 'snapshot', code: 'unknown_reference', path: '/snapshot/rows/4/subject_id' }]);
    const dupRow = input({ snapshot: { rows: [...s.rows, { class_id: 'c-1', subject_id: 's-math', teacher_id: 't-2', hours: 1 }] } });
    expect(codes(validate(dupRow))).toEqual(['snapshot:duplicate_row']);
  });

  it('enforces size limits from the schema', () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ id: `c-${String(i)}`, students: 1, priority: false }));
    expect(codes(validate(input({ snapshot: { classes: many, rows: [] }, lessons: [], day_formats: [] })))).toContain(
      'snapshot:limit',
    );
  });

  it('a malformed timetable is part=timetable (a solver bug), not a broken snapshot', () => {
    const bad = input();
    const lessons = [{ ...bad.timetable.lessons[0], lesson_no: 0 }];
    expect(codes(validate({ ...bad, timetable: { ...bad.timetable, lessons } }))).toEqual(['timetable:schema']);
  });

  it('unknown fields are refused, so personal data cannot ride along, and values are never echoed', () => {
    const base = input();
    const withName = { ...base, snapshot: { ...base.snapshot, teachers: [{ ...base.snapshot.teachers[0], signature: MARKER }] } };
    const o = validate(withName);
    expect(codes(o)).toContain('snapshot:schema');
    expect(JSON.stringify(o)).not.toContain(MARKER);
    const asId = { ...base, snapshot: { ...base.snapshot, classes: [{ id: `${MARKER} 5-А`, students: 1, priority: false }] } };
    expect(JSON.stringify(validate(asId))).not.toContain(MARKER);
  });

  it('caps the number of issues', () => {
    const lessons = Array.from({ length: 50 }, () => ({ bad: true }));
    const base = input();
    expect(issues(validate({ ...base, timetable: { ...base.timetable, lessons } })).length).toBeLessThanOrEqual(20);
  });
});

describe('totality', () => {
  it('never throws on arbitrary values', () => {
    fc.assert(
      fc.property(fc.anything({ withNullPrototype: true, withBigInt: true, withMap: true, withSet: true }), (v) => {
        expect(['ACCEPTED', 'REJECTED', 'INVALID_INPUT']).toContain(validate(v).status);
      }),
      { numRuns: 300 },
    );
  });

  it('never throws when any field of a valid input is replaced by junk', () => {
    const junk = fc.oneof(fc.constant(null), fc.constant(Number.NaN), fc.constant(1e308), fc.constant(-1), fc.string(), fc.object());
    fc.assert(
      fc.property(fc.constantFrom('kind', 'school_days', 'lessons_per_day', 'staff', 'capacity', 'classes', 'rows'), junk, (field, value) => {
        const base = input();
        const o = validate({ ...base, snapshot: { ...base.snapshot, [field]: value } });
        expect(o.status).toBe('INVALID_INPUT');
      }),
      { numRuns: 200 },
    );
  });

  it('ids such as __proto__ or constructor are plain data', () => {
    const base = snapshot();
    const s = {
      classes: [{ id: '__proto__', students: 10, priority: false }],
      rows: [{ class_id: '__proto__', subject_id: 's-math', teacher_id: 't-1', hours: 1 }],
    };
    const o = validate(input({ snapshot: { ...base, ...s }, lessons: [{ class_id: '__proto__', day: 1, lesson_no: 1, subject_id: 's-math', teacher_id: 't-1' }], day_formats: [1, 2, 3, 4, 5].map((day) => ({ class_id: '__proto__', day, in_person: day === 1 })) }));
    expect(o.status).toBe('ACCEPTED');
  });
});
