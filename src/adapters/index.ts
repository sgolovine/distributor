import antigravityConfig from "./antigravity.config.js";
import clineConfig from "./cline.config.js";
import claudeCodeConfig from "./claude-code.config.js";
import codexConfig from "./codex.config.js";
import crushConfig from "./crush.config.js";
import cursorConfig from "./cursor.config.js";
import geminiCliConfig from "./gemini-cli.config.js";
import githubCopilotConfig from "./github-copilot.config.js";
import gooseConfig from "./goose.config.js";
import {
  type AvailableAdapterId,
  isAvailableAdapterId,
} from "./catalog.js";
import opencodeConfig from "./opencode.config.js";
import openhandsConfig from "./openhands.config.js";
import piConfig from "./pi.config.js";
import qwenCodeConfig from "./qwen-code.config.js";
import kiloCodeConfig from "./kilo-code.config.js";
import rooCodeConfig from "./roo-code.config.js";
import traeAgentConfig from "./trae-agent.config.js";
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
  cursor: parseHarnessConfig("cursor", cursorConfig),
  "gemini-cli": parseHarnessConfig("gemini-cli", geminiCliConfig),
  antigravity: parseHarnessConfig("antigravity", antigravityConfig),
  "github-copilot": parseHarnessConfig("github-copilot", githubCopilotConfig),
  openhands: parseHarnessConfig("openhands", openhandsConfig),
  pi: parseHarnessConfig("pi", piConfig),
  cline: parseHarnessConfig("cline", clineConfig),
  goose: parseHarnessConfig("goose", gooseConfig),
  crush: parseHarnessConfig("crush", crushConfig),
  "qwen-code": parseHarnessConfig("qwen-code", qwenCodeConfig),
  "kilo-code": parseHarnessConfig("kilo-code", kiloCodeConfig),
  "roo-code": parseHarnessConfig("roo-code", rooCodeConfig),
  "trae-agent": parseHarnessConfig("trae-agent", traeAgentConfig),
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
