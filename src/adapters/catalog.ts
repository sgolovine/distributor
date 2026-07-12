import {
  AdapterCatalogSchema,
  type AdapterCatalogEntry,
} from "./schema.js";

const catalogEntries = [
  {
    name: "codex",
    displayName: "Codex CLI",
    adapterStatus: "available",
  },
  {
    name: "claude-code",
    displayName: "Claude Code",
    adapterStatus: "available",
  },
  {
    name: "opencode",
    displayName: "OpenCode",
    adapterStatus: "available",
  },
  { name: "cursor", displayName: "Cursor", adapterStatus: "available" },
  {
    name: "gemini-cli",
    displayName: "Gemini CLI",
    adapterStatus: "available",
  },
  {
    name: "antigravity",
    displayName: "Antigravity",
    adapterStatus: "available",
  },
  {
    name: "github-copilot",
    displayName: "GitHub Copilot",
    adapterStatus: "available",
  },
  {
    name: "openhands",
    displayName: "OpenHands",
    adapterStatus: "available",
  },
  { name: "pi", displayName: "Pi", adapterStatus: "available" },
  { name: "cline", displayName: "Cline", adapterStatus: "available" },
  { name: "goose", displayName: "Goose", adapterStatus: "available" },
  { name: "crush", displayName: "Crush", adapterStatus: "available" },
  {
    name: "qwen-code",
    displayName: "Qwen Code",
    adapterStatus: "available",
  },
  {
    name: "kilo-code",
    displayName: "Kilo Code",
    adapterStatus: "available",
  },
  {
    name: "roo-code",
    displayName: "Roo Code",
    adapterStatus: "available",
  },
  {
    name: "trae-agent",
    displayName: "Trae Agent",
    adapterStatus: "available",
  },
] as const satisfies readonly AdapterCatalogEntry[];

type CatalogEntryLiteral = (typeof catalogEntries)[number];

export type AdapterId = CatalogEntryLiteral["name"];
export type AvailableAdapterId = Extract<
  CatalogEntryLiteral,
  { adapterStatus: "available" }
>["name"];

export const adapterCatalog: readonly AdapterCatalogEntry[] =
  AdapterCatalogSchema.parse(catalogEntries);

const adapterCatalogByName = new Map(
  adapterCatalog.map((entry) => [entry.name, entry]),
);

export function getAdapterCatalogEntry(
  name: string,
): AdapterCatalogEntry | undefined {
  return adapterCatalogByName.get(name);
}

export function isAdapterId(name: string): name is AdapterId {
  return adapterCatalogByName.has(name);
}

export function isAvailableAdapterId(
  name: string,
): name is AvailableAdapterId {
  return adapterCatalogByName.get(name)?.adapterStatus === "available";
}
