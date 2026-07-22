import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { getAvailableAdapterConfig } from "../../src/adapters/index.js";
import type { DiscoveredConfig } from "../../src/config/discover.js";
import type { ValidatedProjectConfig } from "../../src/config/validate.js";
import { DistributorError } from "../../src/errors.js";
import type { SkillDiscoveryResult } from "../../src/skills/discover.js";
import type {
  ApplyFailure,
  ApplySyncResult,
} from "../../src/sync/apply.js";
import type { ReadOnlySyncPlan } from "../../src/sync/plan.js";
import type { PlacementResolution } from "../../src/sync/resolve-placements.js";
import {
  runSync,
  type RunSyncRuntime,
} from "../../src/sync/run-sync.js";
import type { LoadedManagedState } from "../../src/sync/state.js";
import type { PlannedFile, PlanOperation } from "../../src/sync/types.js";
import { useFixture } from "../helpers/fixture.js";

describe("runSync orchestration", () => {
  it("runs the read pipeline in order and stops before apply for dry run", async () => {
    const fixture = orchestrationFixture();
    const events: string[] = [];
    const runtime = fixtureRuntime(fixture, events);

    const result = await runSync({
      cwd: "/project/nested",
      dryRun: true,
      runtime,
    });

    expect(events).toEqual([
      "discover-config",
      "load-config",
      "discover-skills",
      "resolve-placements",
      "load-state",
      "build-plan",
    ]);
    expect(result).toMatchObject({
      exitCode: 0,
      dryRun: true,
      applied: false,
      failures: [],
    });
    expect(result).not.toHaveProperty("applyResult");
    expect(result.counts).toMatchObject({
      source: { skills: 1, files: 1 },
      physicalOperations: { total: 1, create: 1 },
      satisfiedPlacements: 1,
      warnings: 2,
      failures: 0,
    });
    expect(result.counts.harnesses.map((item) => item.harnessId)).toEqual([
      "claude-code",
      "codex",
      "opencode",
    ]);
    expect(
      result.counts.harnesses.find((item) => item.harnessId === "codex"),
    ).toMatchObject({
      operations: { total: 0 },
      satisfiedPlacements: ["project"],
    });
    expect(
      result.counts.harnesses.find(
        (item) => item.harnessId === "claude-code",
      ),
    ).toMatchObject({ operations: { total: 1, create: 1 }, warnings: 1 });
    expect(
      result.counts.harnesses.find((item) => item.harnessId === "opencode"),
    ).toMatchObject({ operations: { total: 1, create: 1 } });
    expect(Object.isFrozen(result.counts)).toBe(true);
    expect(Object.isFrozen(result.counts.physicalOperations)).toBe(true);
    expect(Object.isFrozen(result.counts.harnesses)).toBe(true);
    expect(Object.isFrozen(result.counts.harnesses[0])).toBe(true);
    expect(Object.isFrozen(result.counts.harnesses[0]?.placements)).toBe(true);
  });

  it("keeps dry-run and successful apply counts at parity", async () => {
    const fixture = orchestrationFixture();
    const dryEvents: string[] = [];
    const applyEvents: string[] = [];
    const dry = await runSync({
      dryRun: true,
      runtime: fixtureRuntime(fixture, dryEvents),
    });
    const applied = await runSync({
      runtime: fixtureRuntime(fixture, applyEvents),
    });

    expect(applied).toMatchObject({
      exitCode: 0,
      dryRun: false,
      applied: true,
      failures: [],
    });
    expect(applied.counts).toEqual(dry.counts);
    expect(applyEvents).toEqual([...dryEvents, "apply-plan"]);
    expect(applied.applyResult).toMatchObject({
      statePersisted: true,
      stateWritten: true,
    });
  });

  it("rejects a non-applicable plan with every conflict before apply", async () => {
    const fixture = orchestrationFixture();
    const conflictOperation = {
      ...fixture.mapping,
      kind: "conflict",
      reason: "Target is unmanaged.",
    } satisfies PlanOperation;
    fixture.plan = {
      ...fixture.plan,
      applicable: false,
      operations: [conflictOperation],
      failures: [
        {
          operation: "conflict",
          path: fixture.mapping.targetPath,
          message: "Target is unmanaged.",
        },
        {
          operation: "conflict",
          path: dirname(fixture.mapping.targetPath),
          message: "Target parent escapes its placement.",
        },
      ],
    };
    const events: string[] = [];

    const error = await captureDistributorError(
      runSync({ runtime: fixtureRuntime(fixture, events) }),
    );

    expect(error).toMatchObject({ category: "conflict", exitCode: 1 });
    expect(error.issues.map((issue) => issue.message)).toEqual([
      "Target parent escapes its placement.",
      "Target is unmanaged.",
    ]);
    expect(error.correction).toContain("did not write");
    expect(events).not.toContain("apply-plan");
  });

  it("returns exit 1 with successful operations and state retained after partial apply", async () => {
    const fixture = orchestrationFixture();
    const second = secondMapping(fixture.mapping);
    const firstOperation = fixture.plan.operations[0]!;
    const secondOperation = { ...second, kind: "create" } satisfies PlanOperation;
    fixture.resolution = {
      ...fixture.resolution,
      mappings: [fixture.mapping, second],
    };
    fixture.plan = {
      ...fixture.plan,
      operations: [firstOperation, secondOperation],
    };
    const failure: ApplyFailure = {
      phase: "target",
      operation: "create",
      path: second.targetPath,
      message: "Could not create the second link.",
      correction: "Fix target permissions and retry.",
      harnessId: "claude-code",
      placementId: "project",
      attributions: second.attributions,
    };
    fixture.applyResult = {
      operations: [
        {
          operation: firstOperation,
          status: "created",
          targetLinkMutated: true,
        },
        {
          operation: secondOperation,
          status: "failed",
          targetLinkMutated: false,
          failure,
        },
      ],
      failures: [failure],
      warnings: [
        ...fixture.plan.warnings,
        { path: "/project/.distributor/.gitignore", message: "State warning." },
      ],
      nextState: {
        version: 1,
        entries: [
          {
            sourcePath: fixture.mapping.sourcePath,
            targetPath: fixture.mapping.targetPath,
            linkValue: fixture.mapping.linkValue,
            attributions: fixture.mapping.attributions,
          },
        ],
      },
      statePersisted: true,
      stateWritten: true,
    };

    const result = await runSync({ runtime: fixtureRuntime(fixture, []) });

    expect(result.exitCode).toBe(1);
    expect(result.failures).toEqual([failure]);
    expect(result.applyResult?.operations).toHaveLength(2);
    expect(result.applyResult?.nextState.entries).toHaveLength(1);
    expect(result.counts.physicalOperations).toMatchObject({
      total: 1,
      create: 1,
    });
    expect(result.counts.failures).toBe(1);
    expect(
      result.counts.harnesses.find(
        (harness) => harness.harnessId === "claude-code",
      ),
    ).toMatchObject({ failures: 1 });
    expect(
      result.counts.harnesses.find(
        (harness) => harness.harnessId === "opencode",
      ),
    ).toMatchObject({ failures: 1 });
    expect(result.warnings.map((warning) => warning.message)).toEqual([
      "Ignored source-root file.",
      "State warning.",
      "External target warning.",
    ]);
  });
});

