import { discoverConfig } from "../config/discover.js";
import {
  loadProjectConfig,
  type ValidateConfigOptions,
  type ValidatedProjectConfig,
} from "../config/validate.js";
import {
  DistributorError,
  type ValidationIssue,
} from "../errors.js";
import {
  discoverSkills,
  type SkillDiscoveryResult,
} from "../skills/discover.js";
import {
  applySyncPlan,
  type ApplyFailure,
  type ApplySyncResult,
} from "./apply.js";
import { buildSyncPlan, type ReadOnlySyncPlan } from "./plan.js";
import {
  resolvePlacements,
  type PlacementResolution,
} from "./resolve-placements.js";
import { loadManagedState } from "./state.js";
import type {
  PlanNotice,
  PlanOperation,
  PlanOperationKind,
} from "./types.js";

export interface RunSyncRuntime {
  readonly discoverConfig: typeof discoverConfig;
  readonly loadProjectConfig: typeof loadProjectConfig;
  readonly discoverSkills: typeof discoverSkills;
  readonly resolvePlacements: typeof resolvePlacements;
  readonly loadManagedState: typeof loadManagedState;
  readonly buildSyncPlan: typeof buildSyncPlan;
  readonly applySyncPlan: typeof applySyncPlan;
}

export interface RunSyncOptions extends ValidateConfigOptions {
  readonly cwd?: string;
  readonly harness?: string;
  readonly dryRun?: boolean;
  readonly runtime?: Partial<RunSyncRuntime>;
}

export interface OperationCounts {
  readonly total: number;
  readonly create: number;
  readonly update: number;
  readonly adopt: number;
  readonly skip: number;
  readonly stale: number;
  readonly conflict: number;
}

export interface PlacementSyncCounts {
  readonly placementId: string;
  readonly operations: OperationCounts;
  readonly satisfied: boolean;
  readonly warnings: number;
  readonly failures: number;
}

export interface HarnessSyncCounts {
  readonly harnessId: string;
  readonly operations: OperationCounts;
  readonly satisfiedPlacements: readonly string[];
  readonly warnings: number;
  readonly failures: number;
  readonly placements: readonly PlacementSyncCounts[];
}

export interface SyncCounts {
  readonly source: {
    readonly skills: number;
    readonly files: number;
  };
  readonly physicalOperations: OperationCounts;
  readonly stale: number;
  readonly satisfiedPlacements: number;
  readonly warnings: number;
  readonly failures: number;
  readonly harnesses: readonly HarnessSyncCounts[];
}

export interface RunSyncResult {
  readonly exitCode: 0 | 1;
  readonly dryRun: boolean;
  readonly applied: boolean;
  readonly configPath: string;
  readonly projectRoot: string;
  readonly sourceRoot: string;
  readonly plan: ReadOnlySyncPlan;
  readonly applyResult?: ApplySyncResult;
  readonly warnings: readonly PlanNotice[];
  readonly failures: readonly ApplyFailure[];
  readonly counts: SyncCounts;
}

interface MutableOperationCounts {
  total: number;
  create: number;
  update: number;
  adopt: number;
  skip: number;
  stale: number;
  conflict: number;
}

interface MutablePlacementCounts {
  readonly placementId: string;
  readonly operations: MutableOperationCounts;
  satisfied: boolean;
  warnings: number;
  failures: number;
}

interface MutableHarnessCounts {
  readonly harnessId: string;
  readonly operations: MutableOperationCounts;
  readonly satisfiedPlacements: Set<string>;
  readonly placements: Map<string, MutablePlacementCounts>;
  warnings: number;
  failures: number;
}

const defaultRuntime: RunSyncRuntime = {
  discoverConfig,
  loadProjectConfig,
  discoverSkills,
  resolvePlacements,
  loadManagedState,
  buildSyncPlan,
  applySyncPlan,
};

