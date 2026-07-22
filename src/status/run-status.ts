import { loadAdapterRegistry } from "../adapters/index.js";
import { discoverConfig } from "../config/discover.js";
import {
  loadProjectConfig,
  type ValidateConfigOptions,
} from "../config/validate.js";
import {
  discoverSkills,
  type SkillDiscoveryResult,
} from "../skills/discover.js";
import { buildSyncPlan } from "../sync/plan.js";
import {
  type PlacementResolution,
  resolvePlacements,
} from "../sync/resolve-placements.js";
import { loadManagedState } from "../sync/state.js";

export interface RunStatusRuntime {
  readonly discoverConfig: typeof discoverConfig;
  readonly loadProjectConfig: typeof loadProjectConfig;
  readonly discoverSkills: typeof discoverSkills;
  readonly resolvePlacements: typeof resolvePlacements;
  readonly loadManagedState: typeof loadManagedState;
  readonly buildSyncPlan: typeof buildSyncPlan;
}

export interface RunStatusOptions extends ValidateConfigOptions {
  readonly cwd?: string;
  readonly runtime?: Partial<RunStatusRuntime>;
}

export type SkillHarnessConfigurationStatus =
  | "configured"
  | "needs sync"
  | "conflict";

export interface StatusHarness {
  readonly harnessId: string;
  readonly storagePaths: readonly string[];
  readonly references: number;
}

export interface StatusSkillHarness {
  readonly harnessId: string;
  readonly status: SkillHarnessConfigurationStatus;
}

export interface StatusSkill {
  readonly name: string;
  readonly sourcePath: string;
  readonly harnesses: readonly StatusSkillHarness[];
}

export interface RunStatusResult {
  readonly exitCode: 0;
  readonly projectRoot: string;
  readonly sourceRoot: string;
  readonly skills: number;
  readonly references: number;
  readonly harnesses: readonly StatusHarness[];
  readonly skillStatuses: readonly StatusSkill[];
  readonly upToDate: boolean;
}

const defaultRuntime: RunStatusRuntime = {
  discoverConfig,
  loadProjectConfig,
  discoverSkills,
  resolvePlacements,
  loadManagedState,
  buildSyncPlan,
};

export async function runStatus(
  options: RunStatusOptions = {},
): Promise<RunStatusResult> {
  const runtime: RunStatusRuntime = { ...defaultRuntime, ...options.runtime };
  const cwd = options.cwd ?? process.cwd();
  const adapterRegistry = await loadAdapterRegistry(cwd);
  const discovered = await runtime.discoverConfig(cwd);
  const config = await runtime.loadProjectConfig(discovered, {
    adapterRegistry,
    ...(options.homeDirectory === undefined
      ? {}
      : { homeDirectory: options.homeDirectory }),
    ...(options.environment === undefined
      ? {}
      : { environment: options.environment }),
    ...(options.pathStyle === undefined
      ? {}
      : { pathStyle: options.pathStyle }),
  });
  const skills = await runtime.discoverSkills(config.sourceRoot);
  const resolution = runtime.resolvePlacements(config, skills, {
    ...(options.homeDirectory === undefined
      ? {}
      : { homeDirectory: options.homeDirectory }),
    ...(options.pathStyle === undefined
      ? {}
      : { pathStyle: options.pathStyle }),
  });
  const state = await runtime.loadManagedState(config.projectRoot);
  const plan = await runtime.buildSyncPlan(resolution, state);

  return {
    exitCode: 0,
    projectRoot: config.projectRoot,
    sourceRoot: config.sourceRoot,
    skills: skills.skills.length,
    references: countReferences(skills, resolution),
    harnesses: buildHarnessStatuses(
      config.harnesses,
      resolution,
      skills.skills.length,
    ),
    skillStatuses: skills.skills.map((skill) => ({
      name: skill.name,
      sourcePath: skill.directoryPath,
      harnesses: config.harnesses
        .map((harness) => ({
          harnessId: harness.name,
          status: configurationStatus(
            skill.name,
            harness.name,
            resolution,
            plan,
          ),
        }))
        .sort((left, right) => compareText(left.harnessId, right.harnessId)),
    })),
    upToDate:
      plan.applicable &&
      plan.operations.every((operation) => operation.kind === "skip"),
  };
}

function buildHarnessStatuses(
  configuredHarnesses: readonly { readonly name: string }[],
  resolution: PlacementResolution,
  skillCount: number,
): StatusHarness[] {
  return configuredHarnesses
    .map((harness) => {
      const placements = resolution.placements.filter(
        (placement) => placement.harnessId === harness.name,
      );
      const satisfiedPlacements = resolution.satisfiedPlacements.filter(
        (placement) => placement.harnessId === harness.name,
      );

      return {
        harnessId: harness.name,
        storagePaths: [
          ...new Set([
            ...placements.map((placement) => placement.targetRoot),
            ...satisfiedPlacements.map((placement) => placement.sourceRoot),
          ]),
        ].sort(compareText),
        references:
          skillCount * (placements.length + satisfiedPlacements.length),
      };
    })
    .sort((left, right) => compareText(left.harnessId, right.harnessId));
}

function configurationStatus(
  skillName: string,
  harnessId: string,
  resolution: PlacementResolution,
  plan: Awaited<ReturnType<typeof buildSyncPlan>>,
): SkillHarnessConfigurationStatus {
  const operations = plan.operations.filter(
    (operation) =>
      operation.skillName === skillName &&
      operation.attributions.some(
        (attribution) => attribution.harnessId === harnessId,
      ),
  );

  if (operations.some((operation) => operation.kind === "conflict")) {
    return "conflict";
  }
  if (
    operations.some(
      (operation) =>
        operation.kind === "create" ||
        operation.kind === "update" ||
        operation.kind === "adopt",
    )
  ) {
    return "needs sync";
  }
  if (
    operations.length > 0 ||
    resolution.satisfiedPlacements.some(
      (placement) => placement.harnessId === harnessId,
    )
  ) {
    return "configured";
  }
  return "needs sync";
}

function countReferences(
  skills: SkillDiscoveryResult,
  resolution: PlacementResolution,
): number {
  const placements =
    resolution.placements.length + resolution.satisfiedPlacements.length;
  return skills.skills.length * placements;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
