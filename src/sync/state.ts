import { lstat, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DistributorError,
  type ValidationIssue,
  validationError,
} from "../errors.js";
import { atomicWriteFile } from "../filesystem/atomic-write.js";
import {
  deserializeStatePath,
  pathComparisonKey,
  serializeStatePath,
} from "../filesystem/paths.js";
import { ManagedStateSchema } from "./state-schema.js";
import type { OwnershipAttribution, PlanNotice } from "./types.js";

export const MANAGED_STATE_VERSION = 1 as const;

export interface ManagedStateEntry {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly linkValue: string;
  readonly attributions: readonly OwnershipAttribution[];
}

export interface ManagedState {
  readonly version: typeof MANAGED_STATE_VERSION;
  readonly entries: readonly ManagedStateEntry[];
  readonly directories?: readonly string[];
}

export interface LoadedManagedState extends ManagedState {
  readonly path: string;
  readonly exists: boolean;
  readonly originalText: string | undefined;
  readonly warnings: readonly PlanNotice[];
}

export type StateOwnershipStatus = "owned" | "missing" | "conflict";

export interface StateOwnershipResult {
  readonly entry: ManagedStateEntry;
  readonly status: StateOwnershipStatus;
  readonly currentLinkValue?: string;
  readonly reason?: string;
}

export interface StateEvaluation {
  readonly evaluated: readonly StateOwnershipResult[];
  readonly untouched: readonly ManagedStateEntry[];
}

export interface StatePersistenceResult {
  readonly written: boolean;
  readonly warnings: readonly PlanNotice[];
}

const STATE_IGNORE_CONTENTS = "*\n!.gitignore\n";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareAttributions(
  left: OwnershipAttribution,
  right: OwnershipAttribution,
): number {
  return (
    compareText(left.harnessId, right.harnessId) ||
    compareText(left.placementId, right.placementId)
  );
}

export function compareStateEntries(
  left: ManagedStateEntry,
  right: ManagedStateEntry,
): number {
  return (
    compareText(pathComparisonKey(left.targetPath), pathComparisonKey(right.targetPath)) ||
    compareText(left.targetPath, right.targetPath) ||
    compareText(left.sourcePath, right.sourcePath) ||
    compareText(left.linkValue, right.linkValue)
  );
}

export function statePathForProject(projectRoot: string): string {
  return join(projectRoot, ".distributor", "state.json");
}

function issuePath(path: readonly PropertyKey[]): string {
  return path
    .map((part, index) =>
      typeof part === "number" ? `[${part}]` : `${index === 0 ? "" : "."}${String(part)}`,
    )
    .join("");
}

function stateFailure(
  statePath: string,
  message: string,
  issues: readonly ValidationIssue[],
  cause?: unknown,
): DistributorError {
  return validationError("state", message, issues, {
    operation: "load managed state",
    context: { statePath },
    correction:
      "Restore a valid state file from backup or move the invalid file aside after reviewing managed links.",
    ...(cause === undefined ? {} : { cause }),
  });
}

function parseStateText(text: string, statePath: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw stateFailure(
      statePath,
      `Managed state is not valid JSON: ${statePath}`,
      [
        {
          path: statePath,
          message: error instanceof Error ? error.message : String(error),
          expected: "valid Distributor managed state JSON",
          correction: "Do not let Distributor discard corrupt state automatically.",
        },
      ],
      error,
    );
  }
}

