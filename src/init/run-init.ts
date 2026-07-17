import { isCancel, multiselect, text } from "@clack/prompts";
import type { Stats } from "node:fs";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  getRegistryAvailableConfig,
  loadAdapterRegistry,
} from "../adapters/index.js";
import { supportedConfigsAt } from "../config/discover.js";
import {
  loadProjectConfig,
  validateProjectConfig,
  type ValidateConfigOptions,
} from "../config/validate.js";
import { DEFAULT_SOURCE_PATH } from "../config/schema.js";
import { DistributorError } from "../errors.js";
import {
  isStrictChildPath,
  pathsAreEquivalent,
} from "../filesystem/paths.js";

const GENERATED_CONFIG_NAME = "distributor.config.json";
const STATE_DIRECTORY_NAME = ".distributor";
const STATE_IGNORE_NAME = ".gitignore";
const STATE_IGNORE_CONTENTS =
  "*\n!.gitignore\n!adapters/\n!adapters/**\n";

export interface InitSelections {
  readonly source: string;
  readonly harnesses: readonly string[];
}

export interface InitPromptContext {
  readonly defaultSource: string;
  readonly defaultHarnesses: readonly string[];
  readonly harnesses: readonly {
    name: string;
    displayName: string;
  }[];
}

export type InitPrompt = (
  context: InitPromptContext,
) => Promise<InitSelections>;

export interface RunInitOptions extends ValidateConfigOptions {
  readonly cwd?: string;
  readonly yes?: boolean;
  readonly isInteractive?: boolean;
  readonly prompt?: InitPrompt;
}

export type InitArtifact = "config" | "source" | "state-ignore";
export type InitOutcomeStatus = "created" | "preserved";

export interface InitOutcome {
  readonly artifact: InitArtifact;
  readonly status: InitOutcomeStatus;
  readonly path: string;
}

export interface InitResult {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly sourceRoot: string;
  readonly outcomes: readonly InitOutcome[];
  readonly noOp: boolean;
}

interface InitPlan {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly configContents: string | undefined;
  readonly sourceRoot: string;
  readonly createSource: boolean;
  readonly stateDirectory: string;
  readonly stateIgnorePath: string;
  readonly createStateIgnore: boolean;
}

function cancelledPrompt(): DistributorError {
  return new DistributorError(
    "usage",
    "Distributor initialization was cancelled.",
    {
      operation: "collect init selections",
      correction:
        "Rerun `distributor init` and complete the prompts, or use `--yes`.",
    },
  );
}

export async function promptForInitSelections(
  context: InitPromptContext,
): Promise<InitSelections> {
  const source = await text({
    message: "Where are your Agent Skills stored?",
    initialValue: context.defaultSource,
    defaultValue: context.defaultSource,
    validate: (value) =>
      value === undefined || value.trim().length === 0
        ? "Enter a non-empty source path."
        : undefined,
  });
  if (isCancel(source)) {
    throw cancelledPrompt();
  }

  const harnesses = await multiselect<string>({
    message: "Which harnesses should use these skills?",
    options: context.harnesses.map((harness) => ({
      value: harness.name,
      label: harness.displayName,
    })),
    initialValues: [...context.defaultHarnesses],
    required: true,
  });
  if (isCancel(harnesses)) {
    throw cancelledPrompt();
  }

  return { source, harnesses };
}

function serializeConfig(selections: InitSelections): string {
  const harnesses = selections.harnesses.map((name) => JSON.stringify(name));

  return [
    "{",
    `  "source": ${JSON.stringify(selections.source)},`,
    `  "harnesses": [${harnesses.join(", ")}]`,
    "}",
    "",
  ].join("\n");
}

async function inspectPath(
  path: string,
  operation: string,
): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw new DistributorError(
      "filesystem",
      `Could not inspect initialization path: ${path}`,
      {
        operation,
        context: { path },
        correction:
          "Fix the path or its permissions, then rerun initialization.",
        cause: error,
      },
    );
  }
}

function ensureSourceDoesNotCollide(
  sourceRoot: string,
  configPath: string,
  stateIgnorePath: string,
  createsConfig: boolean,
): void {
  const collidesWithConfig =
    createsConfig &&
    (pathsAreEquivalent(sourceRoot, configPath) ||
      isStrictChildPath(configPath, sourceRoot));
  const collidesWithIgnore =
    pathsAreEquivalent(sourceRoot, stateIgnorePath) ||
    isStrictChildPath(stateIgnorePath, sourceRoot);

  if (!collidesWithConfig && !collidesWithIgnore) {
    return;
  }

  throw new DistributorError(
    "source",
    `The selected source path collides with an initialization file: ${sourceRoot}`,
    {
      operation: "preflight init",
      context: { sourceRoot },
      correction:
        "Choose a source directory that is not an initialization file or its child.",
    },
  );
}