describe("runSync filesystem guarantees", () => {
  it("links helper files and directories alongside valid skills", async () => {
    await useFixture(async (root) => {
      const sourceRoot = join(root, ".agents", "skills");
      const skillRoot = join(sourceRoot, "review");
      const helperFile = join(sourceRoot, "_bqe-core-reference", "schema.json");
      await mkdir(skillRoot, { recursive: true });
      await mkdir(dirname(helperFile), { recursive: true });
      await writeFile(
        join(root, "distributor.config.json"),
        JSON.stringify({ harnesses: ["claude-code"] }),
        "utf8",
      );
      await writeFile(
        join(skillRoot, "SKILL.md"),
        "---\nname: review\ndescription: Review code.\n---\n",
        "utf8",
      );
      await writeFile(helperFile, "{}\n", "utf8");
      await writeFile(
        join(sourceRoot, "shared.md"),
        "Shared guidance.\n",
        "utf8",
      );

      const result = await runSync({ cwd: root });
      const helperTarget = join(
        root,
        ".claude",
        "skills",
        "_bqe-core-reference",
        "schema.json",
      );
      const rootFileTarget = join(root, ".claude", "skills", "shared.md");

      expect(result.counts.source).toEqual({ skills: 1, files: 3 });
      expect(result.counts.physicalOperations).toMatchObject({
        total: 3,
        create: 3,
      });
      expect((await lstat(helperTarget)).isSymbolicLink()).toBe(true);
      expect((await lstat(rootFileTarget)).isSymbolicLink()).toBe(true);
      expect(await readlink(helperTarget)).toBe(
        relative(dirname(helperTarget), helperFile),
      );
      expect(await readlink(rootFileTarget)).toBe(
        relative(dirname(rootFileTarget), join(sourceRoot, "shared.md")),
      );
    });
  });

  it("skips invalid skills with a warning and syncs valid skills", async () => {
    await useFixture(async (root) => {
      const sourceRoot = join(root, ".agents", "skills");
      const validRoot = join(sourceRoot, "review");
      const invalidRoot = join(sourceRoot, "broken");
      await mkdir(validRoot, { recursive: true });
      await mkdir(invalidRoot, { recursive: true });
      await writeFile(
        join(root, "distributor.config.json"),
        JSON.stringify({ harnesses: ["claude-code"] }),
        "utf8",
      );
      await writeFile(
        join(validRoot, "SKILL.md"),
        "---\nname: review\ndescription: Review code.\n---\n",
        "utf8",
      );
      await writeFile(
        join(invalidRoot, "SKILL.md"),
        "Missing frontmatter.\n",
        "utf8",
      );

      const result = await runSync({ cwd: root });

      expect(result).toMatchObject({ exitCode: 0, applied: true });
      expect(result.counts.source).toEqual({ skills: 1, files: 1 });
      expect(result.warnings).toEqual([
        expect.objectContaining({
          path: invalidRoot,
          message: expect.stringContaining('Skipped invalid skill "broken"'),
        }),
      ]);
      expect(
        (await lstat(
          join(root, ".claude", "skills", "review", "SKILL.md"),
        )).isSymbolicLink(),
      ).toBe(true);
      await expect(
        access(join(root, ".claude", "skills", "broken")),
      ).rejects.toThrow();
    });
  });

  it("preserves managed references when a previously valid skill becomes invalid", async () => {
    await useFixture(async (root) => {
      const skillRoot = join(root, ".agents", "skills", "review");
      const skillFile = join(skillRoot, "SKILL.md");
      const target = join(root, ".claude", "skills", "review", "SKILL.md");
      await mkdir(skillRoot, { recursive: true });
      await writeFile(
        join(root, "distributor.config.json"),
        JSON.stringify({ harnesses: ["claude-code"] }),
        "utf8",
      );
      await writeFile(
        skillFile,
        "---\nname: review\ndescription: Review code.\n---\n",
        "utf8",
      );
      await runSync({ cwd: root });
      const originalLink = await readlink(target);

      await writeFile(skillFile, "Missing frontmatter.\n", "utf8");
      const result = await runSync({ cwd: root });
      const state = JSON.parse(
        await readFile(join(root, ".distributor", "state.json"), "utf8"),
      ) as { entries: unknown[] };

      expect(result).toMatchObject({ exitCode: 0, applied: true });
      expect(result.counts.physicalOperations).toMatchObject({
        total: 0,
        stale: 0,
      });
      expect(result.warnings).toEqual([
        expect.objectContaining({
          path: skillRoot,
          message: expect.stringContaining('Skipped invalid skill "review"'),
        }),
      ]);
      expect((await lstat(target)).isSymbolicLink()).toBe(true);
      expect(await readlink(target)).toBe(originalLink);
      expect(state.entries).toHaveLength(1);
    });
  });

  it("keeps an ineffective state-ignore warning at dry-run/apply parity", async () => {
    await useFixture(async (root) => {
      const skillRoot = join(root, ".agents", "skills", "review");
      const ignorePath = join(root, ".distributor", ".gitignore");
      await mkdir(skillRoot, { recursive: true });
      await mkdir(dirname(ignorePath), { recursive: true });
      await writeFile(
        join(root, "distributor.config.json"),
        JSON.stringify({ harnesses: ["claude-code"] }),
        "utf8",
      );
      await writeFile(
        join(skillRoot, "SKILL.md"),
        "---\nname: review\ndescription: Review code.\n---\n",
        "utf8",
      );
      await writeFile(ignorePath, "custom-rule\n", "utf8");

      const dry = await runSync({ cwd: root, dryRun: true });
      const applied = await runSync({ cwd: root });

      expect(applied.counts).toEqual(dry.counts);
      expect(applied.warnings).toEqual(dry.warnings);
      expect(dry.warnings).toEqual([
        expect.objectContaining({
          path: ignorePath,
          message: expect.stringContaining("does not ignore state.json"),
        }),
      ]);
      expect(await readFile(ignorePath, "utf8")).toBe("custom-rule\n");
    });
  });

  it("does not create state artifacts for an empty satisfied sync", async () => {
    await useFixture(async (root) => {
      await mkdir(join(root, ".agents", "skills"), { recursive: true });
      await writeFile(
        join(root, "distributor.config.json"),
        JSON.stringify({ harnesses: ["codex"] }),
        "utf8",
      );

      const result = await runSync({ cwd: root });

      expect(result).toMatchObject({ exitCode: 0, applied: true });
      expect(result.counts).toMatchObject({
        source: { skills: 0, files: 0 },
        physicalOperations: { total: 0 },
        satisfiedPlacements: 1,
      });
      expect(result.applyResult).toMatchObject({
        statePersisted: true,
        stateWritten: false,
      });
      await expect(access(join(root, ".distributor"))).rejects.toThrow();
    });
  });

  it("keeps a recursive metadata snapshot unchanged during dry run", async () => {
    await useFixture(async (root) => {
      const skillRoot = join(root, ".agents", "skills", "review");
      await mkdir(skillRoot, { recursive: true });
      await writeFile(
        join(root, "distributor.config.json"),
        JSON.stringify({ harnesses: ["claude-code"] }),
        "utf8",
      );
      await writeFile(
        join(skillRoot, "SKILL.md"),
        "---\nname: review\ndescription: Review code.\n---\n",
        "utf8",
      );
      const before = await metadataSnapshot(root);

      const result = await runSync({ cwd: root, dryRun: true });
      const after = await metadataSnapshot(root);

      expect(result.counts.physicalOperations).toMatchObject({
        total: 1,
        create: 1,
      });
      expect(after).toEqual(before);
      await expect(access(join(root, ".claude"))).rejects.toThrow();
      await expect(access(join(root, ".distributor"))).rejects.toThrow();
    });
  });
});

