import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  adapterCatalog,
  availableAdapterConfigs,
} from "../../src/adapters/index.js";
import { runCli, type CliRuntime } from "../../src/cli.js";
import {
  DEFAULT_SOURCE_PATH,
  DistributorConfigSchema,
  type DistributorConfig as SchemaDistributorConfig,
} from "../../src/config/schema.js";
import { validateProjectConfig } from "../../src/config/validate.js";
import type { DistributorConfig } from "../../src/index.js";
import { runInit } from "../../src/init/run-init.js";
import { createOutput } from "../../src/output.js";
import { applySyncPlan } from "../../src/sync/apply.js";
import { runSync, type RunSyncResult } from "../../src/sync/run-sync.js";
import {
  loadManagedState,
  statePathForProject,
} from "../../src/sync/state.js";
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

const DEFAULT_CONFIG = `{
  "source": ".agents/skills",
  "harnesses": [${ALL_HARNESSES.map((name) => JSON.stringify(name)).join(", ")}]
}
`;

const DEFAULT_IGNORE = "*\n!.gitignore\n";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;

const publicTypeMatchesSchema: Equal<
  DistributorConfig,
  SchemaDistributorConfig
> = true;

const documentedConfig = {
  source: ".agents/skills",
  harnesses: [...ALL_HARNESSES],
} satisfies DistributorConfig;