export async function runSync(
  options: RunSyncOptions = {},
): Promise<RunSyncResult> {
  const runtime: RunSyncRuntime = { ...defaultRuntime, ...options.runtime };
  const cwd = options.cwd ?? process.cwd();
  const configOptions = validationOptions(options);
  const discovered = await runtime.discoverConfig(cwd);
  const config = await runtime.loadProjectConfig(discovered, configOptions);
  const skills = await runtime.discoverSkills(config.sourceRoot);
  const resolution = runtime.resolvePlacements(config, skills, {
    ...(options.harness === undefined ? {} : { harness: options.harness }),
    ...(options.homeDirectory === undefined
      ? {}
      : { homeDirectory: options.homeDirectory }),
    ...(options.pathStyle === undefined
      ? {}
      : { pathStyle: options.pathStyle }),
  });
  const state = await runtime.loadManagedState(config.projectRoot);
  const plan = await runtime.buildSyncPlan(resolution, state, {
    ...(options.harness === undefined ? {} : { harnessId: options.harness }),
  });

  if (
    !plan.applicable ||
    plan.failures.length > 0 ||
    plan.operations.some((operation) => operation.kind === "conflict")
  ) {
    throw planningConflict(plan, config);
  }

  const skillWarnings = skills.warnings.map(
    (warning): PlanNotice => ({
      path: warning.path,
      message: warning.message,
    }),
  );

  if (options.dryRun === true) {
    const warnings = mergeNotices(skillWarnings, plan.warnings);
    const failures: readonly ApplyFailure[] = Object.freeze([]);
    return Object.freeze({
      exitCode: 0,
      dryRun: true,
      applied: false,
      configPath: config.configPath,
      projectRoot: config.projectRoot,
      sourceRoot: config.sourceRoot,
      plan,
      warnings,
      failures,
      counts: buildCounts(
        skills,
        resolution,
        plan.operations,
        warnings,
        failures,
      ),
    });
  }

  const applyResult = await runtime.applySyncPlan(
    plan,
    resolution,
    state,
    config.projectRoot,
    {
      ...(options.harness === undefined ? {} : { harnessId: options.harness }),
    },
  );
  const warnings = mergeNotices(
    skillWarnings,
    plan.warnings,
    applyResult.warnings,
  );
  const failures = Object.freeze([...applyResult.failures].sort(compareFailures));
  const completedOperations = applyResult.operations
    .filter((result) => result.status !== "failed")
    .map((result) => result.operation);

  return Object.freeze({
    exitCode: failures.length === 0 ? 0 : 1,
    dryRun: false,
    applied: true,
    configPath: config.configPath,
    projectRoot: config.projectRoot,
    sourceRoot: config.sourceRoot,
    plan,
    applyResult,
    warnings,
    failures,
    counts: buildCounts(
      skills,
      resolution,
      completedOperations,
      warnings,
      failures,
    ),
  });
}

function validationOptions(options: RunSyncOptions): ValidateConfigOptions {
  return {
    ...(options.homeDirectory === undefined
      ? {}
      : { homeDirectory: options.homeDirectory }),
    ...(options.environment === undefined
      ? {}
      : { environment: options.environment }),
    ...(options.pathStyle === undefined
      ? {}
      : { pathStyle: options.pathStyle }),
  };
}

function planningConflict(
  plan: ReadOnlySyncPlan,
  config: ValidatedProjectConfig,
): DistributorError {
  const issues = new Map<string, ValidationIssue>();

  for (const failure of plan.failures) {
    const issue = {
      message: failure.message,
      ...(failure.path === undefined ? {} : { path: failure.path }),
      correction: "Resolve this conflict without overwriting unmanaged content.",
    } satisfies ValidationIssue;
    issues.set(issueKey(issue), issue);
  }
  for (const operation of plan.operations) {
    if (operation.kind !== "conflict") {
      continue;
    }
    const issue = {
      path: operation.targetPath,
      message: operation.reason,
      correction: "Resolve this target conflict and rerun sync.",
    } satisfies ValidationIssue;
    issues.set(issueKey(issue), issue);
  }

  if (issues.size === 0) {
    const issue = {
      message: "The sync plan was marked non-applicable.",
      correction: "Review the requested source, placements, state, and targets.",
    } satisfies ValidationIssue;
    issues.set(issueKey(issue), issue);
  }

  const sortedIssues = [...issues.values()].sort(compareIssues);
  return new DistributorError(
    "conflict",
    `Sync planning found ${sortedIssues.length} conflict${sortedIssues.length === 1 ? "" : "s"}.`,
    {
      operation: "build sync plan",
      context: {
        configPath: config.configPath,
        projectRoot: config.projectRoot,
      },
      correction:
        "Resolve every reported conflict safely, then rerun sync. Distributor did not write targets or state.",
      issues: sortedIssues,
    },
  );
}

