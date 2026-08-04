import { posix, win32 } from "node:path";

import { describe, expect, it } from "vitest";

import {
  getAvailableAdapterConfig,
  type AvailableAdapterId,
  type HarnessPlacement,
} from "../../src/adapters/index.js";
import type {
  ValidatedHarnessSelection,
  ValidatedProjectConfig,
} from "../../src/config/validate.js";
import { DistributorError } from "../../src/errors.js";
import type {
  SkillDiscoveryResult,
  SourceHelperFile,
  SourceSkill,
} from "../../src/skills/discover.js";
import { resolvePlacements } from "../../src/sync/resolve-placements.js";

describe("resolvePlacements", () => {
  it("uses default project placements and satisfies an equal source", () => {
    const projectRoot = "/project";
    const sourceRoot = "/project/.agents/skills";
    const result = resolvePlacements(
      projectConfig(projectRoot, sourceRoot, [
        automatic("opencode"),
        automatic("codex"),
        automatic("claude-code"),
      ]),
      discovery(sourceRoot, [
        skill(sourceRoot, "review", ["SKILL.md", "references/a.md"]),
      ]),
      { pathStyle: "posix" },
    );

    expect(result.satisfiedPlacements).toEqual([
      {
        harnessId: "codex",
        placementId: "project",
        sourceRoot,
      },
    ]);
    expect(result.placements).toEqual([
      expect.objectContaining({
        harnessId: "claude-code",
        targetRoot: "/project/.claude/skills",
        hasPathOverride: false,
      }),
      expect.objectContaining({
        harnessId: "opencode",
        targetRoot: "/project/.opencode/skills",
        hasPathOverride: false,
      }),
    ]);
    expect(result.mappings.map((mapping) => mapping.targetPath)).toEqual([
      "/project/.claude/skills/review/SKILL.md",
      "/project/.claude/skills/review/references/a.md",
      "/project/.opencode/skills/review/SKILL.md",
      "/project/.opencode/skills/review/references/a.md",
    ]);
    expect(result.mappings[0]?.linkValue).toBe(
      "../../../.agents/skills/review/SKILL.md",
    );
    expect(result.sourceRootIdentity).toEqual({
      realPath: sourceRoot,
      device: 1,
      inode: 1,
    });
  });

  it("maps helper files at their unchanged source-relative paths", () => {
    const sourceRoot = "/project/.agents/skills";
    const result = resolvePlacements(
      projectConfig("/project", sourceRoot, [automatic("claude-code")]),
      discovery(
        sourceRoot,
        [skill(sourceRoot, "review")],
        [
          helperFile(sourceRoot, "_bqe-core-reference/schema.json"),
          helperFile(sourceRoot, "shared.md"),
        ],
      ),
      { pathStyle: "posix" },
    );

    expect(result.mappings.map((mapping) => mapping.targetPath)).toEqual([
      "/project/.claude/skills/_bqe-core-reference/schema.json",
      "/project/.claude/skills/review/SKILL.md",
      "/project/.claude/skills/shared.md",
    ]);
    expect(result.mappings[0]).toMatchObject({
      skillName: "_bqe-core-reference",
      sourcePath: "/project/.agents/skills/_bqe-core-reference/schema.json",
      linkValue: "../../../.agents/skills/_bqe-core-reference/schema.json",
    });
  });

  it("switches compatible harnesses to their own folder and ignores the flag otherwise", () => {
    const sourceRoot = "/project/source";

    for (const [useHarnessFolder, targetRoot] of [
      [false, "/project/.agents/skills"],
      [true, "/project/.opencode/skills"],
    ] as const) {
      const result = resolvePlacements(
        projectConfig("/project", sourceRoot, [
          automatic("opencode", useHarnessFolder),
        ]),
        discovery(sourceRoot, [skill(sourceRoot, "review")]),
        { pathStyle: "posix" },
      );

      expect(result.placements[0]?.targetRoot).toBe(targetRoot);
    }

    for (const useHarnessFolder of [false, true]) {
      const result = resolvePlacements(
        projectConfig("/project", sourceRoot, [
          automatic("claude-code", useHarnessFolder),
        ]),
        discovery(sourceRoot, [skill(sourceRoot, "review")]),
        { pathStyle: "posix" },
      );

      expect(result.placements[0]?.targetRoot).toBe(
        "/project/.claude/skills",
      );
    }
  });

  it("switches Codex between shared and harness-specific user folders", () => {
    const projectRoot = "/project";
    const sourceRoot = "/project/skills";

    for (const [useHarnessFolder, placementId, targetRoot] of [
      [false, "agents-user", "/home/dev/.agents/skills"],
      [true, "user", "/home/dev/.codex/skills"],
    ] as const) {
      const result = resolvePlacements(
        {
          ...projectConfig(projectRoot, sourceRoot, [
            automatic("codex", useHarnessFolder),
          ]),
          scope: "global",
        },
        discovery(sourceRoot, [skill(sourceRoot, "review")]),
        { pathStyle: "posix", homeDirectory: "/home/dev" },
      );

      expect(result.placements).toEqual([
        expect.objectContaining({
          harnessId: "codex",
          placement: expect.objectContaining({ id: placementId }),
          targetRoot,
        }),
      ]);
      expect(result.mappings[0]?.targetPath).toBe(
        `${targetRoot}/review/SKILL.md`,
      );
    }
  });

  it("does not substitute compatible project paths for the default", () => {
    const sourceRoot = "/project/.claude/skills";
    const result = resolvePlacements(
      projectConfig("/project", sourceRoot, [automatic("opencode")]),
      discovery(sourceRoot, [skill(sourceRoot, "review")]),
      { pathStyle: "posix" },
    );

    expect(result.satisfiedPlacements).toEqual([]);
    expect(result.placements).toEqual([
      expect.objectContaining({
        harnessId: "opencode",
        targetRoot: "/project/.opencode/skills",
      }),
    ]);
    expect(result.mappings[0]?.targetPath).toBe(
      "/project/.opencode/skills/review/SKILL.md",
    );
  });

  it("uses shared agents and native harness directories for global scope", () => {
    const projectRoot = "/project";
    const sourceRoot = "/project/.agents/skills";
    const config = projectConfig(projectRoot, sourceRoot, [
      automatic("opencode", false),
      automatic("codex", false),
      automatic("claude-code", false),
    ]);
    const result = resolvePlacements(
      { ...config, scope: "global" },
      discovery(sourceRoot, [skill(sourceRoot, "review")]),
      { pathStyle: "posix", homeDirectory: "/home/dev" },
    );

    expect(
      result.placements.map((placement) => ({
        harnessId: placement.harnessId,
        placementId: placement.placement.id,
        targetRoot: placement.targetRoot,
      })),
    ).toEqual([
      {
        harnessId: "claude-code",
        placementId: "user",
        targetRoot: "/home/dev/.claude/skills",
      },
      {
        harnessId: "codex",
        placementId: "agents-user",
        targetRoot: "/home/dev/.agents/skills",
      },
      {
        harnessId: "opencode",
        placementId: "agents-user",
        targetRoot: "/home/dev/.agents/skills",
      },
    ]);
    expect(result.mappings).toHaveLength(2);
    expect(result.mappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetPath: "/home/dev/.agents/skills/review/SKILL.md",
          attributions: [
            { harnessId: "codex", placementId: "agents-user" },
            { harnessId: "opencode", placementId: "agents-user" },
          ],
        }),
        expect.objectContaining({
          targetPath: "/home/dev/.claude/skills/review/SKILL.md",
        }),
      ]),
    );
  });

  it("sorts full sync mappings independently of config and skill order", () => {
    const sourceRoot = "/project/source";
    const result = resolvePlacements(
      projectConfig("/project", sourceRoot, [
        automatic("opencode"),
        automatic("codex"),
        automatic("claude-code"),
      ]),
      discovery(sourceRoot, [
        skill(sourceRoot, "zeta"),
        skill(sourceRoot, "alpha"),
      ]),
      { pathStyle: "posix" },
    );

    expect(
      result.mappings.map(
        (mapping) =>
          `${mapping.attributions[0]?.harnessId}:${mapping.skillName}`,
      ),
    ).toEqual([
      "claude-code:alpha",
      "claude-code:zeta",
      "codex:alpha",
      "codex:zeta",
      "opencode:alpha",
      "opencode:zeta",
    ]);
  });

  it("maps OpenAI agent metadata only for Codex", () => {
    const sourceRoot = "/project/source";
    const result = resolvePlacements(
      projectConfig("/project", sourceRoot, [
        explicit(
          "antigravity",
          placement("antigravity", "project"),
          "/project/targets/antigravity",
          true,
        ),
        explicit(
          "claude-code",
          placement("claude-code", "project"),
          "/project/targets/claude-code",
          true,
        ),
        explicit(
          "codex",
          placement("codex", "project"),
          "/project/targets/codex",
          true,
        ),
        explicit(
          "goose",
          placement("goose", "project"),
          "/project/targets/goose",
          true,
        ),
        explicit(
          "openhands",
          placement("openhands", "project"),
          "/project/targets/openhands",
          true,
        ),
        explicit(
          "opencode",
          placement("opencode", "project"),
          "/project/targets/opencode",
          true,
        ),
      ]),
      discovery(sourceRoot, [
        skill(sourceRoot, "review", [
          "SKILL.md",
          "agents/openai.yaml",
          "agents/openai.yml",
        ]),
      ]),
      { pathStyle: "posix" },
    );

    const openAiConfigMappings = result.mappings.filter(
      (mapping) =>
        mapping.sourcePath.endsWith("/agents/openai.yaml") ||
        mapping.sourcePath.endsWith("/agents/openai.yml"),
    );

    expect(openAiConfigMappings).toEqual([
      expect.objectContaining({
        sourcePath: "/project/source/review/agents/openai.yaml",
        attributions: [{ harnessId: "codex", placementId: "project" }],
      }),
      expect.objectContaining({
        sourcePath: "/project/source/review/agents/openai.yml",
        attributions: [{ harnessId: "codex", placementId: "project" }],
      }),
    ]);
    expect(result.mappings.filter((mapping) =>
      mapping.sourcePath.endsWith("/SKILL.md"),
    )).toHaveLength(6);
  });

  it("filters to one enabled harness and rejects invalid selections", () => {
    const sourceRoot = "/project/source";
    const config = projectConfig("/project", sourceRoot, [
      automatic("claude-code"),
      automatic("codex"),
    ]);
    const discovered = discovery(sourceRoot, [skill(sourceRoot, "review")]);

    expect(
      resolvePlacements(config, discovered, {
        harness: "codex",
        pathStyle: "posix",
      }).placements.map((item) => item.harnessId),
    ).toEqual(["codex"]);

    for (const requested of ["unknown", "cursor", "opencode"]) {
      expect(() =>
        resolvePlacements(config, discovered, {
          harness: requested,
          pathStyle: "posix",
        }),
      ).toThrow(DistributorError);
      try {
        resolvePlacements(config, discovered, {
          harness: requested,
          pathStyle: "posix",
        });
      } catch (error) {
        expect(error).toMatchObject({ exitCode: 2 });
      }
    }
  });

  it("retains explicit placement metadata when a path overrides its root", () => {
    const sourceRoot = "/project/source";
    const userPlacement = placement("opencode", "user");
    const result = resolvePlacements(
      projectConfig("/project", sourceRoot, [
        explicit("opencode", userPlacement, "/project/custom", true),
      ]),
      discovery(sourceRoot, [skill(sourceRoot, "review")]),
      { pathStyle: "posix" },
    );

    expect(result.placements).toEqual([
      {
        harnessId: "opencode",
        placement: userPlacement,
        targetRoot: "/project/custom",
        hasPathOverride: true,
      },
    ]);
    expect(result.placements[0]?.placement).toMatchObject({
      id: "user",
      scope: "user",
      createIfMissing: true,
    });
  });

  it("treats an equal explicit target as satisfied and rejects a child target", () => {
    const sourceRoot = "/project/source";
    const projectPlacement = placement("claude-code", "project");

    expect(
      resolvePlacements(
        projectConfig("/project", sourceRoot, [
          explicit("claude-code", projectPlacement, sourceRoot, true),
        ]),
        discovery(sourceRoot, [skill(sourceRoot, "review")]),
        { pathStyle: "posix" },
      ).satisfiedPlacements,
    ).toEqual([
      {
        harnessId: "claude-code",
        placementId: "project",
        sourceRoot,
      },
    ]);

    expect(() =>
      resolvePlacements(
        projectConfig("/project", sourceRoot, [
          explicit(
            "claude-code",
            projectPlacement,
            "/project/source/generated",
            true,
          ),
        ]),
        discovery(sourceRoot, [skill(sourceRoot, "review")]),
        { pathStyle: "posix" },
      ),
    ).toThrow("inside source root");
  });

  it("warns and uses absolute links for an external target", () => {
    const sourceRoot = "/project/source";
    const result = resolvePlacements(
      projectConfig("/project", sourceRoot, [
        explicit(
          "claude-code",
          placement("claude-code", "user"),
          "/home/dev/.claude/skills",
          false,
        ),
      ]),
      discovery(sourceRoot, [skill(sourceRoot, "review")]),
      { pathStyle: "posix" },
    );

    expect(result.warnings).toEqual([
      expect.objectContaining({
        harnessId: "claude-code",
        placementId: "user",
        path: "/home/dev/.claude/skills",
      }),
    ]);
    expect(result.mappings[0]?.linkValue).toBe(
      "/project/source/review/SKILL.md",
    );
  });

  it("uses absolute links without an external-target warning for an external source", () => {
    const sourceRoot = "/shared/source";
    const result = resolvePlacements(
      projectConfig("/project", sourceRoot, [automatic("claude-code")]),
      discovery(sourceRoot, [skill(sourceRoot, "review")]),
      { pathStyle: "posix" },
    );

    expect(result.warnings).toEqual([]);
    expect(result.mappings[0]?.linkValue).toBe(
      "/shared/source/review/SKILL.md",
    );
  });

  it("rejects a target file that would land back inside the source tree", () => {
    const sourceRoot = "/project/review";

    expect(() =>
      resolvePlacements(
        projectConfig("/project", sourceRoot, [
          explicit(
            "claude-code",
            placement("claude-code", "project"),
            "/project",
            true,
          ),
        ]),
        discovery(sourceRoot, [skill(sourceRoot, "review")]),
        { pathStyle: "posix" },
      ),
    ).toThrow("canonical source tree");
  });

  it("deduplicates identical mappings and retains sorted attribution", () => {
    const sourceRoot = "/project/source";
    const targetRoot = "/project/shared";
    const result = resolvePlacements(
      projectConfig("/project", sourceRoot, [
        explicit(
          "opencode",
          placement("opencode", "project"),
          targetRoot,
          true,
        ),
        explicit(
          "claude-code",
          placement("claude-code", "project"),
          targetRoot,
          true,
        ),
      ]),
      discovery(sourceRoot, [skill(sourceRoot, "review")]),
      { pathStyle: "posix" },
    );

    expect(result.mappings).toHaveLength(1);
    expect(result.mappings[0]?.attributions).toEqual([
      { harnessId: "claude-code", placementId: "project" },
      { harnessId: "opencode", placementId: "project" },
    ]);
  });

  it("rejects different sources colliding at one target", () => {
    const sourceRoot = "/project/source";
    const review = skill(sourceRoot, "review", [
      "SKILL.md",
      "review/SKILL.md",
    ]);
    const targets = [
      {
        placement: placement("opencode", "project"),
        targetRoot: "/project/out",
        hasPathOverride: true,
      },
      {
        placement: placement("opencode", "user"),
        targetRoot: "/project/out/review",
        hasPathOverride: true,
      },
    ];

    expect(() =>
      resolvePlacements(
        projectConfig("/project", sourceRoot, [
          { name: "opencode", useHarnessFolder: false, targets },
        ]),
        discovery(sourceRoot, [review]),
        { pathStyle: "posix" },
      ),
    ).toThrow("maps to different source files");
  });

  it("rejects case-colliding source files with Windows semantics", () => {
    const projectRoot = "C:\\project";
    const sourceRoot = "C:\\project\\source";
    const review = windowsSkill(sourceRoot, "review", ["Foo.md", "foo.md"]);

    expect(() =>
      resolvePlacements(
        projectConfig(projectRoot, sourceRoot, [
          explicit(
            "claude-code",
            placement("claude-code", "project"),
            "C:\\project\\out",
            true,
          ),
        ]),
        discovery(sourceRoot, [review]),
        { pathStyle: "win32" },
      ),
    ).toThrow("collide unsafely");
  });
});

