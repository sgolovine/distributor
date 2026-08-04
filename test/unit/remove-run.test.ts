import { lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { runRemove } from "../../src/remove/run-remove.js";
import {
  loadManagedState,
  persistManagedState,
  type ManagedState,
} from "../../src/sync/state.js";
import { useFixture } from "../helpers/fixture.js";

describe("runRemove", () => {
  it("removes exact managed links, clears missing entries, and empties state", async () => {
    await useFixture(async (root) => {
      await writeConfig(root);
      const exactTarget = join(root, ".claude", "skills", "review", "SKILL.md");
      const missingTarget = join(root, ".cline", "skills", "review", "SKILL.md");
      await mkdir(dirname(exactTarget), { recursive: true });
      await symlink("../../../../skills/review/SKILL.md", exactTarget, "file");
      await writeState(root, [
        entry(root, exactTarget, "../../../../skills/review/SKILL.md"),
        entry(root, missingTarget, "../../../../skills/review/SKILL.md"),
      ]);

      const result = await runRemove({ cwd: root });

      expect(result).toMatchObject({
        exitCode: 0,
        counts: { removed: 1, missing: 1, failed: 0 },
        stateWritten: true,
      });
      await expect(lstat(exactTarget)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await lstat(dirname(exactTarget))).isDirectory()).toBe(true);
      expect((await loadManagedState(root)).entries).toEqual([]);
    });
  });

  it("preserves changed targets and their ownership records", async () => {
    await useFixture(async (root) => {
      await writeConfig(root);
      const target = join(root, ".claude", "skills", "review", "SKILL.md");
      await mkdir(dirname(target), { recursive: true });
      await symlink("changed-source", target, "file");
      await writeState(root, [entry(root, target, "expected-source")]);

      const result = await runRemove({ cwd: root });

      expect(result).toMatchObject({
        exitCode: 1,
        counts: { removed: 0, missing: 0, failed: 1 },
      });
      expect(await readlink(target)).toBe("changed-source");
      expect((await loadManagedState(root)).entries).toHaveLength(1);
    });
  });

  it("removes created directories from the deepest path upward", async () => {
    await useFixture(async (root) => {
      await writeConfig(root);
      const targetRoot = join(root, ".claude", "skills");
      const skillDirectory = join(targetRoot, "review");
      const target = join(skillDirectory, "SKILL.md");
      await mkdir(skillDirectory, { recursive: true });
      await symlink("../../../../skills/review/SKILL.md", target, "file");
      await writeState(
        root,
        [entry(root, target, "../../../../skills/review/SKILL.md")],
        [targetRoot, skillDirectory],
      );

      const result = await runRemove({ cwd: root });

      expect(result).toMatchObject({
        exitCode: 0,
        counts: { removed: 1, missing: 0, failed: 0 },
        directoryCounts: { removed: 2, missing: 0, failed: 0 },
      });
      await expect(lstat(targetRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await loadManagedState(root)).directories).toEqual([]);
    });
  });

  it("does not remove pre-existing directories that were not recorded", async () => {
    await useFixture(async (root) => {
      await writeConfig(root);
      const targetRoot = join(root, ".claude", "skills");
      const skillDirectory = join(targetRoot, "review");
      const target = join(skillDirectory, "SKILL.md");
      await mkdir(skillDirectory, { recursive: true });
      await symlink("../../../../skills/review/SKILL.md", target, "file");
      await writeState(
        root,
        [entry(root, target, "../../../../skills/review/SKILL.md")],
        [skillDirectory],
      );

      const result = await runRemove({ cwd: root });

      expect(result.exitCode).toBe(0);
      await expect(lstat(skillDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await lstat(targetRoot)).isDirectory()).toBe(true);
    });
  });

  it("retains a recorded directory when it contains an unmanaged file", async () => {
    await useFixture(async (root) => {
      await writeConfig(root);
      const directory = join(root, ".claude", "skills", "review");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "notes.txt"), "keep", "utf8");
      await writeState(root, [], [directory]);

      const result = await runRemove({ cwd: root });

      expect(result).toMatchObject({
        exitCode: 1,
        counts: { removed: 0, missing: 0, failed: 0 },
        directoryCounts: { removed: 0, missing: 0, failed: 1 },
      });
      expect((await lstat(directory)).isDirectory()).toBe(true);
      expect((await loadManagedState(root)).directories).toEqual([directory]);
    });
  });

  it("is a no-op when Distributor has no recorded links", async () => {
    await useFixture(async (root) => {
      await writeConfig(root);

      const result = await runRemove({ cwd: root });

      expect(result).toMatchObject({
        exitCode: 0,
        counts: { removed: 0, missing: 0, failed: 0 },
        stateWritten: false,
      });
    });
  });
});

async function writeConfig(root: string): Promise<void> {
  await writeFile(
    join(root, "distributor.config.json"),
    '{"harnesses":[{"name":"claude-code","useHarnessFolder":true}]}\n',
    "utf8",
  );
}

function entry(root: string, targetPath: string, linkValue: string) {
  return {
    sourcePath: join(root, "skills", "review", "SKILL.md"),
    targetPath,
    linkValue,
    attributions: [{ harnessId: "claude-code", placementId: "project" }],
  } as const;
}

async function writeState(
  root: string,
  entries: ManagedState["entries"],
  directories: readonly string[] = [],
): Promise<void> {
  const loaded = await loadManagedState(root);
  await persistManagedState(loaded, { version: 1, entries, directories }, root);
  expect(await readFile(loaded.path, "utf8")).toContain('"version": 1');
}