function issueKey(issue: ValidationIssue): string {
  return `${issue.path ?? ""}\0${issue.message}`;
}

function compareIssues(left: ValidationIssue, right: ValidationIssue): number {
  return (
    compareText(left.path ?? "", right.path ?? "") ||
    compareText(left.message, right.message)
  );
}

function mergeNotices(
  ...groups: readonly (readonly PlanNotice[])[]
): readonly PlanNotice[] {
  const notices = new Map<string, PlanNotice>();

  for (const notice of groups.flat()) {
    notices.set(noticeKey(notice), notice);
  }

  return Object.freeze([...notices.values()].sort(compareNotices));
}

function noticeKey(notice: PlanNotice): string {
  return `${notice.harnessId ?? ""}\0${notice.placementId ?? ""}\0${notice.path ?? ""}\0${notice.message}`;
}

function compareNotices(left: PlanNotice, right: PlanNotice): number {
  return (
    compareText(left.harnessId ?? "", right.harnessId ?? "") ||
    compareText(left.placementId ?? "", right.placementId ?? "") ||
    compareText(left.path ?? "", right.path ?? "") ||
    compareText(left.message, right.message)
  );
}

function compareFailures(left: ApplyFailure, right: ApplyFailure): number {
  return (
    compareText(left.harnessId ?? "", right.harnessId ?? "") ||
    compareText(left.placementId ?? "", right.placementId ?? "") ||
    compareText(left.path, right.path) ||
    compareText(left.phase, right.phase) ||
    compareText(left.operation ?? "", right.operation ?? "") ||
    compareText(left.message, right.message)
  );
}

function buildCounts(
  skills: SkillDiscoveryResult,
  resolution: PlacementResolution,
  operations: readonly PlanOperation[],
  warnings: readonly PlanNotice[],
  failures: readonly ApplyFailure[],
): SyncCounts {
  const physicalOperations = emptyOperationCounts();
  const harnesses = new Map<string, MutableHarnessCounts>();

  for (const placement of resolution.placements) {
    ensurePlacement(harnesses, placement.harnessId, placement.placement.id);
  }
  for (const satisfied of resolution.satisfiedPlacements) {
    const harness = ensurePlacement(
      harnesses,
      satisfied.harnessId,
      satisfied.placementId,
    );
    harness.satisfiedPlacements.add(satisfied.placementId);
    harness.placements.get(satisfied.placementId)!.satisfied = true;
  }

  for (const operation of operations) {
    incrementOperation(physicalOperations, operation.kind);
    const seenHarnesses = new Set<string>();
    const seenPlacements = new Set<string>();

    for (const attribution of operation.attributions) {
      const pairKey = `${attribution.harnessId}\0${attribution.placementId}`;
      const harness = ensurePlacement(
        harnesses,
        attribution.harnessId,
        attribution.placementId,
      );
      if (!seenHarnesses.has(attribution.harnessId)) {
        incrementOperation(harness.operations, operation.kind);
        seenHarnesses.add(attribution.harnessId);
      }
      if (!seenPlacements.has(pairKey)) {
        incrementOperation(
          harness.placements.get(attribution.placementId)!.operations,
          operation.kind,
        );
        seenPlacements.add(pairKey);
      }
    }
  }

  for (const warning of warnings) {
    if (warning.harnessId === undefined) {
      continue;
    }
    const harness = ensureHarness(harnesses, warning.harnessId);
    harness.warnings += 1;
    if (warning.placementId !== undefined) {
      ensurePlacement(
        harnesses,
        warning.harnessId,
        warning.placementId,
      ).placements.get(warning.placementId)!.warnings += 1;
    }
  }
  for (const failure of failures) {
    const attributions = new Map<string, {
      readonly harnessId: string;
      readonly placementId?: string;
    }>();
    for (const attribution of failure.attributions ?? []) {
      attributions.set(
        `${attribution.harnessId}\0${attribution.placementId}`,
        attribution,
      );
    }
    if (failure.harnessId !== undefined) {
      attributions.set(
        `${failure.harnessId}\0${failure.placementId ?? ""}`,
        {
          harnessId: failure.harnessId,
          ...(failure.placementId === undefined
            ? {}
            : { placementId: failure.placementId }),
        },
      );
    }

    const countedHarnesses = new Set<string>();
    for (const attribution of attributions.values()) {
      const harness = ensureHarness(harnesses, attribution.harnessId);
      if (!countedHarnesses.has(attribution.harnessId)) {
        harness.failures += 1;
        countedHarnesses.add(attribution.harnessId);
      }
      if (attribution.placementId !== undefined) {
        ensurePlacement(
          harnesses,
          attribution.harnessId,
          attribution.placementId,
        ).placements.get(attribution.placementId)!.failures += 1;
      }
    }
  }

  const frozenHarnesses = [...harnesses.values()]
    .sort((left, right) => compareText(left.harnessId, right.harnessId))
    .map(freezeHarnessCounts);
  const source = Object.freeze({
    skills: skills.skills.length,
    files: skills.skills.reduce((count, skill) => count + skill.files.length, 0),
  });
  const frozenPhysicalOperations = freezeOperationCounts(physicalOperations);

  return Object.freeze({
    source,
    physicalOperations: frozenPhysicalOperations,
    stale: frozenPhysicalOperations.stale,
    satisfiedPlacements: resolution.satisfiedPlacements.length,
    warnings: warnings.length,
    failures: failures.length,
    harnesses: Object.freeze(frozenHarnesses),
  });
}