describe("Distributor initial-release acceptance matrix", () => {
  it("criterion 1: init --yes creates the exact default setup non-destructively", async () => {
    await useFixture(async (root) => {
      const result = await runInit({ cwd: root, yes: true });

      expect(await readFile(result.configPath, "utf8")).toBe(DEFAULT_CONFIG);
      expect((await lstat(result.sourceRoot)).isDirectory()).toBe(true);
      expect(
        await readFile(join(root, ".distributor", ".gitignore"), "utf8"),
      ).toBe(DEFAULT_IGNORE);
      expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
        "created",
        "created",
        "created",
      ]);
    });

    await useFixture(async (root) => {
      const configPath = join(root, "distributor.config.json");
      const sourceRoot = join(root, "skills");
      const sourceFile = join(sourceRoot, "keep.txt");
      const ignorePath = join(root, ".distributor", ".gitignore");
      const configText = '{"source":"skills","harnesses":["codex"]}\n';
      await mkdir(sourceRoot);
      await writeFile(sourceFile, "keep source content\n", "utf8");
      await writeFile(configPath, configText, "utf8");
      await mkdir(dirname(ignorePath));
      await writeFile(ignorePath, "custom ignore\n", "utf8");

      const result = await runInit({ cwd: root, yes: true });

      expect(result.noOp).toBe(true);
      expect(await readFile(configPath, "utf8")).toBe(configText);
      expect(await readFile(sourceFile, "utf8")).toBe("keep source content\n");
      expect(await readFile(ignorePath, "utf8")).toBe("custom ignore\n");
    });
  });

  it("criterion 2: syncing an empty initialized source is a write-free no-op", async () => {
    await useFixture(async (root) => {
      await runInit({ cwd: root, yes: true });
      const before = await snapshotTree(root);

      const result = await runSync({ cwd: root });

      expect(result).toMatchObject({
        exitCode: 0,
        applied: true,
        counts: {
          source: { skills: 0, files: 0 },
          physicalOperations: { total: 0 },
          failures: 0,
        },
      });
      expect(result.applyResult).toMatchObject({
        statePersisted: true,
        stateWritten: false,
        operations: [],
      });
      expect(await exists(statePathForProject(root))).toBe(false);
      expect(await exists(join(root, ".claude"))).toBe(false);
      expect(await exists(join(root, ".opencode"))).toBe(false);
      expect(await snapshotTree(root)).toEqual(before);
    });
  });

  it("criterion 3: a multi-file skill produces nested Claude file symlinks with exact raw values", async () => {
    await useFixture(async (root) => {
      await runInit({ cwd: root, yes: true });
      await writeSkill(root, "review", {
        "references/checklist.md": "# Checklist\n",
        "scripts/check.sh": "#!/bin/sh\nexit 0\n",
      });

      const result = await runSync({ cwd: root });
      const sourceRoot = join(root, ".agents", "skills", "review");
      const targetRoot = join(root, ".claude", "skills", "review");
      const expectedFiles = [
        "SKILL.md",
        "references/checklist.md",
        "scripts/check.sh",
      ];

      expect(result.exitCode).toBe(0);
      expect(result.counts.source).toEqual({ skills: 1, files: 3 });
      for (const file of expectedFiles) {
        const sourcePath = join(sourceRoot, file);
        const targetPath = join(targetRoot, file);
        expect((await lstat(targetPath)).isSymbolicLink()).toBe(true);
        expect(await readlink(targetPath)).toBe(
          relative(dirname(targetPath), sourcePath),
        );
      }
      expect((await lstat(targetRoot)).isDirectory()).toBe(true);
      expect((await lstat(join(targetRoot, "references"))).isDirectory()).toBe(
        true,
      );
    });
  });

  it("criterion 4: Codex and OpenCode are satisfied in place without fallback directories", async () => {
    await useFixture(async (root) => {
      await runInit({ cwd: root, yes: true });
      await writeSkill(root, "review");

      const result = await runSync({ cwd: root });

      expect(result.plan.satisfiedPlacements).toEqual(
        expect.arrayContaining([
          {
            harnessId: "codex",
            placementId: "project",
            sourceRoot: join(root, ".agents", "skills"),
          },
          {
            harnessId: "opencode",
            placementId: "agents-project",
            sourceRoot: join(root, ".agents", "skills"),
          },
        ]),
      );
      expect(
        result.counts.harnesses.find((harness) => harness.harnessId === "codex")
          ?.operations.total,
      ).toBe(0);
      expect(
        result.counts.harnesses.find(
          (harness) => harness.harnessId === "opencode",
        )?.operations.total,
      ).toBe(0);
      expect(await exists(join(root, ".opencode"))).toBe(false);
      expect(await exists(join(root, ".codex"))).toBe(false);
    });
  });

  it("criterion 5: a second identical sync skips targets and retains deterministic state and output", async () => {
    await useFixture(async (root) => {
      await runInit({ cwd: root, yes: true });
      await writeSkill(root, "review", {
        "references/checklist.md": "# Checklist\n",
      });
      await runSync({ cwd: root });
      const target = join(root, ".claude", "skills", "review", "SKILL.md");
      const targetBefore = await linkIdentity(target);
      const stateBefore = await readFile(statePathForProject(root), "utf8");

      const second = await runSync({ cwd: root });
      const third = await runSync({ cwd: root });

      expect(
        second.applyResult?.operations.every(
          (operation) =>
            operation.status === "skipped" &&
            operation.targetLinkMutated === false,
        ),
      ).toBe(true);
      expect(second.applyResult?.stateWritten).toBe(false);
      expect(second.counts.physicalOperations).toMatchObject({
        create: 0,
        update: 0,
        adopt: 0,
        skip: 8,
      });
      expect(third.counts).toEqual(second.counts);
      expect(renderSync(third)).toBe(renderSync(second));
      expect(await linkIdentity(target)).toEqual(targetBefore);
      expect(await readFile(statePathForProject(root), "utf8")).toBe(
        stateBefore,
      );
    });
  });

  it("criterion 6: every unmanaged target and escaping parent globally aborts all writes", async () => {
    for (const scenario of [
      "regular-file",
      "directory",
      "changed-link",
      "escaping-parent",
    ] as const) {
      await useFixture(async (root) => {
        await runInit({ cwd: root, yes: true });
        await writeSkill(root, "alpha");
        const alphaTarget = join(
          root,
          ".claude",
          "skills",
          "alpha",
          "SKILL.md",
        );
        const betaTarget = join(root, ".claude", "skills", "beta", "SKILL.md");
        let stateBefore: string | undefined;

        if (scenario === "changed-link") {
          await runSync({ cwd: root });
          stateBefore = await readFile(statePathForProject(root), "utf8");
          await rm(alphaTarget);
          await symlink("changed-after-sync", alphaTarget, "file");
          await writeSkill(root, "beta");
        } else {
          await writeSkill(root, "beta");
          if (scenario === "regular-file") {
            await mkdir(dirname(alphaTarget), { recursive: true });
            await writeFile(alphaTarget, "unmanaged", "utf8");
          } else if (scenario === "directory") {
            await mkdir(alphaTarget, { recursive: true });
          } else {
            const outside = join(root, "outside");
            await mkdir(join(root, ".claude", "skills"), { recursive: true });
            await mkdir(outside);
            await symlink(outside, dirname(alphaTarget), "dir");
          }
        }

        await expect(runSync({ cwd: root })).rejects.toMatchObject({
          category: "conflict",
          exitCode: 1,
          correction: expect.stringContaining("did not write"),
        });
        expect(await exists(betaTarget)).toBe(false);
        if (scenario === "escaping-parent") {
          expect(await readdir(join(root, "outside"))).toEqual([]);
        }
        if (stateBefore === undefined) {
          expect(await exists(statePathForProject(root))).toBe(false);
        } else {
          expect(await readFile(statePathForProject(root), "utf8")).toBe(
            stateBefore,
          );
          expect(await readlink(alphaTarget)).toBe("changed-after-sync");
        }
      });
    }
  });

  it("criterion 7: dry run has plan/count parity and changes no content or metadata", async () => {
    await useFixture(async (root) => {
      await runInit({ cwd: root, yes: true });
      await writeSkill(root, "review", {
        "references/checklist.md": "# Checklist\n",
      });
      const ignorePath = join(root, ".distributor", ".gitignore");
      await writeFile(ignorePath, "custom-rule\n", "utf8");
      const before = await snapshotTree(root);

      const dryRun = await runSync({ cwd: root, dryRun: true });

      expect(await snapshotTree(root)).toEqual(before);
      expect(dryRun).toMatchObject({
        exitCode: 0,
        dryRun: true,
        applied: false,
      });
      expect(dryRun).not.toHaveProperty("applyResult");

      const applied = await runSync({ cwd: root });
      expect(applied.counts).toEqual(dryRun.counts);
      expect(applied.warnings).toEqual(dryRun.warnings);
      expect(dryRun.warnings).toEqual([
        expect.objectContaining({
          path: ignorePath,
          message: expect.stringContaining("does not ignore state.json"),
        }),
      ]);
      expect(await readFile(ignorePath, "utf8")).toBe("custom-rule\n");
      expect(applied.plan.operations.map(operationIdentity)).toEqual(
        dryRun.plan.operations.map(operationIdentity),
      );
    });
  });

  it("criterion 8: removing a source skill removes its managed targets and state", async () => {
    await useFixture(async (root) => {
      await runInit({ cwd: root, yes: true });
      await writeSkill(root, "review", {
        "references/checklist.md": "# Checklist\n",
      });
      await runSync({ cwd: root });
      const sourceSkill = join(root, ".agents", "skills", "review");
      const targetSkill = join(root, ".claude", "skills", "review");
      const target = join(
        root,
        ".claude",
        "skills",
        "review",
        "references",
        "checklist.md",
      );
      await rm(sourceSkill, { recursive: true });

      const result = await runSync({ cwd: root });

      expect(result.exitCode).toBe(0);
      expect(result.counts.stale).toBeGreaterThan(0);
      expect(
        result.applyResult?.operations.some(
          (operation) => operation.operation.kind === "stale",
        ),
      ).toBe(true);
      await expect(lstat(join(targetSkill, "SKILL.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(targetSkill)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(loadManagedState(root)).resolves.toMatchObject({
        entries: expect.not.arrayContaining([
          expect.objectContaining({
            sourcePath: expect.stringContaining(sourceSkill),
          }),
        ]),
      });
    });
  });

  it("criterion 9: invalid inputs and Windows symlink limits return actionable specified exits", async () => {
    await useFixture(async (root) => {
      await writeFile(
        join(root, "distributor.config.json"),
        '{"harnesses":[]}\n',
        "utf8",
      );
      const cli = await runCliAt(root, ["sync"]);
      expect(cli.code).toBe(2);
      expect(cli.stderr).toContain("Invalid Distributor config");
      expect(cli.stderr).toContain("harnesses");
      expect(cli.stderr).toContain("Action:");
    });

    await useFixture(async (root) => {
      await writeConfig(root, ["claude-code"]);
      const skillRoot = join(root, ".agents", "skills", "broken");
      await mkdir(skillRoot, { recursive: true });
      await writeFile(
        join(skillRoot, "SKILL.md"),
        "# no frontmatter\n",
        "utf8",
      );
      const cli = await runCliAt(root, ["sync"]);
      expect(cli.code).toBe(1);
      expect(cli.stderr).toContain("SKILL.md must begin");
      expect(cli.stderr).toContain(join(skillRoot, "SKILL.md"));
      expect(cli.stderr).not.toContain("at ");
    });

    await useFixture(async (root) => {
      await writeConfig(root, ["invented"]);
      await mkdir(join(root, ".agents", "skills"), { recursive: true });
      const cli = await runCliAt(root, ["sync"]);
      expect(cli.code).toBe(2);
      expect(cli.stderr).toContain('unknown harness "invented"');
      expect(cli.stderr).toContain("Action:");
    });

    await useFixture(async (root) => {
      await runInit({ cwd: root, yes: true });
      await writeSkill(root, "review");
      const windowsApply: typeof applySyncPlan = (
        plan,
        resolution,
        state,
        projectRoot,
        options = {},
      ) =>
        applySyncPlan(plan, resolution, state, projectRoot, {
          ...options,
          platform: "win32",
          filesystem: {
            ...options.filesystem,
            symlink: async () => {
              throw Object.assign(new Error("privilege unavailable"), {
                code: "EPERM",
              });
            },
          },
        });
      const windowsRunSync: typeof runSync = (options = {}) =>
        runSync({
          ...options,
          runtime: { ...options.runtime, applySyncPlan: windowsApply },
        });
      const cli = await runCliAt(root, ["sync"], {
        runSync: windowsRunSync,
      });

      expect(cli.code).toBe(1);
      expect(cli.stderr).toContain("Developer Mode");
      expect(cli.stderr).toContain("will not copy files or create junctions");
      expect(
        await exists(join(root, ".claude", "skills", "review", "SKILL.md")),
      ).toBe(false);
      expect(await exists(statePathForProject(root))).toBe(false);
    });
  });

  it("links OpenAI metadata only to Codex and removes every managed file link", async () => {
    await useFixture(async (root) => {
      await writeFile(
        join(root, "distributor.config.json"),
        `${JSON.stringify({
          source: ".source/skills",
          harnesses: [
            {
              name: "codex",
              targets: [{ placement: "project", path: ".codex/skills" }],
            },
            {
              name: "claude-code",
              targets: [{ placement: "project", path: ".claude/skills" }],
            },
          ],
        }, null, 2)}\n`,
        "utf8",
      );
      const skillRoot = join(root, ".source", "skills", "review");
      await mkdir(join(skillRoot, "agents"), { recursive: true });
      await writeFile(
        join(skillRoot, "SKILL.md"),
        "---\nname: review\ndescription: Review code.\n---\n",
        "utf8",
      );
      await writeFile(
        join(skillRoot, "agents", "openai.yml"),
        "interface:\n  display_name: Review\n",
        "utf8",
      );

      const sync = await runSync({ cwd: root });
      const codexSkill = join(root, ".codex", "skills", "review");
      const claudeSkill = join(root, ".claude", "skills", "review");

      expect(sync.exitCode).toBe(0);
      expect((await lstat(join(codexSkill, "SKILL.md"))).isSymbolicLink()).toBe(true);
      expect(
        (await lstat(join(codexSkill, "agents", "openai.yml"))).isSymbolicLink(),
      ).toBe(true);
      expect((await lstat(join(claudeSkill, "SKILL.md"))).isSymbolicLink()).toBe(true);
      expect(await exists(join(claudeSkill, "agents", "openai.yml"))).toBe(false);

      const removal = await runCliAt(root, ["remove"]);

      expect(removal).toMatchObject({ code: 0, stderr: "" });
      expect(removal.stdout).toContain("Removed 3 managed links");
      expect(await exists(join(codexSkill, "SKILL.md"))).toBe(false);
      expect(await exists(join(codexSkill, "agents", "openai.yml"))).toBe(false);
      expect(await exists(join(claudeSkill, "SKILL.md"))).toBe(false);
      expect(await exists(join(skillRoot, "agents", "openai.yml"))).toBe(true);
      expect(await exists(codexSkill)).toBe(false);
      await expect(loadManagedState(root)).resolves.toMatchObject({
        entries: [],
        directories: [],
      });
    });
  });

  it("criterion 10: examples, adapter defaults, generated config, and public schema type agree", async () => {
    expect(publicTypeMatchesSchema).toBe(true);
    expect(DistributorConfigSchema.parse(documentedConfig)).toEqual(
      documentedConfig,
    );
    expect(DEFAULT_SOURCE_PATH).toBe(".agents/skills");
    expect(
      adapterCatalog
        .filter((entry) => entry.adapterStatus === "available")
        .map((entry) => entry.name),
    ).toEqual(ALL_HARNESSES);
    expect(Object.keys(availableAdapterConfigs)).toEqual(ALL_HARNESSES);
    expect(
      Object.fromEntries(
        Object.entries(availableAdapterConfigs).map(([name, config]) => {
          const placement = config.placements.find(
            (item) => item.id === config.defaultProjectPlacementId,
          );
          return [name, placement?.defaultPath];
        }),
      ),
    ).toEqual({
      codex: ".agents/skills",
      "claude-code": ".claude/skills",
      opencode: ".opencode/skills",
      cursor: ".cursor/skills",
      "gemini-cli": ".gemini/skills",
      antigravity: ".agents/skills",
      "github-copilot": ".github/skills",
      openhands: ".agents/skills",
      pi: ".pi/skills",
      cline: ".cline/skills",
      goose: ".agents/skills",
      crush: ".crush/skills",
      "qwen-code": ".qwen/skills",
      "kilo-code": ".kilo/skills",
      "roo-code": ".roo/skills",
      "trae-agent": ".trae/skills",
    });

    await useFixture(async (root) => {
      const init = await runInit({ cwd: root, yes: true });
      const generated = await readFile(init.configPath, "utf8");
      expect(generated).toBe(DEFAULT_CONFIG);
      expect(DistributorConfigSchema.parse(JSON.parse(generated))).toEqual(
        documentedConfig,
      );
    });

    const [readme, spec, configSpec, techStack, plan] = await Promise.all([
      readFile(new URL("../../README.md", import.meta.url), "utf8"),
      readFile(new URL("../../specs/SPEC.md", import.meta.url), "utf8"),
      readFile(new URL("../../specs/CONFIG_SPEC.md", import.meta.url), "utf8"),
      readFile(new URL("../../specs/TECH_STACK.md", import.meta.url), "utf8"),
      readFile(new URL("../../specs/PLAN.md", import.meta.url), "utf8"),
    ]);
    const readmeExamples = [
      ...readme.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g),
    ]
      .map((match) => match[1])
      .filter((example): example is string => example !== undefined)
      .map((example) => JSON.parse(example) as unknown);
    expect(readmeExamples).toHaveLength(2);
    expect(readmeExamples[0]).toEqual(documentedConfig);
    for (const example of readmeExamples) {
      expect(DistributorConfigSchema.parse(example)).toEqual(example);
      const expectedNames = (
        example as { harnesses: Array<string | { name: string }> }
      ).harnesses
        .map((harness) =>
          typeof harness === "string" ? harness : harness.name,
        )
        .sort();
      expect(
        validateProjectConfig(
          example,
          {
            configPath: "/project/distributor.config.json",
            projectRoot: "/project",
          },
          {
            environment: {},
            homeDirectory: "/home/test",
            pathStyle: "posix",
          },
        )
          .harnesses.map((harness) => harness.name)
          .sort(),
      ).toEqual(expectedNames);
    }
    expect(spec).toContain('"harnesses": [');
    expect(plan).toContain("all available adapters as defaults");
    expect(configSpec).toMatch(/\| `codex`\s+\| Codex CLI\s+\| available/);
    expect(configSpec).toContain("2026-07-12");
    expect(techStack).toContain(
      "public\n  `DistributorConfig` TypeScript type",
    );
  });
});

