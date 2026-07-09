import { lstatSync, realpathSync } from "node:fs";
import { access, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  getAvailableAdapterConfig,
  type HarnessPlacement,
} from "../../src/adapters/index.js";
import { useFixture } from "../helpers/fixture.js";
import {
  discoverSkills,
  type SourceRootIdentity,
} from "../../src/skills/discover.js";
import { buildSyncPlan } from "../../src/sync/plan.js";
import type {
  PlacementResolution,
  ResolvedTargetPlacement,
} from "../../src/sync/resolve-placements.js";
import type {
  ManagedState,
  ManagedStateEntry,
} from "../../src/sync/state.js";
import type { OwnershipAttribution, PlannedFile } from "../../src/sync/types.js";

const CLAUDE_ATTRIBUTION = {
  harnessId: "claude-code",
  placementId: "project",
} as const;

describe("buildSyncPlan", () => {
  it("rejects a source ancestor redirected after skill discovery", async () => {
    await useFixture(async (root) => {
      const projectRoot = join(root, "project");
      const sourceRoot = join(projectRoot, ".agents", "skills");
      const sourcePath = join(sourceRoot, "review", "SKILL.md");
      const targetRoot = join(projectRoot, ".claude", "skills");
      const targetPath = join(targetRoot, "review", "SKILL.md");
      await mkdir(dirname(sourcePath), { recursive: true });
      await writeFile(
        sourcePath,
        "---\nname: review\ndescription: Review code.\n---\n",
      );
      const discovered = await discoverSkills(sourceRoot);
      const mapping: PlannedFile = {
        skillName: "review",
        sourcePath,
        targetPath,
        linkValue: relative(dirname(targetPath), sourcePath),
        attributions: [CLAUDE_ATTRIBUTION],
      };
      const input = {
        ...resolution(targetRoot, [mapping]),
        sourceRootIdentity: discovered.sourceRootIdentity,
      };
      const outsideAgents = join(root, "outside-agents");
      const outsideSkill = join(outsideAgents, "skills", "review");
      await mkdir(outsideSkill, { recursive: true });
      await writeFile(join(outsideSkill, "SKILL.md"), "outside");
      await rm(join(projectRoot, ".agents"), { recursive: true });
      await symlink(outsideAgents, join(projectRoot, ".agents"), "dir");

      await expect(buildSyncPlan(input, emptyState())).rejects.toMatchObject({
        category: "source",
        message: expect.stringContaining("identity changed after discovery"),
      });
      await expect(access(targetRoot)).rejects.toThrow();
    });
  });

  it("classifies an absent target as create without creating parents", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);

      const plan = await buildSyncPlan(
        resolution(fixture.targetRoot, [fixture.mapping]),
        emptyState(),
      );

      expect(plan.applicable).toBe(true);
      expect(plan.operations).toEqual([
        expect.objectContaining({ kind: "create", targetPath: fixture.targetPath }),
      ]);
      await expect(access(fixture.targetRoot)).rejects.toThrow();
    });
  });

  it("classifies an unchanged owned link as skip", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      await createTargetLink(fixture.mapping, fixture.mapping.linkValue);
      const state = managedState([
        stateEntry(fixture.mapping, fixture.mapping.linkValue),
      ]);

      const plan = await buildSyncPlan(
        resolution(fixture.targetRoot, [fixture.mapping]),
        state,
      );

      expect(plan).toMatchObject({ applicable: true, failures: [] });
      expect(plan.operations).toEqual([
        expect.objectContaining({ kind: "skip", linkValue: fixture.mapping.linkValue }),
      ]);
    });
  });

  it("preserves an equivalent adopted raw link value on later skips", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      await createTargetLink(fixture.mapping, fixture.sourcePath);
      const state = managedState([
        stateEntry(fixture.mapping, fixture.sourcePath),
      ]);

      const plan = await buildSyncPlan(
        resolution(fixture.targetRoot, [fixture.mapping]),
        state,
      );

      expect(plan.applicable).toBe(true);
      expect(plan.operations).toEqual([
        expect.objectContaining({
          kind: "skip",
          linkValue: fixture.sourcePath,
        }),
      ]);
    });
  });

  it("classifies an unchanged managed mapping to an old source as update", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      const oldSource = join(root, "old-source", "review", "SKILL.md");
      await mkdir(dirname(oldSource), { recursive: true });
      await writeFile(oldSource, "old");
      const oldLink = relative(dirname(fixture.targetPath), oldSource);
      await createTargetLink(fixture.mapping, oldLink);
      const state = managedState([
        {
          ...stateEntry(fixture.mapping, oldLink),
          sourcePath: oldSource,
        },
      ]);

      const plan = await buildSyncPlan(
        resolution(fixture.targetRoot, [fixture.mapping]),
        state,
      );

      expect(plan.applicable).toBe(true);
      expect(plan.operations).toEqual([
        expect.objectContaining({
          kind: "update",
          sourcePath: fixture.sourcePath,
          linkValue: fixture.mapping.linkValue,
        }),
      ]);
    });
  });

  it("adopts exact and lexically equivalent unrecorded links", async () => {
    await useFixture(async (root) => {
      const first = await mappingFixture(root, "first");
      const second = await mappingFixture(root, "second");
      await createTargetLink(first.mapping, first.mapping.linkValue);
      await createTargetLink(second.mapping, second.sourcePath);

      const plan = await buildSyncPlan(
        resolution(first.targetRoot, [second.mapping, first.mapping]),
        emptyState(),
      );

      expect(plan.applicable).toBe(true);
      expect(plan.operations.map((operation) => operation.kind)).toEqual([
        "adopt",
        "adopt",
      ]);
      expect(
        plan.operations.find(
          (operation) => operation.targetPath === second.targetPath,
        )?.linkValue,
      ).toBe(second.sourcePath);
    });
  });

  it("aggregates unmanaged target conflicts and keeps independent creates in the plan", async () => {
    await useFixture(async (root) => {
      const absent = await mappingFixture(root, "absent");
      const regular = await mappingFixture(root, "regular");
      const directory = await mappingFixture(root, "directory");
      const linked = await mappingFixture(root, "linked");
      await mkdir(dirname(regular.targetPath), { recursive: true });
      await writeFile(regular.targetPath, "unmanaged");
      await mkdir(directory.targetPath, { recursive: true });
      await mkdir(dirname(linked.targetPath), { recursive: true });
      await symlink("somewhere-else", linked.targetPath, "file");

      const plan = await buildSyncPlan(
        resolution(absent.targetRoot, [
          linked.mapping,
          absent.mapping,
          directory.mapping,
          regular.mapping,
        ]),
        emptyState(),
      );

      expect(plan.applicable).toBe(false);
      expect(plan.operations.filter((operation) => operation.kind === "create")).toHaveLength(1);
      expect(plan.operations.filter((operation) => operation.kind === "conflict")).toHaveLength(3);
      expect(plan.failures).toHaveLength(3);
      await expect(access(absent.targetPath)).rejects.toThrow();
    });
  });

  it("makes out-of-plan state tampering a global conflict", async () => {
    await useFixture(async (root) => {
      const desired = await mappingFixture(root, "desired");
      const recorded = await mappingFixture(root, "recorded");
      await createTargetLink(recorded.mapping, recorded.mapping.linkValue);
      const state = managedState([
        stateEntry(recorded.mapping, "changed-after-sync"),
      ]);

      const plan = await buildSyncPlan(
        resolution(desired.targetRoot, [desired.mapping]),
        state,
      );

      expect(plan.applicable).toBe(false);
      expect(plan.operations).toEqual([
        expect.objectContaining({ kind: "create", targetPath: desired.targetPath }),
      ]);
      expect(plan.failures).toEqual([
        expect.objectContaining({
          path: recorded.targetPath,
          message: expect.stringContaining("ownership is invalid"),
        }),
      ]);
    });
  });

  it("rejects a recorded-but-tampered target even when it now resolves correctly", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      await createTargetLink(fixture.mapping, fixture.mapping.linkValue);
      const state = managedState([
        stateEntry(fixture.mapping, "different-recorded-value"),
      ]);

      const plan = await buildSyncPlan(
        resolution(fixture.targetRoot, [fixture.mapping]),
        state,
      );

      expect(plan.applicable).toBe(false);
      expect(plan.operations).toEqual([
        expect.objectContaining({
          kind: "conflict",
          reason: expect.stringContaining("changed"),
        }),
      ]);
    });
  });

  it("reports an unchanged broken managed link as stale and ignores a missing record", async () => {
    await useFixture(async (root) => {
      const stale = await mappingFixture(root, "stale");
      const missing = await mappingFixture(root, "missing");
      await createTargetLink(stale.mapping, "missing-source");
      const state = managedState([
        stateEntry(stale.mapping, "missing-source"),
        stateEntry(missing.mapping, missing.mapping.linkValue),
      ]);

      const plan = await buildSyncPlan(emptyResolution(), state);

      expect(plan.applicable).toBe(true);
      expect(plan.operations).toEqual([
        expect.objectContaining({
          kind: "stale",
          targetPath: stale.targetPath,
        }),
      ]);
    });
  });

  it("turns a missing recorded target that is still desired into create", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      const state = managedState([
        stateEntry(fixture.mapping, fixture.mapping.linkValue),
      ]);

      const plan = await buildSyncPlan(
        resolution(fixture.targetRoot, [fixture.mapping]),
        state,
      );

      expect(plan).toMatchObject({ applicable: true });
      expect(plan.operations).toEqual([
        expect.objectContaining({ kind: "create" }),
      ]);
    });
  });

  it("allows a filtered sync to recreate an identical other-only mapping", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      const state = managedState([
        {
          ...stateEntry(fixture.mapping, fixture.mapping.linkValue),
          attributions: [
            { harnessId: "opencode", placementId: "project" },
          ],
        },
      ]);

      const plan = await buildSyncPlan(
        resolution(fixture.targetRoot, [fixture.mapping]),
        state,
        { harnessId: "claude-code" },
      );

      expect(plan.applicable).toBe(true);
      expect(plan.operations).toEqual([
        expect.objectContaining({ kind: "create" }),
      ]);
    });
  });

  it("rejects a different mapping for a missing other-only target", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      const oldSource = join(root, "old", "SKILL.md");
      const oldLink = relative(dirname(fixture.targetPath), oldSource);
      const state = managedState([
        {
          ...stateEntry(fixture.mapping, oldLink),
          sourcePath: oldSource,
          attributions: [
            { harnessId: "opencode", placementId: "project" },
          ],
        },
      ]);

      const plan = await buildSyncPlan(
        resolution(fixture.targetRoot, [fixture.mapping]),
        state,
        { harnessId: "claude-code" },
      );

      expect(plan.applicable).toBe(false);
      expect(plan.operations[0]).toMatchObject({
        kind: "conflict",
        reason: expect.stringContaining("desired source or raw link differs"),
      });
    });
  });

  it("allows an identical missing shared mapping in a filtered sync", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      const state = managedState([
        {
          ...stateEntry(fixture.mapping, fixture.mapping.linkValue),
          attributions: [
            CLAUDE_ATTRIBUTION,
            { harnessId: "opencode", placementId: "project" },
          ],
        },
      ]);

      const plan = await buildSyncPlan(
        resolution(fixture.targetRoot, [fixture.mapping]),
        state,
        { harnessId: "claude-code" },
      );

      expect(plan.applicable).toBe(true);
      expect(plan.operations[0]).toMatchObject({ kind: "create" });
    });
  });

  it("rejects a different mapping for a missing shared target", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      const oldSource = join(root, "old", "SKILL.md");
      const state = managedState([
        {
          ...stateEntry(fixture.mapping, "recorded-raw-link"),
          sourcePath: oldSource,
          attributions: [
            CLAUDE_ATTRIBUTION,
            { harnessId: "opencode", placementId: "project" },
          ],
        },
      ]);

      const plan = await buildSyncPlan(
        resolution(fixture.targetRoot, [fixture.mapping]),
        state,
        { harnessId: "claude-code" },
      );

      expect(plan.applicable).toBe(false);
      expect(plan.operations[0]).toMatchObject({ kind: "conflict" });
    });
  });

  it("rejects missing parents when placement creation is disallowed", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);

      const plan = await buildSyncPlan(
        resolution(fixture.targetRoot, [fixture.mapping], false),
        emptyState(),
      );

      expect(plan.applicable).toBe(false);
      expect(plan.operations[0]).toMatchObject({ kind: "conflict" });
      expect(plan.failures[0]?.message).toContain("does not allow");
    });
  });

  it("rejects a non-directory target parent", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      const blocker = dirname(fixture.targetPath);
      await mkdir(dirname(blocker), { recursive: true });
      await writeFile(blocker, "blocks directory creation");

      const plan = await buildSyncPlan(
        resolution(fixture.targetRoot, [fixture.mapping]),
        emptyState(),
      );

      expect(plan.applicable).toBe(false);
      expect(plan.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: blocker,
            message: expect.stringContaining("not a directory"),
          }),
        ]),
      );
    });
  });

  it("allows a parent symlink contained within the target root", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      const linkedParent = dirname(fixture.targetPath);
      const safeDirectory = join(fixture.targetRoot, "safe-review");
      await mkdir(safeDirectory, { recursive: true });
      await symlink(safeDirectory, linkedParent, "dir");

      const plan = await buildSyncPlan(
        resolution(fixture.targetRoot, [fixture.mapping]),
        emptyState(),
      );

      expect(plan).toMatchObject({ applicable: true, failures: [] });
      expect(plan.operations[0]).toMatchObject({ kind: "create" });
    });
  });

  it("rejects distinct desired targets that alias the same physical path", async () => {
    await useFixture(async (root) => {
      const first = await mappingFixture(root, "first");
      const second = await mappingFixture(root, "second");
      const realParent = join(first.targetRoot, "real");
      const aliasParent = join(first.targetRoot, "alias");
      await mkdir(realParent, { recursive: true });
      await symlink(realParent, aliasParent, "dir");
      const firstTarget = join(aliasParent, "SKILL.md");
      const secondTarget = join(realParent, "SKILL.md");
      const firstMapping: PlannedFile = {
        ...first.mapping,
        targetPath: firstTarget,
        linkValue: relative(dirname(firstTarget), first.sourcePath),
      };
      const secondMapping: PlannedFile = {
        ...second.mapping,
        targetPath: secondTarget,
        linkValue: relative(dirname(secondTarget), second.sourcePath),
      };

      const plan = await buildSyncPlan(
        resolution(first.targetRoot, [firstMapping, secondMapping]),
        emptyState(),
      );

      expect(plan.applicable).toBe(false);
      expect(plan.operations).toEqual([
        expect.objectContaining({
          kind: "conflict",
          reason: expect.stringContaining("same physical path"),
        }),
        expect.objectContaining({
          kind: "conflict",
          reason: expect.stringContaining("same physical path"),
        }),
      ]);
      expect(plan.failures).toHaveLength(2);
      await expect(access(join(realParent, "SKILL.md"))).rejects.toThrow();
    });
  });

  it("rejects a parent symlink that escapes the target root", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      const linkedParent = dirname(fixture.targetPath);
      const outside = join(root, "outside");
      await mkdir(fixture.targetRoot, { recursive: true });
      await mkdir(outside);
      await symlink(outside, linkedParent, "dir");

      const plan = await buildSyncPlan(
        resolution(fixture.targetRoot, [fixture.mapping]),
        emptyState(),
      );

      expect(plan.applicable).toBe(false);
      expect(plan.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: linkedParent,
            message: expect.stringContaining("escapes target root"),
          }),
        ]),
      );
    });
  });

  it("rejects an escaping symlink above a missing project target root", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      const redirect = join(root, "redirect");
      const outside = join(root, "outside");
      const targetRoot = join(redirect, "skills");
      const targetPath = join(targetRoot, "review", "SKILL.md");
      const mapping: PlannedFile = {
        ...fixture.mapping,
        targetPath,
        linkValue: relative(dirname(targetPath), fixture.sourcePath),
      };
      await mkdir(outside);
      await symlink(outside, redirect, "dir");

      const plan = await buildSyncPlan(
        resolution(targetRoot, [mapping]),
        emptyState(),
      );

      expect(plan.applicable).toBe(false);
      expect(plan.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: redirect,
            message: expect.stringContaining("escapes target root"),
          }),
        ]),
      );
    });
  });

  it("inspects an escaping ancestor above a missing external target root", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      const redirect = join(root, "external-redirect");
      const outside = join(root, "external-outside");
      const targetRoot = join(redirect, "skills");
      const targetPath = join(targetRoot, "review", "SKILL.md");
      const mapping: PlannedFile = {
        ...fixture.mapping,
        targetPath,
        linkValue: fixture.sourcePath,
      };
      await mkdir(outside);
      await symlink(outside, redirect, "dir");

      const plan = await buildSyncPlan(
        resolution(targetRoot, [mapping]),
        emptyState(),
      );

      expect(plan.applicable).toBe(false);
      expect(plan.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: redirect,
            message: expect.stringContaining("redirects through symbolic link"),
          }),
        ]),
      );
      await expect(access(join(outside, "skills"))).rejects.toThrow();
    });
  });

  it("limits stale and tamper evaluation to a selected harness", async () => {
    await useFixture(async (root) => {
      const selected = await mappingFixture(root, "selected");
      const other = await mappingFixture(root, "other", {
        harnessId: "opencode",
        placementId: "project",
      });
      await createTargetLink(selected.mapping, selected.mapping.linkValue);
      await mkdir(dirname(other.targetPath), { recursive: true });
      await writeFile(other.targetPath, "tampered but out of scope");
      const state = managedState([
        {
          ...stateEntry(selected.mapping, selected.mapping.linkValue),
          attributions: [
            CLAUDE_ATTRIBUTION,
            { harnessId: "opencode", placementId: "project" },
          ],
        },
        stateEntry(other.mapping, other.mapping.linkValue),
      ]);

      const plan = await buildSyncPlan(emptyResolution(), state, {
        harnessId: "claude-code",
      });

      expect(plan.applicable).toBe(true);
      expect(plan.failures).toEqual([]);
      expect(plan.operations).toEqual([
        expect.objectContaining({
          kind: "stale",
          targetPath: selected.targetPath,
          attributions: [CLAUDE_ATTRIBUTION],
        }),
      ]);
      expect(plan.stateEvaluation.untouched).toEqual([
        expect.objectContaining({ targetPath: other.targetPath }),
      ]);
    });
  });

  it("does not update a shared target during a filtered sync", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      const oldSource = join(root, "old", "SKILL.md");
      await mkdir(dirname(oldSource), { recursive: true });
      await writeFile(oldSource, "old");
      const oldLink = relative(dirname(fixture.targetPath), oldSource);
      await createTargetLink(fixture.mapping, oldLink);
      const state = managedState([
        {
          ...stateEntry(fixture.mapping, oldLink),
          sourcePath: oldSource,
          attributions: [
            CLAUDE_ATTRIBUTION,
            { harnessId: "opencode", placementId: "project" },
          ],
        },
      ]);

      const plan = await buildSyncPlan(
        resolution(fixture.targetRoot, [fixture.mapping]),
        state,
        { harnessId: "claude-code" },
      );

      expect(plan.applicable).toBe(false);
      expect(plan.operations[0]).toMatchObject({
        kind: "conflict",
        reason: expect.stringContaining("outside the selected harness scope"),
      });
    });
  });

  it("returns stable operation and diagnostic order", async () => {
    await useFixture(async (root) => {
      const zeta = await mappingFixture(root, "zeta");
      const alpha = await mappingFixture(root, "alpha");
      await mkdir(dirname(zeta.targetPath), { recursive: true });
      await writeFile(zeta.targetPath, "unmanaged");

      const input = resolution(alpha.targetRoot, [zeta.mapping, alpha.mapping]);
      const first = await buildSyncPlan(input, emptyState());
      const second = await buildSyncPlan(input, emptyState());

      expect(second.operations).toEqual(first.operations);
      expect(second.failures).toEqual(first.failures);
      expect(first.operations.map((operation) => operation.skillName)).toEqual([
        "alpha",
        "zeta",
      ]);
    });
  });
});

