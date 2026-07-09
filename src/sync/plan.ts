import type { Stats } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  isStrictChildPath,
  pathComparisonKey,
  pathsAreEquivalent,
} from "../filesystem/paths.js";
import type {
  PlacementResolution,
  ResolvedTargetPlacement,
} from "./resolve-placements.js";
import {
  evaluateManagedState,
  type ManagedState,
  type ManagedStateEntry,
  type StateEvaluation,
  type StateOwnershipResult,
} from "./state.js";
import type {
  OwnershipAttribution,
  PlannedFile,
  PlanFailure,
  PlanNotice,
  PlanOperation,
  SyncPlan,
} from "./types.js";

export interface BuildSyncPlanOptions {
  readonly harnessId?: string;
}

export interface ReadOnlySyncPlan extends SyncPlan {
  readonly applicable: boolean;
  readonly stateEvaluation: StateEvaluation;
}

interface ParentProblem {
  readonly path: string;
  readonly message: string;
}

type TargetInspection =
  | { readonly kind: "absent" }
  | { readonly kind: "symlink"; readonly linkValue: string }
  | { readonly kind: "other"; readonly description: string }
  | { readonly kind: "error"; readonly message: string };

interface Classification {
  readonly operation: PlanOperation;
  readonly problem?: ParentProblem;
}

interface PhysicalTargetRecord {
  readonly mapping: PlannedFile;
  readonly physicalPath: string;
}

export async function buildSyncPlan(
  resolution: PlacementResolution,
  state: ManagedState,
  options: BuildSyncPlanOptions = {},
): Promise<ReadOnlySyncPlan> {
  const stateEvaluation = await evaluateManagedState(state, options.harnessId);
  const desiredMappings = [...resolution.mappings].sort(comparePlannedFiles);
  const desiredTargets = new Set(
    desiredMappings.map((mapping) => pathComparisonKey(mapping.targetPath)),
  );
  const stateByTarget = new Map(
    state.entries.map((entry) => [pathComparisonKey(entry.targetPath), entry]),
  );
  const evaluationByTarget = new Map(
    stateEvaluation.evaluated.map((result) => [
      pathComparisonKey(result.entry.targetPath),
      result,
    ]),
  );
  const operations: PlanOperation[] = [];
  const failures: PlanFailure[] = [];
  const physicalTargets: PhysicalTargetRecord[] = [];

  for (const result of stateEvaluation.evaluated) {
    if (
      result.status === "conflict" &&
      !desiredTargets.has(pathComparisonKey(result.entry.targetPath))
    ) {
      failures.push(stateConflictFailure(result, options.harnessId));
    }
  }

  for (const mapping of desiredMappings) {
    const parentProblems = await inspectMappingParents(mapping, resolution);
    const target = await inspectTarget(mapping.targetPath);
    const physicalPath = await resolvePhysicalTargetPath(mapping.targetPath);
    if (physicalPath !== undefined) {
      physicalTargets.push({ mapping, physicalPath });
    }
    const stateEntry = stateByTarget.get(pathComparisonKey(mapping.targetPath));
    const stateResult = evaluationByTarget.get(
      pathComparisonKey(mapping.targetPath),
    );
    const classification = classifyDesiredTarget(
      mapping,
      target,
      stateEntry,
      stateResult,
      options.harnessId,
    );
    const reasons = [...parentProblems];

    if (classification.problem !== undefined) {
      reasons.push(classification.problem);
    }

    if (reasons.length === 0) {
      operations.push(classification.operation);
      continue;
    }

    for (const problem of reasons) {
      failures.push(mappingFailure(mapping, problem));
    }
    operations.push({
      ...mapping,
      kind: "conflict",
      reason: reasons.map((problem) => problem.message).join(" "),
    });
  }

  applyPhysicalAliasConflicts(physicalTargets, operations, failures);

  for (const result of stateEvaluation.evaluated) {
    if (
      result.status === "owned" &&
      !desiredTargets.has(pathComparisonKey(result.entry.targetPath))
    ) {
      operations.push(staleOperation(result.entry, options.harnessId));
    }
  }

  operations.sort(compareOperations);
  const sortedFailures = deduplicateNotices(failures).sort(compareNotices);

  return {
    applicable:
      sortedFailures.length === 0 &&
      !operations.some((operation) => operation.kind === "conflict"),
    operations,
    satisfiedPlacements: [...resolution.satisfiedPlacements].sort(
      (left, right) =>
        compareText(left.harnessId, right.harnessId) ||
        compareText(left.placementId, right.placementId),
    ),
    warnings: deduplicateNotices(resolution.warnings).sort(compareNotices),
    failures: sortedFailures,
    stateEvaluation,
  };
}

