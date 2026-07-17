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
  resolvePlacements,
  type PlacementResolution,
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

export interface RunStatusResult {
  readonly exitCode: 0;
  readonly projectRoot: string;
  readonly sourceRoot: string;
  readonly skills: number;
  readonly references: number;
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
  const discovered = await runtime.discoverConfig(cwd);
  const config = await runtime.loadProjectConfig(discovered, {
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
    upToDate:
      plan.applicable &&
      plan.operations.every((operation) => operation.kind === "skip"),
  };
}

function countReferences(
  skills: SkillDiscoveryResult,
  resolution: PlacementResolution,
): number {
  const placements =
    resolution.placements.length + resolution.satisfiedPlacements.length;
  return skills.skills.length * placements;
}