interface MappingFixture {
  sourcePath: string;
  targetPath: string;
  sourceRoot: string;
  targetRoot: string;
  mapping: PlannedFile;
}

async function mappingFixture(
  root: string,
  skillName = "review",
  attribution: OwnershipAttribution = CLAUDE_ATTRIBUTION,
): Promise<MappingFixture> {
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "target");
  const sourcePath = join(sourceRoot, skillName, "SKILL.md");
  const targetPath = join(targetRoot, skillName, "SKILL.md");
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, `${skillName} source`);
  const mapping: PlannedFile = {
    skillName,
    sourcePath,
    targetPath,
    linkValue: relative(dirname(targetPath), sourcePath),
    attributions: [attribution],
  };
  return { sourcePath, targetPath, sourceRoot, targetRoot, mapping };
}

function resolution(
  targetRoot: string,
  mappings: readonly PlannedFile[],
  createIfMissing = true,
): PlacementResolution {
  const placement = claudePlacement(createIfMissing);
  const byAttribution = new Map<string, ResolvedTargetPlacement>();
  for (const mapping of mappings) {
    for (const attribution of mapping.attributions) {
      byAttribution.set(`${attribution.harnessId}\0${attribution.placementId}`, {
        harnessId: attribution.harnessId,
        placement: { ...placement, id: attribution.placementId },
        targetRoot,
        hasPathOverride: true,
      });
    }
  }
  const sourceRoot = sourceRootForMappings(mappings);
  return {
    sourceRoot,
    sourceRootIdentity: sourceIdentity(sourceRoot),
    placements: [...byAttribution.values()],
    mappings,
    satisfiedPlacements: [],
    warnings: [],
  };
}

