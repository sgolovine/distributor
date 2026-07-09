import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import {
  getAdapterCatalogEntry,
  getAvailableAdapterConfig,
  type HarnessPlacement,
} from "../adapters/index.js";
import type {
  ValidatedHarnessSelection,
  ValidatedProjectConfig,
  ValidatedTargetSelection,
} from "../config/validate.js";
import { DistributorError } from "../errors.js";
import {
  isStrictChildPath,
  normalizeAbsolutePath,
  pathComparisonKey,
  pathsAreEquivalent,
  resolveConfigPath,
  type PathStyle,
} from "../filesystem/paths.js";
import type {
  SkillDiscoveryResult,
  SourceRootIdentity,
  SourceSkill,
} from "../skills/discover.js";
import type {
  OwnershipAttribution,
  PlannedFile,
  PlanNotice,
  SatisfiedPlacement,
} from "./types.js";

export interface ResolvedTargetPlacement {
  readonly harnessId: string;
  readonly placement: HarnessPlacement;
  readonly targetRoot: string;
  readonly hasPathOverride: boolean;
}

export interface PlacementResolution {
  readonly sourceRoot: string;
  readonly sourceRootIdentity: SourceRootIdentity;
  readonly placements: readonly ResolvedTargetPlacement[];
  readonly mappings: readonly PlannedFile[];
  readonly satisfiedPlacements: readonly SatisfiedPlacement[];
  readonly warnings: readonly PlanNotice[];
}

export interface ResolvePlacementsOptions {
  readonly harness?: string;
  readonly homeDirectory?: string;
  readonly pathStyle?: PathStyle;
}

interface MutableMapping {
  skillName: string;
  sourcePath: string;
  targetPath: string;
  linkValue: string;
  attributions: OwnershipAttribution[];
}

const DEFAULT_PATH_STYLE: PathStyle =
  process.platform === "win32" ? "win32" : "posix";

export function resolvePlacements(
  config: ValidatedProjectConfig,
  discovery: SkillDiscoveryResult,
  options: ResolvePlacementsOptions = {},
): PlacementResolution {
  const style = options.pathStyle ?? DEFAULT_PATH_STYLE;
  const pathApi = style === "win32" ? win32 : posix;
  const projectRoot = normalizeAbsolutePath(config.projectRoot, style);
  const sourceRoot = normalizeAbsolutePath(config.sourceRoot, style);
  const discoveredSourceRoot = normalizeAbsolutePath(discovery.sourceRoot, style);
  if (!pathsAreEquivalent(sourceRoot, discoveredSourceRoot, style)) {
    throw new DistributorError(
      "source",
      "Skill discovery and placement resolution disagree on the source root.",
      {
        operation: "resolve placements",
        context: { sourceRoot, discoveredSourceRoot },
        correction: "Rediscover skills from the configured source root and rerun sync.",
      },
    );
  }
  const selectedHarnesses = selectHarnesses(config.harnesses, options.harness);
  const placements: ResolvedTargetPlacement[] = [];
  const satisfiedPlacements: SatisfiedPlacement[] = [];
  const warnings: PlanNotice[] = [];

  for (const harness of selectedHarnesses) {
    const adapter = getAvailableAdapterConfig(harness.name);
    if (adapter === undefined || adapter.defaultProjectPlacementId === undefined) {
      throw new Error(`Available adapter metadata is incomplete for ${harness.name}.`);
    }

    if (harness.targets === undefined) {
      const compatible = adapter.placements
        .filter(
          (placement) =>
            placement.scope === "project" &&
            (placement.support === "native" ||
              placement.support === "compatibility"),
        )
        .sort((left, right) => compareText(left.id, right.id));
      const satisfied = compatible.find((placement) =>
        pathsAreEquivalent(
          sourceRoot,
          resolveAdapterPath(
            placement.defaultPath,
            projectRoot,
            style,
            options.homeDirectory,
          ),
          style,
        ),
      );

      if (satisfied !== undefined) {
        satisfiedPlacements.push({
          harnessId: harness.name,
          placementId: satisfied.id,
          sourceRoot,
        });
        continue;
      }

      const defaultPlacement = adapter.placements.find(
        (placement) => placement.id === adapter.defaultProjectPlacementId,
      );
      if (defaultPlacement === undefined) {
        throw new Error(`Default placement metadata is missing for ${harness.name}.`);
      }

      addPlacement(
        {
          harnessId: harness.name,
          placement: defaultPlacement,
          targetRoot: resolveAdapterPath(
            defaultPlacement.defaultPath,
            projectRoot,
            style,
            options.homeDirectory,
          ),
          hasPathOverride: false,
        },
        sourceRoot,
        projectRoot,
        style,
        placements,
        satisfiedPlacements,
        warnings,
      );
      continue;
    }

    const targets = [...harness.targets].sort(
      (left, right) =>
        compareText(left.placement.id, right.placement.id) ||
        compareText(left.targetRoot, right.targetRoot),
    );
    for (const target of targets) {
      addPlacement(
        resolvedExplicitPlacement(harness.name, target, style),
        sourceRoot,
        projectRoot,
        style,
        placements,
        satisfiedPlacements,
        warnings,
      );
    }
  }

  placements.sort(comparePlacement);
  satisfiedPlacements.sort(compareSatisfiedPlacement);
  warnings.sort(compareNotice);

  return {
    sourceRoot,
    sourceRootIdentity: discovery.sourceRootIdentity,
    placements,
    mappings: buildMappings(
      projectRoot,
      sourceRoot,
      placements,
      discovery.skills,
      style,
      pathApi,
    ),
    satisfiedPlacements,
    warnings,
  };
}

