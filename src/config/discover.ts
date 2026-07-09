import { lstat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

import { DistributorError } from "../errors.js";
import { SUPPORTED_CONFIG_FILENAMES } from "./supported.js";

export interface DiscoveredConfig {
  configPath: string;
  projectRoot: string;
  searchedBoundary: string;
}

async function isSupportedConfigFile(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) {
      throw new DistributorError(
        "config",
        `Supported config path is not a regular file: ${path}`,
        {
          operation: "discover config",
          context: { configPath: path },
          correction:
            "Move this filesystem node aside and create a regular Distributor config file.",
        },
      );
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    if (error instanceof DistributorError) {
      throw error;
    }
    throw new DistributorError(
      "filesystem",
      `Could not inspect config candidate: ${path}`,
      {
        operation: "discover config",
        context: { configPath: path },
        correction: "Fix path permissions and rerun Distributor.",
        cause: error,
      },
    );
  }
}

export async function supportedConfigsAt(directory: string): Promise<string[]> {
  const candidates = SUPPORTED_CONFIG_FILENAMES.map((name) =>
    join(directory, name),
  );
  const present = await Promise.all(candidates.map(isSupportedConfigFile));

  return candidates.filter((_, index) => present[index]);
}

export async function findGitWorktreeRoot(
  startDirectory: string,
): Promise<string | undefined> {
  let current = resolve(startDirectory);

  while (true) {
    try {
      const marker = await lstat(join(current, ".git"));
      if (marker.isDirectory() || marker.isFile()) {
        return current;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new DistributorError(
          "filesystem",
          `Could not inspect Git worktree marker: ${join(current, ".git")}`,
          {
            operation: "find Git worktree root",
            context: { path: join(current, ".git") },
            correction: "Fix path permissions and rerun Distributor.",
            cause: error,
          },
        );
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export async function findInitRoot(startDirectory: string): Promise<string> {
  const start = resolve(startDirectory);
  return (await findGitWorktreeRoot(start)) ?? start;
}

export async function discoverConfig(
  startDirectory: string,
): Promise<DiscoveredConfig> {
  const start = resolve(startDirectory);
  const worktreeRoot = await findGitWorktreeRoot(start);
  const boundary = worktreeRoot ?? parse(start).root;
  let current = start;

  while (true) {
    const matches = await supportedConfigsAt(current);
    if (matches.length > 1) {
      throw new DistributorError(
        "config",
        `Multiple Distributor configs found in ${current}: ${matches.join(", ")}`,
        {
          operation: "discover config",
          context: { directory: current, files: matches.join(", ") },
          correction: "Keep exactly one supported Distributor config in this directory.",
        },
      );
    }

    const configPath = matches[0];
    if (configPath !== undefined) {
      return {
        configPath,
        projectRoot: current,
        searchedBoundary: boundary,
      };
    }

    if (current === boundary) {
      break;
    }
    current = dirname(current);
  }

  throw new DistributorError(
    "config",
    `No Distributor config found from ${start} through ${boundary}.`,
    {
      operation: "discover config",
      context: { start, boundary },
      correction:
        "Run `distributor init` or create distributor.config.json, distributor.config.js, or distributor.config.ts.",
    },
  );
}
