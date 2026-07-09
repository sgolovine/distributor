import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  readlink,
  realpath,
  symlink,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { DistributorError } from "../errors.js";
import {
  isStrictChildPath,
  pathComparisonKey,
  pathsAreEquivalent,
} from "../filesystem/paths.js";
import type { SourceRootIdentity } from "../skills/discover.js";
import type { ReadOnlySyncPlan } from "./plan.js";
import type {
  PlacementResolution,
  ResolvedTargetPlacement,
} from "./resolve-placements.js";
import {
  compareAttributions,
  compareStateEntries,
  persistManagedState,
  type LoadedManagedState,
  type ManagedState,
  type ManagedStateEntry,
} from "./state.js";
import type {
  OwnershipAttribution,
  PlanNotice,
  PlanOperation,
  PlanOperationKind,
} from "./types.js";

export interface ApplyFilesystem {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly readlink: (path: string) => Promise<string>;
  readonly realpath: (path: string) => Promise<string>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly symlink: (
    target: string,
    path: string,
    type: "file",
  ) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
}

export interface ApplySyncPlanOptions {
  readonly harnessId?: string;
  readonly platform?: NodeJS.Platform;
  readonly filesystem?: Partial<ApplyFilesystem>;
  readonly persistState?: typeof persistManagedState;
}

export type ApplyOperationStatus =
  | "created"
  | "updated"
  | "adopted"
  | "skipped"
  | "stale"
  | "failed";

export interface ApplyFailure {
  readonly phase: "parent" | "target" | "state";
  readonly message: string;
  readonly path: string;
  readonly correction: string;
  readonly operation?: PlanOperationKind;
  readonly harnessId?: string;
  readonly placementId?: string;
  readonly attributions?: readonly OwnershipAttribution[];
  readonly cause?: unknown;
}

export interface ApplyOperationResult {
  readonly operation: PlanOperation;
  readonly status: ApplyOperationStatus;
  readonly targetLinkMutated: boolean;
  readonly failure?: ApplyFailure;
}

export interface ApplySyncResult {
  readonly operations: readonly ApplyOperationResult[];
  readonly failures: readonly ApplyFailure[];
  readonly warnings: readonly PlanNotice[];
  readonly nextState: ManagedState;
  readonly statePersisted: boolean;
  readonly stateWritten: boolean;
}

interface ParentChain {
  readonly inspectionRoot: string;
  readonly verifyInspectionRoot: boolean;
  readonly targetRoot: string;
  readonly targetParent: string;
}

type TargetInspection =
  | { readonly kind: "absent" }
  | { readonly kind: "symlink"; readonly linkValue: string }
  | { readonly kind: "other"; readonly description: string };

class OperationFailure extends Error {
  readonly phase: "parent" | "target";
  readonly correction: string;
  readonly targetLinkMutated: boolean;

  constructor(
    phase: "parent" | "target",
    message: string,
    correction: string,
    options: {
      readonly cause?: unknown;
      readonly targetLinkMutated?: boolean;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "OperationFailure";
    this.phase = phase;
    this.correction = correction;
    this.targetLinkMutated = options.targetLinkMutated ?? false;
  }
}

const defaultFilesystem: ApplyFilesystem = {
  lstat,
  readlink,
  realpath,
  mkdir: async (path) => {
    await mkdir(path);
  },
  symlink: async (target, path, type) => {
    await symlink(target, path, type);
  },
  unlink,
};

export async function applySyncPlan(
  plan: ReadOnlySyncPlan,
  resolution: PlacementResolution,
  loadedState: LoadedManagedState,
  projectRoot: string,
  options: ApplySyncPlanOptions = {},
): Promise<ApplySyncResult> {
  if (
    !plan.applicable ||
    plan.failures.length > 0 ||
    plan.operations.some((operation) => operation.kind === "conflict")
  ) {
    throw new DistributorError(
      "conflict",
      "Cannot apply a sync plan that contains planning conflicts.",
      {
        operation: "apply sync plan",
        correction: "Resolve every planning conflict and build a new plan before applying.",
      },
    );
  }

  const filesystem: ApplyFilesystem = {
    ...defaultFilesystem,
    ...options.filesystem,
  };
  const platform = options.platform ?? process.platform;
  const priorByTarget = new Map(
    loadedState.entries.map((entry) => [pathComparisonKey(entry.targetPath), entry]),
  );
  const nextEntries = initialStateEntries(
    loadedState,
    plan,
    options.harnessId,
  );
  const operationResults: ApplyOperationResult[] = [];
  const failures: ApplyFailure[] = [];
  const reservedPhysicalTargets = new Map<string, string>();

  for (const operation of plan.operations) {
    const targetKey = pathComparisonKey(operation.targetPath);
    const priorEntry = priorByTarget.get(targetKey);

    try {
      const status = await applyOperation(
        operation,
        priorEntry,
        resolution,
        plan.sourceRootIdentity,
        filesystem,
        platform,
        reservedPhysicalTargets,
      );
      operationResults.push({
        operation,
        status,
        targetLinkMutated:
          operation.kind === "create" || operation.kind === "update",
      });
      recordSuccessfulOperation(
        nextEntries,
        operation,
        priorEntry,
        options.harnessId,
      );
    } catch (error) {
      const failure = operationFailure(operation, error);
      const targetLinkMutated =
        error instanceof OperationFailure
          ? error.targetLinkMutated
          : false;
      failures.push(failure);
      operationResults.push({
        operation,
        status: "failed",
        targetLinkMutated,
        failure,
      });

      await retainStateAfterFailure(
        nextEntries,
        targetKey,
        priorEntry,
        options.harnessId,
        filesystem,
      );
    }
  }

  const nextState: ManagedState = {
    version: 1,
    entries: [...nextEntries.values()].sort(compareStateEntries),
  };
  let statePersisted = false;
  let stateWritten = false;
  let persistenceWarnings: readonly PlanNotice[] = [];
  let returnedState = nextState;

  try {
    const persistence = await (options.persistState ?? persistManagedState)(
      loadedState,
      nextState,
      projectRoot,
    );
    statePersisted = true;
    stateWritten = persistence.written;
    persistenceWarnings = persistence.warnings;
  } catch (error) {
    const persistenceFailure = stateFailure(loadedState.path, error);
    failures.push(persistenceFailure);
    await reconcileAfterPersistenceFailure(
      operationResults,
      priorByTarget,
      persistenceFailure,
      failures,
      resolution,
      reservedPhysicalTargets,
      filesystem,
      platform,
    );
    returnedState = {
      version: 1,
      entries: [...loadedState.entries].sort(compareStateEntries),
    };
  }

  return {
    operations: operationResults,
    failures,
    warnings: [...plan.warnings, ...persistenceWarnings],
    nextState: returnedState,
    statePersisted,
    stateWritten,
  };
}

async function reconcileAfterPersistenceFailure(
  results: ApplyOperationResult[],
  priorByTarget: ReadonlyMap<string, ManagedStateEntry>,
  persistenceFailure: ApplyFailure,
  failures: ApplyFailure[],
  resolution: PlacementResolution,
  reservedPhysicalTargets: ReadonlyMap<string, string>,
  filesystem: ApplyFilesystem,
  platform: NodeJS.Platform,
): Promise<void> {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];
    if (result === undefined) {
      continue;
    }

