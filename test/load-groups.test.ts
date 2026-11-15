// Teacher groups of one day (/load reasons of remote days): classes linked by a shared teacher, transitively.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { teacherGroups } from '../src/domain/load.js';
import type { Lesson } from '../src/index.js';
import { linkedClasses } from './support/groups.js';

const L = (class_id: string, teacher_id: string): Lesson => ({ class_id, day: 1, lesson_no: 1, subject_id: 's-0', teacher_id });
const members = (groups: readonly ReadonlySet<string>[]) => groups.map((g) => [...g].sort()).sort();

describe('teacherGroups', () => {
  it('links classes transitively: A -t1- B -t2- C is one group', () => {
    const { label, groups } = teacherGroups(['A', 'B', 'C'], [L('A', 't1'), L('B', 't1'), L('B', 't2'), L('C', 't2')]);
    expect(members(groups)).toEqual([['A', 'B', 'C']]);
    for (const c of ['A', 'B', 'C']) expect(label.get(c)).toBe(groups[0]);
  });

  it('two components are two groups', () => {
    const { label, groups } = teacherGroups(['A', 'B', 'C', 'D'], [L('A', 't1'), L('C', 't2'), L('B', 't1'), L('D', 't2')]);
    expect(members(groups)).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    expect(label.get('A')).toBe(label.get('B'));
    expect(label.get('C')).toBe(label.get('D'));
    expect(label.get('A')).not.toBe(label.get('C'));
  });

  it('a class without lessons is a group of its own', () => {
    const { label, groups } = teacherGroups(['A', 'B', 'C'], [L('A', 't1'), L('B', 't1')]);
    expect(members(groups)).toEqual([['A', 'B'], ['C']]);
    expect([...(label.get('C') ?? [])]).toEqual(['C']);
  });

  it('only the lessons passed as linking link classes', () => {
    // A lesson of a teacher missing from the snapshot is left out of `linking` by buildLoad.
    const { groups } = teacherGroups(['A', 'B'], [L('A', 't1'), L('B', 't2')]);
    expect(members(groups)).toEqual([['A'], ['B']]);
  });

  it('is a partition: every class in exactly one group, labelled with it; one group per component (union-find)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.array(fc.tuple(fc.nat(9), fc.nat(5)), { maxLength: 25 }),
        (n, pairs) => {
          const classIds = Array.from({ length: n }, (_, i) => `c-${String(i)}`);
          const linking = pairs.map(([c, t]) => L(`c-${String(c % n)}`, `t-${String(t)}`));
          const { label, groups } = teacherGroups(classIds, linking);
          const components = new Set(classIds.map((c) => [...linkedClasses(linking, classIds, c)].sort().join(',')));
          expect(groups.length).toBe(components.size);
          expect(members(groups).map((g) => g.join(',')).sort()).toEqual([...components].sort());
          expect(groups.reduce((sum, g) => sum + g.size, 0)).toBe(n);
          expect(label.size).toBe(n);
          for (const g of groups) for (const c of g) expect(label.get(c)).toBe(g);
        },
      ),
      { numRuns: 300, seed: 20261115 },
    );
  });
});
