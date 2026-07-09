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
  SourceSkill,
} from "../../src/skills/discover.js";
import { resolvePlacements } from "../../src/sync/resolve-placements.js";

describe("resolvePlacements", () => {
  it("satisfies compatible automatic placements and maps the fallback", () => {
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
      {
        harnessId: "opencode",
        placementId: "agents-project",
        sourceRoot,
      },
    ]);
    expect(result.placements).toEqual([
      expect.objectContaining({
        harnessId: "claude-code",
        targetRoot: "/project/.claude/skills",
        hasPathOverride: false,
      }),
    ]);
    expect(result.mappings.map((mapping) => mapping.targetPath)).toEqual([
      "/project/.claude/skills/review/SKILL.md",
      "/project/.claude/skills/review/references/a.md",
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

  it("recognizes every declared compatible project placement", () => {
    const sourceRoot = "/project/.claude/skills";
    const result = resolvePlacements(
      projectConfig("/project", sourceRoot, [automatic("opencode")]),
      discovery(sourceRoot, [skill(sourceRoot, "review")]),
      { pathStyle: "posix" },
    );

    expect(result.satisfiedPlacements).toEqual([
      {
        harnessId: "opencode",
        placementId: "claude-project",
        sourceRoot,
      },
    ]);
    expect(result.mappings).toEqual([]);
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
          { name: "opencode", targets },
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
    sourceRoot,
    harnesses,
  };
}

function discovery(
  sourceRoot: string,
  skills: readonly SourceSkill[],
): SkillDiscoveryResult {
  return {
    sourceRoot,
    sourceRootIdentity: {
      realPath: sourceRoot,
      device: 1,
      inode: 1,
    },
    skills: [...skills],
    warnings: [],
  };
}

function automatic(name: AvailableAdapterId): ValidatedHarnessSelection {
  return { name, targets: undefined };
}

function explicit(
  name: AvailableAdapterId,
  selectedPlacement: HarnessPlacement,
  targetRoot: string,
  hasPathOverride: boolean,
): ValidatedHarnessSelection {
  return {
    name,
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