function selectHarnesses(
  configured: readonly ValidatedHarnessSelection[],
  requested: string | undefined,
): ValidatedHarnessSelection[] {
  if (requested === undefined) {
    return [...configured].sort((left, right) =>
      compareText(left.name, right.name),
    );
  }

  const catalogEntry = getAdapterCatalogEntry(requested);
  if (catalogEntry === undefined) {
    throw harnessSelectionError(
      `Unknown harness ${JSON.stringify(requested)}.`,
      requested,
      "Use codex, claude-code, or opencode.",
    );
  }
  if (catalogEntry.adapterStatus !== "available") {
    throw harnessSelectionError(
      `Harness ${JSON.stringify(requested)} is ${catalogEntry.adapterStatus}, not available.`,
      requested,
      "Choose an available harness.",
    );
  }

  const selection = configured.find((harness) => harness.name === requested);
  if (selection === undefined) {
    throw harnessSelectionError(
      `Harness ${JSON.stringify(requested)} is not enabled by project configuration.`,
      requested,
      "Enable the harness in Distributor config or select an enabled harness.",
    );
  }

  return [selection];
}

function harnessSelectionError(
  message: string,
  requested: string,
  correction: string,
): DistributorError {
  return new DistributorError("usage", message, {
    operation: "select sync harness",
    received: requested,
    correction,
  });
}

function resolveAdapterPath(
  configuredPath: string,
  projectRoot: string,
  style: PathStyle,
  homeDirectory: string | undefined,
): string {
  return resolveConfigPath(configuredPath, {
    projectRoot,
    style,
    homeDirectory: homeDirectory ?? homedir(),
  });
}

function resolvedExplicitPlacement(
  harnessId: string,
  target: ValidatedTargetSelection,
  style: PathStyle,
): ResolvedTargetPlacement {
  return {
    harnessId,
    placement: target.placement,
    targetRoot: normalizeAbsolutePath(target.targetRoot, style),
    hasPathOverride: target.hasPathOverride,
  };
}

function addPlacement(
  resolved: ResolvedTargetPlacement,
  sourceRoot: string,
  projectRoot: string,
  style: PathStyle,
  placements: ResolvedTargetPlacement[],
  satisfiedPlacements: SatisfiedPlacement[],
  warnings: PlanNotice[],
): void {
  if (pathsAreEquivalent(resolved.targetRoot, sourceRoot, style)) {
    satisfiedPlacements.push({
      harnessId: resolved.harnessId,
      placementId: resolved.placement.id,
      sourceRoot,
    });
    return;
  }

  if (isStrictChildPath(sourceRoot, resolved.targetRoot, style)) {
    throw new DistributorError(
      "conflict",
      `Target root ${resolved.targetRoot} is inside source root ${sourceRoot}.`,
      {
        operation: "resolve placement",
        context: {
          harnessId: resolved.harnessId,
          placementId: resolved.placement.id,
          sourceRoot,
          targetRoot: resolved.targetRoot,
        },
        correction: "Choose a target outside the source root to avoid recursive discovery.",
      },
    );
  }

  placements.push(resolved);

  if (
    isProjectLocal(sourceRoot, projectRoot, style) &&
    !isProjectLocal(resolved.targetRoot, projectRoot, style)
  ) {
    warnings.push({
      harnessId: resolved.harnessId,
      placementId: resolved.placement.id,
      path: resolved.targetRoot,
      message:
        "This external target links to a project-local source and will break if the project moves or is deleted.",
    });
  }
}