async function inspectMappingParents(
  mapping: PlannedFile,
  resolution: PlacementResolution,
): Promise<ParentProblem[]> {
  const placements = placementsForMapping(mapping, resolution.placements);
  const problems: ParentProblem[] = [];

  if (placements.length === 0) {
    return [
      {
        path: mapping.targetPath,
        message: "No resolved placement owns this desired target mapping.",
      },
    ];
  }

  for (const placement of placements) {
    problems.push(
      ...(await inspectParentChain(
        placement.targetRoot,
        dirname(mapping.targetPath),
        placement.placement.createIfMissing,
        isAbsolute(mapping.linkValue)
          ? placement.targetRoot
          : commonAncestor(mapping.sourcePath, placement.targetRoot),
      )),
    );
  }

  return deduplicateParentProblems(problems).sort(compareParentProblems);
}

function placementsForMapping(
  mapping: PlannedFile,
  placements: readonly ResolvedTargetPlacement[],
): ResolvedTargetPlacement[] {
  const selected = placements.filter(
    (placement) =>
      mapping.attributions.some(
        (attribution) =>
          attribution.harnessId === placement.harnessId &&
          attribution.placementId === placement.placement.id,
      ) && isStrictChildPath(placement.targetRoot, mapping.targetPath),
  );
  const unique = new Map<string, ResolvedTargetPlacement>();

  for (const placement of selected) {
    const key = `${placement.harnessId}\0${placement.placement.id}\0${pathComparisonKey(placement.targetRoot)}`;
    unique.set(key, placement);
  }

  return [...unique.values()].sort(compareResolvedPlacements);
}

async function inspectParentChain(
  targetRoot: string,
  targetParent: string,
  createIfMissing: boolean,
  inspectionRoot: string,
): Promise<ParentProblem[]> {
  if (
    !pathsAreEquivalent(targetRoot, targetParent) &&
    !isStrictChildPath(targetRoot, targetParent)
  ) {
    return [
      {
        path: targetParent,
        message: `Target parent escapes resolved target root ${targetRoot}.`,
      },
    ];
  }

  const relativeParent = relative(inspectionRoot, targetParent);
  const segments = relativeParent === "" ? [] : relativeParent.split(sep);
  const paths = [inspectionRoot];
  let current = inspectionRoot;
  for (const segment of segments) {
    current = resolve(current, segment);
    paths.push(current);
  }

  for (const parentPath of paths) {
    let stats: Stats;
    try {
      stats = await lstat(parentPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        if (pathsAreEquivalent(parentPath, targetRoot)) {
          const ancestorProblem = await inspectMissingRootAncestor(targetRoot);
          if (ancestorProblem !== undefined) {
            return [ancestorProblem];
          }
        }
        return createIfMissing
          ? []
          : [
              {
                path: parentPath,
                message:
                  "A required target parent is missing and this placement does not allow directory creation.",
              },
            ];
      }
      return [
        {
          path: parentPath,
          message: `Could not inspect target parent: ${errorMessage(error)}.`,
        },
      ];
    }

    if (stats.isSymbolicLink()) {
      const problem = await inspectParentSymlink(parentPath, targetRoot);
      if (problem !== undefined) {
        return [problem];
      }
      continue;
    }

    if (!stats.isDirectory()) {
      return [
        {
          path: parentPath,
          message: `Target parent is ${describeNode(stats)}, not a directory.`,
        },
      ];
    }
  }

  return [];
}

async function inspectMissingRootAncestor(
  targetRoot: string,
): Promise<ParentProblem | undefined> {
  let candidate = dirname(targetRoot);

  while (true) {
    let stats: Stats;
    try {
      stats = await lstat(candidate);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        return {
          path: candidate,
          message: `Could not inspect existing target-root ancestor: ${errorMessage(error)}.`,
        };
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        return undefined;
      }
      candidate = parent;
      continue;
    }

    if (stats.isSymbolicLink()) {
      let linkValue: string;
      try {
        linkValue = await readlink(candidate);
      } catch (error) {
        return {
          path: candidate,
          message: `Could not read target-root ancestor symbolic link: ${errorMessage(error)}.`,
        };
      }
      return {
        path: candidate,
        message: `Existing target-root ancestor redirects through symbolic link ${JSON.stringify(linkValue)}.`,
      };
    }

    if (!stats.isDirectory()) {
      return {
        path: candidate,
        message: `Existing target-root ancestor is ${describeNode(stats)}, not a directory.`,
      };
    }

    try {
      const canonical = await realpath(candidate);
      if (!pathsAreEquivalent(canonical, candidate)) {
        return {
          path: candidate,
          message: `Existing target-root ancestor is redirected by a symbolic link to ${canonical}.`,
        };
      }
    } catch (error) {
      return {
        path: candidate,
        message: `Could not resolve existing target-root ancestor safely: ${errorMessage(error)}.`,
      };
    }

    return undefined;
  }
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

