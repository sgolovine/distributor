import { describe, expect, it } from "vitest";

import {
  adapterCatalog,
  availableAdapterConfigs,
  getAdapterCatalogEntry,
  getAvailableAdapterConfig,
  isAdapterId,
  isAvailableAdapterId,
} from "../../src/adapters/index.js";
import type { HarnessConfig } from "../../src/adapters/schema.js";

const expectedConfigs = {
  codex: {
    name: "codex",
    displayName: "Codex CLI",
    adapterStatus: "available",
    supportsNativeSkills: true,
    defaultProjectPlacementId: "project",
    placements: [
      {
        id: "project",
        item: "skills",
        support: "native",
        scope: "project",
        defaultPath: ".agents/skills",
        createIfMissing: true,
      },
      {
        id: "user",
        item: "skills",
        support: "native",
        scope: "user",
        defaultPath: "~/.agents/skills",
        createIfMissing: true,
      },
      {
        id: "admin",
        item: "skills",
        support: "native",
        scope: "admin",
        defaultPath: "/etc/codex/skills",
        createIfMissing: false,
      },
    ],
    sources: ["https://developers.openai.com/codex/skills"],
    verifiedAt: "2026-07-09",
  },
  "claude-code": {
    name: "claude-code",
    displayName: "Claude Code",
    adapterStatus: "available",
    supportsNativeSkills: true,
    defaultProjectPlacementId: "project",
    placements: [
      {
        id: "project",
        item: "skills",
        support: "native",
        scope: "project",
        defaultPath: ".claude/skills",
        createIfMissing: true,
      },
      {
        id: "user",
        item: "skills",
        support: "native",
        scope: "user",
        defaultPath: "~/.claude/skills",
        createIfMissing: true,
      },
    ],
    sources: ["https://code.claude.com/docs/en/skills"],
    verifiedAt: "2026-07-09",
  },
  opencode: {
    name: "opencode",
    displayName: "OpenCode",
    adapterStatus: "available",
    supportsNativeSkills: true,
    defaultProjectPlacementId: "project",
    placements: [
      {
        id: "project",
        item: "skills",
        support: "native",
        scope: "project",
        defaultPath: ".opencode/skills",
        createIfMissing: true,
      },
      {
        id: "agents-project",
        item: "skills",
        support: "compatibility",
        scope: "project",
        defaultPath: ".agents/skills",
        createIfMissing: true,
      },
      {
        id: "claude-project",
        item: "skills",
        support: "compatibility",
        scope: "project",
        defaultPath: ".claude/skills",
        createIfMissing: true,
      },
      {
        id: "user",
        item: "skills",
        support: "native",
        scope: "user",
        defaultPath: "~/.config/opencode/skills",
        createIfMissing: true,
      },
      {
        id: "agents-user",
        item: "skills",
        support: "compatibility",
        scope: "user",
        defaultPath: "~/.agents/skills",
        createIfMissing: true,
      },
      {
        id: "claude-user",
        item: "skills",
        support: "compatibility",
        scope: "user",
        defaultPath: "~/.claude/skills",
        createIfMissing: true,
      },
    ],
    sources: ["https://opencode.ai/docs/skills/"],
    verifiedAt: "2026-07-09",
  },
} satisfies Record<string, HarnessConfig>;

function discoversProjectPath(config: HarnessConfig, path: string): boolean {
  return config.placements.some(
    (placement) =>
      placement.scope === "project" &&
      (placement.support === "native" ||
        placement.support === "compatibility") &&
      placement.defaultPath === path,
  );
}

describe("adapter catalog", () => {
  it("records every stable ID, display name, and status", () => {
    expect(adapterCatalog).toEqual([
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
    ]);
  });

  it("distinguishes available, unavailable, and unknown IDs", () => {
    expect(isAdapterId("codex")).toBe(true);
    expect(isAvailableAdapterId("codex")).toBe(true);
    expect(getAdapterCatalogEntry("cursor")?.adapterStatus).toBe("planned");
    expect(isAdapterId("cursor")).toBe(true);
    expect(isAvailableAdapterId("cursor")).toBe(false);
    expect(getAvailableAdapterConfig("cursor")).toBeUndefined();
    expect(isAdapterId("unknown")).toBe(false);
    expect(getAdapterCatalogEntry("unknown")).toBeUndefined();
  });
});

describe("available adapter configurations", () => {
  it("contains only the three shipping adapters", () => {
    expect(Object.keys(availableAdapterConfigs).sort()).toEqual([
      "claude-code",
      "codex",
      "opencode",
    ]);
  });

  it("matches every placement field, source URL, and verification date", () => {
    expect(availableAdapterConfigs).toEqual(expectedConfigs);
  });

  it("keeps optional environment overrides and notes absent", () => {
    for (const config of Object.values(availableAdapterConfigs)) {
      for (const placement of config.placements) {
        expect(placement).not.toHaveProperty("environmentVariables");
        expect(placement).not.toHaveProperty("notes");
      }
    }
  });

  it("makes the default source discoverable by Codex and OpenCode only", () => {
    expect(
      discoversProjectPath(availableAdapterConfigs.codex, ".agents/skills"),
    ).toBe(true);
    expect(
      discoversProjectPath(
        availableAdapterConfigs["claude-code"],
        ".agents/skills",
      ),
    ).toBe(false);
    expect(
      discoversProjectPath(availableAdapterConfigs.opencode, ".agents/skills"),
    ).toBe(true);
  });

  it("uses declared project defaults when compatibility does not satisfy", () => {
    expect(
      Object.fromEntries(
        Object.entries(availableAdapterConfigs).map(([name, config]) => {
          const placement = config.placements.find(
            (candidate) =>
              candidate.id === config.defaultProjectPlacementId,
          );
          return [name, placement?.defaultPath];
        }),
      ),
    ).toEqual({
      codex: ".agents/skills",
      "claude-code": ".claude/skills",
      opencode: ".opencode/skills",
    });
  });

  it("retains non-selectable Codex admin metadata", () => {
    const admin = availableAdapterConfigs.codex.placements.find(
      (placement) => placement.id === "admin",
    );

    expect(admin).toEqual({
      id: "admin",
      item: "skills",
      support: "native",
      scope: "admin",
      defaultPath: "/etc/codex/skills",
      createIfMissing: false,
    });
  });
});
