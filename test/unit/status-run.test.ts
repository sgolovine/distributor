import { lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { runStatus } from "../../src/status/run-status.js";
import { runSync } from "../../src/sync/run-sync.js";
import { statePathForProject } from "../../src/sync/state.js";
import { useFixture } from "../helpers/fixture.js";

describe("status", () => {
  it("counts skill-to-placement references and detects pending sync work", async () => {
    await useFixture(async (root) => {
      await writeConfig(root);
      await writeSkill(root, "alpha");
      await writeSkill(root, "beta");

      const beforeSync = await runStatus({ cwd: root });

      expect(beforeSync).toMatchObject({
        exitCode: 0,
        skills: 2,
        references: 4,
        upToDate: false,
      });
      await expect(lstat(statePathForProject(root))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        lstat(join(root, ".claude", "skills", "alpha", "SKILL.md")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      await runSync({ cwd: root });

      await expect(runStatus({ cwd: root })).resolves.toMatchObject({
        exitCode: 0,
        skills: 2,
        references: 4,
        upToDate: true,
      });
    });
  });

  it("reports a changed managed link as out of date without failing", async () => {
    await useFixture(async (root) => {
      await writeConfig(root);
      await writeSkill(root, "alpha");
      await runSync({ cwd: root });
      const target = join(
        root,
        ".claude",
        "skills",
        "alpha",
        "SKILL.md",
      );
      await rm(target);
      await symlink("changed-after-sync", target, "file");

      await expect(runStatus({ cwd: root })).resolves.toMatchObject({
        exitCode: 0,
        skills: 1,
        references: 2,
        upToDate: false,
      });
    });
  });
});

async function writeConfig(root: string): Promise<void> {
  await writeFile(
    join(root, "distributor.config.json"),
    '{"source":".agents/skills","harnesses":["codex","claude-code"]}\n',
    "utf8",
  );
}

async function writeSkill(root: string, name: string): Promise<void> {
  const skillPath = join(root, ".agents", "skills", name, "SKILL.md");
  await mkdir(dirname(skillPath), { recursive: true });
  await writeFile(
    skillPath,
    `---
name: ${name}
description: ${name} skill.
---
`,
    "utf8",
  );
}