    if (result.status === "adopted") {
      results[index] = {
        operation: result.operation,
        status: "failed",
        targetLinkMutated: false,
        failure: operationPersistenceFailure(
          result.operation,
          persistenceFailure,
        ),
      };
      continue;
    }

    const failedMutation =
      result.status === "failed" &&
      result.targetLinkMutated &&
      (result.operation.kind === "create" || result.operation.kind === "update");
    if (
      result.status !== "created" &&
      result.status !== "updated" &&
      !failedMutation
    ) {
      continue;
    }

    const priorEntry = priorByTarget.get(
      pathComparisonKey(result.operation.targetPath),
    );
    if (priorEntry === undefined) {
      continue;
    }

    try {
      if (failedMutation) {
        const current = await inspectTarget(
          result.operation.targetPath,
          filesystem,
        );
        if (current.kind === "absent") {
          continue;
        }
      }
      const placements = placementsForOperation(
        result.operation,
        resolution.placements,
      );
      if (placements.length === 0) {
        throw new OperationFailure(
          "parent",
          "No resolved placement owns this operation during rollback.",
          "Review the target and rebuild the sync plan before retrying.",
        );
      }
      const expectedPhysicalTarget = reservedPhysicalTargetKey(
        result.operation,
        reservedPhysicalTargets,
      );
      if (expectedPhysicalTarget === undefined) {
        throw new OperationFailure(
          "parent",
          "The physical target used during apply was not recorded for rollback.",
          "Review the target and rebuild the sync plan before retrying.",
        );
      }
      await rollbackManagedMutation(
        result.operation,
        priorEntry,
        placements,
        expectedPhysicalTarget,
        filesystem,
        platform,
      );
      if (failedMutation) {
        continue;
      }
      results[index] = {
        operation: result.operation,
        status: "failed",
        targetLinkMutated: true,
        failure: operationPersistenceFailure(
          result.operation,
          persistenceFailure,
        ),
      };
    } catch (error) {
      const failure = operationFailure(result.operation, error);
      failures.push(failure);
      if (failedMutation) {
        continue;
      }
      results[index] = {
        operation: result.operation,
        status: "failed",
        targetLinkMutated: true,
        failure,
      };
    }
  }
}