function validateParsedState(
  value: unknown,
  projectRoot: string,
  statePath: string,
): ManagedState {
  const parsed = ManagedStateSchema.safeParse(value);
  if (!parsed.success) {
    throw stateFailure(
      statePath,
      `Managed state has an invalid schema: ${statePath}`,
      parsed.error.issues.map((issue) => ({
        path: issuePath(issue.path),
        message: issue.message,
        expected: "managed state schema version 1",
        correction: "Review the state schema before changing or removing this file.",
      })),
    );
  }

  const issues: ValidationIssue[] = [];
  const entries: ManagedStateEntry[] = [];
  const directories: string[] = [];
  const seenTargets = new Map<string, number>();
  const seenDirectories = new Map<string, number>();

  for (const [entryIndex, entry] of parsed.data.entries.entries()) {
    let sourcePath: string | undefined;
    let targetPath: string | undefined;
    try {
      sourcePath = deserializeStatePath(entry.sourcePath, projectRoot);
      if (serializeStatePath(sourcePath, projectRoot) !== entry.sourcePath) {
        issues.push({
          path: `entries[${entryIndex}].sourcePath`,
          message: "stored source path is not in canonical normalized form",
          received: entry.sourcePath,
          expected: serializeStatePath(sourcePath, projectRoot),
          correction: "Review the state path instead of allowing automatic repair.",
        });
      }
    } catch (error) {
      const failure = error as DistributorError;
      issues.push({
        path: `entries[${entryIndex}].sourcePath`,
        message: failure.message,
        received: entry.sourcePath,
        expected: "a canonical project-relative or external absolute path",
        correction: failure.correction ?? "Use a canonical stored source path.",
      });
    }
    try {
      targetPath = deserializeStatePath(entry.targetPath, projectRoot);
      if (serializeStatePath(targetPath, projectRoot) !== entry.targetPath) {
        issues.push({
          path: `entries[${entryIndex}].targetPath`,
          message: "stored target path is not in canonical normalized form",
          received: entry.targetPath,
          expected: serializeStatePath(targetPath, projectRoot),
          correction: "Review the state path instead of allowing automatic repair.",
        });
      }
    } catch (error) {
      const failure = error as DistributorError;
      issues.push({
        path: `entries[${entryIndex}].targetPath`,
        message: failure.message,
        received: entry.targetPath,
        expected: "a canonical project-relative or external absolute path",
        correction: failure.correction ?? "Use a canonical stored target path.",
      });
    }

    const seenAttributions = new Set<string>();
    const attributions = [...entry.attributions].sort(compareAttributions);
    for (const [attributionIndex, attribution] of attributions.entries()) {
      const key = `${attribution.harnessId}\0${attribution.placementId}`;
      if (seenAttributions.has(key)) {
        issues.push({
          path: `entries[${entryIndex}].attributions[${attributionIndex}]`,
          message: "duplicates a harness/placement attribution",
          received: attribution,
          expected: "unique ownership attributions",
          correction: "Remove only the duplicate attribution after reviewing the state.",
        });
      }
      seenAttributions.add(key);
    }

    if (targetPath !== undefined) {
      const targetKey = pathComparisonKey(targetPath);
      const priorIndex = seenTargets.get(targetKey);
      if (priorIndex !== undefined) {
        issues.push({
          path: `entries[${entryIndex}].targetPath`,
          message: `duplicates the normalized target in entries[${priorIndex}]`,
          received: entry.targetPath,
          expected: "one managed-state entry per target",
          correction: "Resolve the duplicate without changing target files automatically.",
        });
      } else {
        seenTargets.set(targetKey, entryIndex);
      }
    }

    if (sourcePath !== undefined && targetPath !== undefined) {
      entries.push({
        sourcePath,
        targetPath,
        linkValue: entry.linkValue,
        attributions,
      });
    }
  }

  for (const [directoryIndex, storedDirectory] of parsed.data.directories.entries()) {
    try {
      const directory = deserializeStatePath(storedDirectory, projectRoot);
      const canonicalDirectory = serializeStatePath(directory, projectRoot);
      if (canonicalDirectory !== storedDirectory) {
        issues.push({
          path: `directories[${directoryIndex}]`,
          message: "stored directory path is not in canonical normalized form",
          received: storedDirectory,
          expected: canonicalDirectory,
          correction: "Review the state path instead of allowing automatic repair.",
        });
      }

      const key = pathComparisonKey(directory);
      const priorIndex = seenDirectories.get(key);
      if (priorIndex !== undefined) {
        issues.push({
          path: `directories[${directoryIndex}]`,
          message: `duplicates the normalized directory in directories[${priorIndex}]`,
          received: storedDirectory,
          expected: "unique managed directory paths",
          correction: "Remove only the duplicate directory after reviewing the state.",
        });
      } else {
        seenDirectories.set(key, directoryIndex);
        directories.push(directory);
      }
    } catch (error) {
      const failure = error as DistributorError;
      issues.push({
        path: `directories[${directoryIndex}]`,
        message: failure.message,
        received: storedDirectory,
        expected: "a canonical project-relative or external absolute path",
        correction: failure.correction ?? "Use a canonical stored directory path.",
      });
    }
  }

  if (issues.length > 0) {
    throw stateFailure(
      statePath,
      `Managed state contains unsafe or duplicate paths: ${statePath}`,
      issues,
    );
  }

  return {
    version: MANAGED_STATE_VERSION,
    entries: entries.sort(compareStateEntries),
    directories: directories.sort(compareText),
  };
}

