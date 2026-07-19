import type { Dirent, Stats } from "node:fs";
import { cp, lstat, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { confirm, isCancel, multiselect } from "@clack/prompts";

import {
  type AdapterRegistry,
  getRegistryAvailableConfig,
  loadAdapterRegistry,
} from "../adapters/index.js";
import { discoverConfigIfPresent } from "../config/discover.js";
import {
  loadProjectConfig,
  type ValidateConfigOptions,
} from "../config/validate.js";
import { DistributorError } from "../errors.js";
import {
  type PathStyle,
  pathComparisonKey,
  pathsAreEquivalent,
  resolveConfigPath,
} from "../filesystem/paths.js";
import { type InitPrompt, type InitResult, runInit } from "../init/run-init.js";
import { discoverSkill, SkillValidationError } from "../skills/discover.js";

export interface ImportCandidate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly sourceRoot: string;
  readonly sourcePath: string;
  readonly harnesses: readonly string[];
}

export interface ImportWarning {
  readonly path: string;
  readonly message: string;
}

export interface ImportScanResult {
  readonly candidates: readonly ImportCandidate[];
  readonly warnings: readonly ImportWarning[];
}

export interface ImportPromptContext {
  readonly sourceRoot: string;
  readonly candidates: readonly ImportCandidate[];
}

export type ImportPrompt = (
  context: ImportPromptContext,
) => Promise<readonly string[]>;

export type ImportOfferPrompt = (
  context: ImportPromptContext,
) => Promise<boolean>;

export interface ImportedSkill {
  readonly name: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
}

export interface RunImportOptions extends ValidateConfigOptions {
  readonly cwd?: string;
  readonly isInteractive?: boolean;
  readonly projectRoot?: string;
  readonly sourceRoot?: string;
  readonly offer?: boolean;
  readonly prompt?: ImportPrompt;
  readonly offerPrompt?: ImportOfferPrompt;
  readonly initPrompt?: InitPrompt;
}

export interface RunImportResult {
  readonly projectRoot: string;
  readonly sourceRoot: string;
  readonly initialized?: InitResult;
  readonly candidates: readonly ImportCandidate[];
  readonly imported: readonly ImportedSkill[];
  readonly warnings: readonly ImportWarning[];
  readonly declined: boolean;
}

interface ScanRoot {
  readonly path: string;
  readonly harnesses: Set<string>;
}

function cancelledImport(): DistributorError {
  return new DistributorError("usage", "Skill import was cancelled.", {
    operation: "collect import selections",
    correction: "Rerun `distributor import` and complete the prompts.",
  });
}

export async function promptForImportSelections(
  context: ImportPromptContext,
): Promise<readonly string[]> {
  const selected = await multiselect<string>({
    message: `Which skills should be imported into ${context.sourceRoot}?`,
    options: context.candidates.map((candidate) => ({
      value: candidate.id,
      label: candidate.name,
      hint: `${candidate.harnesses.join(", ")} - ${candidate.sourceRoot}`,
    })),
    required: false,
  });
  if (isCancel(selected)) {
    throw cancelledImport();
  }
  return selected;
}

export async function promptForImportOffer(
  context: ImportPromptContext,
): Promise<boolean> {
  const accepted = await confirm({
    message: `Found ${context.candidates.length} importable skill${context.candidates.length === 1 ? "" : "s"}. Import skills now?`,
    initialValue: true,
  });
  if (isCancel(accepted)) {
    throw cancelledImport();
  }
  return accepted;
}

