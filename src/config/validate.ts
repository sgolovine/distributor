import { extname } from "node:path";
import { homedir } from "node:os";

import {
  adapterCatalog,
  getAdapterCatalogEntry,
  getAvailableAdapterConfig,
  isAvailableAdapterId,
  type AvailableAdapterId,
  type HarnessPlacement,
} from "../adapters/index.js";
import {
  DistributorError,
  type ValidationIssue,
  validationError,
} from "../errors.js";
import {
  pathComparisonKey,
  resolveConfigPath,
  type PathStyle,
} from "../filesystem/paths.js";
import type { DiscoveredConfig } from "./discover.js";
import { loadSelectedConfig } from "./load.js";
import {
  DistributorConfigSchema,
  type ParsedDistributorConfig,
  type TargetSelection,
} from "./schema.js";

export interface ValidatedTargetSelection {
  readonly placement: HarnessPlacement;
  readonly targetRoot: string;
  readonly hasPathOverride: boolean;
}

export interface ValidatedHarnessSelection {
  readonly name: AvailableAdapterId;
  readonly targets: readonly ValidatedTargetSelection[] | undefined;
}

export interface ValidatedProjectConfig {
  readonly configPath: string;
  readonly projectRoot: string;
  readonly sourceRoot: string;
  readonly harnesses: readonly ValidatedHarnessSelection[];
}

export interface ValidateConfigOptions {
  readonly homeDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly pathStyle?: PathStyle;
}

const availableHarnessIds = adapterCatalog
  .filter((entry) => entry.adapterStatus === "available")
  .map((entry) => entry.name)
  .join(", ");

function valueAtPath(value: unknown, path: readonly PropertyKey[]): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

function issuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return "<config>";
  }

  return path
    .map((segment, index) =>
      typeof segment === "number" ? `[${segment}]` : `${index === 0 ? "" : "."}${String(segment)}`,
    )
    .join("");
}

interface RawSchemaIssue {
  readonly code: string;
  readonly message: string;
  readonly path: readonly PropertyKey[];
  readonly errors?: readonly (readonly RawSchemaIssue[])[];
}

interface FlattenedSchemaIssue {
  readonly message: string;
  readonly path: readonly PropertyKey[];
}

function flattenSchemaIssues(
  issues: readonly RawSchemaIssue[],
  prefix: readonly PropertyKey[] = [],
): FlattenedSchemaIssue[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    if (issue.code !== "invalid_union" || issue.errors === undefined) {
      return [{ message: issue.message, path }];
    }

    const branches = issue.errors.map((branch) =>
      flattenSchemaIssues(branch, path),
    );
    branches.sort((left, right) => {
      const leftDepth = Math.max(...left.map((item) => item.path.length), 0);
      const rightDepth = Math.max(...right.map((item) => item.path.length), 0);
      return rightDepth - leftDepth || left.length - right.length;
    });
    return branches[0] ?? [{ message: issue.message, path }];
  });
}

function parseConfigShape(
  rawConfig: unknown,
  configPath: string,
): ParsedDistributorConfig {
  const result = DistributorConfigSchema.safeParse(rawConfig);
  if (result.success) {
    return result.data;
  }

  const schemaIssues = flattenSchemaIssues(
    result.error.issues as readonly RawSchemaIssue[],
  );
  const issues: ValidationIssue[] = schemaIssues.map((issue) => {
    const received = valueAtPath(rawConfig, issue.path);
    return {
      message: issue.message,
      path: issuePath(issue.path),
      ...(received === undefined ? {} : { received }),
      expected: "the documented Distributor configuration shape",
      correction: "Update this field to match the configuration examples.",
    };
  });

  throw validationError("config", `Invalid Distributor config: ${configPath}`, issues, {
    operation: "validate config",
    context: { configPath },
    correction: "Correct every reported field and rerun Distributor.",
  });
}

function resolveSelectedPlacementPath(
  selection: TargetSelection,
  placement: HarnessPlacement,
  projectRoot: string,
  homeDirectory: string,
  environment: Readonly<Record<string, string | undefined>>,
  pathStyle: PathStyle | undefined,
): string {
  if (selection.path !== undefined) {
    return resolveConfigPath(selection.path, {
      projectRoot,
      homeDirectory,
      ...(pathStyle === undefined ? {} : { style: pathStyle }),
    });
  }

  const environmentPath = placement.environmentVariables
    ?.map((name) => environment[name])
    .find((value): value is string => value !== undefined && value.length > 0);

  return resolveConfigPath(environmentPath ?? placement.defaultPath, {
    projectRoot,
    homeDirectory,
    ...(pathStyle === undefined ? {} : { style: pathStyle }),
  });
}