async function inspectParentSymlink(
  parentPath: string,
  targetRoot: string,
): Promise<ParentProblem | undefined> {
  let linkValue: string;
  try {
    linkValue = await readlink(parentPath);
  } catch (error) {
    return {
      path: parentPath,
      message: `Could not read target-parent symbolic link: ${errorMessage(error)}.`,
    };
  }

  const lexicalTarget = isAbsolute(linkValue)
    ? resolve(linkValue)
    : resolve(dirname(parentPath), linkValue);
  if (!isContainedBy(targetRoot, lexicalTarget)) {
    return {
      path: parentPath,
      message: `Target-parent symbolic link escapes target root ${targetRoot}.`,
    };
  }

  let resolvedTarget: string;
  try {
    resolvedTarget = await realpath(parentPath);
  } catch (error) {
    return {
      path: parentPath,
      message: `Target-parent symbolic link cannot be resolved safely: ${errorMessage(error)}.`,
    };
  }

  if (!isContainedBy(targetRoot, resolvedTarget)) {
    return {
      path: parentPath,
      message: `Resolved target-parent symbolic link escapes target root ${targetRoot}.`,
    };
  }

  try {
    const resolvedStats = await lstat(resolvedTarget);
    if (!resolvedStats.isDirectory()) {
      return {
        path: parentPath,
        message: "Target-parent symbolic link does not resolve to a directory.",
      };
    }
  } catch (error) {
    return {
      path: parentPath,
      message: `Could not inspect resolved target parent: ${errorMessage(error)}.`,
    };
  }

  return undefined;
}

function isContainedBy(parent: string, candidate: string): boolean {
  return (
    pathsAreEquivalent(parent, candidate) ||
    isStrictChildPath(parent, candidate)
  );
}

async function inspectTarget(targetPath: string): Promise<TargetInspection> {
  let stats: Stats;
  try {
    stats = await lstat(targetPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { kind: "absent" };
    }
    return {
      kind: "error",
      message: `Could not inspect target: ${errorMessage(error)}.`,
    };
  }

  if (!stats.isSymbolicLink()) {
    return { kind: "other", description: describeNode(stats) };
  }

  try {
    return { kind: "symlink", linkValue: await readlink(targetPath) };
  } catch (error) {
    return {
      kind: "error",
      message: `Could not read target symbolic link: ${errorMessage(error)}.`,
    };
  }
}

function classifyDesiredTarget(
  mapping: PlannedFile,
  target: TargetInspection,
  stateEntry: ManagedStateEntry | undefined,
  stateResult: StateOwnershipResult | undefined,
  harnessId: string | undefined,
): Classification {
  if (stateResult?.status === "conflict") {
    return conflictClassification(
      mapping,
      stateResult.reason ?? "The recorded managed target was modified.",
    );
  }

  if (stateEntry !== undefined) {
    return classifyRecordedTarget(
      mapping,
      target,
      stateEntry,
      stateResult,
      harnessId,
    );
  }

  if (target.kind === "absent") {
    return { operation: { ...mapping, kind: "create" } };
  }
  if (target.kind === "error") {
    return conflictClassification(mapping, target.message);
  }
  if (target.kind === "other") {
    return conflictClassification(
      mapping,
      `Target contains unmanaged ${target.description}; Distributor will not overwrite it.`,
    );
  }

  if (
    target.linkValue === mapping.linkValue ||
    linkResolvesTo(target.linkValue, mapping.targetPath, mapping.sourcePath)
  ) {
    return {
      operation: {
        ...mapping,
        kind: "adopt",
        linkValue: target.linkValue,
      },
    };
  }

  return conflictClassification(
    mapping,
    "Target contains an unmanaged symbolic link with a different source; Distributor will not overwrite it.",
  );
}