function projectConfig(
  projectRoot: string,
  sourceRoot: string,
  harnesses: readonly ValidatedHarnessSelection[],
): ValidatedProjectConfig {
  const separator = projectRoot.includes("\\") ? "\\" : "/";
  return {
    configPath: `${projectRoot}${separator}distributor.config.json`,
    projectRoot,
    scope: "project",
    sourceRoot,
    harnesses,
  };
}

function discovery(
  sourceRoot: string,
  skills: readonly SourceSkill[],
  helperFiles: readonly SourceHelperFile[] = [],
): SkillDiscoveryResult {
  return {
    sourceRoot,
    sourceRootIdentity: {
      realPath: sourceRoot,
      device: 1,
      inode: 1,
    },
    skills: [...skills],
    helperFiles: [...helperFiles],
    warnings: [],
  };
}

function helperFile(
  sourceRoot: string,
  sourceRelativePath: string,
): SourceHelperFile {
  return {
    absolutePath: posix.join(sourceRoot, sourceRelativePath),
    sourceRelativePath,
    helperName: sourceRelativePath.split("/", 1)[0] ?? sourceRelativePath,
  };
}

function automatic(
  name: AvailableAdapterId,
  useHarnessFolder = true,
): ValidatedHarnessSelection {
  return { name, useHarnessFolder, targets: undefined };
}

