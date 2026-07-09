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
  { name: "cursor", displayName: "Cursor", adapterStatus: "planned" },
  {
    name: "gemini-cli",
    displayName: "Gemini CLI",
    adapterStatus: "planned",
  },
  {
    name: "antigravity",
    displayName: "Antigravity",
    adapterStatus: "planned",
  },
  {
    name: "github-copilot",
    displayName: "GitHub Copilot",
    adapterStatus: "planned",
  },
  {
    name: "openhands",
    displayName: "OpenHands",
    adapterStatus: "planned",
  },
  { name: "pi", displayName: "Pi", adapterStatus: "planned" },
  { name: "cline", displayName: "Cline", adapterStatus: "planned" },
  { name: "goose", displayName: "Goose", adapterStatus: "planned" },
  { name: "crush", displayName: "Crush", adapterStatus: "blocked" },
  {
    name: "qwen-code",
    displayName: "Qwen Code",
    adapterStatus: "blocked",
  },
  {
    name: "kilo-code",
    displayName: "Kilo Code",
    adapterStatus: "planned",
  },
  {
    name: "roo-code",
    displayName: "Roo Code",
    adapterStatus: "planned",
  },
  {
    name: "trae-agent",
    displayName: "Trae Agent",
    adapterStatus: "blocked",
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