async function rollbackManagedMutation(
  operation: PlanOperation,
  priorEntry: ManagedStateEntry,
  placements: readonly ResolvedTargetPlacement[],
  expectedPhysicalTarget: string,
  filesystem: ApplyFilesystem,
  platform: NodeJS.Platform,
): Promise<void> {
  await prepareAndRevalidateParents(
    operation,
    placements,
    false,
    filesystem,
  );
  await requirePhysicalRollbackTarget(
    operation,
    expectedPhysicalTarget,
    filesystem,
  );
  const current = await inspectTarget(operation.targetPath, filesystem);
  if (current.kind === "symlink" && current.linkValue === priorEntry.linkValue) {
    return;
  }
  if (current.kind !== "symlink" || current.linkValue !== operation.linkValue) {
    throw new OperationFailure(
      "target",
      `Could not roll back the managed link because the target changed: ${operation.targetPath}`,
      "Review the target race manually; Distributor did not overwrite the changed path.",
    );
  }

  try {
    await filesystem.unlink(operation.targetPath);
  } catch (error) {
    throw new OperationFailure(
      "target",
      `Could not remove the new link during state-failure rollback: ${operation.targetPath}`,
      "Fix the target permissions and rerun sync; the on-disk state still records the prior link.",
      { cause: error },
    );
  }

  const afterRemoval = await inspectTarget(operation.targetPath, filesystem);
  if (afterRemoval.kind !== "absent") {
    throw new OperationFailure(
      "target",
      `Target changed during state-failure rollback: ${operation.targetPath}`,
      "Review the raced target manually; Distributor will not overwrite it.",
      { targetLinkMutated: true },
    );
  }

  if (operation.kind === "create") {
    return;
  }

  await prepareAndRevalidateParents(
    operation,
    placements,
    false,
    filesystem,
  );
  await requirePhysicalRollbackTarget(
    operation,
    expectedPhysicalTarget,
    filesystem,
  );

  try {
    await filesystem.symlink(
      priorEntry.linkValue,
      operation.targetPath,
      "file",
    );
  } catch (error) {
    throw symlinkFailure(operation.targetPath, error, platform, true);
  }

  const restored = await inspectTarget(operation.targetPath, filesystem);
  if (restored.kind !== "symlink" || restored.linkValue !== priorEntry.linkValue) {
    throw new OperationFailure(
      "target",
      `Prior managed link could not be verified after rollback: ${operation.targetPath}`,
      "Review the target manually before rerunning sync.",
      { targetLinkMutated: true },
    );
  }
}

function reservedPhysicalTargetKey(
  operation: PlanOperation,
  reserved: ReadonlyMap<string, string>,
): string | undefined {
  const logicalKey = pathComparisonKey(operation.targetPath);
  for (const [physicalKey, targetPath] of reserved) {
    if (pathComparisonKey(targetPath) === logicalKey) {
      return physicalKey;
    }
  }
  return undefined;
}

async function requirePhysicalRollbackTarget(
  operation: PlanOperation,
  expectedPhysicalTarget: string,
  filesystem: ApplyFilesystem,
): Promise<void> {
  const currentPhysicalTarget = await resolvePhysicalTargetPath(
    operation.targetPath,
    filesystem,
  );
  if (pathComparisonKey(currentPhysicalTarget) !== expectedPhysicalTarget) {
    throw new OperationFailure(
      "parent",
      `Physical target changed before state-failure rollback: ${operation.targetPath}`,
      "Restore the original parent chain and rerun sync; Distributor did not mutate the redirected target.",
    );
  }
}

function initialStateEntries(
  loadedState: LoadedManagedState,
  plan: ReadOnlySyncPlan,
  harnessId: string | undefined,
): Map<string, ManagedStateEntry> {
  const evaluationByTarget = new Map(
    plan.stateEvaluation.evaluated.map((result) => [
      pathComparisonKey(result.entry.targetPath),
      result,
    ]),
  );
  const desiredTargets = new Set(
    plan.operations
      .filter((operation) => operation.kind !== "stale")
      .map((operation) => pathComparisonKey(operation.targetPath)),
  );
  const entries = new Map<string, ManagedStateEntry>();

  for (const entry of loadedState.entries) {
    const key = pathComparisonKey(entry.targetPath);
    const evaluation = evaluationByTarget.get(key);

    if (evaluation === undefined || evaluation.status === "owned") {
      entries.set(key, entry);
      continue;
    }

    if (evaluation.status !== "missing" || desiredTargets.has(key)) {
      continue;
    }

    if (harnessId !== undefined) {
      const untouchedAttributions = entry.attributions.filter(
        (attribution) => attribution.harnessId !== harnessId,
      );
      if (untouchedAttributions.length > 0) {
        entries.set(key, {
          ...entry,
          attributions: untouchedAttributions,
        });
      }
    }
  }

  return entries;
}

async function applyOperation(
  operation: PlanOperation,
  priorEntry: ManagedStateEntry | undefined,
  resolution: PlacementResolution,
  sourceRootIdentity: SourceRootIdentity,
  filesystem: ApplyFilesystem,
  platform: NodeJS.Platform,
  reservedPhysicalTargets: Map<string, string>,
): Promise<Exclude<ApplyOperationStatus, "failed">> {
  if (operation.kind === "stale") {
    requirePriorOwnership(operation, priorEntry);
    await requireExactOwnership(operation, priorEntry, filesystem);
    return "stale";
  }

  if (operation.kind === "update") {
    requirePriorOwnership(operation, priorEntry);
    await requireExactOwnership(operation, priorEntry, filesystem);
  }

  await requireRegularSource(
    operation,
    resolution.sourceRoot,
    sourceRootIdentity,
    filesystem,
  );

  const placements = placementsForOperation(operation, resolution.placements);
  if (placements.length === 0) {
    throw new OperationFailure(
      "parent",
      "No resolved placement owns this operation during apply.",
      "Build a new plan from the current adapter placement resolution.",
    );
  }

  const mayCreateParents =
    operation.kind === "create" &&
    placements.every((placement) => placement.placement.createIfMissing);
  await prepareAndRevalidateParents(
    operation,
    placements,
    mayCreateParents,
    filesystem,
  );
  await reservePhysicalTarget(
    operation,
    reservedPhysicalTargets,
    filesystem,
  );

  switch (operation.kind) {
    case "create":
      await createTarget(operation, filesystem, platform);
      return "created";
    case "update":
      requirePriorOwnership(operation, priorEntry);
      await updateTarget(operation, priorEntry, filesystem, platform);
      return "updated";
    case "adopt":
      await adoptTarget(operation, filesystem);
      return "adopted";
    case "skip":
      requirePriorOwnership(operation, priorEntry);
      await skipTarget(operation, priorEntry, filesystem);
      return "skipped";
    case "conflict":
      throw new OperationFailure(
        "target",
        "A conflict operation cannot be applied.",
        "Resolve the conflict and rebuild the plan.",
      );
  }
}

