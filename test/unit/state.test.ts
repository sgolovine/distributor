import { mkdir, readlink, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { DistributorError } from "../../src/errors.js";
import {
  evaluateManagedState,
  loadManagedState,
  serializeManagedState,
  statePathForProject,
  type ManagedState,
} from "../../src/sync/state.js";
import { useFixture } from "../helpers/fixture.js";

function stateFixture(root: string): ManagedState {
  return {
    version: 1,
    entries: [
      {
        sourcePath: join(root, ".agents", "skills", "review", "SKILL.md"),
        targetPath: join(root, ".claude", "skills", "review", "SKILL.md"),
        linkValue: "../../../.agents/skills/review/SKILL.md",
        attributions: [{ harnessId: "claude-code", placementId: "project" }],
      },
    ],
  };
}

describe("managed state", () => {
  it("uses only the canonical project-local state path", async () => {
    await useFixture(async (root) => {
      const loaded = await loadManagedState(root);

      expect(loaded.exists).toBe(false);
      expect(loaded.path).toBe(join(root, ".distributor", "state.json"));
      expect(statePathForProject(root)).toBe(loaded.path);
      expect(loaded.entries).toEqual([]);
    });
  });

  it("serializes deterministically with project-relative paths and a newline", async () => {
    await useFixture(async (root) => {
      const state = stateFixture(root);
      const text = serializeManagedState(state, root);

      expect(text.endsWith("\n")).toBe(true);
      expect(text).toContain('"sourcePath": ".agents/skills/review/SKILL.md"');
      expect(text).toContain('"targetPath": ".claude/skills/review/SKILL.md"');
      expect(serializeManagedState(state, root)).toBe(text);

      const path = statePathForProject(root);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, "utf8");
      await expect(loadManagedState(root)).resolves.toMatchObject({
        exists: true,
        entries: state.entries,
      });
    });
  });

  it("keeps external paths absolute", async () => {
    await useFixture(async (root) => {
      const externalSource = join(dirname(root), "external", "SKILL.md");
      const state: ManagedState = {
        version: 1,
        entries: [
          {
            sourcePath: externalSource,
            targetPath: join(root, "target", "SKILL.md"),
            linkValue: externalSource,
            attributions: [{ harnessId: "claude-code", placementId: "project" }],
          },
        ],
      };

      expect(serializeManagedState(state, root)).toContain(externalSource);
    });
  });

  it.each([
    ["invalid JSON", "{"],
    ["unknown version", JSON.stringify({ version: 2, entries: [] })],
    ["unknown field", JSON.stringify({ version: 1, entries: [], extra: true })],
  ])("rejects %s without repairing it", async (_label, contents) => {
    await useFixture(async (root) => {
      const path = statePathForProject(root);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents, "utf8");

      await expect(loadManagedState(root)).rejects.toMatchObject({
        category: "state",
        exitCode: 1,
      });
    });
  });

  it("rejects duplicate normalized targets and attributions", async () => {
    await useFixture(async (root) => {
      const path = statePathForProject(root);
      const attribution = { harnessId: "claude-code", placementId: "project" };
      const entry = {
        sourcePath: ".agents/skills/review/SKILL.md",
        targetPath: ".claude/skills/review/SKILL.md",
        linkValue: "source",
        attributions: [attribution, attribution],
      };
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({ version: 1, entries: [entry, entry] }),
        "utf8",
      );

      try {
        await loadManagedState(root);
        expect.fail("Expected state validation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(DistributorError);
        expect((error as DistributorError).issues).toHaveLength(3);
      }
    });
  });

  it("recognizes exact raw links, including unchanged broken links", async () => {
    await useFixture(async (root) => {
      const state = stateFixture(root);
      const entry = state.entries[0]!;
      await mkdir(dirname(entry.targetPath), { recursive: true });
      await symlink(entry.linkValue, entry.targetPath, "file");

      expect(await readlink(entry.targetPath)).toBe(entry.linkValue);
      await expect(evaluateManagedState(state)).resolves.toMatchObject({
        evaluated: [{ status: "owned", currentLinkValue: entry.linkValue }],
      });
    });
  });

  it("classifies missing, replaced, and changed recorded targets", async () => {
    await useFixture(async (root) => {
      const state = stateFixture(root);
      const entry = state.entries[0]!;

      await expect(evaluateManagedState(state)).resolves.toMatchObject({
        evaluated: [{ status: "missing" }],
      });

      await mkdir(dirname(entry.targetPath), { recursive: true });
      await writeFile(entry.targetPath, "unmanaged", "utf8");
      await expect(evaluateManagedState(state)).resolves.toMatchObject({
        evaluated: [{ status: "conflict" }],
      });
    });
  });

  it("evaluates only selected-harness entries and preserves other entries", async () => {
    await useFixture(async (root) => {
      const first = stateFixture(root).entries[0]!;
      const second = {
        ...first,
        targetPath: join(root, ".other", "skills", "review", "SKILL.md"),
        attributions: [{ harnessId: "opencode", placementId: "project" }],
      };
      const state: ManagedState = { version: 1, entries: [first, second] };

      const evaluation = await evaluateManagedState(state, "claude-code");
      expect(evaluation.evaluated.map((item) => item.entry)).toEqual([first]);
      expect(evaluation.untouched).toEqual([second]);
    });
  });

  it("rejects noncanonical absolute paths inside the project", async () => {
    await useFixture(async (root) => {
      const path = statePathForProject(root);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          entries: [
            {
              sourcePath: join(root, "source", "SKILL.md"),
              targetPath: "target/SKILL.md",
              linkValue: relative(join(root, "target"), join(root, "source", "SKILL.md")),
              attributions: [{ harnessId: "claude-code", placementId: "project" }],
            },
          ],
        }),
        "utf8",
      );

      await expect(loadManagedState(root)).rejects.toMatchObject({
        category: "state",
      });
    });
  });
});