function buildMappings(
  projectRoot: string,
  sourceRoot: string,
  placements: readonly ResolvedTargetPlacement[],
  discoveredSkills: readonly SourceSkill[],
  style: PathStyle,
  pathApi: typeof posix,
): PlannedFile[] {
  const byTarget = new Map<string, MutableMapping>();
  const skills = [...discoveredSkills].sort((left, right) =>
    compareText(left.name, right.name),
  );

  for (const placement of placements) {
    for (const skill of skills) {
      const files = [...skill.files].sort((left, right) =>
        compareText(left.sourceRelativePath, right.sourceRelativePath),
      );

      for (const file of files) {
        const sourcePath = normalizeAbsolutePath(file.absolutePath, style);
        const expectedSourcePath = pathApi.resolve(
          sourceRoot,
          file.sourceRelativePath,
        );
        if (
          pathApi.isAbsolute(file.sourceRelativePath) ||
          !isStrictChildPath(sourceRoot, sourcePath, style) ||
          !pathsAreEquivalent(expectedSourcePath, sourcePath, style)
        ) {
          throw mappingConflict(
            `Source file mapping escapes or disagrees with the source root: ${file.absolutePath}.`,
            { sourcePath: file.absolutePath, sourceRoot },
            "Keep every discovered file strictly inside the configured source root.",
          );
        }

        const targetPath = normalizeAbsolutePath(
          pathApi.resolve(placement.targetRoot, file.sourceRelativePath),
          style,
        );
        if (!isStrictChildPath(placement.targetRoot, targetPath, style)) {
          throw mappingConflict(
            `Target file mapping escapes target root ${placement.targetRoot}.`,
            { targetPath, targetRoot: placement.targetRoot },
            "Use a source-relative file path that remains inside the selected target root.",
          );
        }
        if (
          pathsAreEquivalent(targetPath, sourcePath, style) ||
          isStrictChildPath(sourceRoot, targetPath, style)
        ) {
          throw mappingConflict(
            `Target file ${targetPath} would write into the canonical source tree.`,
            { sourceRoot, sourcePath, targetPath },
            "Choose a target root whose emitted files remain outside the canonical source tree.",
          );
        }

        const linkValue =
          isProjectLocal(sourcePath, projectRoot, style) &&
          isProjectLocal(targetPath, projectRoot, style)
            ? pathApi.relative(pathApi.dirname(targetPath), sourcePath)
            : sourcePath;
        const attribution = {
          harnessId: placement.harnessId,
          placementId: placement.placement.id,
        };
        const targetKey = pathComparisonKey(targetPath, style);
        const existing = byTarget.get(targetKey);

        if (existing === undefined) {
          byTarget.set(targetKey, {
            skillName: skill.name,
            sourcePath,
            targetPath,
            linkValue,
            attributions: [attribution],
          });
          continue;
        }

        if (!pathsAreEquivalent(existing.sourcePath, sourcePath, style)) {
          throw mappingConflict(
            `Target ${targetPath} maps to different source files.`,
            {
              targetPath,
              sourcePath,
              existingSourcePath: existing.sourcePath,
            },
          );
        }
        if (
          existing.sourcePath !== sourcePath ||
          existing.skillName !== skill.name ||
          existing.linkValue !== linkValue
        ) {
          throw mappingConflict(
            `Normalized path keys collide unsafely at target ${targetPath}.`,
            {
              targetPath,
              sourcePath,
              existingSourcePath: existing.sourcePath,
            },
          );
        }

        if (!existing.attributions.some((item) => sameAttribution(item, attribution))) {
          existing.attributions.push(attribution);
        }
      }
    }
  }

  return [...byTarget.values()]
    .map((mapping): PlannedFile => ({
      ...mapping,
      attributions: mapping.attributions.sort(compareAttribution),
    }))
    .sort(compareMapping);
}

function mappingConflict(
  message: string,
  context: Readonly<Record<string, string>>,
  correction = "Choose non-overlapping target roots and remove case-colliding source paths.",
): DistributorError {
  return new DistributorError("conflict", message, {
    operation: "map source files",
    context,
    correction,
  });
}

function isProjectLocal(
  value: string,
  projectRoot: string,
  style: PathStyle,
): boolean {
  return (
    pathsAreEquivalent(value, projectRoot, style) ||
    isStrictChildPath(projectRoot, value, style)
  );
}

function sameAttribution(
  left: OwnershipAttribution,
  right: OwnershipAttribution,
): boolean {
  return (
    left.harnessId === right.harnessId &&
    left.placementId === right.placementId
  );
}

function comparePlacement(
  left: ResolvedTargetPlacement,
  right: ResolvedTargetPlacement,
): number {
  return (
    compareText(left.harnessId, right.harnessId) ||
    compareText(left.placement.id, right.placement.id) ||
    compareText(left.targetRoot, right.targetRoot)
  );
}

function compareSatisfiedPlacement(
  left: SatisfiedPlacement,
  right: SatisfiedPlacement,
): number {
  return (
    compareText(left.harnessId, right.harnessId) ||
    compareText(left.placementId, right.placementId)
  );
}

function compareAttribution(
  left: OwnershipAttribution,
  right: OwnershipAttribution,
): number {
  return (
    compareText(left.harnessId, right.harnessId) ||
    compareText(left.placementId, right.placementId)
  );
}

function compareMapping(left: PlannedFile, right: PlannedFile): number {
  const leftAttribution = left.attributions[0];
  const rightAttribution = right.attributions[0];
  if (leftAttribution === undefined || rightAttribution === undefined) {
    throw new Error("Every desired mapping must have an attribution.");
  }

  return (
    compareAttribution(leftAttribution, rightAttribution) ||
    compareText(left.skillName, right.skillName) ||
    compareText(left.targetPath, right.targetPath) ||
    compareText(left.sourcePath, right.sourcePath)
  );
}

function compareNotice(left: PlanNotice, right: PlanNotice): number {
  return (
    compareText(left.harnessId ?? "", right.harnessId ?? "") ||
    compareText(left.placementId ?? "", right.placementId ?? "") ||
    compareText(left.path ?? "", right.path ?? "") ||
    compareText(left.message, right.message)
  );
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