async function requireRegularSource(
  operation: PlanOperation,
  sourceRoot: string,
  expectedSourceRoot: SourceRootIdentity,
  filesystem: ApplyFilesystem,
): Promise<void> {
  if (!isStrictChildPath(sourceRoot, operation.sourcePath)) {
    throw new OperationFailure(
      "target",
      `Source file escapes the canonical source root: ${operation.sourcePath}`,
      "Rebuild the sync plan from files contained by the configured source root.",
    );
  }

  let sourceRootStats: Stats;
  let currentRealSourceRoot: string;
  try {
    sourceRootStats = await filesystem.lstat(sourceRoot);
    currentRealSourceRoot = await filesystem.realpath(sourceRoot);
  } catch (error) {
    throw new OperationFailure(
      "target",
      `Source root changed or disappeared after planning: ${sourceRoot}`,
      "Restore the real source directory and rebuild the sync plan.",
      { cause: error },
    );
  }
  if (
    !sourceRootStats.isDirectory() ||
    sourceRootStats.dev !== expectedSourceRoot.device ||
    sourceRootStats.ino !== expectedSourceRoot.inode ||
    !pathsAreEquivalent(currentRealSourceRoot, expectedSourceRoot.realPath)
  ) {
    throw new OperationFailure(
      "target",
      `Source root identity changed after planning: ${sourceRoot}`,
      "Restore the original real source directory and rebuild the sync plan.",
    );
  }

  const sourceParent = dirname(operation.sourcePath);
  const relativeParent = relative(sourceRoot, sourceParent);
  let currentParent = sourceRoot;
  for (const segment of relativeParent === "" ? [] : relativeParent.split(sep)) {
    currentParent = resolve(currentParent, segment);
    let parentStats: Stats;
    try {
      parentStats = await filesystem.lstat(currentParent);
    } catch (error) {
      throw new OperationFailure(
        "target",
        `Source parent changed or disappeared after planning: ${currentParent}`,
        "Restore real source directories and rebuild the sync plan.",
        { cause: error },
      );
    }
    if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
      throw new OperationFailure(
        "target",
        `Source parent changed after planning and is not a real directory: ${currentParent}`,
        "Restore real source directories; Distributor will not traverse source symlinks.",
      );
    }
  }

  let stats: Stats;
  let physicalSource: string;
  try {
    stats = await filesystem.lstat(operation.sourcePath);
    physicalSource = await filesystem.realpath(operation.sourcePath);
  } catch (error) {
    throw new OperationFailure(
      "target",
      `Source file changed or disappeared after planning: ${operation.sourcePath}`,
      "Restore a regular source file and rebuild the sync plan.",
      { cause: error },
    );
  }

  if (!stats.isFile()) {
    const nodeType = stats.isSymbolicLink()
      ? "a symbolic link"
      : describeNode(stats);
    throw new OperationFailure(
      "target",
      `Source file changed after planning and is now ${nodeType}: ${operation.sourcePath}`,
      "Restore a regular source file; Distributor will not link through source symlinks.",
    );
  }
  if (!isStrictChildPath(expectedSourceRoot.realPath, physicalSource)) {
    throw new OperationFailure(
      "target",
      `Source file resolves outside the canonical source root: ${operation.sourcePath}`,
      "Restore the source file beneath the real source root and rebuild the plan.",
    );
  }
}

function requirePriorOwnership(
  operation: PlanOperation,
  priorEntry: ManagedStateEntry | undefined,
): asserts priorEntry is ManagedStateEntry {
  if (priorEntry === undefined) {
    throw new OperationFailure(
      "target",
      `Operation ${operation.kind} requires a prior managed-state entry.`,
      "Reload managed state and build a new sync plan.",
    );
  }
}

async function createTarget(
  operation: PlanOperation,
  filesystem: ApplyFilesystem,
  platform: NodeJS.Platform,
): Promise<void> {
  const target = await inspectTarget(operation.targetPath, filesystem);
  if (target.kind !== "absent") {
    throw targetRaceFailure(operation.targetPath, target);
  }

  try {
    await filesystem.symlink(
      operation.linkValue,
      operation.targetPath,
      "file",
    );
  } catch (error) {
    throw symlinkFailure(operation.targetPath, error, platform, false);
  }

  await verifyDesiredLink(operation, filesystem, true);
}