function ensureHarness(
  harnesses: Map<string, MutableHarnessCounts>,
  harnessId: string,
): MutableHarnessCounts {
  const existing = harnesses.get(harnessId);
  if (existing !== undefined) {
    return existing;
  }

  const created: MutableHarnessCounts = {
    harnessId,
    operations: emptyOperationCounts(),
    satisfiedPlacements: new Set(),
    placements: new Map(),
    warnings: 0,
    failures: 0,
  };
  harnesses.set(harnessId, created);
  return created;
}

function ensurePlacement(
  harnesses: Map<string, MutableHarnessCounts>,
  harnessId: string,
  placementId: string,
): MutableHarnessCounts {
  const harness = ensureHarness(harnesses, harnessId);
  if (!harness.placements.has(placementId)) {
    harness.placements.set(placementId, {
      placementId,
      operations: emptyOperationCounts(),
      satisfied: false,
      warnings: 0,
      failures: 0,
    });
  }
  return harness;
}

function emptyOperationCounts(): MutableOperationCounts {
  return {
    total: 0,
    create: 0,
    update: 0,
    adopt: 0,
    skip: 0,
    stale: 0,
    conflict: 0,
  };
}

function incrementOperation(
  counts: MutableOperationCounts,
  kind: PlanOperationKind,
): void {
  counts.total += 1;
  counts[kind] += 1;
}

function freezeOperationCounts(
  counts: MutableOperationCounts,
): OperationCounts {
  return Object.freeze({ ...counts });
}

function freezeHarnessCounts(
  harness: MutableHarnessCounts,
): HarnessSyncCounts {
  const placements = [...harness.placements.values()]
    .sort((left, right) => compareText(left.placementId, right.placementId))
    .map(
      (placement): PlacementSyncCounts =>
        Object.freeze({
          placementId: placement.placementId,
          operations: freezeOperationCounts(placement.operations),
          satisfied: placement.satisfied,
          warnings: placement.warnings,
          failures: placement.failures,
        }),
    );

  return Object.freeze({
    harnessId: harness.harnessId,
    operations: freezeOperationCounts(harness.operations),
    satisfiedPlacements: Object.freeze(
      [...harness.satisfiedPlacements].sort(compareText),
    ),
    warnings: harness.warnings,
    failures: harness.failures,
    placements: Object.freeze(placements),
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