function classifyRecordedTarget(
  mapping: PlannedFile,
  target: TargetInspection,
  stateEntry: ManagedStateEntry,
  stateResult: StateOwnershipResult | undefined,
  harnessId: string | undefined,
): Classification {
  const inEvaluationScope =
    harnessId === undefined ||
    stateEntry.attributions.some(
      (attribution) => attribution.harnessId === harnessId,
    );

  if (target.kind === "absent") {
    const hasUntouchedAttribution =
      harnessId !== undefined &&
      stateEntry.attributions.some(
        (attribution) => attribution.harnessId !== harnessId,
      );
    const preservesRecordedMapping =
      pathsAreEquivalent(stateEntry.sourcePath, mapping.sourcePath) &&
      stateEntry.linkValue === mapping.linkValue;

    if (
      harnessId === undefined ||
      (!hasUntouchedAttribution &&
        inEvaluationScope &&
        stateResult?.status === "missing") ||
      preservesRecordedMapping
    ) {
      return { operation: { ...mapping, kind: "create" } };
    }
    return conflictClassification(
      mapping,
      "The missing target has preserved ownership outside this filtered sync, and the desired source or raw link differs from its recorded mapping.",
    );
  }
  if (target.kind === "error") {
    return conflictClassification(mapping, target.message);
  }
  if (target.kind !== "symlink") {
    return conflictClassification(
      mapping,
      `Recorded target is now ${target.description}; Distributor will not restore it automatically.`,
    );
  }
  if (target.linkValue !== stateEntry.linkValue) {
    return conflictClassification(
      mapping,
      "The recorded symbolic link value has changed; Distributor will not restore it automatically.",
    );
  }

  const mappingIsCorrect =
    pathsAreEquivalent(stateEntry.sourcePath, mapping.sourcePath) &&
    linkResolvesTo(target.linkValue, mapping.targetPath, mapping.sourcePath);
  if (mappingIsCorrect) {
    return {
      operation: {
        ...mapping,
        kind: "skip",
        linkValue: target.linkValue,
      },
    };
  }

  const hasUntouchedAttribution =
    harnessId !== undefined &&
    stateEntry.attributions.some(
      (attribution) => attribution.harnessId !== harnessId,
    );
  if (!inEvaluationScope || hasUntouchedAttribution) {
    return conflictClassification(
      mapping,
      "Updating this shared target would invalidate ownership outside the selected harness scope.",
    );
  }

  return { operation: { ...mapping, kind: "update" } };
}

async function resolvePhysicalTargetPath(
  targetPath: string,
): Promise<string | undefined> {
  let candidate = dirname(targetPath);
  let suffix = basename(targetPath);

  while (true) {
    try {
      return resolve(await realpath(candidate), suffix);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        return undefined;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        return undefined;
      }
      suffix = join(basename(candidate), suffix);
      candidate = parent;
    }
  }
}

function applyPhysicalAliasConflicts(
  records: readonly PhysicalTargetRecord[],
  operations: PlanOperation[],
  failures: PlanFailure[],
): void {
  const byPhysicalTarget = new Map<string, PhysicalTargetRecord[]>();
  for (const record of records) {
    const key = pathComparisonKey(record.physicalPath);
    const group = byPhysicalTarget.get(key);
    if (group === undefined) {
      byPhysicalTarget.set(key, [record]);
    } else {
      group.push(record);
    }
  }

  const groups = [...byPhysicalTarget.entries()].sort(([left], [right]) =>
    compareText(left, right),
  );
  for (const [, unsortedRecords] of groups) {
    const uniqueTargets = new Map(
      unsortedRecords.map((record) => [
        pathComparisonKey(record.mapping.targetPath),
        record,
      ]),
    );
    const aliased = [...uniqueTargets.values()].sort((left, right) =>
      compareText(left.mapping.targetPath, right.mapping.targetPath),
    );
    if (aliased.length < 2) {
      continue;
    }

    const physicalPath = aliased[0]?.physicalPath;
    if (physicalPath === undefined) {
      continue;
    }
    const message = `Desired targets ${aliased
      .map((record) => record.mapping.targetPath)
      .join(", ")} resolve to the same physical path ${physicalPath}.`;

    for (const record of aliased) {
      failures.push(
        mappingFailure(record.mapping, {
          path: record.mapping.targetPath,
          message,
        }),
      );
      const operationIndex = operations.findIndex(
        (operation) =>
          pathComparisonKey(operation.targetPath) ===
          pathComparisonKey(record.mapping.targetPath),
      );
      const operation = operations[operationIndex];
      if (operation === undefined) {
        continue;
      }
      const reason =
        operation.kind === "conflict"
          ? `${operation.reason} ${message}`
          : message;
      operations[operationIndex] = {
        ...operation,
        kind: "conflict",
        reason,
      };
    }
  }
}