async function updateTarget(
  operation: PlanOperation,
  priorEntry: ManagedStateEntry,
  filesystem: ApplyFilesystem,
  platform: NodeJS.Platform,
): Promise<void> {
  await requireExactOwnership(operation, priorEntry, filesystem);

  try {
    await filesystem.unlink(operation.targetPath);
  } catch (error) {
    throw new OperationFailure(
      "target",
      `Could not remove the unchanged managed link: ${operation.targetPath}`,
      "Fix the target permissions and rerun sync; unmanaged content was not overwritten.",
      { cause: error },
    );
  }

  const afterRemoval = await inspectTarget(operation.targetPath, filesystem);
  if (afterRemoval.kind !== "absent") {
    throw new OperationFailure(
      "target",
      `Target changed after its managed link was removed: ${operation.targetPath}`,
      "Review the raced target and rerun sync; Distributor will not overwrite it.",
      { targetLinkMutated: true },
    );
  }

  try {
    await filesystem.symlink(
      operation.linkValue,
      operation.targetPath,
      "file",
    );
  } catch (error) {
    throw symlinkFailure(operation.targetPath, error, platform, true);
  }

  await verifyDesiredLink(operation, filesystem, true);
}

async function adoptTarget(
  operation: PlanOperation,
  filesystem: ApplyFilesystem,
): Promise<void> {
  const target = await inspectTarget(operation.targetPath, filesystem);
  if (
    target.kind !== "symlink" ||
    target.linkValue !== operation.linkValue ||
    !linkResolvesTo(
      target.linkValue,
      operation.targetPath,
      operation.sourcePath,
    )
  ) {
    throw new OperationFailure(
      "target",
      `Adopted target changed after planning: ${operation.targetPath}`,
      "Review the target and rebuild the plan; Distributor did not replace it.",
    );
  }
}

async function skipTarget(
  operation: PlanOperation,
  priorEntry: ManagedStateEntry,
  filesystem: ApplyFilesystem,
): Promise<void> {
  await requireExactOwnership(operation, priorEntry, filesystem);
  await verifyDesiredLink(operation, filesystem, false);
}

async function requireExactOwnership(
  operation: PlanOperation,
  priorEntry: ManagedStateEntry,
  filesystem: ApplyFilesystem,
): Promise<void> {
  if (!(await hasExactOwnership(priorEntry, filesystem))) {
    throw new OperationFailure(
      "target",
      `Managed target ownership changed after planning: ${operation.targetPath}`,
      "Review the target and rebuild the plan; Distributor will not overwrite it.",
    );
  }
}

async function verifyDesiredLink(
  operation: PlanOperation,
  filesystem: ApplyFilesystem,
  targetLinkMutated: boolean,
): Promise<void> {
  const target = await inspectTarget(operation.targetPath, filesystem);
  if (
    target.kind !== "symlink" ||
    target.linkValue !== operation.linkValue ||
    !linkResolvesTo(
      target.linkValue,
      operation.targetPath,
      operation.sourcePath,
    )
  ) {
    throw new OperationFailure(
      "target",
      `Target does not match the desired link after apply: ${operation.targetPath}`,
      "Review the target and rerun sync; Distributor did not record ownership.",
      { targetLinkMutated },
    );
  }
}

async function hasExactOwnership(
  entry: ManagedStateEntry,
  filesystem: ApplyFilesystem,
): Promise<boolean> {
  try {
    const stats = await filesystem.lstat(entry.targetPath);
    return (
      stats.isSymbolicLink() &&
      (await filesystem.readlink(entry.targetPath)) === entry.linkValue
    );
  } catch {
    return false;
  }
}

async function retainStateAfterFailure(
  entries: Map<string, ManagedStateEntry>,
  targetKey: string,
  priorEntry: ManagedStateEntry | undefined,
  harnessId: string | undefined,
  filesystem: ApplyFilesystem,
): Promise<void> {
  if (
    priorEntry !== undefined &&
    (await hasExactOwnership(priorEntry, filesystem))
  ) {
    entries.set(targetKey, priorEntry);
    return;
  }

  if (priorEntry !== undefined && harnessId !== undefined) {
    const untouchedAttributions = priorEntry.attributions.filter(
      (attribution) => attribution.harnessId !== harnessId,
    );
    if (untouchedAttributions.length > 0) {
      entries.set(targetKey, {
        ...priorEntry,
        attributions: untouchedAttributions,
      });
      return;
    }
  }

  entries.delete(targetKey);
}

function recordSuccessfulOperation(
  entries: Map<string, ManagedStateEntry>,
  operation: PlanOperation,
  priorEntry: ManagedStateEntry | undefined,
  harnessId: string | undefined,
): void {
  if (operation.kind === "stale") {
    if (priorEntry !== undefined) {
      entries.set(pathComparisonKey(operation.targetPath), priorEntry);
    }
    return;
  }

  const attributions = mergeAttributions(
    priorEntry?.attributions ?? [],
    operation.attributions,
    harnessId,
  );
  entries.set(pathComparisonKey(operation.targetPath), {
    sourcePath: operation.sourcePath,
    targetPath: operation.targetPath,
    linkValue: operation.linkValue,
    attributions,
  });
}

function mergeAttributions(
  prior: readonly OwnershipAttribution[],
  desired: readonly OwnershipAttribution[],
  harnessId: string | undefined,
): OwnershipAttribution[] {
  const candidates =
    harnessId === undefined
      ? desired
      : [
          ...prior.filter(
            (attribution) => attribution.harnessId !== harnessId,
          ),
          ...desired,
        ];
  return [
    ...new Map(
      candidates.map((attribution) => [
        `${attribution.harnessId}\0${attribution.placementId}`,
        attribution,
      ]),
    ).values(),
  ].sort(compareAttributions);
}

