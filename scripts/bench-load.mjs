// Manual benchmark of buildLoad (GET /load) and validate, outside CI and without time thresholds:
// the numbers go into the PR description, a noisy machine must never fail a build.
//   npm run build && node scripts/bench-load.mjs [dist dir, default dist] [runs, default 5]
// Inputs are deterministic: a typical school and the largest input the schema allows
// (200 classes, 6 days x 10 lessons = 12 000 lessons, 1 200 day formats) with 3, 30 and 500 teachers
// and a teacher chain (class i shares a teacher with class i + 1), the worst case for teacher groups.
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const dist = path.resolve(process.argv[2] ?? 'dist');
const runs = Number(process.argv[3] ?? 5);
const { buildLoad } = await import(pathToFileURL(path.join(dist, 'domain/load.js')).href);
const { validate, VALIDATOR_VERSION } = await import(pathToFileURL(path.join(dist, 'index.js')).href);

function school({ classes, days, perDay, teachers, teacherOf, model = '1.2', remote = 0.5 }) {
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const schoolDays = Array.from({ length: days }, (_, i) => i + 1);
  const lessons = [];
  const rows = new Map();
  for (let c = 0; c < classes; c += 1) {
    for (const day of schoolDays) {
      for (let n = 1; n <= perDay; n += 1) {
        const subject_id = `s-${String(Math.floor(rnd() * 20))}`;
        const teacher_id = `t-${String(teacherOf(c, n))}`;
        lessons.push({ class_id: `c-${String(c)}`, day, lesson_no: n, subject_id, teacher_id });
        const k = `c-${String(c)}|${subject_id}`;
        rows.set(k, { class_id: `c-${String(c)}`, subject_id, teacher_id, hours: (rows.get(k)?.hours ?? 0) + 1 });
      }
    }
  }
  const day_formats = [];
  for (let c = 0; c < classes; c += 1) for (const day of schoolDays) day_formats.push({ class_id: `c-${String(c)}`, day, in_person: rnd() > remote });
  return {
    schema_version: '1.0',
    snapshot: {
      kind: model === '1.2' ? 'alert' : 'main',
      school_days: schoolDays,
      lessons_per_day: perDay,
      staff: 10,
      capacity: model === '1.2' ? { seats: classes * 12, passport: classes * 15 } : { passport: classes * 15 },
      classes: Array.from({ length: classes }, (_, i) => ({ id: `c-${String(i)}`, students: 20, priority: false })),
      subjects: Array.from({ length: 20 }, (_, i) => ({ id: `s-${String(i)}`, priority_area: i < 3, no_shelter: i === 19 })),
      teachers: Array.from({ length: teachers }, (_, i) => ({ id: `t-${String(i)}`, weekly_limit: 60, unavailable_days: [] })),
      rows: [...rows.values()],
    },
    timetable: { lessons, day_formats },
  };
}

const max = { classes: 200, days: 6, perDay: 10 };
const cases = {
  'typical (30 classes, 5x7, 60 teachers)': school({ classes: 30, days: 5, perDay: 7, teachers: 60, teacherOf: (c, n) => (c * 2 + n) % 60 }),
  'max, 3 teachers': school({ ...max, teachers: 3, teacherOf: (c, n) => (c * 3 + n) % 3 }),
  'max, 30 teachers': school({ ...max, teachers: 30, teacherOf: (c, n) => (c * 3 + n) % 30 }),
  'max, 500 teachers': school({ ...max, teachers: 500, teacherOf: (c, n) => (c * 3 + n) % 500 }),
  // Lesson 1 of class c: teacher c; lesson 2: teacher c - 1 (the previous class); the rest from a pool.
  'max, teacher chain': school({
    ...max,
    teachers: 500,
    teacherOf: (c, n) => (n === 1 ? c : n === 2 && c > 0 ? c - 1 : 200 + ((c * 8 + n) % 300)),
  }),
  // The cases above have one teacher group a day and, in model 1.2, mostly the no_shelter reason.
  // Model 1.1 always checks the load; two own teachers per class give 200 groups a day, each checked.
  'max, teacher chain, model 1.1': school({
    ...max,
    teachers: 500,
    model: '1.1',
    teacherOf: (c, n) => (n === 1 ? c : n === 2 && c > 0 ? c - 1 : 200 + ((c * 8 + n) % 300)),
  }),
  'max, own teachers (200 groups a day), model 1.1': school({ ...max, teachers: 400, model: '1.1', teacherOf: (c, n) => c * 2 + (n % 2) }),
  'max, own teachers (200 groups a day), model 1.2': school({ ...max, teachers: 400, teacherOf: (c, n) => c * 2 + (n % 2) }),
};

const time = (f) => {
  f(); // warm-up
  const ms = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    f();
    ms.push(performance.now() - t0);
  }
  ms.sort((a, b) => a - b);
  return `median ${ms[Math.floor(ms.length / 2)].toFixed(1)} ms, min ${ms[0].toFixed(1)} ms`;
};

console.log(`validator ${VALIDATOR_VERSION} (${dist}), ${String(runs)} runs after one warm-up`);
for (const [name, input] of Object.entries(cases)) {
  const status = validate(input).status;
  console.log(`${name}: ${String(input.timetable.lessons.length)} lessons, ${status}`);
  console.log(`  buildLoad ${time(() => buildLoad(input))}`);
  console.log(`  validate  ${time(() => validate(input))}`);
}