function conflictClassification(
  mapping: PlannedFile,
  message: string,
): Classification {
  return {
    operation: { ...mapping, kind: "conflict", reason: message },
    problem: { path: mapping.targetPath, message },
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

function staleOperation(
  entry: ManagedStateEntry,
  harnessId: string | undefined,
): PlanOperation {
  return {
    kind: "stale",
    skillName: "<stale>",
    sourcePath: entry.sourcePath,
    targetPath: entry.targetPath,
    linkValue: entry.linkValue,
    attributions:
      harnessId === undefined
        ? entry.attributions
        : entry.attributions.filter(
            (attribution) => attribution.harnessId === harnessId,
          ),
  };
}

function stateConflictFailure(
  result: StateOwnershipResult,
  harnessId: string | undefined,
): PlanFailure {
  const attribution = selectedAttribution(result.entry.attributions, harnessId);
  return {
    operation: "conflict",
    path: result.entry.targetPath,
    ...(attribution === undefined
      ? {}
      : {
          harnessId: attribution.harnessId,
          placementId: attribution.placementId,
        }),
    message: `Managed target ownership is invalid: ${result.reason ?? "the target was modified"}`,
  };
}

function mappingFailure(
  mapping: PlannedFile,
  problem: ParentProblem,
): PlanFailure {
  const attribution = mapping.attributions[0];
  return {
    operation: "conflict",
    path: problem.path,
    ...(attribution === undefined
      ? {}
      : {
          harnessId: attribution.harnessId,
          placementId: attribution.placementId,
        }),
    message: problem.message,
  };
}

function selectedAttribution(
  attributions: readonly OwnershipAttribution[],
  harnessId: string | undefined,
): OwnershipAttribution | undefined {
  return (
    (harnessId === undefined
      ? undefined
      : attributions.find(
          (attribution) => attribution.harnessId === harnessId,
        )) ?? [...attributions].sort(compareAttributions)[0]
  );
}

function describeNode(stats: Stats): string {
  if (stats.isDirectory()) {
    return "a directory";
  }
  if (stats.isFile()) {
    return "a regular file";
  }
  if (stats.isSocket()) {
    return "a socket";
  }
  if (stats.isFIFO()) {
    return "a FIFO";
  }
  if (stats.isBlockDevice()) {
    return "a block device";
  }
  if (stats.isCharacterDevice()) {
    return "a character device";
  }
  return "an unsupported filesystem node";
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deduplicateParentProblems(
  problems: readonly ParentProblem[],
): ParentProblem[] {
  return [
    ...new Map(
      problems.map((problem) => [
        `${problem.path}\0${problem.message}`,
        problem,
      ]),
    ).values(),
  ];
}

function deduplicateNotices<T extends PlanNotice>(notices: readonly T[]): T[] {
  return [
    ...new Map(
      notices.map((notice) => [
        `${notice.harnessId ?? ""}\0${notice.placementId ?? ""}\0${notice.path ?? ""}\0${notice.message}`,
        notice,
      ]),
    ).values(),
  ];
}

function compareResolvedPlacements(
  left: ResolvedTargetPlacement,
  right: ResolvedTargetPlacement,
): number {
  return (
    compareText(left.harnessId, right.harnessId) ||
    compareText(left.placement.id, right.placement.id) ||
    compareText(left.targetRoot, right.targetRoot)
  );
}

function compareAttributions(
  left: OwnershipAttribution,
  right: OwnershipAttribution,
): number {
  return (
    compareText(left.harnessId, right.harnessId) ||
    compareText(left.placementId, right.placementId)
  );
}

function comparePlannedFiles(left: PlannedFile, right: PlannedFile): number {
  const leftAttribution = [...left.attributions].sort(compareAttributions)[0];
  const rightAttribution = [...right.attributions].sort(compareAttributions)[0];
  return (
    compareText(leftAttribution?.harnessId ?? "", rightAttribution?.harnessId ?? "") ||
    compareText(leftAttribution?.placementId ?? "", rightAttribution?.placementId ?? "") ||
    compareText(left.skillName, right.skillName) ||
    compareText(left.targetPath, right.targetPath) ||
    compareText(left.sourcePath, right.sourcePath)
  );
}

function compareOperations(left: PlanOperation, right: PlanOperation): number {
  return (
    comparePlannedFiles(left, right) ||
    compareText(left.kind, right.kind)
  );
}

function compareNotices(left: PlanNotice, right: PlanNotice): number {
  return (
    compareText(left.harnessId ?? "", right.harnessId ?? "") ||
    compareText(left.placementId ?? "", right.placementId ?? "") ||
    compareText(left.path ?? "", right.path ?? "") ||
    compareText(left.message, right.message)
  );
}

function compareParentProblems(
  left: ParentProblem,
  right: ParentProblem,
): number {
  return (
    compareText(left.path, right.path) || compareText(left.message, right.message)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