function placementsForOperation(
  operation: PlanOperation,
  placements: readonly ResolvedTargetPlacement[],
): ResolvedTargetPlacement[] {
  const matching = placements.filter(
    (placement) =>
      operation.attributions.some(
        (attribution) =>
          attribution.harnessId === placement.harnessId &&
          attribution.placementId === placement.placement.id,
      ) && isStrictChildPath(placement.targetRoot, operation.targetPath),
  );
  const unique = new Map<string, ResolvedTargetPlacement>();

  for (const placement of matching) {
    unique.set(
      `${placement.harnessId}\0${placement.placement.id}\0${pathComparisonKey(placement.targetRoot)}`,
      placement,
    );
  }

  return [...unique.values()].sort(
    (left, right) =>
      compareText(left.harnessId, right.harnessId) ||
      compareText(left.placement.id, right.placement.id) ||
      compareText(left.targetRoot, right.targetRoot),
  );
}

async function reservePhysicalTarget(
  operation: PlanOperation,
  reserved: Map<string, string>,
  filesystem: ApplyFilesystem,
): Promise<void> {
  const physicalPath = await resolvePhysicalTargetPath(
    operation.targetPath,
    filesystem,
  );
  const physicalKey = pathComparisonKey(physicalPath);
  const logicalKey = pathComparisonKey(operation.targetPath);
  const existingTarget = reserved.get(physicalKey);

  if (
    existingTarget !== undefined &&
    pathComparisonKey(existingTarget) !== logicalKey
  ) {
    throw new OperationFailure(
      "parent",
      `Target ${operation.targetPath} now aliases reserved physical target ${physicalPath}.`,
      "Restore distinct real parent paths and rebuild the sync plan.",
    );
  }

  reserved.set(physicalKey, operation.targetPath);
}

async function resolvePhysicalTargetPath(
  targetPath: string,
  filesystem: ApplyFilesystem,
): Promise<string> {
  let candidate = dirname(targetPath);
  let suffix = basename(targetPath);

  while (true) {
    try {
      return resolve(await filesystem.realpath(candidate), suffix);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw new OperationFailure(
          "parent",
          `Could not resolve physical target parent ${candidate}: ${errorMessage(error)}`,
          "Fix the target parent or its permissions and rebuild the plan.",
          { cause: error },
        );
      }

      const parent = dirname(candidate);
      if (parent === candidate) {
        throw new OperationFailure(
          "parent",
          `Could not resolve a physical path for target ${targetPath}.`,
          "Choose a target beneath an existing real directory.",
        );
      }
      suffix = join(basename(candidate), suffix);
      candidate = parent;
    }
  }
}

async function prepareAndRevalidateParents(
  operation: PlanOperation,
  placements: readonly ResolvedTargetPlacement[],
  mayCreate: boolean,
  filesystem: ApplyFilesystem,
): Promise<void> {
  const chains = await parentChains(operation, placements, filesystem);

  for (const chain of chains) {
    await inspectParentChain(chain, mayCreate, filesystem);
  }
  for (const chain of chains) {
    await inspectParentChain(chain, false, filesystem);
  }
}

async function parentChains(
  operation: PlanOperation,
  placements: readonly ResolvedTargetPlacement[],
  filesystem: ApplyFilesystem,
): Promise<ParentChain[]> {
  const targetParent = dirname(operation.targetPath);
  const unique = new Map<string, ParentChain>();

  for (const placement of placements) {
    if (
      !pathsAreEquivalent(placement.targetRoot, targetParent) &&
      !isStrictChildPath(placement.targetRoot, targetParent)
    ) {
      throw new OperationFailure(
        "parent",
        `Target parent escapes resolved target root ${placement.targetRoot}.`,
        "Rebuild the plan from non-overlapping target placements.",
      );
    }

    const absoluteLink = isAbsolute(operation.linkValue);
    const inspection = absoluteLink
      ? await absoluteInspectionRoot(placement.targetRoot, filesystem)
      : {
          path: commonAncestor(
            operation.sourcePath,
            placement.targetRoot,
          ),
          verifyCanonical: false,
        };
    const chain = {
      inspectionRoot: inspection.path,
      verifyInspectionRoot: inspection.verifyCanonical,
      targetRoot: placement.targetRoot,
      targetParent,
    };
    unique.set(
      `${pathComparisonKey(inspection.path)}\0${pathComparisonKey(placement.targetRoot)}\0${pathComparisonKey(targetParent)}`,
      chain,
    );
  }

  return [...unique.values()];
}

async function absoluteInspectionRoot(
  targetRoot: string,
  filesystem: ApplyFilesystem,
): Promise<{ readonly path: string; readonly verifyCanonical: boolean }> {
  let candidate = targetRoot;

  while (true) {
    try {
      await filesystem.lstat(candidate);
      return {
        path: candidate,
        verifyCanonical: !pathsAreEquivalent(candidate, targetRoot),
      };
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw new OperationFailure(
          "parent",
          `Could not inspect target-root ancestor ${candidate}: ${errorMessage(error)}`,
          "Fix the ancestor path or its permissions and rebuild the plan.",
          { cause: error },
        );
      }

      const parent = dirname(candidate);
      if (parent === candidate) {
        throw new OperationFailure(
          "parent",
          `No existing target-root ancestor was found for ${targetRoot}.`,
          "Choose a target beneath an existing real directory.",
        );
      }
      candidate = parent;
    }
  }
}