interface OrchestrationFixture {
  discovered: DiscoveredConfig;
  config: ValidatedProjectConfig;
  skills: SkillDiscoveryResult;
  resolution: PlacementResolution;
  state: LoadedManagedState;
  plan: ReadOnlySyncPlan;
  applyResult: ApplySyncResult;
  mapping: PlannedFile;
}

function orchestrationFixture(): OrchestrationFixture {
  const sourceRoot = "/project/.agents/skills";
  const targetRoot = "/project/shared/skills";
  const sourcePath = `${sourceRoot}/review/SKILL.md`;
  const targetPath = `${targetRoot}/review/SKILL.md`;
  const attributions = [
    { harnessId: "claude-code", placementId: "project" },
    { harnessId: "opencode", placementId: "project" },
  ] as const;
  const mapping: PlannedFile = {
    skillName: "review",
    sourcePath,
    targetPath,
    linkValue: "../../../.agents/skills/review/SKILL.md",
    attributions,
  };
  const operation = { ...mapping, kind: "create" } satisfies PlanOperation;
  const claudePlacement = projectPlacement("claude-code");
  const opencodePlacement = projectPlacement("opencode");
  const planWarning = {
    harnessId: "claude-code",
    placementId: "project",
    path: targetRoot,
    message: "External target warning.",
  } as const;
  const state: LoadedManagedState = {
    version: 1,
    entries: [],
    path: "/project/.distributor/state.json",
    exists: false,
    originalText: undefined,
    warnings: [],
  };

  return {
    discovered: {
      configPath: "/project/distributor.config.json",
      projectRoot: "/project",
      searchedBoundary: "/project",
    },
    config: {
      configPath: "/project/distributor.config.json",
      projectRoot: "/project",
      scope: "project",
      sourceRoot,
      harnesses: [
        { name: "claude-code", targets: undefined },
        { name: "codex", targets: undefined },
        { name: "opencode", targets: undefined },
      ],
    },
    skills: {
      sourceRoot,
      sourceRootIdentity: { realPath: sourceRoot, device: 1, inode: 1 },
      skills: [
        {
          name: "review",
          directoryPath: `${sourceRoot}/review`,
          frontmatter: { name: "review", description: "Review code." },
          files: [
            {
              absolutePath: sourcePath,
              sourceRelativePath: "review/SKILL.md",
              skillRelativePath: "SKILL.md",
            },
          ],
        },
      ],
      helperFiles: [],
      warnings: [
        {
          code: "ignored-source-root-file",
          path: `${sourceRoot}/notes.txt`,
          message: "Ignored source-root file.",
        },
      ],
    },
    resolution: {
      sourceRoot,
      sourceRootIdentity: { realPath: sourceRoot, device: 1, inode: 1 },
      placements: [
        {
          harnessId: "claude-code",
          placement: claudePlacement,
          targetRoot,
          hasPathOverride: true,
        },
        {
          harnessId: "opencode",
          placement: opencodePlacement,
          targetRoot,
          hasPathOverride: true,
        },
      ],
      mappings: [mapping],
      satisfiedPlacements: [
        { harnessId: "codex", placementId: "project", sourceRoot },
      ],
      warnings: [planWarning],
    },
    state,
    plan: {
      applicable: true,
      sourceRootIdentity: { realPath: sourceRoot, device: 1, inode: 1 },
      operations: [operation],
      satisfiedPlacements: [
        { harnessId: "codex", placementId: "project", sourceRoot },
      ],
      warnings: [planWarning],
      failures: [],
      stateEvaluation: { evaluated: [], untouched: [] },
    },
    applyResult: {
      operations: [
        { operation, status: "created", targetLinkMutated: true },
      ],
      failures: [],
      warnings: [planWarning],
      nextState: { version: 1, entries: [] },
      statePersisted: true,
      stateWritten: true,
    },
    mapping,
  };
}

