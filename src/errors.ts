export type ExitCode = 0 | 1 | 2;

export type FailureCategory =
  | "usage"
  | "config"
  | "source"
  | "state"
  | "conflict"
  | "filesystem";

export type ValidationFailureCategory = Extract<
  FailureCategory,
  "config" | "source" | "state"
>;

export interface ValidationIssue {
  readonly message: string;
  readonly path?: string;
  readonly received?: unknown;
  readonly expected?: string;
  readonly correction?: string;
}

export interface DistributorErrorOptions {
  readonly operation?: string;
  readonly context?: Readonly<Record<string, string>>;
  readonly received?: unknown;
  readonly correction?: string;
  readonly issues?: readonly ValidationIssue[];
  readonly cause?: unknown;
}

export function exitCodeForFailure(category: FailureCategory): 1 | 2 {
  return category === "usage" || category === "config" ? 2 : 1;
}

export class DistributorError extends Error {
  readonly category: FailureCategory;
  readonly exitCode: 1 | 2;
  readonly operation: string | undefined;
  readonly context: Readonly<Record<string, string>> | undefined;
  readonly received: unknown;
  readonly correction: string | undefined;
  readonly issues: readonly ValidationIssue[];

  constructor(
    category: FailureCategory,
    message: string,
    options: DistributorErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "DistributorError";
    this.category = category;
    this.exitCode = exitCodeForFailure(category);
    this.operation = options.operation;
    this.context = options.context;
    this.received = options.received;
    this.correction = options.correction;
    this.issues = options.issues === undefined ? [] : [...options.issues];
  }
}

export function validationError(
  category: ValidationFailureCategory,
  message: string,
  issues: readonly ValidationIssue[],
  options: Omit<DistributorErrorOptions, "issues"> = {},
): DistributorError {
  if (issues.length === 0) {
    throw new TypeError("A validation error requires at least one issue.");
  }

  return new DistributorError(category, message, { ...options, issues });
}
