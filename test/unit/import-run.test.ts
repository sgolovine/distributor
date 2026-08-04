import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  type ImportOfferPrompt,
  type ImportPrompt,
  runImport,
} from "../../src/import/run-import.js";
import type { InitPrompt } from "../../src/init/run-init.js";
import { useFixture } from "../helpers/fixture.js";

describe("runImport", () => {
  it("deduplicates harness roots and copies selected project and user skills", async () => {
    await useFixture(async (root) => {
      const home = join(root, "home");
      const sourceRoot = join(root, "canonical", "skills");
      await writeConfig(root, "canonical/skills");
      await writeSkill(join(root, ".claude", "skills"), "alpha", {
        "references/checklist.md": "check\n",
      });
      await writeSkill(join(home, ".agents", "skills"), "beta");
      await writeSkill(sourceRoot, "existing");
      await writeSkill(join(root, ".cursor", "skills"), "existing");

      const prompt = vi.fn<ImportPrompt>(async (context) => {
        expect(context.candidates.map((candidate) => candidate.name)).toEqual([
          "alpha",
          "beta",
        ]);
        expect(
          context.candidates.find((candidate) => candidate.name === "alpha")
            ?.harnesses,
        ).toEqual(
          expect.arrayContaining([
            "claude-code",
            "cline",
            "crush",
            "github-copilot",
            "goose",
            "opencode",
          ]),
        );
        return context.candidates.map((candidate) => candidate.id);
      });

      const result = await runImport({
        cwd: root,
        homeDirectory: home,
        environment: {},
        isInteractive: true,
        prompt,
      });

      expect(result.imported.map((skill) => skill.name)).toEqual([
        "alpha",
        "beta",
      ]);
      expect(
        await readFile(
          join(sourceRoot, "alpha", "references", "checklist.md"),
          "utf8",
        ),
      ).toBe("check\n");
      expect(
        await readFile(join(sourceRoot, "beta", "SKILL.md"), "utf8"),
      ).toContain("name: beta");
      expect(prompt).toHaveBeenCalledOnce();
    });
  });

  it("runs interactive initialization before importing when config is missing", async () => {
    await useFixture(async (root) => {
      await writeSkill(join(root, ".claude", "skills"), "alpha");
      const initPrompt = vi.fn<InitPrompt>(async () => ({
        scope: "project",
        source: "team-skills",
        harnesses: ["claude-code"],
      }));
      const prompt = vi.fn<ImportPrompt>(async (context) =>
        context.candidates.map((candidate) => candidate.id),
      );

      const result = await runImport({
        cwd: root,
        homeDirectory: join(root, "home"),
        environment: {},
        isInteractive: true,
        initPrompt,
        prompt,
      });

      expect(result.initialized).toMatchObject({
        projectRoot: root,
        sourceRoot: join(root, "team-skills"),
      });
      expect(initPrompt).toHaveBeenCalledOnce();
      expect(result.imported).toHaveLength(1);
      expect(
        (await lstat(join(root, "team-skills", "alpha"))).isDirectory(),
      ).toBe(true);
    });
  });

  it("preserves existing source skills and skips selection when none remain", async () => {
    await useFixture(async (root) => {
      await writeConfig(root, "canonical/skills");
      await writeSkill(join(root, "canonical", "skills"), "alpha", {
        "keep.txt": "canonical\n",
      });
      await writeSkill(join(root, ".claude", "skills"), "alpha", {
        "keep.txt": "harness\n",
      });
      const prompt = vi.fn<ImportPrompt>();

      const result = await runImport({
        cwd: root,
        homeDirectory: join(root, "home"),
        environment: {},
        isInteractive: false,
        prompt,
      });

      expect(result.candidates).toEqual([]);
      expect(result.imported).toEqual([]);
      expect(prompt).not.toHaveBeenCalled();
      expect(
        await readFile(
          join(root, "canonical", "skills", "alpha", "keep.txt"),
          "utf8",
        ),
      ).toBe("canonical\n");
    });
  });

  it("rejects selecting two source copies with the same destination name", async () => {
    await useFixture(async (root) => {
      const sourceRoot = join(root, "canonical", "skills");
      await writeConfig(root, "canonical/skills");
      await mkdir(sourceRoot, { recursive: true });
      await writeSkill(join(root, ".claude", "skills"), "alpha");
      await writeSkill(join(root, ".cursor", "skills"), "alpha");

      await expect(
        runImport({
          cwd: root,
          homeDirectory: join(root, "home"),
          environment: {},
          isInteractive: true,
          prompt: async (context) =>
            context.candidates.map((candidate) => candidate.id),
        }),
      ).rejects.toMatchObject({ category: "conflict", exitCode: 1 });
      await expect(lstat(join(sourceRoot, "alpha"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("reports invalid harness skills as warnings and offers valid skills", async () => {
    await useFixture(async (root) => {
      await writeConfig(root, "canonical/skills");
      const invalid = join(root, ".claude", "skills", "invalid");
      await mkdir(invalid, { recursive: true });
      await writeFile(join(invalid, "SKILL.md"), "# missing frontmatter\n");
      await writeSkill(join(root, ".claude", "skills"), "valid");

      const result = await runImport({
        cwd: root,
        homeDirectory: join(root, "home"),
        environment: {},
        isInteractive: true,
        prompt: async () => [],
      });

      expect(result.candidates.map((candidate) => candidate.name)).toEqual([
        "valid",
      ]);
      expect(result.warnings).toEqual([
        expect.objectContaining({
          path: invalid,
          message: expect.stringContaining("Ignored invalid skill"),
        }),
      ]);
    });
  });

  it("allows init to offer and decline discovered imports", async () => {
    await useFixture(async (root) => {
      await writeConfig(root, "canonical/skills");
      await mkdir(join(root, "canonical", "skills"), { recursive: true });
      await writeSkill(join(root, ".claude", "skills"), "alpha");
      const offerPrompt = vi.fn<ImportOfferPrompt>(async () => false);
      const prompt = vi.fn<ImportPrompt>();

      const result = await runImport({
        cwd: root,
        homeDirectory: join(root, "home"),
        environment: {},
        isInteractive: true,
        offer: true,
        offerPrompt,
        prompt,
      });

      expect(result.declined).toBe(true);
      expect(result.imported).toEqual([]);
      expect(offerPrompt).toHaveBeenCalledOnce();
      expect(prompt).not.toHaveBeenCalled();
    });
  });
});

async function writeConfig(root: string, source: string): Promise<void> {
  await writeFile(
    join(root, "distributor.config.json"),
    `${JSON.stringify({
      source,
      harnesses: [{ name: "claude-code", useHarnessFolder: true }],
    })}\n`,
    "utf8",
  );
}

async function writeSkill(
  sourceRoot: string,
  name: string,
  extraFiles: Readonly<Record<string, string>> = {},
): Promise<void> {
  const skillRoot = join(sourceRoot, name);
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} test skill\n---\n`,
    "utf8",
  );
  for (const [path, contents] of Object.entries(extraFiles)) {
    const destination = join(skillRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents, "utf8");
  }
}