function fixtureRuntime(
  fixture: OrchestrationFixture,
  events: string[],
): RunSyncRuntime {
  return {
    async discoverConfig() {
      events.push("discover-config");
      return fixture.discovered;
    },
    async loadProjectConfig() {
      events.push("load-config");
      return fixture.config;
    },
    async discoverSkills() {
      events.push("discover-skills");
      return fixture.skills;
    },
    resolvePlacements() {
      events.push("resolve-placements");
      return fixture.resolution;
    },
    async loadManagedState() {
      events.push("load-state");
      return fixture.state;
    },
    async buildSyncPlan() {
      events.push("build-plan");
      return fixture.plan;
    },
    async applySyncPlan() {
      events.push("apply-plan");
      return fixture.applyResult;
    },
  };
}

function projectPlacement(harnessId: "claude-code" | "opencode") {
  const placement = getAvailableAdapterConfig(harnessId)?.placements.find(
    (candidate) => candidate.id === "project",
  );
  if (placement === undefined) {
    throw new Error(`Missing ${harnessId} project placement fixture.`);
  }
  return placement;
}

function secondMapping(first: PlannedFile): PlannedFile {
  return {
    ...first,
    skillName: "second",
    sourcePath: first.sourcePath.replace("/review/", "/second/"),
    targetPath: first.targetPath.replace("/review/", "/second/"),
    linkValue: first.linkValue.replace("/review/", "/second/"),
    attributions: first.attributions,
  };
}

async function captureDistributorError(
  promise: Promise<unknown>,
): Promise<DistributorError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DistributorError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected DistributorError.");
}

async function metadataSnapshot(root: string): Promise<readonly string[]> {
  const records: string[] = [];

  async function visit(directory: string): Promise<void> {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const path = join(directory, name);
      const stats = await lstat(path);
      const relativePath = relative(root, path);
      const type = stats.isDirectory()
        ? "directory"
        : stats.isSymbolicLink()
          ? "symlink"
          : "file";
      const linkValue = stats.isSymbolicLink() ? await readlink(path) : "";
      records.push(
        [
          relativePath,
          type,
          stats.mode,
          stats.size,
          stats.mtimeMs,
          stats.ctimeMs,
          linkValue,
        ].join("\0"),
      );
      if (stats.isDirectory()) {
        await visit(path);
      }
    }
  }

  await visit(root);
  return records;
}
