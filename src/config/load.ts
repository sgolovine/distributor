import { extname } from "node:path";
import { pathToFileURL } from "node:url";

import {
  cosmiconfig,
  defaultLoaders,
  type Loader,
} from "cosmiconfig";
import { tsImport } from "tsx/esm/api";

import { SUPPORTED_CONFIG_FILENAMES } from "./supported.js";

const loadTypeScript: Loader = async (filepath) => {
  const loaded: unknown = await tsImport(pathToFileURL(filepath).href, {
    parentURL: import.meta.url,
    tsconfig: false,
  });

  if (typeof loaded !== "object" || loaded === null || !("default" in loaded)) {
    return null;
  }

  const defaultExport: unknown = loaded.default;
  if (
    typeof defaultExport === "object" &&
    defaultExport !== null &&
    "default" in defaultExport &&
    "__esModule" in defaultExport &&
    defaultExport.__esModule === true
  ) {
    return defaultExport.default;
  }

  return defaultExport;
};

const loaders = {
  ".json": defaultLoaders[".json"],
  ".js": defaultLoaders[".js"],
  ".ts": loadTypeScript,
};

export async function loadSelectedConfig(filepath: string): Promise<unknown> {
  const extension = extname(filepath);
  if (!(extension in loaders)) {
    throw new Error(
      `Unsupported Distributor config extension ${JSON.stringify(extension)}.`,
    );
  }

  const explorer = cosmiconfig("distributor", {
    cache: false,
    loaders,
    searchPlaces: [...SUPPORTED_CONFIG_FILENAMES],
    searchStrategy: "none",
  });
  const result = await explorer.load(filepath);

  if (result === null || result.isEmpty === true) {
    throw new Error(`Distributor config is empty: ${filepath}`);
  }

  return result.config;
}