async function writeConfig(
  root: string,
  harnesses: readonly string[],
): Promise<void> {
  await writeFile(
    join(root, "distributor.config.json"),
    `${JSON.stringify({ source: DEFAULT_SOURCE_PATH, harnesses }, null, 2)}\n`,
    "utf8",
  );
  await mkdir(join(root, ".agents", "skills"), { recursive: true });
}

async function writeSkill(
  root: string,
  name: string,
  extraFiles: Readonly<Record<string, string>> = {},
): Promise<void> {
  const skillRoot = join(root, ".agents", "skills", name);
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} acceptance skill\n---\n\n# ${name}\n`,
    "utf8",
  );
  for (const [path, contents] of Object.entries(extraFiles)) {
    const absolutePath = join(skillRoot, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, "utf8");
  }
}

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

interface TreeEntry {
  readonly type: "directory" | "file" | "symlink" | "other";
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly content?: string;
  readonly linkValue?: string;
}

async function snapshotTree(root: string): Promise<Record<string, TreeEntry>> {
  const snapshot: Record<string, TreeEntry> = {};

  async function visit(path: string, relativePath: string): Promise<void> {
    const stats = await lstat(path);
    const type = stats.isDirectory()
      ? "directory"
      : stats.isFile()
        ? "file"
        : stats.isSymbolicLink()
          ? "symlink"
          : "other";
    snapshot[relativePath] = {
      type,
      mode: stats.mode,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ...(type === "file"
        ? { content: (await readFile(path)).toString("base64") }
        : {}),
      ...(type === "symlink" ? { linkValue: await readlink(path) } : {}),
    };
    if (type === "directory") {
      const names = (await readdir(path)).sort();
      for (const name of names) {
        await visit(
          join(path, name),
          relativePath === "." ? name : join(relativePath, name),
        );
      }
    }
  }

  await visit(root, ".");
  return snapshot;
}

