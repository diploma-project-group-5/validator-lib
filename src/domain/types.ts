// Public data types. Field names follow the contracts schemas (snake_case on the wire):
// contracts/schemas/validator/validation.input.v1.json and validation.outcome.v1.json.
// A test validates every outcome against the outcome schema, so the two cannot drift silently.

export type Kind = 'main' | 'alert';
export type Model = '1.1' | '1.2';
export type Condition = 'seats' | 'passport';

export interface CapacityPassport {
  readonly passport: number;
}
export interface CapacityAlert {
  readonly seats: number;
  readonly passport: number;
}
export type Capacity = CapacityPassport | CapacityAlert;

export interface SchoolClass {
  readonly id: string;
  readonly students: number;
  readonly priority: boolean;
}
export interface Subject {
  readonly id: string;
  readonly priority_area: boolean;
  readonly no_shelter: boolean;
}
export interface Teacher {
  readonly id: string;
  readonly weekly_limit: number;
  readonly unavailable_days: readonly number[];
}
export interface CurriculumRow {
  readonly class_id: string;
  readonly subject_id: string;
  readonly teacher_id: string;
  readonly hours: number;
}
/** substitution: a substitute teacher, exempt from teacher_not_in_plan ("не за фахом", spec §04). */
export type LessonOrigin = 'plan' | 'substitution';
export interface Lesson {
  readonly class_id: string;
  readonly day: number;
  readonly lesson_no: number;
  readonly subject_id: string;
  readonly teacher_id: string;
  readonly origin?: LessonOrigin;
}
/** A template lesson not held this week (ADR 2026-11-09-validator-lib-substitution-check). */
export type NotHeldKind = 'self_study' | 'cancelled' | 'holiday';
export interface NotHeld {
  readonly class_id: string;
  readonly day: number;
  readonly lesson_no: number;
  readonly subject_id: string;
  readonly kind: NotHeldKind;
}
/** A teacher absent on these lessons of a weekday of the checked week. */
export interface Absence {
  readonly teacher_id: string;
  readonly day: number;
  readonly lesson_nos: readonly number[];
}
export interface DayFormat {
  readonly class_id: string;
  readonly day: number;
  readonly in_person: boolean;
}

export interface Snapshot {
  readonly kind: Kind;
  readonly school_days: readonly number[];
  readonly lessons_per_day: number;
  readonly staff: number;
  readonly capacity: Capacity;
  readonly classes: readonly SchoolClass[];
  readonly subjects: readonly Subject[];
  readonly teachers: readonly Teacher[];
  readonly rows: readonly CurriculumRow[];
}

export interface ValidationInput {
  readonly schema_version: '1.0';
  readonly snapshot: Snapshot;
  readonly timetable: {
    readonly lessons: readonly Lesson[];
    readonly day_formats: readonly DayFormat[];
    readonly not_held?: readonly NotHeld[];
  };
  readonly absences?: readonly Absence[];
  /** Weekdays of the checked week that are holidays: removed from school_days, their lessons are not_held. */
  readonly holidays?: readonly number[];
}

/** Registry order is the sort order of conflicts (see rules/registry.ts). */
export type ConflictRule =
  | 'class_not_active'
  | 'subject_not_active'
  | 'teacher_not_active'
  | 'day_not_school_day'
  | 'lesson_no_out_of_range'
  | 'day_format_missing'
  | 'day_format_duplicate'
  | 'in_person_without_lessons'
  | 'class_double_booked'
  | 'teacher_double_booked'
  | 'teacher_mixed_format'
  | 'teacher_unavailable_day'
  | 'teacher_weekly_limit'
  | 'lesson_not_in_plan'
  | 'teacher_not_in_plan'
  | 'plan_hours_mismatch'
  | 'capacity_exceeded'
  | 'no_shelter_in_person';

export interface Conflict {
  readonly rule: ConflictRule;
  readonly class_id?: string;
  readonly teacher_id?: string;
  readonly subject_id?: string;
  readonly day?: number;
  readonly lesson_no?: number;
  readonly condition?: Condition;
  readonly value?: number;
  readonly limit?: number;
}

export interface Cond {
  readonly load: number;
  readonly limit: number;
  readonly ok: boolean;
}
export interface DayLoad {
  readonly students_in_person: number;
  readonly teachers_on_site: number;
  readonly conditions: { readonly passport: Cond; readonly seats?: Cond };
  readonly ok: boolean;
}
/** Same shape as a contracts/vectors/capacity file without `expected`; model and capacity agree. */
export type DayLoadInput =
  | (DayLoadBase & { readonly model: '1.1'; readonly capacity: CapacityPassport })
  | (DayLoadBase & { readonly model: '1.2'; readonly capacity: CapacityAlert });
interface DayLoadBase {
  readonly staff: number;
  readonly day: {
    readonly classes: readonly { readonly id: string; readonly students: number; readonly in_person: boolean }[];
    readonly lessons: readonly { readonly class_id: string; readonly teacher_id: string }[];
  };
}

export type FormatReason = 'no_lessons' | 'no_shelter' | 'day_limit' | 'priority' | 'capacity_available';
export interface ClassDayLoad {
  readonly class_id: string;
  readonly day: number;
  readonly in_person: boolean;
  readonly lessons: number;
  readonly reason: FormatReason;
}
export interface LoadReport {
  readonly days: readonly ({ readonly day: number } & DayLoad)[];
  readonly class_days: readonly ClassDayLoad[];
  readonly summary: {
    readonly remote_class_days: number;
    readonly peak: readonly { readonly condition: Condition; readonly day: number; readonly load: number; readonly limit: number }[];
    readonly classes_without_in_person_days: readonly string[];
  };
}

export interface Meta {
  readonly validator_version: string;
  readonly contracts_version: string;
  readonly model: Model | null;
}

export type IssuePart = 'input' | 'snapshot' | 'timetable';
export type IssueCode =
  | 'schema'
  | 'limit'
  | 'duplicate_id'
  | 'unknown_reference'
  | 'duplicate_row'
  | 'kind_capacity_mismatch'
  | 'unsupported_version'
  | 'requires_absences'
  | 'requires_holidays'
  | 'not_held_day'
  | 'duplicate_slot';
export interface InputIssue {
  readonly part: IssuePart;
  readonly code: IssueCode;
  /** JSON pointer into the input; never an input value (it may hold personal data). */
  readonly path: string;
  readonly keyword?: string;
}

export type ValidationOutcome =
  | {
      readonly status: 'ACCEPTED';
      readonly conflicts: readonly [];
      readonly conflicts_total: 0;
      readonly load: LoadReport;
      readonly meta: Meta;
    }
  | {
      readonly status: 'REJECTED';
      readonly conflicts: readonly Conflict[];
      readonly conflicts_total: number;
      readonly load: LoadReport;
      readonly meta: Meta;
    }
  | { readonly status: 'INVALID_INPUT'; readonly issues: readonly InputIssue[]; readonly meta: Meta };