async function buildInitPlan(options: RunInitOptions): Promise<InitPlan> {
  const projectRoot = resolve(options.cwd ?? process.cwd());
  let matches: string[];
  try {
    matches = await supportedConfigsAt(projectRoot);
  } catch (error) {
    if (error instanceof DistributorError) {
      throw error;
    }

    throw new DistributorError(
      "filesystem",
      `Could not inspect the initialization root: ${projectRoot}`,
      {
        operation: "inspect init root",
        context: { projectRoot },
        correction:
          "Fix the directory or its permissions, then rerun initialization.",
        cause: error,
      },
    );
  }

  if (matches.length > 1) {
    throw new DistributorError(
      "config",
      `Multiple Distributor configs found at the init root ${projectRoot}: ${matches.join(", ")}`,
      {
        operation: "preflight init",
        context: { projectRoot, files: matches.join(", ") },
        correction: "Keep exactly one supported Distributor config at the init root.",
      },
    );
  }

  const existingConfigPath = matches[0];
  const configPath =
    existingConfigPath ?? join(projectRoot, GENERATED_CONFIG_NAME);
  const adapterRegistry = await loadAdapterRegistry(projectRoot);
  const availableHarnessChoices = adapterRegistry.catalog.flatMap((entry) =>
    getRegistryAvailableConfig(adapterRegistry, entry.name) === undefined
      ? []
      : [{ name: entry.name, displayName: entry.displayName }],
  );
  const defaultHarnesses = availableHarnessChoices.map(
    (choice) => choice.name,
  );
  let configContents: string | undefined;
  let sourceRoot: string;

  if (existingConfigPath !== undefined) {
    const config = await loadProjectConfig(
      { configPath: existingConfigPath, projectRoot },
      { ...options, adapterRegistry },
    );
    sourceRoot = config.sourceRoot;
  } else {
    if (options.yes !== true && options.isInteractive !== true) {
      throw new DistributorError(
        "usage",
        "Interactive input is unavailable while Distributor configuration is missing.",
        {
          operation: "collect init selections",
          context: { projectRoot },
          correction:
            "Rerun `distributor init --yes` to accept the documented defaults.",
        },
      );
    }

    const selections =
      options.yes === true
        ? { source: DEFAULT_SOURCE_PATH, harnesses: defaultHarnesses }
        : await (options.prompt ?? promptForInitSelections)({
            defaultSource: DEFAULT_SOURCE_PATH,
            defaultHarnesses,
            harnesses: availableHarnessChoices,
          });
    const config = validateProjectConfig(
      {
        source: selections.source,
        harnesses: [...selections.harnesses],
      },
      { configPath, projectRoot },
      { ...options, adapterRegistry },
    );
    sourceRoot = config.sourceRoot;
    configContents = serializeConfig(selections);
  }

  const stateDirectory = join(projectRoot, STATE_DIRECTORY_NAME);
  const stateIgnorePath = join(stateDirectory, STATE_IGNORE_NAME);
  ensureSourceDoesNotCollide(
    sourceRoot,
    configPath,
    stateIgnorePath,
    existingConfigPath === undefined,
  );

  const sourceStats = await inspectPath(sourceRoot, "inspect init source");
  if (sourceStats !== undefined && !sourceStats.isDirectory()) {
    throw new DistributorError(
      "source",
      `The selected source path is not a directory: ${sourceRoot}`,
      {
        operation: "preflight init",
        context: { sourceRoot },
        correction:
          "Choose a directory source path without replacing the existing node.",
      },
    );
  }

  const stateDirectoryStats = await inspectPath(
    stateDirectory,
    "inspect init state directory",
  );
  if (stateDirectoryStats !== undefined && !stateDirectoryStats.isDirectory()) {
    throw new DistributorError(
      "filesystem",
      `The Distributor state path is not a directory: ${stateDirectory}`,
      {
        operation: "preflight init",
        context: { stateDirectory },
        correction:
          "Move the existing node aside, create a directory, and rerun initialization.",
      },
    );
  }

  const stateIgnoreStats =
    stateDirectoryStats === undefined
      ? undefined
      : await inspectPath(stateIgnorePath, "inspect init ignore file");
  if (stateIgnoreStats !== undefined && !stateIgnoreStats.isFile()) {
    throw new DistributorError(
      "filesystem",
      `The Distributor ignore path is not a regular file: ${stateIgnorePath}`,
      {
        operation: "preflight init",
        context: { stateIgnorePath },
        correction: "Move the existing node aside and rerun initialization.",
      },
    );
  }

  return {
    projectRoot,
    configPath,
    configContents,
    sourceRoot,
    createSource: sourceStats === undefined,
    stateDirectory,
    stateIgnorePath,
    createStateIgnore: stateIgnoreStats === undefined,
  };
}

