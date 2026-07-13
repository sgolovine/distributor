import { lstat, readlink, unlink } from "node:fs/promises";

import { discoverConfig } from "../config/discover.js";
import {
  loadManagedState,
  persistManagedState,
  type ManagedState,
  type ManagedStateEntry,
} from "../sync/state.js";
import type { PlanNotice } from "../sync/types.js";

export type RemoveStatus = "removed" | "missing" | "failed";

export interface RemoveOperationResult {
  readonly targetPath: string;
  readonly status: RemoveStatus;
  readonly message?: string;
}

export interface RunRemoveResult {
  readonly exitCode: 0 | 1;
  readonly projectRoot: string;
  readonly operations: readonly RemoveOperationResult[];
  readonly warnings: readonly PlanNotice[];
  readonly stateWritten: boolean;
  readonly counts: {
    readonly removed: number;
    readonly missing: number;
    readonly failed: number;
  };
}

export interface RunRemoveRuntime {
  readonly discoverConfig: typeof discoverConfig;
  readonly loadManagedState: typeof loadManagedState;
  readonly persistManagedState: typeof persistManagedState;
}

export interface RunRemoveOptions {
  readonly cwd?: string;
  readonly runtime?: Partial<RunRemoveRuntime>;
}

const defaultRuntime: RunRemoveRuntime = {
  discoverConfig,
  loadManagedState,
  persistManagedState,
};

export async function runRemove(
  options: RunRemoveOptions = {},
): Promise<RunRemoveResult> {
  const runtime = { ...defaultRuntime, ...options.runtime };
  const discovered = await runtime.discoverConfig(options.cwd ?? process.cwd());
  const state = await runtime.loadManagedState(discovered.projectRoot);
  const operations: RemoveOperationResult[] = [];
  const retainedEntries: ManagedStateEntry[] = [];

  for (const entry of state.entries) {
    const result = await removeEntry(entry);
    operations.push(result);
    if (result.status === "failed") {
      retainedEntries.push(entry);
    }
  }

  const nextState: ManagedState = { version: 1, entries: retainedEntries };
  let stateWritten = false;
  let warnings: readonly PlanNotice[] = state.warnings;

  try {
    const persistence = await runtime.persistManagedState(
      state,
      nextState,
      discovered.projectRoot,
    );
    stateWritten = persistence.written;
    warnings = mergeWarnings(state.warnings, persistence.warnings);
  } catch (error) {
    operations.push({
      targetPath: state.path,
      status: "failed",
      message: `Could not update managed state: ${errorMessage(error)}`,
    });
  }

  const counts = Object.freeze({
    removed: operations.filter((result) => result.status === "removed").length,
    missing: operations.filter((result) => result.status === "missing").length,
    failed: operations.filter((result) => result.status === "failed").length,
  });

  return Object.freeze({
    exitCode: counts.failed === 0 ? 0 : 1,
    projectRoot: discovered.projectRoot,
    operations: Object.freeze(operations),
    warnings,
    stateWritten,
    counts,
  });
}

async function removeEntry(
  entry: ManagedStateEntry,
): Promise<RemoveOperationResult> {
  try {
    const stats = await lstat(entry.targetPath);
    if (!stats.isSymbolicLink()) {
      return failed(entry, "Recorded target is no longer a symbolic link.");
    }

    const linkValue = await readlink(entry.targetPath);
    if (linkValue !== entry.linkValue) {
      return failed(entry, "Recorded symbolic link value has changed.");
    }

    await unlink(entry.targetPath);
    return { targetPath: entry.targetPath, status: "removed" };
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { targetPath: entry.targetPath, status: "missing" };
    }
    return failed(entry, `Could not remove managed link: ${errorMessage(error)}`);
  }
}

function failed(
  entry: ManagedStateEntry,
  message: string,
): RemoveOperationResult {
  return { targetPath: entry.targetPath, status: "failed", message };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeWarnings(
  left: readonly PlanNotice[],
  right: readonly PlanNotice[],
): readonly PlanNotice[] {
  const warnings = new Map<string, PlanNotice>();
  for (const warning of [...left, ...right]) {
    warnings.set(`${warning.path ?? ""}\0${warning.message}`, warning);
  }
  return Object.freeze([...warnings.values()]);
}