export async function loadManagedState(
  projectRoot: string,
): Promise<LoadedManagedState> {
  const path = statePathForProject(projectRoot);
  const stateDirectory = dirname(path);

  let directoryStats;
  try {
    directoryStats = await lstat(stateDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        version: MANAGED_STATE_VERSION,
        entries: [],
        directories: [],
        path,
        exists: false,
        originalText: undefined,
        warnings: [],
      };
    }
    throw new DistributorError("state", `Could not inspect managed state directory: ${stateDirectory}`, {
      operation: "load managed state",
      context: { stateDirectory },
      correction: "Fix the state-directory permissions and rerun Distributor.",
      cause: error,
    });
  }

  if (!directoryStats.isDirectory()) {
    throw new DistributorError(
      "state",
      `Managed state directory is not a real directory: ${stateDirectory}`,
      {
        operation: "load managed state",
        context: { stateDirectory },
        correction:
          "Move the non-directory or symbolic link aside after reviewing it; Distributor will not follow it.",
      },
    );
  }
  const warnings = await inspectManagedStateIgnore(projectRoot);

  let stateStats;
  try {
    stateStats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        version: MANAGED_STATE_VERSION,
        entries: [],
        directories: [],
        path,
        exists: false,
        originalText: undefined,
        warnings,
      };
    }
    throw new DistributorError("state", `Could not inspect managed state: ${path}`, {
      operation: "load managed state",
      context: { statePath: path },
      correction: "Fix the state-file permissions and rerun Distributor.",
      cause: error,
    });
  }

  if (!stateStats.isFile()) {
    throw new DistributorError(
      "state",
      `Managed state path is not a regular file: ${path}`,
      {
        operation: "load managed state",
        context: { statePath: path },
        correction:
          "Move the non-file or symbolic link aside after reviewing managed links; Distributor will not follow it.",
      },
    );
  }

  let originalText: string;
  try {
    originalText = await readFile(path, "utf8");
  } catch (error) {
    throw new DistributorError("state", `Could not read managed state: ${path}`, {
      operation: "load managed state",
      context: { statePath: path },
      correction: "Fix the state-file permissions and rerun Distributor.",
      cause: error,
    });
  }

  const state = validateParsedState(parseStateText(originalText, path), projectRoot, path);
  return { ...state, path, exists: true, originalText, warnings };
}

export function serializeManagedState(
  state: ManagedState,
  projectRoot: string,
): string {
  const entries = [...state.entries].sort(compareStateEntries).map((entry) => ({
    sourcePath: serializeStatePath(entry.sourcePath, projectRoot),
    targetPath: serializeStatePath(entry.targetPath, projectRoot),
    linkValue: entry.linkValue,
    attributions: [...entry.attributions].sort(compareAttributions).map((item) => ({
      harnessId: item.harnessId,
      placementId: item.placementId,
    })),
  }));
  const directories = [...(state.directories ?? [])]
    .sort(compareText)
    .map((directory) => serializeStatePath(directory, projectRoot));

  return `${JSON.stringify({ version: MANAGED_STATE_VERSION, entries, directories }, null, 2)}\n`;
}

