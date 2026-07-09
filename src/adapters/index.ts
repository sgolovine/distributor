import claudeCodeConfig from "./claude-code.config.js";
import codexConfig from "./codex.config.js";
import {
  type AvailableAdapterId,
  isAvailableAdapterId,
} from "./catalog.js";
import opencodeConfig from "./opencode.config.js";
import {
  parseHarnessConfig,
  type HarnessConfig,
} from "./schema.js";

export const availableAdapterConfigs: Readonly<
  Record<AvailableAdapterId, HarnessConfig>
> = {
  codex: parseHarnessConfig("codex", codexConfig),
  "claude-code": parseHarnessConfig("claude-code", claudeCodeConfig),
  opencode: parseHarnessConfig("opencode", opencodeConfig),
};

export function getAvailableAdapterConfig(
  name: string,
): HarnessConfig | undefined {
  if (!isAvailableAdapterId(name)) {
    return undefined;
  }

  return availableAdapterConfigs[name];
}

export {
  adapterCatalog,
  getAdapterCatalogEntry,
  isAdapterId,
  isAvailableAdapterId,
} from "./catalog.js";
export type { AdapterId, AvailableAdapterId } from "./catalog.js";
export {
  AdapterCatalogEntrySchema,
  AdapterCatalogSchema,
  AdapterStatusSchema,
  HarnessConfigSchema,
  HarnessPlacementSchema,
  HarnessPlacementScopeSchema,
  HarnessPlacementSupportSchema,
  parseHarnessConfig,
} from "./schema.js";
export type {
  AdapterCatalogEntry,
  AdapterStatus,
  HarnessConfig,
  HarnessPlacement,
  HarnessPlacementScope,
  HarnessPlacementSupport,
} from "./schema.js";
