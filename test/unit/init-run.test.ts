import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DistributorError } from "../../src/errors.js";
import { runInit, type InitPrompt } from "../../src/init/run-init.js";
import { useFixture } from "../helpers/fixture.js";

const ALL_HARNESSES = [
  "codex",
  "claude-code",
  "opencode",
  "cursor",
  "gemini-cli",
  "antigravity",
  "github-copilot",
  "openhands",
  "pi",
  "cline",
  "goose",
  "crush",
  "qwen-code",
  "kilo-code",
  "roo-code",
  "trae-agent",
] as const;

const DEFAULT_CONFIG_CONTENTS = `{
  "source": ".agents/skills",
  "harnesses": [${ALL_HARNESSES.map((name) => JSON.stringify(name)).join(", ")}]
}
`;

const IGNORE_CONTENTS =
  "*\n!.gitignore\n!adapters/\n!adapters/**\n";

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR"
    ) {
      return false;
    }
    throw error;
  }
}

describe("runInit root and config selection", () => {
  it.each(["directory", "file"] as const)(
    "uses the invocation directory inside a Git worktree with a .git %s",
    async (markerType) => {
      await useFixture(async (root) => {
        const worktree = join(root, "worktree");
        const nested = join(worktree, "packages", "app");
        await mkdir(nested, { recursive: true });
        if (markerType === "directory") {
          await mkdir(join(worktree, ".git"));
        } else {
          await writeFile(
            join(worktree, ".git"),
            "gitdir: elsewhere\n",
            "utf8",
          );
        }

        const result = await runInit({ cwd: nested, yes: true });

        expect(result.projectRoot).toBe(nested);
        expect(result.configPath).toBe(
          join(nested, "distributor.config.json"),
        );
        expect(await exists(join(worktree, "distributor.config.json"))).toBe(
          false,
        );
        expect(await exists(join(nested, ".distributor", ".gitignore"))).toBe(
          true,
        );
      });
    },
  );

  it("uses the invocation directory outside a Git worktree", async () => {
    await useFixture(async (root) => {
      const invocationDirectory = join(root, "nested");
      await mkdir(invocationDirectory);

      const result = await runInit({ cwd: invocationDirectory, yes: true });

      expect(result.projectRoot).toBe(invocationDirectory);
      expect(await exists(join(root, "distributor.config.json"))).toBe(false);
    });
  });

  it(
    "preserves a config in the invocation directory inside a Git worktree",
    async () => {
      await useFixture(async (root) => {
        const nested = join(root, "nested");
        const nestedConfig = join(nested, "distributor.config.json");
        await mkdir(join(root, ".git"));
        await mkdir(nested);
        await writeFile(
          nestedConfig,
          '{"source":"nested-skills","harnesses":["codex"]}\n',
          "utf8",
        );

        const result = await runInit({ cwd: nested, yes: true });

        expect(result.projectRoot).toBe(nested);
        expect(result.configPath).toBe(nestedConfig);
        expect(await readFile(nestedConfig, "utf8")).toBe(
          '{"source":"nested-skills","harnesses":["codex"]}\n',
        );
        expect(await exists(join(root, "distributor.config.json"))).toBe(false);
      });
    },
  );

  it("reports every conflicting config at the init root before writes", async () => {
    await useFixture(async (root) => {
      const jsonConfig = join(root, "distributor.config.json");
      const jsConfig = join(root, "distributor.config.js");
      await writeFile(jsonConfig, "{}\n", "utf8");
      await writeFile(jsConfig, "export default {};\n", "utf8");

      try {
        await runInit({ cwd: root, yes: true });
        expect.fail("Expected conflicting configs to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(DistributorError);
        expect((error as Error).message).toContain(jsonConfig);
        expect((error as Error).message).toContain(jsConfig);
      }

      expect(await exists(join(root, ".agents"))).toBe(false);
      expect(await exists(join(root, ".distributor"))).toBe(false);
    });
  });

  it("preserves and validates one existing config without prompting", async () => {
    await useFixture(async (root) => {
      const configPath = join(root, "distributor.config.json");
      const configContents =
        '{"source":"custom/skills","harnesses":["codex"]}\n';
      await writeFile(configPath, configContents, "utf8");
      const prompt = vi.fn<InitPrompt>();

      const result = await runInit({
        cwd: root,
        isInteractive: false,
        prompt,
      });

      expect(prompt).not.toHaveBeenCalled();
      expect(result.sourceRoot).toBe(join(root, "custom", "skills"));
      expect(await lstat(result.sourceRoot)).toMatchObject({});
      expect((await lstat(result.sourceRoot)).isDirectory()).toBe(true);
      expect(await readFile(configPath, "utf8")).toBe(configContents);
      expect(result.outcomes).toContainEqual({
        artifact: "config",
        status: "preserved",
        path: configPath,
      });
    });
  });

  it("fails invalid existing configuration without creating setup artifacts", async () => {
    await useFixture(async (root) => {
      const configPath = join(root, "distributor.config.json");
      await writeFile(
        configPath,
        '{"source":"skills","harnesses":["invented"]}\n',
        "utf8",
      );

      await expect(
        runInit({ cwd: root, isInteractive: false }),
      ).rejects.toMatchObject({ category: "config", exitCode: 2 });
      expect(await exists(join(root, "skills"))).toBe(false);
      expect(await exists(join(root, ".distributor"))).toBe(false);
    });
  });
});

describe("runInit selection collection", () => {
  it("creates the exact documented defaults with --yes and never syncs", async () => {
    await useFixture(async (root) => {
      const prompt = vi.fn<InitPrompt>();

      const result = await runInit({
        cwd: root,
        yes: true,
        isInteractive: false,
        prompt,
      });

      expect(prompt).not.toHaveBeenCalled();
      expect(await readFile(result.configPath, "utf8")).toBe(
        DEFAULT_CONFIG_CONTENTS,
      );
      expect((await lstat(join(root, ".agents", "skills"))).isDirectory()).toBe(
        true,
      );
      expect(
        await readFile(join(root, ".distributor", ".gitignore"), "utf8"),
      ).toBe(IGNORE_CONTENTS);
      expect(await exists(join(root, ".distributor", "state.json"))).toBe(
        false,
      );
      expect(await exists(join(root, ".claude"))).toBe(false);
      expect(await exists(join(root, ".opencode"))).toBe(false);
      expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
        "created",
        "created",
        "created",
      ]);
      expect(result.noOp).toBe(false);
    });
  });

  it("uses an injected interactive prompt with documented defaults", async () => {
    await useFixture(async (root) => {
      const prompt = vi.fn<InitPrompt>(async (context) => {
        expect(context).toEqual({
          defaultSource: ".agents/skills",
          defaultHarnesses: ALL_HARNESSES,
          harnesses: ALL_HARNESSES.map((name) => ({
            name,
            displayName: {
              codex: "Codex CLI",
              "claude-code": "Claude Code",
              opencode: "OpenCode",
              cursor: "Cursor",
              "gemini-cli": "Gemini CLI",
              antigravity: "Antigravity",
              "github-copilot": "GitHub Copilot",
              openhands: "OpenHands",
              pi: "Pi",
              cline: "Cline",
              goose: "Goose",
              crush: "Crush",
              "qwen-code": "Qwen Code",
              "kilo-code": "Kilo Code",
              "roo-code": "Roo Code",
              "trae-agent": "Trae Agent",
            }[name],
          })),
        });
        return {
          source: "team-skills",
          harnesses: ["claude-code", "codex"],
        };
      });

      const result = await runInit({
        cwd: root,
        isInteractive: true,
        prompt,
      });

      expect(prompt).toHaveBeenCalledOnce();
      expect(await readFile(result.configPath, "utf8")).toBe(`{
  "source": "team-skills",
  "harnesses": ["claude-code", "codex"]
}
`);
      expect((await lstat(join(root, "team-skills"))).isDirectory()).toBe(true);
    });
  });

  it("rejects non-interactive config creation without --yes", async () => {
    await useFixture(async (root) => {
      await expect(
        runInit({ cwd: root, isInteractive: false }),
      ).rejects.toMatchObject({
        category: "usage",
        exitCode: 2,
        correction: expect.stringContaining("--yes"),
      });

      expect(await exists(join(root, "distributor.config.json"))).toBe(false);
      expect(await exists(join(root, ".agents"))).toBe(false);
      expect(await exists(join(root, ".distributor"))).toBe(false);
    });
  });
});