async function linkIdentity(path: string): Promise<{
  readonly ino: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly linkValue: string;
}> {
  const stats = await lstat(path);
  return {
    ino: stats.ino,
    mode: stats.mode,
    mtimeMs: stats.mtimeMs,
    linkValue: await readlink(path),
  };
}

function renderSync(result: RunSyncResult): string {
  let stdout = "";
  const output = createOutput({
    writeOut: (text) => {
      stdout += text;
    },
    writeErr: () => undefined,
    stdoutIsTTY: false,
  });
  output.printSync(result);
  return stdout;
}

function operationIdentity(operation: {
  readonly kind: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly linkValue: string;
}): unknown {
  return {
    kind: operation.kind,
    sourcePath: operation.sourcePath,
    targetPath: operation.targetPath,
    linkValue: operation.linkValue,
  };
}

async function runCliAt(
  root: string,
  args: readonly string[],
  runtime: Partial<CliRuntime> = {},
): Promise<{
  readonly code: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  const output = createOutput({
    writeOut: (text) => {
      stdout += text;
    },
    writeErr: (text) => {
      stderr += text;
    },
    stdoutIsTTY: false,
  });
  const code = await runCli(args, {
    version: "0.0.0-acceptance",
    cwd: root,
    isInteractive: false,
    output,
    runtime,
  });
  return { code, stdout, stderr };
}
