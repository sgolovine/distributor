import { describe, expect, it } from "vitest";

import {
  adapterCatalog,
  availableAdapterConfigs,
  getAdapterCatalogEntry,
  getAvailableAdapterConfig,
  isAdapterId,
  isAvailableAdapterId,
} from "../../src/adapters/index.js";

const expectedAdapters = {
  codex: ["Codex CLI", ".agents/skills", ["project", "user", "admin"]],
  "claude-code": ["Claude Code", ".claude/skills", ["project", "user"]],
  opencode: [
    "OpenCode",
    ".opencode/skills",
    [
      "project",
      "agents-project",
      "claude-project",
      "user",
      "agents-user",
      "claude-user",
    ],
  ],
  cursor: [
    "Cursor",
    ".cursor/skills",
    ["project", "agents-project", "user", "agents-user"],
  ],
  "gemini-cli": [
    "Gemini CLI",
    ".gemini/skills",
    ["project", "agents-project", "user", "agents-user"],
  ],
  antigravity: [
    "Antigravity",
    ".agents/skills",
    ["project", "legacy-project", "user"],
  ],
  "github-copilot": [
    "GitHub Copilot",
    ".github/skills",
    ["project", "agents-project", "claude-project", "user", "agents-user"],
  ],
  openhands: [
    "OpenHands",
    ".agents/skills",
    ["project", "legacy-project", "user", "openhands-user"],
  ],
  pi: [
    "Pi",
    ".pi/skills",
    ["project", "agents-project", "user", "agents-user"],
  ],
  cline: [
    "Cline",
    ".cline/skills",
    ["project", "clinerules-project", "claude-project", "user"],
  ],
  goose: [
    "Goose",
    ".agents/skills",
    ["project", "goose-project", "claude-project", "user", "claude-user"],
  ],
  crush: [
    "Crush",
    ".crush/skills",
    [
      "project",
      "agents-project",
      "claude-project",
      "cursor-project",
      "user",
      "agents-user",
      "claude-user",
    ],
  ],
  "qwen-code": ["Qwen Code", ".qwen/skills", ["project", "user"]],
  "kilo-code": [
    "Kilo Code",
    ".kilo/skills",
    ["project", "agents-project", "user"],
  ],
  "roo-code": [
    "Roo Code",
    ".roo/skills",
    ["project", "agents-project", "user", "agents-user"],
  ],
  "trae-agent": ["Trae Agent", ".trae/skills", ["project", "user"]],
} as const;

describe("adapter catalog", () => {
  it("makes every specified harness available", () => {
    expect(
      adapterCatalog.map(({ name, displayName, adapterStatus }) => ({
        name,
        displayName,
        adapterStatus,
      })),
    ).toEqual(
      Object.entries(expectedAdapters).map(([name, [displayName]]) => ({
        name,
        displayName,
        adapterStatus: "available",
      })),
    );
  });

  it("distinguishes available and unknown IDs", () => {
    for (const name of Object.keys(expectedAdapters)) {
      expect(isAdapterId(name)).toBe(true);
      expect(isAvailableAdapterId(name)).toBe(true);
      expect(getAdapterCatalogEntry(name)?.adapterStatus).toBe("available");
      expect(getAvailableAdapterConfig(name)).toBeDefined();
    }
    expect(isAdapterId("unknown")).toBe(false);
    expect(getAdapterCatalogEntry("unknown")).toBeUndefined();
  });
});

describe("available adapter configurations", () => {
  it("declares the specified default paths and placement IDs", () => {
    expect(Object.keys(availableAdapterConfigs)).toEqual(
      Object.keys(expectedAdapters),
    );

    for (const [
      name,
      [, expectedDefaultPath, expectedPlacementIds],
    ] of Object.entries(expectedAdapters)) {
      const config = getAvailableAdapterConfig(name);
      expect(config, name).toBeDefined();
      expect(config?.adapterStatus, name).toBe("available");
      expect(config?.supportsNativeSkills, name).toBe(true);
      expect(
        config?.placements.map((placement) => placement.id),
        name,
      ).toEqual(expectedPlacementIds);
      expect(
        config?.placements.find(
          (placement) => placement.id === config.defaultProjectPlacementId,
        )?.defaultPath,
        name,
      ).toBe(expectedDefaultPath);
      expect(
        config?.sources?.every((source) => URL.canParse(source)),
        name,
      ).toBe(true);
    }
  });

  it("marks the documented shared source paths as compatible", () => {
    const agentsCompatible = [
      "codex",
      "opencode",
      "cursor",
      "gemini-cli",
      "antigravity",
      "github-copilot",
      "openhands",
      "pi",
      "goose",
      "crush",
      "kilo-code",
      "roo-code",
    ];

    for (const name of Object.keys(expectedAdapters)) {
      const config = getAvailableAdapterConfig(name);
      const discoversAgents = config?.placements.some(
        (placement) =>
          placement.scope === "project" &&
          placement.defaultPath === ".agents/skills" &&
          placement.support !== "unverified",
      );
      expect(discoversAgents, name).toBe(agentsCompatible.includes(name));
    }
  });

  it("retains environment overrides and documented caveats", () => {
    expect(
      getAvailableAdapterConfig("crush")?.placements.find(
        (placement) => placement.id === "user",
      )?.environmentVariables,
    ).toEqual(["CRUSH_SKILLS_DIR"]);
    expect(
      getAvailableAdapterConfig("goose")?.placements.find(
        (placement) => placement.id === "project",
      )?.notes,
    ).toContain("Summon");
  });
});