describe("runInit preflight and non-destructive apply", () => {
  it("rejects a non-directory source before creating any artifact", async () => {
    await useFixture(async (root) => {
      const sourceParent = join(root, ".agents");
      const sourcePath = join(sourceParent, "skills");
      await mkdir(sourceParent);
      await writeFile(sourcePath, "keep me\n", "utf8");

      await expect(runInit({ cwd: root, yes: true })).rejects.toMatchObject({
        category: "source",
        exitCode: 1,
      });

      expect(await readFile(sourcePath, "utf8")).toBe("keep me\n");
      expect(await exists(join(root, "distributor.config.json"))).toBe(false);
      expect(await exists(join(root, ".distributor"))).toBe(false);
    });
  });

  it("completes all artifact preflight before creating a missing source", async () => {
    await useFixture(async (root) => {
      await writeFile(join(root, ".distributor"), "not a directory\n", "utf8");

      await expect(runInit({ cwd: root, yes: true })).rejects.toMatchObject({
        category: "filesystem",
        exitCode: 1,
      });

      expect(await exists(join(root, ".agents"))).toBe(false);
      expect(await exists(join(root, "distributor.config.json"))).toBe(false);
      expect(await readFile(join(root, ".distributor"), "utf8")).toBe(
        "not a directory\n",
      );
    });
  });

  it("preserves source contents and an existing ignore file in partial setup", async () => {
    await useFixture(async (root) => {
      const sourceRoot = join(root, ".agents", "skills");
      const sourceFile = join(sourceRoot, "existing.txt");
      const ignorePath = join(root, ".distributor", ".gitignore");
      await mkdir(sourceRoot, { recursive: true });
      await writeFile(sourceFile, "source content\n", "utf8");
      await mkdir(join(root, ".distributor"));
      await writeFile(ignorePath, "custom ignore\n", "utf8");

      const result = await runInit({ cwd: root, yes: true });

      expect(await readFile(sourceFile, "utf8")).toBe("source content\n");
      expect(await readFile(ignorePath, "utf8")).toBe("custom ignore\n");
      expect(result.outcomes).toEqual([
        {
          artifact: "config",
          status: "created",
          path: join(root, "distributor.config.json"),
        },
        { artifact: "source", status: "preserved", path: sourceRoot },
        {
          artifact: "state-ignore",
          status: "preserved",
          path: ignorePath,
        },
      ]);
    });
  });

  it("reports repeated complete setup as a successful no-op", async () => {
    await useFixture(async (root) => {
      const first = await runInit({ cwd: root, yes: true });
      const configBefore = await readFile(first.configPath, "utf8");
      const ignoreBefore = await readFile(
        join(root, ".distributor", ".gitignore"),
        "utf8",
      );

      const second = await runInit({ cwd: root, isInteractive: false });

      expect(second.noOp).toBe(true);
      expect(
        second.outcomes.every((outcome) => outcome.status === "preserved"),
      ).toBe(true);
      expect(await readFile(second.configPath, "utf8")).toBe(configBefore);
      expect(
        await readFile(join(root, ".distributor", ".gitignore"), "utf8"),
      ).toBe(ignoreBefore);
    });
  });

  it("rejects a selected source that collides with generated config", async () => {
    await useFixture(async (root) => {
      const prompt: InitPrompt = async () => ({
        source: "distributor.config.json",
        harnesses: ["codex"],
      });

      await expect(
        runInit({ cwd: root, isInteractive: true, prompt }),
      ).rejects.toMatchObject({ category: "source", exitCode: 1 });

      expect(await exists(join(root, "distributor.config.json"))).toBe(false);
      expect(await exists(join(root, ".distributor"))).toBe(false);
    });
  });

  it.skipIf(process.platform === "win32")(
    "refuses to create a project-local source through a symlinked parent",
    async () => {
      await useFixture(async (root) => {
        const external = join(root, "external");
        await mkdir(external);
        await symlink(external, join(root, ".agents"), "dir");

        await expect(runInit({ cwd: root, yes: true })).rejects.toMatchObject({
          category: "filesystem",
          exitCode: 1,
          correction: expect.stringContaining("symbolic links"),
        });
        expect(await exists(join(external, "skills"))).toBe(false);
        expect(await exists(join(root, "distributor.config.json"))).toBe(false);
        expect(await exists(join(root, ".distributor"))).toBe(false);
      });
    },
  );
});