export async function scanHarnessSkills(options: {
  readonly projectRoot: string;
  readonly sourceRoot: string;
  readonly adapterRegistry: AdapterRegistry;
  readonly homeDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly pathStyle?: PathStyle;
}): Promise<ImportScanResult> {
  const environment = options.environment ?? process.env;
  const roots = new Map<string, ScanRoot>();

  for (const entry of options.adapterRegistry.catalog) {
    const adapter = getRegistryAvailableConfig(
      options.adapterRegistry,
      entry.name,
    );
    if (adapter === undefined) {
      continue;
    }

    for (const placement of adapter.placements) {
      if (
        placement.item !== "skills" ||
        (placement.support !== "native" &&
          placement.support !== "compatibility")
      ) {
        continue;
      }
      const environmentPath = placement.environmentVariables
        ?.map((name) => environment[name])
        .find(
          (value): value is string => value !== undefined && value.length > 0,
        );
      const rootPath = resolveConfigPath(
        environmentPath ?? placement.defaultPath,
        {
          projectRoot: options.projectRoot,
          homeDirectory: options.homeDirectory ?? homedir(),
          ...(options.pathStyle === undefined
            ? {}
            : { style: options.pathStyle }),
        },
      );
      if (pathsAreEquivalent(rootPath, options.sourceRoot, options.pathStyle)) {
        continue;
      }
      const key = pathComparisonKey(rootPath, options.pathStyle);
      const existing = roots.get(key);
      if (existing === undefined) {
        roots.set(key, { path: rootPath, harnesses: new Set([entry.name]) });
      } else {
        existing.harnesses.add(entry.name);
      }
    }
  }

  const candidates: ImportCandidate[] = [];
  const warnings: ImportWarning[] = [];
  const existingNames = await existingSkillNames(options.sourceRoot);

  for (const root of [...roots.values()].sort((left, right) =>
    compareText(left.path, right.path),
  )) {
    let entries: Dirent[];
    try {
      entries = await readdir(root.path, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        continue;
      }
      warnings.push({
        path: root.path,
        message: `Could not scan this harness skill directory: ${errorMessage(error)}.`,
      });
      continue;
    }

    for (const entry of entries.sort((left, right) =>
      compareText(left.name, right.name),
    )) {
      if (entry.name.startsWith(".") || !entry.isDirectory()) {
        continue;
      }
      if (existingNames.has(entry.name)) {
        continue;
      }

      try {
        const skill = await discoverSkill(root.path, entry.name);
        candidates.push({
          id: join(root.path, entry.name),
          name: skill.name,
          description: skill.frontmatter.description,
          sourceRoot: root.path,
          sourcePath: skill.directoryPath,
          harnesses: [...root.harnesses].sort(compareText),
        });
      } catch (error) {
        const message =
          error instanceof SkillValidationError
            ? error.problems.map((problem) => problem.message).join("; ")
            : errorMessage(error);
        warnings.push({
          path: join(root.path, entry.name),
          message: `Ignored invalid skill: ${message}`,
        });
      }
    }
  }

  candidates.sort(
    (left, right) =>
      compareText(left.name, right.name) ||
      compareText(left.sourcePath, right.sourcePath),
  );
  warnings.sort((left, right) => compareText(left.path, right.path));
  return { candidates, warnings };
}