function explicit(
  name: AvailableAdapterId,
  selectedPlacement: HarnessPlacement,
  targetRoot: string,
  hasPathOverride: boolean,
): ValidatedHarnessSelection {
  return {
    name,
    useHarnessFolder: false,
    targets: [
      {
        placement: selectedPlacement,
        targetRoot,
        hasPathOverride,
      },
    ],
  };
}

function placement(
  harnessId: AvailableAdapterId,
  placementId: string,
): HarnessPlacement {
  const adapter = getAvailableAdapterConfig(harnessId);
  const selected = adapter?.placements.find((item) => item.id === placementId);
  if (selected === undefined) {
    throw new Error(`Missing ${harnessId}/${placementId} test placement.`);
  }
  return selected;
}

function skill(
  sourceRoot: string,
  name: string,
  relativeFiles: readonly string[] = ["SKILL.md"],
): SourceSkill {
  const directoryPath = posix.join(sourceRoot, name);
  return {
    name,
    directoryPath,
    frontmatter: { name, description: `${name} description` },
    files: relativeFiles.map((relativeFile) => {
      const sourceRelativePath = posix.join(name, relativeFile);
      return {
        absolutePath: posix.join(sourceRoot, sourceRelativePath),
        sourceRelativePath,
        skillRelativePath: relativeFile,
      };
    }),
  };
}

function windowsSkill(
  sourceRoot: string,
  name: string,
  relativeFiles: readonly string[],
): SourceSkill {
  const directoryPath = win32.join(sourceRoot, name);
  return {
    name,
    directoryPath,
    frontmatter: { name, description: `${name} description` },
    files: relativeFiles.map((relativeFile) => {
      const sourceRelativePath = win32.join(name, relativeFile);
      return {
        absolutePath: win32.join(sourceRoot, sourceRelativePath),
        sourceRelativePath,
        skillRelativePath: relativeFile,
      };
    }),
  };
}