function applyFailure(
  message: string,
  operation: string,
  path: string,
  cause: unknown,
): DistributorError {
  return new DistributorError("filesystem", message, {
    operation,
    context: { path },
    correction: "Fix the path or its permissions, then rerun initialization.",
    cause,
  });
}

async function assertRealProjectParents(
  projectRoot: string,
  targetPath: string,
  operation: string,
): Promise<void> {
  const parentPath = dirname(targetPath);
  if (
    !pathsAreEquivalent(parentPath, projectRoot) &&
    !isStrictChildPath(projectRoot, parentPath)
  ) {
    return;
  }

  const relativeParent = relative(projectRoot, parentPath);
  const segments = relativeParent === "" ? [] : relativeParent.split(sep);
  let current = projectRoot;

  for (const segment of segments) {
    current = join(current, segment);
    const stats = await inspectPath(current, operation);
    if (stats === undefined) {
      return;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new DistributorError(
        "filesystem",
        `Initialization parent is not a real directory: ${current}`,
        {
          operation,
          context: { path: current, targetPath },
          correction:
            "Choose a path with real directory parents; Distributor will not write through symbolic links.",
        },
      );
    }
  }
}

async function applyInitPlan(plan: InitPlan): Promise<void> {
  if (plan.createSource) {
    try {
      await assertRealProjectParents(
        plan.projectRoot,
        plan.sourceRoot,
        "create init source",
      );
      await mkdir(plan.sourceRoot, { recursive: true });
    } catch (error) {
      if (error instanceof DistributorError) {
        throw error;
      }
      throw applyFailure(
        `Could not create the source directory: ${plan.sourceRoot}`,
        "create init source",
        plan.sourceRoot,
        error,
      );
    }
  }

  if (plan.configContents !== undefined) {
    try {
      await assertRealProjectParents(
        plan.projectRoot,
        plan.configPath,
        "create init config",
      );
      await writeFile(plan.configPath, plan.configContents, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if (error instanceof DistributorError) {
        throw error;
      }
      throw applyFailure(
        `Could not create Distributor config: ${plan.configPath}`,
        "create init config",
        plan.configPath,
        error,
      );
    }
  }

  if (plan.createStateIgnore) {
    try {
      await assertRealProjectParents(
        plan.projectRoot,
        plan.stateDirectory,
        "create init state directory",
      );
      await mkdir(plan.stateDirectory, { recursive: true });
      await assertRealProjectParents(
        plan.projectRoot,
        plan.stateIgnorePath,
        "create init ignore file",
      );
      await writeFile(plan.stateIgnorePath, STATE_IGNORE_CONTENTS, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if (error instanceof DistributorError) {
        throw error;
      }
      throw applyFailure(
        `Could not create Distributor state ignore file: ${plan.stateIgnorePath}`,
        "create init ignore file",
        plan.stateIgnorePath,
        error,
      );
    }
  }
}

export async function runInit(options: RunInitOptions = {}): Promise<InitResult> {
  const normalizedOptions: RunInitOptions = {
    ...options,
    isInteractive:
      options.isInteractive ?? process.stdin.isTTY === true,
  };
  const plan = await buildInitPlan(normalizedOptions);
  await applyInitPlan(plan);

  const outcomes: InitOutcome[] = [
    {
      artifact: "config",
      status: plan.configContents === undefined ? "preserved" : "created",
      path: plan.configPath,
    },
    {
      artifact: "source",
      status: plan.createSource ? "created" : "preserved",
      path: plan.sourceRoot,
    },
    {
      artifact: "state-ignore",
      status: plan.createStateIgnore ? "created" : "preserved",
      path: plan.stateIgnorePath,
    },
  ];

  return {
    projectRoot: plan.projectRoot,
    configPath: plan.configPath,
    sourceRoot: plan.sourceRoot,
    outcomes,
    noOp: outcomes.every((outcome) => outcome.status === "preserved"),
  };
}
