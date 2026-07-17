import { readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

import type { AdapterCatalogEntry, HarnessConfig } from "./schema.js";
import { HarnessConfigSchema } from "./schema.js";
import { loadSelectedConfig } from "../config/load.js";
import {
  DistributorError,
  type ValidationIssue,
  validationError,
} from "../errors.js";

const CUSTOM_ADAPTER_DIRECTORY = ".distributor/adapters";
const SUPPORTED_ADAPTER_EXTENSIONS = new Set([".json", ".js", ".ts"]);

export interface AdapterRegistry {
  readonly catalog: readonly AdapterCatalogEntry[];
  readonly configs: ReadonlyMap<string, HarnessConfig>;
}

export function createAdapterRegistry(
  catalog: readonly AdapterCatalogEntry[],
  configs: Readonly<Record<string, HarnessConfig>>,
): AdapterRegistry {
  return {
    catalog,
    configs: new Map(Object.entries(configs)),
  };
}

export async function loadCustomAdapterRegistry(
  cwd: string,
  builtInRegistry: AdapterRegistry,
): Promise<AdapterRegistry> {
  const directory = join(resolve(cwd), CUSTOM_ADAPTER_DIRECTORY);
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return builtInRegistry;
    }
    if (code === "ENOTDIR") {
      throw new DistributorError(
        "filesystem",
        `Custom adapter path is not a directory: ${directory}`,
        {
          operation: "discover custom adapters",
          context: { directory },
          correction:
            "Move the conflicting path and create a .distributor/adapters directory.",
          cause: error,
        },
      );
    }

    throw new DistributorError(
      "filesystem",
      `Could not inspect custom adapter directory: ${directory}`,
      {
        operation: "discover custom adapters",
        context: { directory },
        correction: "Fix the directory or its permissions, then rerun Distributor.",
        cause: error,
      },
    );
  }

  const files = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        SUPPORTED_ADAPTER_EXTENSIONS.has(extname(entry.name)),
    )
    .map((entry) => join(directory, entry.name))
    .sort(compareText);

  if (files.length === 0) {
    return builtInRegistry;
  }

  const catalog = [...builtInRegistry.catalog];
  const configs = new Map(builtInRegistry.configs);
  const origins = new Map(
    builtInRegistry.catalog.map((entry) => [entry.name, "a built-in adapter"]),
  );

  for (const filepath of files) {
    const config = await loadCustomAdapter(filepath);
    const priorOrigin = origins.get(config.name);
    if (priorOrigin !== undefined) {
      throw validationError(
        "config",
        `Duplicate adapter ID ${JSON.stringify(config.name)}.`,
        [
          {
            path: filepath,
            message: `duplicates ${priorOrigin}`,
            received: config.name,
            expected: "an adapter ID unique across built-in and custom adapters",
            correction: "Rename or remove one of the duplicate adapters.",
          },
        ],
        {
          operation: "load custom adapters",
          context: { adapterPath: filepath },
          correction: "Give every adapter a unique name.",
        },
      );
    }

    origins.set(config.name, filepath);
    configs.set(config.name, config);
    catalog.push({
      name: config.name,
      displayName: config.displayName,
      adapterStatus: config.adapterStatus,
    });
  }

  return {
    catalog: Object.freeze(catalog),
    configs,
  };
}

export function getRegistryCatalogEntry(
  registry: AdapterRegistry,
  name: string,
): AdapterCatalogEntry | undefined {
  return registry.catalog.find((entry) => entry.name === name);
}

export function getRegistryAvailableConfig(
  registry: AdapterRegistry,
  name: string,
): HarnessConfig | undefined {
  const config = registry.configs.get(name);
  return config?.adapterStatus === "available" ? config : undefined;
}

export function availableAdapterIds(registry: AdapterRegistry): string {
  return registry.catalog
    .filter((entry) => entry.adapterStatus === "available")
    .map((entry) => entry.name)
    .join(", ");
}

async function loadCustomAdapter(filepath: string): Promise<HarnessConfig> {
  let rawConfig: unknown;
  try {
    rawConfig = await loadSelectedConfig(filepath);
  } catch (error) {
    throw new DistributorError(
      "config",
      `Could not load custom adapter: ${filepath}`,
      {
        operation: "load custom adapter",
        context: { adapterPath: filepath },
        correction:
          extname(filepath) === ".json"
            ? "Fix the JSON adapter, then rerun Distributor."
            : "Fix the trusted executable JavaScript or TypeScript adapter, then rerun Distributor.",
        cause: error,
      },
    );
  }

  const result = HarnessConfigSchema.safeParse(rawConfig);
  if (result.success) {
    return result.data;
  }

  const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
    path:
      issue.path.length === 0
        ? filepath
        : `${filepath}:${issue.path.map(String).join(".")}`,
    message: issue.message,
    expected: "the documented HarnessConfig shape",
    correction: "Update this field to match the custom adapter example.",
  }));

  throw validationError(
    "config",
    `Invalid custom adapter: ${filepath}`,
    issues,
    {
      operation: "validate custom adapter",
      context: { adapterPath: filepath },
      correction: "Correct every reported field and rerun Distributor.",
    },
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