function isEntryInScope(
  entry: ManagedStateEntry,
  harnessId: string | undefined,
): boolean {
  return (
    harnessId === undefined ||
    entry.attributions.some((attribution) => attribution.harnessId === harnessId)
  );
}

async function inspectOwnership(
  entry: ManagedStateEntry,
): Promise<StateOwnershipResult> {
  let stats;
  try {
    stats = await lstat(entry.targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { entry, status: "missing" };
    }
    return {
      entry,
      status: "conflict",
      reason: `Could not inspect recorded target: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!stats.isSymbolicLink()) {
    return {
      entry,
      status: "conflict",
      reason: "The recorded target is no longer a symbolic link.",
    };
  }

  try {
    const currentLinkValue = await readlink(entry.targetPath);
    if (currentLinkValue !== entry.linkValue) {
      return {
        entry,
        status: "conflict",
        currentLinkValue,
        reason: "The recorded symbolic link value has changed.",
      };
    }
    return { entry, status: "owned", currentLinkValue };
  } catch (error) {
    return {
      entry,
      status: "conflict",
      reason: `Could not read the recorded symbolic link: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function evaluateManagedState(
  state: ManagedState,
  harnessId?: string,
): Promise<StateEvaluation> {
  const evaluatedEntries = state.entries.filter((entry) =>
    isEntryInScope(entry, harnessId),
  );
  const untouched = state.entries.filter(
    (entry) => !isEntryInScope(entry, harnessId),
  );
  const evaluated: StateOwnershipResult[] = [];

  for (const entry of evaluatedEntries) {
    evaluated.push(await inspectOwnership(entry));
  }

  return { evaluated, untouched };
}

async function ensureRealStateDirectory(path: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new DistributorError(
        "filesystem",
        `Could not inspect managed state directory: ${path}`,
        {
          operation: "persist managed state",
          context: { stateDirectory: path },
          correction: "Fix the state-directory permissions and rerun Distributor.",
          cause: error,
        },
      );
    }

    try {
      await mkdir(path);
      stats = await lstat(path);
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code === "EEXIST") {
        stats = await lstat(path);
      } else {
        throw new DistributorError(
          "filesystem",
          `Could not create managed state directory: ${path}`,
          {
            operation: "persist managed state",
            context: { stateDirectory: path },
            correction: "Fix the project permissions and rerun Distributor.",
            cause: mkdirError,
          },
        );
      }
    }
  }

  if (!stats.isDirectory()) {
    throw new DistributorError(
      "filesystem",
      `Managed state directory is not a real directory: ${path}`,
      {
        operation: "persist managed state",
        context: { stateDirectory: path },
        correction:
          "Move the non-directory or symbolic link aside after reviewing it; Distributor will not write through it.",
      },
    );
  }
}

function ignoreFileCoversState(contents: string): boolean {
  let ignored = false;

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const negated = line.startsWith("!");
    let pattern = negated ? line.slice(1) : line;
    if (pattern.startsWith("/")) {
      pattern = pattern.slice(1);
    }
    if (pattern.length === 0) {
      continue;
    }

    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const expression = escaped
      .replaceAll("**", "\0")
      .replaceAll("*", "[^/]*")
      .replaceAll("?", "[^/]")
      .replaceAll("\0", ".*");
    try {
      if (new RegExp(`^${expression}$`).test("state.json")) {
        ignored = !negated;
      }
    } catch {
      // An invalid pattern does not establish that state.json is ignored.
    }
  }

  return ignored;
}