export async function runImport(
  options: RunImportOptions = {},
): Promise<RunImportResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const isInteractive = options.isInteractive ?? process.stdin.isTTY === true;
  const adapterRegistry = await loadAdapterRegistry(cwd);
  let projectRoot = options.projectRoot;
  let sourceRoot = options.sourceRoot;
  let initialized: InitResult | undefined;

  if ((projectRoot === undefined) !== (sourceRoot === undefined)) {
    throw new TypeError(
      "projectRoot and sourceRoot must be provided together.",
    );
  }

  if (projectRoot === undefined || sourceRoot === undefined) {
    const discovered = await discoverConfigIfPresent(cwd);
    if (discovered === undefined) {
      initialized = await runInit({
        cwd,
        isInteractive,
        ...(options.initPrompt === undefined
          ? {}
          : { prompt: options.initPrompt }),
        ...validationOptions(options),
      });
      projectRoot = initialized.projectRoot;
      sourceRoot = initialized.sourceRoot;
    } else {
      const config = await loadProjectConfig(discovered, {
        ...validationOptions(options),
        adapterRegistry,
      });
      projectRoot = config.projectRoot;
      sourceRoot = config.sourceRoot;
    }
  }

  const scan = await scanHarnessSkills({
    projectRoot,
    sourceRoot,
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
  const context = { sourceRoot, candidates: scan.candidates };
  if (scan.candidates.length === 0) {
    return {
      projectRoot,
      sourceRoot,
      ...(initialized === undefined ? {} : { initialized }),
      candidates: scan.candidates,
      imported: [],
      warnings: scan.warnings,
      declined: false,
    };
  }
  if (!isInteractive) {
    throw new DistributorError(
      "usage",
      "Interactive input is unavailable for skill import selection.",
      {
        operation: "collect import selections",
        correction: "Run `distributor import` in an interactive terminal.",
      },
    );
  }
  if (
    options.offer === true &&
    !(await (options.offerPrompt ?? promptForImportOffer)(context))
  ) {
    return {
      projectRoot,
      sourceRoot,
      ...(initialized === undefined ? {} : { initialized }),
      candidates: scan.candidates,
      imported: [],
      warnings: scan.warnings,
      declined: true,
    };
  }

  const selectedIds = await (options.prompt ?? promptForImportSelections)(
    context,
  );
  const selected = selectCandidates(scan.candidates, selectedIds);
  await preflightImport(sourceRoot, selected);

  const imported: ImportedSkill[] = [];
  for (const candidate of selected) {
    const destinationPath = join(sourceRoot, candidate.name);
    try {
      await cp(candidate.sourcePath, destinationPath, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    } catch (error) {
      throw new DistributorError(
        "filesystem",
        `Could not import skill ${JSON.stringify(candidate.name)}.`,
        {
          operation: "copy imported skill",
          context: { sourcePath: candidate.sourcePath, destinationPath },
          correction:
            "Remove the partial destination if one was created, fix permissions, and rerun import.",
          cause: error,
        },
      );
    }
    imported.push({
      name: candidate.name,
      sourcePath: candidate.sourcePath,
      destinationPath,
    });
  }

  return {
    projectRoot,
    sourceRoot,
    ...(initialized === undefined ? {} : { initialized }),
    candidates: scan.candidates,
    imported,
    warnings: scan.warnings,
    declined: false,
  };
}

async function existingSkillNames(sourceRoot: string): Promise<Set<string>> {
  try {
    const entries = await readdir(sourceRoot, { withFileTypes: true });
    return new Set(entries.map((entry) => entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Set();
    }
    throw new DistributorError(
      "filesystem",
      `Could not inspect the configured skill source: ${sourceRoot}`,
      {
        operation: "scan configured skills",
        context: { sourceRoot },
        correction:
          "Fix the source path or its permissions, then rerun import.",
        cause: error,
      },
    );
  }
}

function selectCandidates(
  candidates: readonly ImportCandidate[],
  selectedIds: readonly string[],
): ImportCandidate[] {
  const byId = new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  );
  const selected: ImportCandidate[] = [];
  const names = new Set<string>();

  for (const id of selectedIds) {
    const candidate = byId.get(id);
    if (candidate === undefined) {
      throw new DistributorError(
        "usage",
        "Import selection is no longer available.",
        {
          operation: "validate import selections",
          received: id,
          correction: "Rerun import and select one of the displayed skills.",
        },
      );
    }
    if (names.has(candidate.name)) {
      throw new DistributorError(
        "conflict",
        `Multiple selected skills would use the destination name ${JSON.stringify(candidate.name)}.`,
        {
          operation: "validate import selections",
          correction: `Select only one copy of ${candidate.name}.`,
        },
      );
    }
    names.add(candidate.name);
    selected.push(candidate);
  }

  return selected;
}

async function preflightImport(
  sourceRoot: string,
  candidates: readonly ImportCandidate[],
): Promise<void> {
  let sourceStats: Stats;
  try {
    sourceStats = await lstat(sourceRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await mkdir(sourceRoot, { recursive: true });
    sourceStats = await lstat(sourceRoot);
  }
  if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
    throw new DistributorError(
      "source",
      `The configured skill source is not a real directory: ${sourceRoot}`,
      {
        operation: "preflight skill import",
        correction: "Choose a regular directory as the Distributor source.",
      },
    );
  }

  for (const candidate of candidates) {
    await discoverSkill(candidate.sourceRoot, candidate.name);
    const destinationPath = join(sourceRoot, candidate.name);
    try {
      await lstat(destinationPath);
      throw new DistributorError(
        "conflict",
        `Import destination already exists: ${destinationPath}`,
        {
          operation: "preflight skill import",
          correction: "Keep the existing skill or remove it before importing.",
        },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
}

function validationOptions(
  options: ValidateConfigOptions,
): ValidateConfigOptions {
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
