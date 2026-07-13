import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  discoverConfig,
  findGitWorktreeRoot,
} from "../../src/config/discover.js";
import { DistributorError } from "../../src/errors.js";
import { useFixture } from "../helpers/fixture.js";

describe("config discovery", () => {
  it("selects the nearest supported config", async () => {
    await useFixture(async (root) => {
      const nested = join(root, "packages", "app", "src");
      await mkdir(nested, { recursive: true });
      await writeFile(join(root, "distributor.config.json"), "{}", "utf8");
      await writeFile(
        join(root, "packages", "app", "distributor.config.ts"),
        "export default {};",
        "utf8",
      );

      await expect(discoverConfig(nested)).resolves.toMatchObject({
        configPath: join(root, "packages", "app", "distributor.config.ts"),
        projectRoot: join(root, "packages", "app"),
      });
    });
  });

  it.each(["directory", "file"] as const)(
    "treats a .git %s as the inclusive worktree boundary",
    async (markerType) => {
      await useFixture(async (root) => {
        const worktree = join(root, "worktree");
        const nested = join(worktree, "nested");
        await mkdir(nested, { recursive: true });
        await writeFile(join(root, "distributor.config.json"), "{}", "utf8");
        if (markerType === "directory") {
          await mkdir(join(worktree, ".git"));
        } else {
          await writeFile(join(worktree, ".git"), "gitdir: elsewhere\n", "utf8");
        }

        await expect(findGitWorktreeRoot(nested)).resolves.toBe(worktree);
        await expect(discoverConfig(nested)).rejects.toMatchObject({
          category: "config",
          exitCode: 2,
          context: { boundary: worktree },
        });
      });
    },
  );

  it("reports every same-directory conflict", async () => {
    await useFixture(async (root) => {
      await writeFile(join(root, "distributor.config.json"), "{}", "utf8");
      await writeFile(join(root, "distributor.config.js"), "export default {};", "utf8");

      try {
        await discoverConfig(root);
        expect.fail("Expected discovery to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(DistributorError);
        expect((error as Error).message).toContain("distributor.config.json");
        expect((error as Error).message).toContain("distributor.config.js");
      }
    });
  });

  it("ignores package and rc configuration names", async () => {
    await useFixture(async (root) => {
      await writeFile(join(root, "package.json"), '{"distributor":{}}', "utf8");
      await writeFile(join(root, ".distributorrc"), "{}", "utf8");

      await expect(discoverConfig(root)).rejects.toMatchObject({
        category: "config",
        exitCode: 2,
      });
    });
  });

  it("rejects a non-file at a supported config path without loading it", async () => {
    await useFixture(async (root) => {
      await mkdir(join(root, "distributor.config.json"));

      await expect(discoverConfig(root)).rejects.toMatchObject({
        category: "config",
        exitCode: 2,
        correction: expect.stringContaining("regular"),
      });
    });
  });
});
