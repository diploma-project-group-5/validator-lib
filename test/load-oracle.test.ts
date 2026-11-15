// buildLoad in linear time per day (0.3.1) gives the /load report of v0.3.0 byte for byte.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildLoad } from '../src/domain/load.js';
import type { ValidationInput } from '../src/index.js';
import { denseSchool, loadSchool } from './support/generators.js';
import { linkedClasses } from './support/groups.js';
import { buildLoadV030 } from './support/load-v030.js';
import { input } from './support/school.js';

const same = (school: ValidationInput) => {
  expect(JSON.stringify(buildLoad(school))).toBe(JSON.stringify(buildLoadV030(school)));
};

describe('buildLoad against the frozen v0.3.0 oracle', () => {
  it('the hand-checked school', () => {
    same(input());
    same(input({ snapshot: { kind: 'alert', capacity: { seats: 30, passport: 50 } } }));
  });

  it('dense, untidy schools (byte-identical JSON)', () => {
    fc.assert(
      fc.property(denseSchool, same),
      { numRuns: 200, seed: 20261109 },
    );
  });

  it('the /load reasons generator (byte-identical JSON)', () => {
    fc.assert(
      fc.property(loadSchool, same),
      { numRuns: 200, seed: 20261109 },
    );
  });

  it('the dense generator reaches the cases the comparison is for', () => {
    const seen = new Set<string>();
    fc.assert(
      fc.property(denseSchool, (school) => {
        const { snapshot, timetable } = school;
        const classIds = snapshot.classes.map((c) => c.id);
        const known = new Set(classIds);
        const teachers = new Set(snapshot.teachers.map((t) => t.id));
        seen.add(`model ${snapshot.kind}`);
        for (const l of timetable.lessons) {
          if (!snapshot.school_days.includes(l.day)) seen.add('lesson outside the school days');
          else if (!known.has(l.class_id)) seen.add('lesson of an unknown class on a school day');
        }
        const report = buildLoad(school);
        for (const day of snapshot.school_days) {
          const ofDay = timetable.lessons.filter((l) => l.day === day && known.has(l.class_id));
          const linking = ofDay.filter((l) => teachers.has(l.teacher_id));
          const cds = report.class_days.filter((cd) => cd.day === day);
          // A reason belongs to a whole group, so two reasons on one day come from two different groups.
          const remoteReasons = new Set(cds.filter((cd) => !cd.in_person && cd.lessons > 0).map((cd) => cd.reason));
          if (remoteReasons.size >= 2) seen.add('one day, two groups with different remote reasons');
          for (const c of classIds) {
            const own = ofDay.filter((l) => l.class_id === c);
            if (own.length > 0 && own.every((l) => l.teacher_id === 't-gone')) seen.add('class-day with t-gone lessons only');
            const group = linkedClasses(linking, classIds, c);
            if (group.size >= 3) seen.add('teacher group of 3+ classes');
            const formats = new Set(cds.filter((cd) => group.has(cd.class_id)).map((cd) => cd.in_person));
            if (formats.size === 2) seen.add('teacher group with in-person and remote classes');
          }
        }
        const fs = timetable.day_formats.map((f) => `${f.class_id}|${String(f.day)}`);
        if (new Set(fs).size < fs.length) seen.add('duplicate day format');
        for (const cd of report.class_days) seen.add(`${cd.in_person ? 'in person' : 'remote'} ${cd.reason}`);
      }),
      { numRuns: 200, seed: 20261109 },
    );
    expect([...seen].sort()).toEqual([
      'class-day with t-gone lessons only',
      'duplicate day format',
      'in person capacity_available',
      'in person priority',
      'lesson of an unknown class on a school day',
      'lesson outside the school days',
      'model alert',
      'model main',
      'one day, two groups with different remote reasons',
      'remote capacity_available',
      'remote day_limit',
      'remote no_lessons',
      'remote no_shelter',
      'teacher group of 3+ classes',
      'teacher group with in-person and remote classes',
    ]);
  });
});
