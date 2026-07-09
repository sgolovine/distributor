export type PlanOperationKind =
  | "create"
  | "update"
  | "adopt"
  | "skip"
  | "stale"
  | "conflict";

export interface OwnershipAttribution {
  readonly harnessId: string;
  readonly placementId: string;
}

export interface PlannedFile {
  readonly skillName: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly linkValue: string;
  readonly attributions: readonly OwnershipAttribution[];
}

export interface CreateOperation extends PlannedFile {
  readonly kind: "create";
}

export interface UpdateOperation extends PlannedFile {
  readonly kind: "update";
}

export interface AdoptOperation extends PlannedFile {
  readonly kind: "adopt";
}

export interface SkipOperation extends PlannedFile {
  readonly kind: "skip";
}

export interface StaleOperation extends PlannedFile {
  readonly kind: "stale";
}

export interface ConflictOperation extends PlannedFile {
  readonly kind: "conflict";
  readonly reason: string;
}

export type PlanOperation =
  | CreateOperation
  | UpdateOperation
  | AdoptOperation
  | SkipOperation
  | StaleOperation
  | ConflictOperation;

export interface SatisfiedPlacement {
  readonly harnessId: string;
  readonly placementId: string;
  readonly sourceRoot: string;
}

export interface PlanNotice {
  readonly message: string;
  readonly harnessId?: string;
  readonly placementId?: string;
  readonly path?: string;
}

export interface PlanFailure extends PlanNotice {
  readonly operation?: PlanOperationKind;
}

export interface SyncPlan {
  readonly operations: readonly PlanOperation[];
  readonly satisfiedPlacements: readonly SatisfiedPlacement[];
  readonly warnings: readonly PlanNotice[];
  readonly failures: readonly PlanFailure[];
}
