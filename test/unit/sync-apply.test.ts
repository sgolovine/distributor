import { lstatSync, realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  getAvailableAdapterConfig,
  type HarnessPlacement,
} from "../../src/adapters/index.js";
import { DistributorError } from "../../src/errors.js";
import type { SourceRootIdentity } from "../../src/skills/discover.js";
import { useFixture } from "../helpers/fixture.js";
import { applySyncPlan } from "../../src/sync/apply.js";
import { buildSyncPlan } from "../../src/sync/plan.js";
import type {
  PlacementResolution,
  ResolvedTargetPlacement,
} from "../../src/sync/resolve-placements.js";
import {
  loadManagedState,
  serializeManagedState,
  statePathForProject,
  type LoadedManagedState,
  type ManagedStateEntry,
} from "../../src/sync/state.js";
import type {
  OwnershipAttribution,
  PlannedFile,
} from "../../src/sync/types.js";

const CLAUDE = {
  harnessId: "claude-code",
  placementId: "project",
} as const;

const OPENCODE = {
  harnessId: "opencode",
  placementId: "project",
} as const;

describe("applySyncPlan target mutations", () => {
  it("creates missing parents, a file symlink, and persisted ownership", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      const loaded = loadedState(root, []);
      const input = resolution(fixture.targetRoot, [fixture.mapping]);
      const plan = await buildSyncPlan(input, loaded);

      const result = await applySyncPlan(plan, input, loaded, root);

      expect(result).toMatchObject({
        statePersisted: true,
        stateWritten: true,
        failures: [],
        operations: [{ status: "created", targetLinkMutated: true }],
      });
      expect(await readlink(fixture.targetPath)).toBe(fixture.mapping.linkValue);
      expect((await lstat(fixture.targetPath)).isSymbolicLink()).toBe(true);
      expect((await lstat(dirname(fixture.targetPath))).isDirectory()).toBe(true);
      await expect(loadManagedState(root)).resolves.toMatchObject({
        directories: [
          fixture.targetRoot,
          dirname(fixture.targetPath),
        ],
        entries: [
          expect.objectContaining({
            targetPath: fixture.targetPath,
            linkValue: fixture.mapping.linkValue,
          }),
        ],
      });
    });
  });

  it("does not recreate a raced-away parent when placement creation is disabled", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      await mkdir(dirname(fixture.targetPath), { recursive: true });
      const loaded = loadedState(root, []);
      const input = resolution(fixture.targetRoot, [fixture.mapping], false);
      const plan = await buildSyncPlan(input, loaded);
      await rm(fixture.targetRoot, { recursive: true });

      const result = await applySyncPlan(plan, input, loaded, root);

      expect(result.operations[0]).toMatchObject({
        status: "failed",
        targetLinkMutated: false,
        failure: {
          phase: "parent",
          message: expect.stringContaining("disappeared"),
        },
      });
      await expect(lstat(fixture.targetRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("refuses a raced target and continues an independent create", async () => {
    await useFixture(async (root) => {
      const first = await mappingFixture(root, "alpha");
      const second = await mappingFixture(root, "beta");
      const loaded = loadedState(root, []);
      const input = resolution(first.targetRoot, [first.mapping, second.mapping]);
      const plan = await buildSyncPlan(input, loaded);
      await mkdir(dirname(first.targetPath), { recursive: true });
      await writeFile(first.targetPath, "raced content", "utf8");

      const result = await applySyncPlan(plan, input, loaded, root);

      expect(result.operations.map((operation) => operation.status)).toEqual([
        "failed",
        "created",
      ]);
      expect(await readFile(first.targetPath, "utf8")).toBe("raced content");
      expect(await readlink(second.targetPath)).toBe(second.mapping.linkValue);
      expect(result.nextState.entries.map((entry) => entry.targetPath)).toEqual([
        second.targetPath,
      ]);
    });
  });

  it("refuses a source file replaced by a symlink after planning", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      const loaded = loadedState(root, []);
      const input = resolution(fixture.targetRoot, [fixture.mapping]);
      const plan = await buildSyncPlan(input, loaded);
      const outside = join(root, "outside.md");
      await writeFile(outside, "outside", "utf8");
      await rm(fixture.sourcePath);
      await symlink(outside, fixture.sourcePath, "file");

      const result = await applySyncPlan(plan, input, loaded, root);

      expect(result.operations[0]).toMatchObject({
        status: "failed",
        targetLinkMutated: false,
        failure: {
          message: expect.stringContaining("Source file changed after planning"),
          correction: expect.stringContaining("source symlinks"),
        },
      });
      await expect(lstat(fixture.targetRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(result.nextState.entries).toEqual([]);
    });
  });

  it("refuses a source directory replaced by an external symlink after planning", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      const loaded = loadedState(root, []);
      const input = resolution(fixture.targetRoot, [fixture.mapping]);
      const plan = await buildSyncPlan(input, loaded);
      const skillRoot = dirname(fixture.sourcePath);
      const outsideSkill = join(root, "outside-skill");
      await mkdir(outsideSkill);
      await writeFile(join(outsideSkill, "SKILL.md"), "outside", "utf8");
      await rm(skillRoot, { recursive: true });
      await symlink(outsideSkill, skillRoot, "dir");

      const result = await applySyncPlan(plan, input, loaded, root);

      expect(result.operations[0]).toMatchObject({
        status: "failed",
        targetLinkMutated: false,
        failure: {
          message: expect.stringContaining("Source parent changed"),
          correction: expect.stringContaining("source symlinks"),
        },
      });
      await expect(lstat(fixture.targetRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(result.nextState.entries).toEqual([]);
    });
  });

  it("rejects a parent symlink that escapes after planning", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      const loaded = loadedState(root, []);
      const input = resolution(fixture.targetRoot, [fixture.mapping]);
      const plan = await buildSyncPlan(input, loaded);
      const outside = join(root, "outside");
      await mkdir(outside);
      await symlink(outside, fixture.targetRoot, "dir");

      const result = await applySyncPlan(plan, input, loaded, root);

      expect(result.operations[0]).toMatchObject({
        status: "failed",
        failure: {
          phase: "parent",
          message: expect.stringContaining("escapes target root"),
        },
      });
      await expect(
        lstat(join(outside, "review", "SKILL.md")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("revalidates ancestors above a missing absolute-link target root", async () => {
    await useFixture(async (root) => {
      const sourcePath = join(root, "source", "review", "SKILL.md");
      const redirectedAncestor = join(root, "redirected");
      const targetRoot = join(redirectedAncestor, "nested", "skills");
      const targetPath = join(targetRoot, "review", "SKILL.md");
      await mkdir(dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, "source", "utf8");
      const mapping: PlannedFile = {
        skillName: "review",
        sourcePath,
        targetPath,
        linkValue: sourcePath,
        attributions: [CLAUDE],
      };
      const loaded = loadedState(root, []);
      const input = resolution(targetRoot, [mapping]);
      const plan = await buildSyncPlan(input, loaded);
      const outside = join(root, "outside");
      await mkdir(outside);
      await symlink(outside, redirectedAncestor, "dir");

      const result = await applySyncPlan(plan, input, loaded, root);

      expect(result.operations[0]).toMatchObject({
        status: "failed",
        failure: {
          phase: "parent",
          message: expect.stringContaining("escapes target root"),
        },
      });
      await expect(lstat(join(outside, "nested"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("adopts an equivalent link without target mutation", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      await createTargetLink(fixture.mapping, fixture.sourcePath);
      const loaded = loadedState(root, []);
      const input = resolution(fixture.targetRoot, [fixture.mapping]);
      const plan = await buildSyncPlan(input, loaded);
      const mkdirTarget = vi.fn(async () => undefined);
      const symlinkTarget = vi.fn(async () => undefined);
      const unlinkTarget = vi.fn(async () => undefined);

      const result = await applySyncPlan(plan, input, loaded, root, {
        filesystem: {
          mkdir: mkdirTarget,
          symlink: symlinkTarget,
          unlink: unlinkTarget,
        },
      });

      expect(result.operations[0]?.status).toBe("adopted");
      expect(result.nextState.directories).toEqual([]);
      expect(mkdirTarget).not.toHaveBeenCalled();
      expect(symlinkTarget).not.toHaveBeenCalled();
      expect(unlinkTarget).not.toHaveBeenCalled();
      expect(result.nextState.entries[0]?.linkValue).toBe(fixture.sourcePath);
    });
  });

  it("skips an exact owned link with no target or state write", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      await createTargetLink(fixture.mapping, fixture.mapping.linkValue);
      const entry = stateEntry(fixture.mapping, fixture.mapping.linkValue);
      const loaded = loadedState(root, [entry], {
        exists: true,
        originalText: serializeManagedState(
          { version: 1, entries: [entry] },
          root,
        ),
      });
      const input = resolution(fixture.targetRoot, [fixture.mapping]);
      const plan = await buildSyncPlan(input, loaded);
      const mkdirTarget = vi.fn(async () => undefined);
      const symlinkTarget = vi.fn(async () => undefined);
      const unlinkTarget = vi.fn(async () => undefined);

      const result = await applySyncPlan(plan, input, loaded, root, {
        filesystem: {
          mkdir: mkdirTarget,
          symlink: symlinkTarget,
          unlink: unlinkTarget,
        },
      });

      expect(result).toMatchObject({
        statePersisted: true,
        stateWritten: false,
        operations: [{ status: "skipped", targetLinkMutated: false }],
      });
      expect(mkdirTarget).not.toHaveBeenCalled();
      expect(symlinkTarget).not.toHaveBeenCalled();
      expect(unlinkTarget).not.toHaveBeenCalled();
    });
  });

  it("updates only an unchanged owned symbolic link", async () => {
    await useFixture(async (root) => {
      const fixture = await updateFixture(root);

      const result = await applySyncPlan(
        fixture.plan,
        fixture.resolution,
        fixture.loaded,
        root,
      );

      expect(result.operations[0]).toMatchObject({
        status: "updated",
        targetLinkMutated: true,
      });
      expect(await readlink(fixture.mapping.targetPath)).toBe(
        fixture.mapping.linkValue,
      );
      expect(result.nextState.entries[0]).toMatchObject({
        sourcePath: fixture.mapping.sourcePath,
        linkValue: fixture.mapping.linkValue,
      });
    });
  });

  it("rolls back an update when state persistence fails and retries safely", async () => {
    await useFixture(async (root) => {
      const fixture = await updateFixture(root);
      const statePath = statePathForProject(root);
      const originalText = serializeManagedState(
        { version: 1, entries: [fixture.priorEntry] },
        root,
      );
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, originalText, "utf8");
      const loaded = await loadManagedState(root);
      const plan = await buildSyncPlan(fixture.resolution, loaded);

      const failed = await applySyncPlan(
        plan,
        fixture.resolution,
        loaded,
        root,
        {
          persistState: async () => {
            throw new Error("simulated state failure");
          },
        },
      );

      expect(failed).toMatchObject({
        statePersisted: false,
        operations: [{ status: "failed", targetLinkMutated: true }],
        nextState: { entries: [fixture.priorEntry] },
      });
      expect(await readlink(fixture.mapping.targetPath)).toBe(
        fixture.priorEntry.linkValue,
      );
      expect(await readFile(statePath, "utf8")).toBe(originalText);

      const reloaded = await loadManagedState(root);
      const retryPlan = await buildSyncPlan(fixture.resolution, reloaded);
      expect(retryPlan.operations[0]?.kind).toBe("update");
      const retried = await applySyncPlan(
        retryPlan,
        fixture.resolution,
        reloaded,
        root,
      );
      expect(retried.operations[0]?.status).toBe("updated");
      expect(await readlink(fixture.mapping.targetPath)).toBe(
        fixture.mapping.linkValue,
      );
    });
  });

  it("rolls back a mutated update that failed post-write verification before persistence failed", async () => {
    await useFixture(async (root) => {
      const fixture = await updateFixture(root);
      let targetReads = 0;

      const result = await applySyncPlan(
        fixture.plan,
        fixture.resolution,
        fixture.loaded,
        root,
        {
          filesystem: {
            readlink: async (path) => {
              const value = await readlink(path);
              if (path === fixture.mapping.targetPath) {
                targetReads += 1;
                if (targetReads === 3) {
                  return "verification-mismatch";
                }
              }
              return value;
            },
          },
          persistState: async () => {
            throw new Error("simulated state failure");
          },
        },
      );

      expect(result.operations[0]).toMatchObject({
        status: "failed",
        targetLinkMutated: true,
        failure: {
          message: expect.stringContaining("does not match the desired link"),
        },
      });
      expect(await readlink(fixture.mapping.targetPath)).toBe(
        fixture.priorEntry.linkValue,
      );
      const retry = await buildSyncPlan(fixture.resolution, fixture.loaded);
      expect(retry).toMatchObject({ applicable: true });
      expect(retry.operations[0]?.kind).toBe("update");
    });
  });

  it("restores a prior-owned create after verification and persistence both fail", async () => {
    await useFixture(async (root) => {
      const fixture = await updateFixture(root);
      await rm(fixture.mapping.targetPath);
      const plan = await buildSyncPlan(fixture.resolution, fixture.loaded);
      expect(plan.operations[0]?.kind).toBe("create");
      let targetReads = 0;

      const result = await applySyncPlan(
        plan,
        fixture.resolution,
        fixture.loaded,
        root,
        {
          filesystem: {
            readlink: async (path) => {
              const value = await readlink(path);
              if (path === fixture.mapping.targetPath) {
                targetReads += 1;
                if (targetReads === 1) {
                  return "verification-mismatch";
                }
              }
              return value;
            },
          },
          persistState: async () => {
            throw new Error("simulated state failure");
          },
        },
      );

      expect(result.operations[0]).toMatchObject({
        status: "failed",
        targetLinkMutated: true,
      });
      await expect(lstat(fixture.mapping.targetPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(result.nextState.entries).toEqual([fixture.priorEntry]);
      const retry = await buildSyncPlan(fixture.resolution, fixture.loaded);
      expect(retry).toMatchObject({ applicable: true });
      expect(retry.operations[0]?.kind).toBe("create");
    });
  });

  it("does not overwrite a target that races state-failure rollback", async () => {
    await useFixture(async (root) => {
      const fixture = await updateFixture(root);

      const result = await applySyncPlan(
        fixture.plan,
        fixture.resolution,
        fixture.loaded,
        root,
        {
          persistState: async () => {
            await rm(fixture.mapping.targetPath);
            await symlink("raced-after-update", fixture.mapping.targetPath, "file");
            throw new Error("simulated state failure");
          },
        },
      );

      expect(result.operations[0]).toMatchObject({
        status: "failed",
        targetLinkMutated: true,
        failure: {
          phase: "target",
          message: expect.stringContaining("target changed"),
        },
      });
      expect(result.failures).toEqual([
        expect.objectContaining({ phase: "state" }),
        expect.objectContaining({
          phase: "target",
          message: expect.stringContaining("target changed"),
        }),
      ]);
      expect(await readlink(fixture.mapping.targetPath)).toBe(
        "raced-after-update",
      );
    });
  });

  it("does not roll back through a target parent redirected after persistence begins", async () => {
    await useFixture(async (root) => {
      const fixture = await updateFixture(root);
      const targetRoot = dirname(dirname(fixture.mapping.targetPath));
      const outsideRoot = join(root, "outside-target");
      const outsideTarget = join(outsideRoot, "review", "SKILL.md");

      const result = await applySyncPlan(
        fixture.plan,
        fixture.resolution,
        fixture.loaded,
        root,
        {
          persistState: async () => {
            await mkdir(dirname(outsideTarget), { recursive: true });
            await symlink(
              fixture.mapping.linkValue,
              outsideTarget,
              "file",
            );
            await rm(targetRoot, { recursive: true });
            await symlink(outsideRoot, targetRoot, "dir");
            throw new Error("simulated state failure");
          },
        },
      );

      expect(result.operations[0]).toMatchObject({
        status: "failed",
        failure: {
          phase: "parent",
          message: expect.stringContaining("escapes target root"),
        },
      });
      expect(await readlink(outsideTarget)).toBe(fixture.mapping.linkValue);
    });
  });

  it("refuses rollback when an in-root parent symlink changes physical targets", async () => {
    await useFixture(async (root) => {
      const sourcePath = join(root, "source", "review", "SKILL.md");
      const oldSource = join(root, "old-source", "review", "SKILL.md");
      const targetRoot = join(root, "target");
      const firstParent = join(targetRoot, "a");
      const secondParent = join(targetRoot, "b");
      const logicalParent = join(targetRoot, "review");
      const targetPath = join(logicalParent, "SKILL.md");
      const firstTarget = join(firstParent, "SKILL.md");
      const secondTarget = join(secondParent, "SKILL.md");
      await mkdir(dirname(sourcePath), { recursive: true });
      await mkdir(dirname(oldSource), { recursive: true });
      await mkdir(firstParent, { recursive: true });
      await mkdir(secondParent, { recursive: true });
      await writeFile(sourcePath, "new source", "utf8");
      await writeFile(oldSource, "old source", "utf8");
      await symlink(firstParent, logicalParent, "dir");
      await symlink(oldSource, firstTarget, "file");
      await symlink(sourcePath, secondTarget, "file");
      const mapping: PlannedFile = {
        skillName: "review",
        sourcePath,
        targetPath,
        linkValue: sourcePath,
        attributions: [CLAUDE],
      };
      const priorEntry = {
        ...stateEntry(mapping, oldSource),
        sourcePath: oldSource,
      };
      const loaded = loadedState(root, [priorEntry]);
      const input = resolution(targetRoot, [mapping]);
      const plan = await buildSyncPlan(input, loaded);
      expect(plan.operations[0]?.kind).toBe("update");

      const result = await applySyncPlan(plan, input, loaded, root, {
        persistState: async () => {
          await rm(logicalParent);
          await symlink(secondParent, logicalParent, "dir");
          throw new Error("simulated state failure");
        },
      });

      expect(result.operations[0]).toMatchObject({
        status: "failed",
        failure: {
          phase: "parent",
          message: expect.stringContaining("Physical target changed"),
        },
      });
      expect(await readlink(firstTarget)).toBe(sourcePath);
      expect(await readlink(secondTarget)).toBe(sourcePath);
    });
  });

  it("retains old ownership when update fails before removal", async () => {
    await useFixture(async (root) => {
      const fixture = await updateFixture(root);
      const unlinkFailure = new Error("unlink denied");

      const result = await applySyncPlan(
        fixture.plan,
        fixture.resolution,
        fixture.loaded,
        root,
        {
          filesystem: {
            unlink: async () => {
              throw unlinkFailure;
            },
          },
        },
      );

      expect(result.operations[0]).toMatchObject({
        status: "failed",
        targetLinkMutated: false,
      });
      expect(await readlink(fixture.mapping.targetPath)).toBe(
        fixture.priorEntry.linkValue,
      );
      expect(result.nextState.entries).toEqual([fixture.priorEntry]);
    });
  });

  it("drops old ownership when update fails after removal", async () => {
    await useFixture(async (root) => {
      const fixture = await updateFixture(root);
      const linkFailure = new Error("link denied");

      const result = await applySyncPlan(
        fixture.plan,
        fixture.resolution,
        fixture.loaded,
        root,
        {
          filesystem: {
            symlink: async () => {
              throw linkFailure;
            },
          },
        },
      );

      expect(result.operations[0]).toMatchObject({
        status: "failed",
        targetLinkMutated: true,
      });
      await expect(lstat(fixture.mapping.targetPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(result.nextState.entries).toEqual([]);
    });
  });

  it("does not overwrite a managed link changed after planning", async () => {
    await useFixture(async (root) => {
      const fixture = await updateFixture(root);
      await rm(fixture.mapping.targetPath);
      await symlink("raced-link", fixture.mapping.targetPath, "file");

      const result = await applySyncPlan(
        fixture.plan,
        fixture.resolution,
        fixture.loaded,
        root,
      );

      expect(result.operations[0]).toMatchObject({
        status: "failed",
        targetLinkMutated: false,
        failure: { message: expect.stringContaining("ownership changed") },
      });
      expect(await readlink(fixture.mapping.targetPath)).toBe("raced-link");
      expect(result.nextState.entries).toEqual([]);
    });
  });

  it("checks update ownership before a raced-away parent and never recreates it", async () => {
    await useFixture(async (root) => {
      const fixture = await updateFixture(root);
      const mkdirTarget = vi.fn(async () => undefined);
      let removedParent = false;

      const result = await applySyncPlan(
        fixture.plan,
        fixture.resolution,
        fixture.loaded,
        root,
        {
          filesystem: {
            readlink: async (path) => {
              const value = await readlink(path);
              if (!removedParent && path === fixture.mapping.targetPath) {
                removedParent = true;
                await rm(fixture.mapping.targetPath);
                await rm(dirname(fixture.mapping.targetPath), {
                  recursive: true,
                });
              }
              return value;
            },
            mkdir: mkdirTarget,
          },
        },
      );

      expect(result.operations[0]).toMatchObject({
        status: "failed",
        targetLinkMutated: false,
        failure: { phase: "parent" },
      });
      expect(mkdirTarget).not.toHaveBeenCalled();
      await expect(lstat(dirname(fixture.mapping.targetPath))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("reserves physical targets against a safe-parent update alias race", async () => {
    await useFixture(async (root) => {
      const fixture = await aliasUpdateFixture(root);
      const unlinkPaths: string[] = [];

      const result = await applySyncPlan(
        fixture.plan,
        fixture.resolution,
        fixture.loaded,
        root,
        {
          filesystem: {
            unlink: async (path) => {
              unlinkPaths.push(path);
              await rm(path);
            },
          },
        },
      );

      expect(result.operations.map((operation) => operation.status)).toEqual([
        "updated",
        "failed",
      ]);
      expect(result.operations[1]?.failure).toMatchObject({
        phase: "parent",
        message: expect.stringContaining("aliases reserved physical target"),
      });
      expect(unlinkPaths).toEqual([fixture.alpha.targetPath]);
      expect(await readlink(fixture.alpha.targetPath)).toBe(
        fixture.alpha.linkValue,
      );
      expect(await readlink(fixture.beta.targetPath)).toBe(
        fixture.alpha.linkValue,
      );
    });
  });

  it("uses the Windows file-link type and returns Developer Mode guidance", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      const loaded = loadedState(root, []);
      const input = resolution(fixture.targetRoot, [fixture.mapping]);
      const plan = await buildSyncPlan(input, loaded);
      const calls: unknown[][] = [];

      const result = await applySyncPlan(plan, input, loaded, root, {
        platform: "win32",
        filesystem: {
          symlink: async (...args) => {
            calls.push(args);
            throw Object.assign(new Error("privilege unavailable"), {
              code: "EPERM",
            });
          },
        },
      });

      expect(calls).toEqual([
        [fixture.mapping.linkValue, fixture.targetPath, "file"],
      ]);
      expect(result.failures[0]).toMatchObject({
        phase: "target",
        correction: expect.stringContaining("Developer Mode"),
      });
      await expect(lstat(fixture.targetPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});

describe("applySyncPlan state merging", () => {
  it("drops only the selected attribution for a shared stale target", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      await createTargetLink(fixture.mapping, fixture.mapping.linkValue);
      const shared = {
        ...stateEntry(fixture.mapping, fixture.mapping.linkValue),
        attributions: [CLAUDE, OPENCODE],
      };
      const loaded = loadedState(root, [shared]);
      const input = emptyResolution();
      const plan = await buildSyncPlan(input, loaded, {
        harnessId: "claude-code",
      });

      const result = await applySyncPlan(plan, input, loaded, root, {
        harnessId: "claude-code",
      });

      expect(result.operations[0]?.status).toBe("stale");
      expect(result.operations[0]?.targetLinkMutated).toBe(false);
      expect(result.nextState.entries).toEqual([
        { ...shared, attributions: [OPENCODE] },
      ]);
      expect(await readlink(fixture.targetPath)).toBe(fixture.mapping.linkValue);
    });
  });

  it("removes an exact stale link and its ownership", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      await createTargetLink(fixture.mapping, fixture.mapping.linkValue);
      const entry = stateEntry(fixture.mapping, fixture.mapping.linkValue);
      const loaded = {
        ...loadedState(root, [entry]),
        directories: [fixture.targetRoot, dirname(fixture.targetPath)],
      };
      const input = emptyResolution();
      const plan = await buildSyncPlan(input, loaded);

      const result = await applySyncPlan(plan, input, loaded, root);

      expect(result.operations[0]).toMatchObject({
        status: "stale",
        targetLinkMutated: true,
      });
      expect(result.nextState.entries).toEqual([]);
      await expect(lstat(fixture.targetPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(dirname(fixture.targetPath))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("retains stale ownership when link removal fails", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      await createTargetLink(fixture.mapping, fixture.mapping.linkValue);
      const entry = stateEntry(fixture.mapping, fixture.mapping.linkValue);
      const loaded = {
        ...loadedState(root, [entry]),
        directories: [fixture.targetRoot, dirname(fixture.targetPath)],
      };
      const input = emptyResolution();
      const plan = await buildSyncPlan(input, loaded);

      const result = await applySyncPlan(plan, input, loaded, root, {
        filesystem: {
          unlink: async () => {
            throw new Error("unlink denied");
          },
        },
      });

      expect(result.operations[0]).toMatchObject({
        status: "failed",
        targetLinkMutated: false,
      });
      expect(result.nextState.entries).toEqual([entry]);
      expect(await readlink(fixture.targetPath)).toBe(fixture.mapping.linkValue);
    });
  });

  it("restores a removed stale link when state persistence fails", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      await createTargetLink(fixture.mapping, fixture.mapping.linkValue);
      const entry = stateEntry(fixture.mapping, fixture.mapping.linkValue);
      const loaded = {
        ...loadedState(root, [entry]),
        directories: [fixture.targetRoot, dirname(fixture.targetPath)],
      };
      const input = emptyResolution();
      const plan = await buildSyncPlan(input, loaded);

      const result = await applySyncPlan(plan, input, loaded, root, {
        persistState: async () => {
          throw new Error("state write denied");
        },
      });

      expect(result.operations[0]).toMatchObject({
        status: "failed",
        targetLinkMutated: true,
      });
      expect(result.nextState.entries).toEqual([entry]);
      expect(await readlink(fixture.targetPath)).toBe(fixture.mapping.linkValue);
    });
  });

  it("drops only selected attribution for a missing undesired target", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      const shared = {
        ...stateEntry(fixture.mapping, fixture.mapping.linkValue),
        attributions: [CLAUDE, OPENCODE],
      };
      const loaded = loadedState(root, [shared]);
      const input = emptyResolution();
      const plan = await buildSyncPlan(input, loaded, {
        harnessId: "claude-code",
      });

      const result = await applySyncPlan(plan, input, loaded, root, {
        harnessId: "claude-code",
      });

      expect(result.operations).toEqual([]);
      expect(result.nextState.entries).toEqual([
        { ...shared, attributions: [OPENCODE] },
      ]);
    });
  });

  it("preserves untouched attribution when selected recreation fails missing", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      const shared = {
        ...stateEntry(fixture.mapping, fixture.mapping.linkValue),
        attributions: [CLAUDE, OPENCODE],
      };
      const loaded = loadedState(root, [shared]);
      const input = resolution(fixture.targetRoot, [fixture.mapping]);
      const plan = await buildSyncPlan(input, loaded, {
        harnessId: "claude-code",
      });

      const result = await applySyncPlan(plan, input, loaded, root, {
        harnessId: "claude-code",
        filesystem: {
          symlink: async () => {
            throw new Error("simulated link failure");
          },
        },
      });

      expect(result.operations[0]).toMatchObject({
        status: "failed",
        targetLinkMutated: false,
      });
      expect(result.nextState.entries).toEqual([
        { ...shared, attributions: [OPENCODE] },
      ]);
    });
  });

  it.each(["regular file", "changed symlink"] as const)(
    "preserves only untouched attribution after a filtered %s race",
    async (replacement) => {
      await useFixture(async (root) => {
        const fixture = await mappingFixture(root);
        await createTargetLink(fixture.mapping, fixture.mapping.linkValue);
        const shared = {
          ...stateEntry(fixture.mapping, fixture.mapping.linkValue),
          attributions: [CLAUDE, OPENCODE],
        };
        const loaded = loadedState(root, [shared]);
        const input = resolution(fixture.targetRoot, [fixture.mapping]);
        const plan = await buildSyncPlan(input, loaded, {
          harnessId: "claude-code",
        });
        await rm(fixture.targetPath);
        if (replacement === "regular file") {
          await writeFile(fixture.targetPath, "raced file", "utf8");
        } else {
          await symlink("changed-link", fixture.targetPath, "file");
        }

        const result = await applySyncPlan(plan, input, loaded, root, {
          harnessId: "claude-code",
        });

        expect(result.operations[0]).toMatchObject({
          status: "failed",
          targetLinkMutated: false,
        });
        expect(result.nextState.entries).toEqual([
          { ...shared, attributions: [OPENCODE] },
        ]);
      });
    },
  );

  it("retains every operation attribution in a shared apply failure", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      const sharedMapping = {
        ...fixture.mapping,
        attributions: [CLAUDE, OPENCODE],
      };
      const loaded = loadedState(root, []);
      const input = resolution(fixture.targetRoot, [sharedMapping]);
      const plan = await buildSyncPlan(input, loaded);
      await mkdir(dirname(fixture.targetPath), { recursive: true });
      await writeFile(fixture.targetPath, "raced file", "utf8");

      const result = await applySyncPlan(plan, input, loaded, root);

      expect(result.failures[0]?.attributions).toEqual([CLAUDE, OPENCODE]);
    });
  });

  it("replaces selected attribution and preserves other shared ownership", async () => {
    await useFixture(async (root) => {
      const updatedAttribution = {
        harnessId: "claude-code",
        placementId: "custom-project",
      };
      const fixture = await mappingFixture(root, "review", updatedAttribution);
      await createTargetLink(fixture.mapping, fixture.mapping.linkValue);
      const prior = {
        ...stateEntry(fixture.mapping, fixture.mapping.linkValue),
        attributions: [CLAUDE, OPENCODE],
      };
      const loaded = loadedState(root, [prior]);
      const input = resolution(fixture.targetRoot, [fixture.mapping]);
      const plan = await buildSyncPlan(input, loaded, {
        harnessId: "claude-code",
      });

      const result = await applySyncPlan(plan, input, loaded, root, {
        harnessId: "claude-code",
      });

      expect(result.operations[0]?.status).toBe("skipped");
      expect(result.nextState.entries[0]?.attributions).toEqual([
        updatedAttribution,
        OPENCODE,
      ]);
    });
  });

  it("reports state persistence failure without claiming ownership was recorded", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      const loaded = loadedState(root, []);
      const input = resolution(fixture.targetRoot, [fixture.mapping]);
      const plan = await buildSyncPlan(input, loaded);
      await writeFile(join(root, ".distributor"), "blocks state", "utf8");

      const result = await applySyncPlan(plan, input, loaded, root);

      expect(result).toMatchObject({
        statePersisted: false,
        stateWritten: false,
        operations: [{ status: "created" }],
        failures: [
          expect.objectContaining({
            phase: "state",
            path: statePathForProject(root),
          }),
        ],
      });
      expect(await readlink(fixture.targetPath)).toBe(fixture.mapping.linkValue);
      expect(await readFile(join(root, ".distributor"), "utf8")).toBe(
        "blocks state",
      );
    });
  });

  it("does not report adoption when its state persistence fails", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      await createTargetLink(fixture.mapping, fixture.sourcePath);
      const loaded = loadedState(root, []);
      const input = resolution(fixture.targetRoot, [fixture.mapping]);
      const plan = await buildSyncPlan(input, loaded);
      await writeFile(join(root, ".distributor"), "blocks state", "utf8");

      const result = await applySyncPlan(plan, input, loaded, root);

      expect(result).toMatchObject({
        statePersisted: false,
        stateWritten: false,
        operations: [
          {
            status: "failed",
            targetLinkMutated: false,
            failure: {
              phase: "state",
              operation: "adopt",
              attributions: [CLAUDE],
            },
          },
        ],
      });
      expect(await readlink(fixture.targetPath)).toBe(fixture.sourcePath);
    });
  });

  it("refuses a non-applicable plan before any apply or state write", async () => {
    await useFixture(async (root) => {
      const fixture = await mappingFixture(root);
      await mkdir(dirname(fixture.targetPath), { recursive: true });
      await writeFile(fixture.targetPath, "unmanaged", "utf8");
      const loaded = loadedState(root, []);
      const input = resolution(fixture.targetRoot, [fixture.mapping]);
      const plan = await buildSyncPlan(input, loaded);

      await expect(
        applySyncPlan(plan, input, loaded, root),
      ).rejects.toBeInstanceOf(DistributorError);
      expect(await readFile(fixture.targetPath, "utf8")).toBe("unmanaged");
      await expect(lstat(join(root, ".distributor"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});

interface MappingFixture {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly targetRoot: string;
  readonly mapping: PlannedFile;
}

async function mappingFixture(
  root: string,
  skillName = "review",
  attribution: OwnershipAttribution = CLAUDE,
): Promise<MappingFixture> {
  const sourcePath = join(root, "source", skillName, "SKILL.md");
  const targetRoot = join(root, "target");
  const targetPath = join(targetRoot, skillName, "SKILL.md");
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, `${skillName} source`, "utf8");
  const mapping: PlannedFile = {
    skillName,
    sourcePath,
    targetPath,
    linkValue: relative(dirname(targetPath), sourcePath),
    attributions: [attribution],
  };
  return { sourcePath, targetPath, targetRoot, mapping };
}

async function updateFixture(root: string): Promise<{
  readonly mapping: PlannedFile;
  readonly priorEntry: ManagedStateEntry;
  readonly loaded: LoadedManagedState;
  readonly resolution: PlacementResolution;
  readonly plan: Awaited<ReturnType<typeof buildSyncPlan>>;
}> {
  const fixture = await mappingFixture(root);
  const oldSource = join(root, "old-source", "review", "SKILL.md");
  await mkdir(dirname(oldSource), { recursive: true });
  await writeFile(oldSource, "old source", "utf8");
  const oldLink = relative(dirname(fixture.targetPath), oldSource);
  await createTargetLink(fixture.mapping, oldLink);
  const priorEntry = {
    ...stateEntry(fixture.mapping, oldLink),
    sourcePath: oldSource,
  };
  const loaded = loadedState(root, [priorEntry]);
  const input = resolution(fixture.targetRoot, [fixture.mapping]);
  const plan = await buildSyncPlan(input, loaded);
  return {
    mapping: fixture.mapping,
    priorEntry,
    loaded,
    resolution: input,
    plan,
  };
}

async function aliasUpdateFixture(root: string): Promise<{
  readonly alpha: PlannedFile;
  readonly beta: PlannedFile;
  readonly loaded: LoadedManagedState;
  readonly resolution: PlacementResolution;
  readonly plan: Awaited<ReturnType<typeof buildSyncPlan>>;
}> {
  const sourcePath = join(root, "source", "shared", "SKILL.md");
  const targetRoot = join(root, "target");
  const alphaTarget = join(targetRoot, "alpha", "SKILL.md");
  const betaTarget = join(targetRoot, "beta", "SKILL.md");
  const desiredLink = relative(dirname(alphaTarget), sourcePath);
  const alpha: PlannedFile = {
    skillName: "alpha",
    sourcePath,
    targetPath: alphaTarget,
    linkValue: desiredLink,
    attributions: [CLAUDE],
  };
  const beta: PlannedFile = {
    skillName: "beta",
    sourcePath,
    targetPath: betaTarget,
    linkValue: desiredLink,
    attributions: [CLAUDE],
  };
  const oldAlphaSource = join(root, "old", "alpha", "SKILL.md");
  const oldBetaSource = join(root, "old", "beta", "SKILL.md");
  await mkdir(dirname(sourcePath), { recursive: true });
  await mkdir(dirname(oldAlphaSource), { recursive: true });
  await mkdir(dirname(oldBetaSource), { recursive: true });
  await writeFile(sourcePath, "new source", "utf8");
  await writeFile(oldAlphaSource, "old alpha", "utf8");
  await writeFile(oldBetaSource, "old beta", "utf8");
  const oldAlphaLink = relative(dirname(alphaTarget), oldAlphaSource);
  await createTargetLink(alpha, oldAlphaLink);
  await createTargetLink(beta, desiredLink);
  const loaded = loadedState(root, [
    {
      ...stateEntry(alpha, oldAlphaLink),
      sourcePath: oldAlphaSource,
    },
    {
      ...stateEntry(beta, desiredLink),
      sourcePath: oldBetaSource,
    },
  ]);
  const input = resolution(targetRoot, [alpha, beta]);
  const plan = await buildSyncPlan(input, loaded);
  await rm(betaTarget);
  await rm(dirname(betaTarget), { recursive: true });
  await symlink(dirname(alphaTarget), dirname(betaTarget), "dir");

  return { alpha, beta, loaded, resolution: input, plan };
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
  const placement = getAvailableAdapterConfig("claude-code")?.placements.find(
    (candidate) => candidate.id === "project",
  );
  if (placement === undefined) {
    throw new Error("Missing Claude Code placement fixture.");
  }
  return { ...placement, createIfMissing };
}

function loadedState(
  root: string,
  entries: readonly ManagedStateEntry[],
  options: { readonly exists?: boolean; readonly originalText?: string } = {},
): LoadedManagedState {
  return {
    version: 1,
    entries,
    path: statePathForProject(root),
    exists: options.exists ?? false,
    originalText: options.originalText,
    warnings: [],
  };
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
