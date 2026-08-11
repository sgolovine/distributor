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
        harnesses: [
          {
            harnessId: "claude-code",
            storagePaths: [join(root, ".claude", "skills")],
            references: 2,
          },
          {
            harnessId: "codex",
            storagePaths: [join(root, ".agents", "skills")],
            references: 2,
          },
        ],
        skillStatuses: [
          {
            name: "alpha",
            sourcePath: join(root, ".agents", "skills", "alpha"),
            harnesses: [
              { harnessId: "claude-code", status: "needs sync" },
              { harnessId: "codex", status: "configured" },
            ],
          },
          {
            name: "beta",
            sourcePath: join(root, ".agents", "skills", "beta"),
            harnesses: [
              { harnessId: "claude-code", status: "needs sync" },
              { harnessId: "codex", status: "configured" },
            ],
          },
        ],
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
        skillStatuses: [
          {
            name: "alpha",
            harnesses: [
              { harnessId: "claude-code", status: "configured" },
              { harnessId: "codex", status: "configured" },
            ],
          },
          {
            name: "beta",
            harnesses: [
              { harnessId: "claude-code", status: "configured" },
              { harnessId: "codex", status: "configured" },
            ],
          },
        ],
        upToDate: true,
      });
    });
  });

  it("reports reference counts for each configured harness", async () => {
    await useFixture(async (root) => {
      await writeFile(
        join(root, "distributor.config.json"),
        JSON.stringify({
          source: ".agents/skills",
          harnesses: [
            {
              name: "claude-code",
              useHarnessFolder: true,
              targets: [{ placement: "project" }, { placement: "user" }],
            },
            { name: "codex", useHarnessFolder: true },
          ],
        }),
        "utf8",
      );
      await writeSkill(root, "alpha");
      await writeSkill(root, "beta");

      await expect(
        runStatus({ cwd: root, homeDirectory: join(root, "home") }),
      ).resolves.toMatchObject({
        skills: 2,
        references: 6,
        harnesses: [
          { harnessId: "claude-code", references: 4 },
          { harnessId: "codex", references: 2 },
        ],
      });
    });
  });

  it("warns about every invalid skill while reporting valid skills", async () => {
    await useFixture(async (root) => {
      await writeConfig(root);
      await writeSkill(root, "alpha");
      await writeInvalidSkill(root, "missing-frontmatter", "No frontmatter");
      await writeInvalidSkill(
        root,
        "missing-description",
        "---\nname: missing-description\n---\n",
      );

      const result = await runStatus({ cwd: root });

      expect(result).toMatchObject({
        exitCode: 0,
        skills: 1,
        references: 2,
      });
      expect(result.skillStatuses.map((skill) => skill.name)).toEqual([
        "alpha",
      ]);
      expect(result.warnings).toEqual([
        expect.objectContaining({
          code: "invalid-skill",
          path: join(root, ".agents", "skills", "missing-description"),
          message: expect.stringContaining("Skipped invalid skill"),
        }),
        expect.objectContaining({
          code: "invalid-skill",
          path: join(root, ".agents", "skills", "missing-frontmatter"),
          message: expect.stringContaining("Skipped invalid skill"),
        }),
      ]);
    });
  });

  it("reports a changed managed link as out of date without failing", async () => {
    await useFixture(async (root) => {
      await writeConfig(root);
      await writeSkill(root, "alpha");
      await runSync({ cwd: root });
      const target = join(root, ".claude", "skills", "alpha");
      await rm(target);
      await symlink("changed-after-sync", target, "dir");

      await expect(runStatus({ cwd: root })).resolves.toMatchObject({
        exitCode: 0,
        skills: 1,
        references: 2,
        skillStatuses: [
          {
            name: "alpha",
            harnesses: [
              { harnessId: "claude-code", status: "conflict" },
              { harnessId: "codex", status: "configured" },
            ],
          },
        ],
        upToDate: false,
      });
    });
  });
});

async function writeConfig(root: string): Promise<void> {
  await writeFile(
    join(root, "distributor.config.json"),
    '{"source":".agents/skills","harnesses":[{"name":"codex","useHarnessFolder":true},{"name":"claude-code","useHarnessFolder":true}]}\n',
    "utf8",
  );
}

async function writeSkill(root: string, name: string): Promise<void> {
  await writeInvalidSkill(
    root,
    name,
    `---
name: ${name}
description: ${name} skill.
---
`,
  );
}

async function writeInvalidSkill(
  root: string,
  name: string,
  contents: string,
): Promise<void> {
  const skillPath = join(root, ".agents", "skills", name, "SKILL.md");
  await mkdir(dirname(skillPath), { recursive: true });
  await writeFile(skillPath, contents, "utf8");
}