async function inspectParentChain(
  chain: ParentChain,
  mayCreate: boolean,
  filesystem: ApplyFilesystem,
): Promise<void> {
  for (const parentPath of pathsInChain(
    chain.inspectionRoot,
    chain.targetParent,
  )) {
    let stats: Stats;
    try {
      stats = await filesystem.lstat(parentPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw new OperationFailure(
          "parent",
          `Could not inspect target parent ${parentPath}: ${errorMessage(error)}`,
          "Fix the parent path or its permissions and rebuild the plan.",
          { cause: error },
        );
      }
      if (!mayCreate) {
        throw new OperationFailure(
          "parent",
          `Required target parent disappeared after planning: ${parentPath}`,
          "Restore the directory or select a placement that allows creation.",
        );
      }

      try {
        await filesystem.mkdir(parentPath);
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") {
          throw new OperationFailure(
            "parent",
            `Could not create target parent ${parentPath}: ${errorMessage(mkdirError)}`,
            "Fix the parent permissions and rerun sync.",
            { cause: mkdirError },
          );
        }
      }

      try {
        stats = await filesystem.lstat(parentPath);
      } catch (inspectError) {
        throw new OperationFailure(
          "parent",
          `Could not revalidate created target parent ${parentPath}: ${errorMessage(inspectError)}`,
          "Review the raced parent path and rebuild the plan.",
          { cause: inspectError },
        );
      }
    }

    await validateParent(
      parentPath,
      stats,
      chain.targetRoot,
      filesystem,
      chain.verifyInspectionRoot &&
        pathsAreEquivalent(parentPath, chain.inspectionRoot),
    );
  }
}

function pathsInChain(inspectionRoot: string, targetParent: string): string[] {
  const relativeParent = relative(inspectionRoot, targetParent);
  if (
    relativeParent === ".." ||
    relativeParent.startsWith(`..${sep}`) ||
    isAbsolute(relativeParent)
  ) {
    throw new OperationFailure(
      "parent",
      `Target parent ${targetParent} escapes inspection root ${inspectionRoot}.`,
      "Rebuild the plan from safe source and target roots.",
    );
  }

  const paths = [inspectionRoot];
  let current = inspectionRoot;
  for (const segment of relativeParent === "" ? [] : relativeParent.split(sep)) {
    current = resolve(current, segment);
    paths.push(current);
  }
  return paths;
}

async function validateParent(
  parentPath: string,
  stats: Stats,
  targetRoot: string,
  filesystem: ApplyFilesystem,
  verifyCanonical: boolean,
): Promise<void> {
  if (!stats.isSymbolicLink()) {
    if (!stats.isDirectory()) {
      throw new OperationFailure(
        "parent",
        `Target parent is not a directory: ${parentPath}`,
        "Move the blocking node aside without overwriting it and rebuild the plan.",
      );
    }
    if (verifyCanonical) {
      let canonicalPath: string;
      try {
        canonicalPath = await filesystem.realpath(parentPath);
      } catch (error) {
        throw new OperationFailure(
          "parent",
          `Could not resolve existing target-root ancestor ${parentPath}: ${errorMessage(error)}`,
          "Fix the ancestor path or its permissions and rebuild the plan.",
          { cause: error },
        );
      }
      if (!pathsAreEquivalent(canonicalPath, parentPath)) {
        throw new OperationFailure(
          "parent",
          `Existing target-root ancestor is redirected to ${canonicalPath}: ${parentPath}`,
          "Choose a target beneath a real, non-redirected directory.",
        );
      }
    }
    return;
  }

  let linkValue: string;
  let resolvedTarget: string;
  try {
    linkValue = await filesystem.readlink(parentPath);
    resolvedTarget = await filesystem.realpath(parentPath);
  } catch (error) {
    throw new OperationFailure(
      "parent",
      `Could not resolve target-parent symbolic link ${parentPath}: ${errorMessage(error)}`,
      "Repair the parent link and rebuild the plan.",
      { cause: error },
    );
  }

  const lexicalTarget = isAbsolute(linkValue)
    ? resolve(linkValue)
    : resolve(dirname(parentPath), linkValue);
  if (
    !isContainedBy(targetRoot, lexicalTarget) ||
    !isContainedBy(targetRoot, resolvedTarget)
  ) {
    throw new OperationFailure(
      "parent",
      `Target-parent symbolic link escapes target root ${targetRoot}: ${parentPath}`,
      "Replace the escaping parent link with a real directory inside the target root.",
    );
  }

  try {
    const resolvedStats = await filesystem.lstat(resolvedTarget);
    if (!resolvedStats.isDirectory()) {
      throw new OperationFailure(
        "parent",
        `Target-parent link does not resolve to a directory: ${parentPath}`,
        "Repair the parent link and rebuild the plan.",
      );
    }
  } catch (error) {
    if (error instanceof OperationFailure) {
      throw error;
    }
    throw new OperationFailure(
      "parent",
      `Could not inspect resolved target parent ${resolvedTarget}: ${errorMessage(error)}`,
      "Repair the parent link and rebuild the plan.",
      { cause: error },
    );
  }
}

