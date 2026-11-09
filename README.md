# validator-lib

Незалежна перевірка розкладу «Лад»: TypeScript-бібліотека для `timetable-service` (синхронно, у процесі) і CLI
`lad-validate` з пакетним режимом JSONL для `bench` і еталонних тестів `solver` (специфікація, розділи 03–06).

Правила написано з тексту специфікації, а не з моделі CP-SAT: бібліотека не імпортує й не копіює код `solver`.
Друга реалізація правил (на Python) не пишеться. Спільна істина з `solver` — вектори місткості в `contracts`.

## API

```ts
import { validate, dayLoad, RULES } from '@lad/validator-lib';

const outcome = validate(input, { max_conflicts: 200 });
// outcome.status: 'ACCEPTED' | 'REJECTED' | 'INVALID_INPUT'
```

- `validate(raw: unknown)` ніколи не кидає виняток на вхідних даних, навіть ворожих. Виняток означає баг бібліотеки.
- **Вхід** — `contracts/schemas/validator/validation.input.v1.json`: знімок закладу (лише id, без ПД) і розклад
  (`lessons`, `day_formats` у формі `solve.completed`).
- **Результат** — `validation.outcome.v1.json`:
  - `ACCEPTED` / `REJECTED` + `conflicts[]` (коди з `conflict.v1.json`), `conflicts_total` і `load` (значення для `/load`);
  - `INVALID_INPUT` + `issues[]`: зламаний вхід або знімок. У `issues` лише JSON-вказівники, ніколи значення.

| Результат | Задача побудови | `:publish` / `:activate` |
|---|---|---|
| `ACCEPTED` | версія `validated` | перевірку пройдено |
| `REJECTED` | `rejected` (помилка solver), звіт зберігається | `409 stale` + `conflicts[]` |
| `INVALID_INPUT`, `part: timetable` | `rejected` | — |
| `INVALID_INPUT`, `part: snapshot` / `input` | `failed` | 500 |

## Правила

Порядок у таблиці — порядок сортування конфліктів.

| Код | Що порушено |
|---|---|
| `class_not_active`, `subject_not_active`, `teacher_not_active` | розклад посилається на id, якого немає в активному знімку (архівований клас, видалений вчитель) |
| `day_not_school_day` | урок чи формат дня поза навчальними днями |
| `lesson_no_out_of_range` | номер уроку більший за `lessons_per_day` |
| `day_format_missing`, `day_format_duplicate` | для класу × навчального дня немає формату або їх кілька |
| `in_person_without_lessons` | очний день без уроків |
| `class_double_booked`, `teacher_double_booked` | накладка в одному слоті |
| `teacher_mixed_format` | вчитель того дня має уроки і в очних, і в дистанційних класах |
| `teacher_unavailable_day` | урок у недоступний день вчителя |
| `teacher_weekly_limit` | уроків за тиждень більше за ліміт |
| `lesson_not_in_plan`, `teacher_not_in_plan`, `plan_hours_mismatch` | розклад не відповідає навчальному плану |
| `capacity_exceeded` | місткість дня: 1.1 — паспорт; 1.2 — окремо `seats` і `passport` |
| `no_shelter_in_person` | лише 1.2: предмет «не в укритті» в очний день |

Формула місткості (розділ 04): учні очних класів + непедагогічний персонал + вчителі з хоча б одним очним уроком
(кожен раз на день) ≤ паспорт; для 1.2 ще учні очних класів ≤ навчальні місця. Правила якості `solver`
(обмеження рядка на день, компактність) не перевіряються.

## CLI

```bash
lad-validate [--fail-on-reject] [--max-conflicts N] < in.jsonl > out.jsonl
lad-validate --version
```

- Рядок входу: `{"case_id": "...", "input": ValidationInput}`; рядок виходу: `{"case_id", "line_no", ...outcome}`.
- Зламаний рядок дає `INVALID_INPUT`, обробка триває. Рядок понад 8 МіБ відхиляється без розбору.
- Коди виходу: 0 — усе оброблено; 1 — `--fail-on-reject` і є не `ACCEPTED`; 2 — помилка аргументів; 3 — внутрішня помилка.

## Розробка

Потрібен Node 24. `@lad/contracts` підключено git-залежністю на тег (`v0.2.0`); lock-файл фіксує коміт.

```bash
npm install
npm run check   # lint, typecheck, tests with coverage, build
```

Схеми копіюються з `@lad/contracts` у `src/generated/` (`npm run sync-schemas`, автоматично перед тестами й збіркою)
і не редагуються тут. Будь-яка зміна, що може змінити вердикт або код конфлікту, — MINOR-версія.