async function inspectExistingStateIgnore(
  ignorePath: string,
): Promise<PlanNotice[] | undefined> {
  let stats;
  try {
    stats = await lstat(ignorePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new DistributorError(
      "filesystem",
      `Could not inspect state ignore file: ${ignorePath}`,
      {
        operation: "inspect managed state",
        context: { ignorePath },
        correction: "Fix the ignore-file permissions and rerun Distributor.",
        cause: error,
      },
    );
  }

  if (!stats.isFile()) {
    throw new DistributorError(
      "filesystem",
      `State ignore path is not a regular file: ${ignorePath}`,
      {
        operation: "inspect managed state",
        context: { ignorePath },
        correction:
          "Move the non-file or symbolic link aside; Distributor will not replace it.",
      },
    );
  }

  let contents: string;
  try {
    contents = await readFile(ignorePath, "utf8");
  } catch (error) {
    throw new DistributorError(
      "filesystem",
      `Could not read state ignore file: ${ignorePath}`,
      {
        operation: "inspect managed state",
        context: { ignorePath },
        correction: "Fix the ignore-file permissions and rerun Distributor.",
        cause: error,
      },
    );
  }

  return ignoreFileCoversState(contents)
    ? []
    : [
        {
          path: ignorePath,
          message:
            "The existing .distributor/.gitignore does not ignore state.json; local ownership state may be committed.",
        },
      ];
}

export async function inspectManagedStateIgnore(
  projectRoot: string,
): Promise<readonly PlanNotice[]> {
  const ignorePath = join(dirname(statePathForProject(projectRoot)), ".gitignore");
  return (await inspectExistingStateIgnore(ignorePath)) ?? [];
}

async function ensureStateIgnore(
  stateDirectory: string,
): Promise<PlanNotice[]> {
  const ignorePath = join(stateDirectory, ".gitignore");
  const existing = await inspectExistingStateIgnore(ignorePath);
  if (existing !== undefined) {
    return existing;
  }

  try {
    await writeFile(ignorePath, STATE_IGNORE_CONTENTS, {
      encoding: "utf8",
      flag: "wx",
    });
    return [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new DistributorError(
        "filesystem",
        `Could not create state ignore file: ${ignorePath}`,
        {
          operation: "persist managed state",
          context: { ignorePath },
          correction: "Fix the state-directory permissions and rerun Distributor.",
          cause: error,
        },
      );
    }
  }

  const raced = await inspectExistingStateIgnore(ignorePath);
  if (raced === undefined) {
    throw new DistributorError(
      "filesystem",
      `State ignore file disappeared while it was being created: ${ignorePath}`,
      {
        operation: "persist managed state",
        context: { ignorePath },
        correction: "Stabilize the state directory and rerun Distributor.",
      },
    );
  }
  return raced;
}

export async function persistManagedState(
  loaded: LoadedManagedState,
  nextState: ManagedState,
  projectRoot: string,
): Promise<StatePersistenceResult> {
  const contents = serializeManagedState(nextState, projectRoot);
  if (
    loaded.originalText === contents ||
    (!loaded.exists &&
      nextState.entries.length === 0 &&
      (nextState.directories?.length ?? 0) === 0)
  ) {
    return { written: false, warnings: [] };
  }

  const expectedPath = statePathForProject(projectRoot);
  if (loaded.path !== expectedPath) {
    throw new DistributorError("state", "Managed state path is not canonical.", {
      operation: "persist managed state",
      context: { statePath: loaded.path, expectedPath },
      correction: "Reload state from the canonical project-local path before writing.",
    });
  }

  const stateDirectory = dirname(expectedPath);
  await ensureRealStateDirectory(stateDirectory);
  const warnings = await ensureStateIgnore(stateDirectory);

  try {
    await atomicWriteFile(expectedPath, contents);
  } catch (error) {
    throw new DistributorError(
      "filesystem",
      `Could not atomically write managed state: ${expectedPath}`,
      {
        operation: "persist managed state",
        context: { statePath: expectedPath },
        correction:
          "Fix the state-directory permissions and rerun sync; prior managed links are restored when safe and new exact links can be adopted.",
        cause: error,
      },
    );
  }

  return { written: true, warnings };
}