function emptyResolution(): PlacementResolution {
  return {
    sourceRoot: process.cwd(),
    sourceRootIdentity: sourceIdentity(process.cwd()),
    placements: [],
    mappings: [],
    satisfiedPlacements: [],
    warnings: [],
  };
}

function sourceRootForMappings(mappings: readonly PlannedFile[]): string {
  const mapping = mappings[0];
  return mapping === undefined
    ? process.cwd()
    : dirname(dirname(mapping.sourcePath));
}

function sourceIdentity(sourceRoot: string): SourceRootIdentity {
  const stats = lstatSync(sourceRoot);
  return {
    realPath: realpathSync(sourceRoot),
    device: stats.dev,
    inode: stats.ino,
  };
}

function claudePlacement(createIfMissing: boolean): HarnessPlacement {
  const adapter = getAvailableAdapterConfig("claude-code");
  const placement = adapter?.placements.find((item) => item.id === "project");
  if (placement === undefined) {
    throw new Error("Missing Claude Code project placement fixture.");
  }
  return { ...placement, createIfMissing };
}

function emptyState(): ManagedState {
  return { version: 1, entries: [] };
}

function managedState(entries: readonly ManagedStateEntry[]): ManagedState {
  return { version: 1, entries };
}

function stateEntry(
  mapping: PlannedFile,
  linkValue: string,
): ManagedStateEntry {
  return {
    sourcePath: mapping.sourcePath,
    targetPath: mapping.targetPath,
    linkValue,
    attributions: mapping.attributions,
  };
}

async function createTargetLink(
  mapping: PlannedFile,
  linkValue: string,
): Promise<void> {
  await mkdir(dirname(mapping.targetPath), { recursive: true });
  await symlink(linkValue, mapping.targetPath, "file");
}