export function validateProjectConfig(
  rawConfig: unknown,
  discovered: Pick<DiscoveredConfig, "configPath" | "projectRoot">,
  options: ValidateConfigOptions = {},
): ValidatedProjectConfig {
  const parsed = parseConfigShape(rawConfig, discovered.configPath);
  const homeDirectory = options.homeDirectory ?? homedir();
  const environment = options.environment ?? process.env;
  const issues: ValidationIssue[] = [];
  const seenHarnesses = new Map<string, number>();
  const harnesses: ValidatedHarnessSelection[] = [];
  let sourceRoot: string | undefined;

  try {
    sourceRoot = resolveConfigPath(parsed.source, {
      projectRoot: discovered.projectRoot,
      homeDirectory,
      ...(options.pathStyle === undefined ? {} : { style: options.pathStyle }),
    });
  } catch (error) {
    const failure = error as DistributorError;
    issues.push({
      message: failure.message,
      path: "source",
      received: parsed.source,
      expected: "a non-empty project-relative or supported expanded path",
      correction: failure.correction ?? "Use a valid source path.",
    });
  }

  for (const [harnessIndex, selection] of parsed.harnesses.entries()) {
    const name = typeof selection === "string" ? selection : selection.name;
    const fieldPath = `harnesses[${harnessIndex}]`;
    const priorIndex = seenHarnesses.get(name);
    if (priorIndex !== undefined) {
      issues.push({
        message: `duplicates harness ${JSON.stringify(name)} from harnesses[${priorIndex}]`,
        path: fieldPath,
        received: name,
        expected: "each harness ID exactly once",
        correction: "Remove the duplicate harness entry.",
      });
      continue;
    }
    seenHarnesses.set(name, harnessIndex);

    const catalogEntry = getAdapterCatalogEntry(name);
    if (catalogEntry === undefined) {
      issues.push({
        message: `unknown harness ${JSON.stringify(name)}`,
        path: fieldPath,
        received: name,
        expected: availableHarnessIds,
        correction: "Use an available harness ID.",
      });
      continue;
    }
    if (
      catalogEntry.adapterStatus !== "available" ||
      !isAvailableAdapterId(name)
    ) {
      issues.push({
        message: `harness ${JSON.stringify(name)} is ${catalogEntry.adapterStatus}, not available`,
        path: fieldPath,
        received: name,
        expected: "an available harness",
        correction: `Remove this harness or choose one of: ${availableHarnessIds}.`,
      });
      continue;
    }

    const adapter = getAvailableAdapterConfig(name);
    if (adapter === undefined) {
      throw new Error(`Available adapter metadata is missing for ${name}.`);
    }
    if (typeof selection === "string" || selection.targets === undefined) {
      harnesses.push({ name, targets: undefined });
      continue;
    }

    const targets: ValidatedTargetSelection[] = [];
    const seenTargetRoots = new Map<string, number>();
    for (const [targetIndex, target] of selection.targets.entries()) {
      const targetPath = `${fieldPath}.targets[${targetIndex}]`;
      const placementId = target.placement ?? adapter.defaultProjectPlacementId;
      const placement = adapter.placements.find((item) => item.id === placementId);

      if (placement === undefined) {
        issues.push({
          message: `unknown placement ${JSON.stringify(placementId)}`,
          path: `${targetPath}.placement`,
          ...(target.placement === undefined ? {} : { received: target.placement }),
          expected: `a placement declared by ${name}`,
          correction: "Choose a declared project or user placement.",
        });
        continue;
      }
      if (placement.support === "unverified") {
        issues.push({
          message: `placement ${JSON.stringify(placement.id)} is unverified`,
          path: `${targetPath}.placement`,
          received: placement.id,
          expected: "a native or compatibility placement",
          correction: "Choose a verified placement.",
        });
        continue;
      }
      if (placement.scope !== "project" && placement.scope !== "user") {
        issues.push({
          message: `placement ${JSON.stringify(placement.id)} has disallowed ${placement.scope} scope`,
          path: `${targetPath}.placement`,
          received: placement.id,
          expected: "a project or explicitly selected user placement",
          correction: "Choose a project or user placement.",
        });
        continue;
      }

      let targetRoot: string;
      try {
        targetRoot = resolveSelectedPlacementPath(
          target,
          placement,
          discovered.projectRoot,
          homeDirectory,
          environment,
          options.pathStyle,
        );
      } catch (error) {
        const failure = error as DistributorError;
        issues.push({
          message: failure.message,
          path: `${targetPath}.${target.path === undefined ? "placement" : "path"}`,
          received: target.path ?? placement.defaultPath,
          expected: "a non-empty project-relative or supported expanded path",
          correction: failure.correction ?? "Use a valid target path.",
        });
        continue;
      }

      const key = pathComparisonKey(targetRoot, options.pathStyle);
      const priorTargetIndex = seenTargetRoots.get(key);
      if (priorTargetIndex !== undefined) {
        issues.push({
          message: `duplicates the effective target selected at ${fieldPath}.targets[${priorTargetIndex}]`,
          path: targetPath,
          received: targetRoot,
          expected: "one selection per effective target root",
          correction: "Remove the duplicate target selection.",
        });
        continue;
      }
      seenTargetRoots.set(key, targetIndex);
      targets.push({
        placement,
        targetRoot,
        hasPathOverride: target.path !== undefined,
      });
    }

    harnesses.push({ name, targets });
  }

  if (issues.length > 0 || sourceRoot === undefined) {
    throw validationError(
      "config",
      `Invalid Distributor config: ${discovered.configPath}`,
      issues,
      {
        operation: "validate config",
        context: { configPath: discovered.configPath },
        correction: "Correct every reported field and rerun Distributor.",
      },
    );
  }

  return {
    configPath: discovered.configPath,
    projectRoot: discovered.projectRoot,
    sourceRoot,
    harnesses: harnesses.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function loadProjectConfig(
  discovered: Pick<DiscoveredConfig, "configPath" | "projectRoot">,
  options: ValidateConfigOptions = {},
): Promise<ValidatedProjectConfig> {
  let rawConfig: unknown;
  try {
    rawConfig = await loadSelectedConfig(discovered.configPath);
  } catch (error) {
    const executable = extname(discovered.configPath) !== ".json";
    throw new DistributorError(
      "config",
      `Could not load Distributor config: ${discovered.configPath}`,
      {
        operation: "load config",
        context: { configPath: discovered.configPath },
        correction: executable
          ? "Fix the trusted executable JavaScript or TypeScript config, then rerun Distributor."
          : "Fix the JSON config, then rerun Distributor.",
        cause: error,
      },
    );
  }

  return validateProjectConfig(rawConfig, discovered, options);
}