async function inspectTarget(
  targetPath: string,
  filesystem: ApplyFilesystem,
): Promise<TargetInspection> {
  let stats: Stats;
  try {
    stats = await filesystem.lstat(targetPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { kind: "absent" };
    }
    throw new OperationFailure(
      "target",
      `Could not inspect target ${targetPath}: ${errorMessage(error)}`,
      "Fix the target permissions and rebuild the plan.",
      { cause: error },
    );
  }

  if (!stats.isSymbolicLink()) {
    return { kind: "other", description: describeNode(stats) };
  }

  try {
    return {
      kind: "symlink",
      linkValue: await filesystem.readlink(targetPath),
    };
  } catch (error) {
    throw new OperationFailure(
      "target",
      `Could not read target symbolic link ${targetPath}: ${errorMessage(error)}`,
      "Fix the target permissions and rebuild the plan.",
      { cause: error },
    );
  }
}

function targetRaceFailure(
  targetPath: string,
  target: Exclude<TargetInspection, { readonly kind: "absent" }>,
): OperationFailure {
  const description =
    target.kind === "symlink" ? "a symbolic link" : target.description;
  return new OperationFailure(
    "target",
    `Target appeared after planning as ${description}: ${targetPath}`,
    "Review the raced target and rerun sync; Distributor did not overwrite it.",
  );
}

function symlinkFailure(
  targetPath: string,
  error: unknown,
  platform: NodeJS.Platform,
  targetLinkMutated: boolean,
): OperationFailure {
  const privilegeFailure =
    platform === "win32" &&
    (errorCode(error) === "EPERM" || errorCode(error) === "EACCES");
  return new OperationFailure(
    "target",
    privilegeFailure
      ? `Windows could not create a file symbolic link at ${targetPath}.`
      : `Could not create file symbolic link at ${targetPath}: ${errorMessage(error)}`,
    privilegeFailure
      ? "Enable Windows Developer Mode or grant symbolic-link privileges, then rerun sync. Distributor will not copy files or create junctions."
      : "Fix the target permissions and rerun sync; Distributor will not copy files or create junctions.",
    { cause: error, targetLinkMutated },
  );
}

function operationFailure(
  operation: PlanOperation,
  error: unknown,
): ApplyFailure {
  const attributions = [...operation.attributions].sort(compareAttributions);
  const attribution = attributions[0];
  const failure =
    error instanceof OperationFailure
      ? error
      : new OperationFailure(
          "target",
          `Unexpected apply failure at ${operation.targetPath}: ${errorMessage(error)}`,
          "Review the target and rerun sync.",
          { cause: error },
        );
  return {
    phase: failure.phase,
    operation: operation.kind,
    path: operation.targetPath,
    message: failure.message,
    correction: failure.correction,
    attributions,
    ...(attribution === undefined
      ? {}
      : {
          harnessId: attribution.harnessId,
          placementId: attribution.placementId,
        }),
    ...(failure.cause === undefined ? {} : { cause: failure.cause }),
  };
}

function operationPersistenceFailure(
  operation: PlanOperation,
  failure: ApplyFailure,
): ApplyFailure {
  const attributions = [...operation.attributions].sort(compareAttributions);
  const attribution = attributions[0];
  return {
    ...failure,
    operation: operation.kind,
    attributions,
    ...(attribution === undefined
      ? {}
      : {
          harnessId: attribution.harnessId,
          placementId: attribution.placementId,
        }),
  };
}

function stateFailure(statePath: string, error: unknown): ApplyFailure {
  const failure =
    error instanceof DistributorError
      ? error
      : new DistributorError(
          "filesystem",
          `Could not persist managed state: ${statePath}`,
          {
            operation: "persist managed state",
            context: { statePath },
            correction:
              "Fix state-directory permissions and rerun sync; Distributor restores prior managed links when safe.",
            cause: error,
          },
        );
  return {
    phase: "state",
    path: statePath,
    message: failure.message,
    correction:
      failure.correction ??
      "Fix state-directory permissions and rerun sync; Distributor restores prior managed links when safe.",
    ...(failure.cause === undefined ? {} : { cause: failure.cause }),
  };
}

function linkResolvesTo(
  linkValue: string,
  targetPath: string,
  expectedSourcePath: string,
): boolean {
  const resolvedLink = isAbsolute(linkValue)
    ? resolve(linkValue)
    : resolve(dirname(targetPath), linkValue);
  return pathsAreEquivalent(resolvedLink, expectedSourcePath);
}

function commonAncestor(left: string, right: string): string {
  let candidate = dirname(left);
  while (!isContainedBy(candidate, right)) {
    const parent = dirname(candidate);
    if (parent === candidate) {
      return candidate;
    }
    candidate = parent;
  }
  return candidate;
}

function isContainedBy(parent: string, candidate: string): boolean {
  return (
    pathsAreEquivalent(parent, candidate) ||
    isStrictChildPath(parent, candidate)
  );
}

function describeNode(stats: Stats): string {
  if (stats.isDirectory()) {
    return "a directory";
  }
  if (stats.isFile()) {
    return "a regular file";
  }
  return "an unsupported filesystem node";
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
