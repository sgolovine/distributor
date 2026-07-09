import { describe, expect, it, vi } from "vitest";

import {
  type CliRuntime,
  runCli,
} from "../../src/cli.js";
import { DistributorError } from "../../src/errors.js";
import type { InitResult } from "../../src/init/run-init.js";
import { createOutput } from "../../src/output.js";
import type { RunSyncResult } from "../../src/sync/run-sync.js";

const VERSION = "9.8.7";

describe("Distributor CLI", () => {
  it("renders identical root help for no command and explicit help", async () => {
    const first = testContext();
    const second = testContext();

    expect(await first.run([])).toBe(0);
    expect(await second.run(["help"])).toBe(0);

    expect(first.stdout()).toBe(second.stdout());
    expect(first.stdout()).toContain("Commands:");
    expect(first.stdout()).toContain("distributor sync --dry-run");
    expect(first.stdout()).toContain("Exit codes:");
    expect(first.stdout()).toContain("trusted executable code");
    expect(first.runInit).not.toHaveBeenCalled();
    expect(first.runSync).not.toHaveBeenCalled();
  });

  it("renders contextual command help without running commands", async () => {
    const init = testContext();
    const sync = testContext();

    expect(await init.run(["init", "--help"])).toBe(0);
    expect(await sync.run(["help", "sync"])).toBe(0);

    expect(init.stdout()).toContain("-y, --yes");
    expect(sync.stdout()).toContain("--harness <harness-id>");
    expect(sync.stdout()).toContain("--dry-run");
    expect(init.runInit).not.toHaveBeenCalled();
    expect(sync.runSync).not.toHaveBeenCalled();
  });

  it("prints both version forms exactly without loading project state", async () => {
    const option = testContext();
    const command = testContext();

    expect(await option.run(["--version"])).toBe(0);
    expect(await command.run(["version"])).toBe(0);

    expect(option.stdout()).toBe(`${VERSION}\n`);
    expect(command.stdout()).toBe(`${VERSION}\n`);
    expect(option.runInit).not.toHaveBeenCalled();
    expect(option.runSync).not.toHaveBeenCalled();
  });

  it("passes init defaults explicitly and renders its result", async () => {
    const context = testContext();

    expect(await context.run(["init", "-y"])).toBe(0);

    expect(context.runInit).toHaveBeenCalledWith({
      cwd: "/workspace",
      yes: true,
      isInteractive: false,
    });
    expect(context.stdout()).toContain("Initialized Distributor at /project.");
    expect(context.stdout()).toContain("config: created");
  });

  it("passes sync flags and renders deterministic dry-run summaries", async () => {
    const context = testContext();

    expect(
      await context.run([
        "sync",
        "--harness",
        "claude-code",
        "--dry-run",
      ]),
    ).toBe(0);

    expect(context.runSync).toHaveBeenCalledWith({
      cwd: "/workspace",
      harness: "claude-code",
      dryRun: true,
    });
    expect(context.stdout()).toContain(
      "Dry run: 1 skill (2 files) would sync to 2 harnesses.",
    );
    expect(context.stdout()).toContain(
      "claude-code: 2 to create, 0 to update, 0 to adopt, 0 to skip",
    );
    expect(context.stdout()).toContain(
      "codex: satisfied at .agents/skills (no links needed)",
    );
    expect(context.stdout()).toContain(
      "stale: 0, warnings: 0, failures: 0",
    );
    expect(context.stderr()).toBe("");
  });

  it("renders empty-source guidance, stale counts, and warning details", async () => {
    const base = syncResult({ dryRun: false });
    const staleOperations = {
      total: 1,
      create: 0,
      update: 0,
      adopt: 0,
      skip: 0,
      stale: 1,
      conflict: 0,
    } as const;
    const result: RunSyncResult = {
      ...base,
      warnings: [
        { path: "/project/notes.txt", message: "Ignored root file." },
      ],
      counts: {
        ...base.counts,
        source: { skills: 0, files: 0 },
        physicalOperations: staleOperations,
        stale: 1,
        warnings: 1,
        harnesses: base.counts.harnesses.map((harness, index) =>
          index === 0
            ? {
                ...harness,
                operations: staleOperations,
                placements: harness.placements.map((placement) => ({
                  ...placement,
                  operations: staleOperations,
                })),
              }
            : harness,
        ),
      },
    };
    const context = testContext({ runSync: async () => result });

    expect(await context.run(["sync"])).toBe(0);
    expect(context.stdout()).toContain(
      "No skills found in /project/.agents/skills. Add a skill directory containing SKILL.md.",
    );
    expect(context.stdout()).toContain("1 stale");
    expect(context.stdout()).toContain("warnings: 1");
    expect(context.stdout()).toContain(
      "Warning: notes.txt: Ignored root file.",
    );
  });

  it.each([
    [["unknown"], "unknown command"],
    [["sync", "--unknown"], "unknown option"],
    [["sync", "--harness"], "argument missing"],
    [
      ["sync", "--harness", "codex", "--harness", "opencode"],
      "may be specified only once",
    ],
  ] as const)("returns exit 2 for invalid invocation %j", async (args, text) => {
    const context = testContext();

    expect(await context.run(args)).toBe(2);
    expect(context.stdout()).toBe("");
    expect(context.stderr()).toContain("Error:");
    expect(context.stderr()).toContain(text);
    expect(context.runSync).not.toHaveBeenCalled();
  });

  it("maps typed failures without printing a stack", async () => {
    const context = testContext({
      runInit: async () => {
        throw new DistributorError("usage", "Initialization needs --yes.", {
          correction: "Rerun with --yes.",
        });
      },
    });

    expect(await context.run(["init"])).toBe(2);
    expect(context.stderr()).toContain("Initialization needs --yes.");
    expect(context.stderr()).toContain("Action: Rerun with --yes.");
    expect(context.stderr()).not.toContain("at ");
  });

  it("returns a sync result exit code and routes failures to stderr", async () => {
    const failed = syncResult({ failed: true, dryRun: false });
    const context = testContext({ runSync: async () => failed });

    expect(await context.run(["sync"])).toBe(1);

    expect(context.stdout()).toContain("Sync completed with failures");
    expect(context.stdout()).toContain("failures: 1");
    expect(context.stderr()).toContain("Error: target: link denied");
    expect(context.stderr()).toContain("Action: Fix permissions.");
  });
});

function testContext(runtime: Partial<CliRuntime> = {}): {
  readonly run: (args: readonly string[]) => Promise<0 | 1 | 2>;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly runInit: ReturnType<typeof vi.fn>;
  readonly runSync: ReturnType<typeof vi.fn>;
} {
  let stdout = "";
  let stderr = "";
  const runInit = vi.fn(
    runtime.runInit ?? (async () => initResult()),
  );
  const runSync = vi.fn(
    runtime.runSync ?? (async () => syncResult()),
  );
  const output = createOutput({
    writeOut: (text) => {
      stdout += text;
    },
    writeErr: (text) => {
      stderr += text;
    },
    stdoutIsTTY: false,
  });

  return {
    run: (args) =>
      runCli(args, {
        version: VERSION,
        cwd: "/workspace",
        isInteractive: false,
        output,
        runtime: { runInit, runSync },
      }),
    stdout: () => stdout,
    stderr: () => stderr,
    runInit,
    runSync,
  };
}

function initResult(): InitResult {
  return {
    projectRoot: "/project",
    configPath: "/project/distributor.config.json",
    sourceRoot: "/project/.agents/skills",
    outcomes: [
      {
        artifact: "config",
        status: "created",
        path: "/project/distributor.config.json",
      },
      {
        artifact: "source",
        status: "created",
        path: "/project/.agents/skills",
      },
      {
        artifact: "state-ignore",
        status: "created",
        path: "/project/.distributor/.gitignore",
      },
    ],
    noOp: false,
  };
}

function syncResult(
  options: { readonly failed?: boolean; readonly dryRun?: boolean } = {},
): RunSyncResult {
  const failed = options.failed === true;
  const dryRun = options.dryRun ?? true;
  const operations = {
    total: 2,
    create: 2,
    update: 0,
    adopt: 0,
    skip: 0,
    stale: 0,
    conflict: 0,
  } as const;
  const emptyOperations = {
    total: 0,
    create: 0,
    update: 0,
    adopt: 0,
    skip: 0,
    stale: 0,
    conflict: 0,
  } as const;
  const failures = failed
    ? [
        {
          phase: "target" as const,
          operation: "create" as const,
          path: "/project/target",
          message: "link denied",
          correction: "Fix permissions.",
          harnessId: "claude-code",
          placementId: "project",
        },
      ]
    : [];

  return {
    exitCode: failed ? 1 : 0,
    dryRun,
    applied: !dryRun,
    configPath: "/project/distributor.config.json",
    projectRoot: "/project",
    sourceRoot: "/project/.agents/skills",
    plan: {
      applicable: true,
      operations: [],
      satisfiedPlacements: [
        {
          harnessId: "codex",
          placementId: "project",
          sourceRoot: "/project/.agents/skills",
        },
      ],
      warnings: [],
      failures: [],
      stateEvaluation: { evaluated: [], untouched: [] },
    },
    warnings: [],
    failures,
    counts: {
      source: { skills: 1, files: 2 },
      physicalOperations: operations,
      stale: 0,
      satisfiedPlacements: 1,
      warnings: 0,
      failures: failures.length,
      harnesses: [
        {
          harnessId: "claude-code",
          operations,
          satisfiedPlacements: [],
          warnings: 0,
          failures: failures.length,
          placements: [
            {
              placementId: "project",
              operations,
              satisfied: false,
              warnings: 0,
              failures: failures.length,
            },
          ],
        },
        {
          harnessId: "codex",
          operations: emptyOperations,
          satisfiedPlacements: ["project"],
          warnings: 0,
          failures: 0,
          placements: [
            {
              placementId: "project",
              operations: emptyOperations,
              satisfied: true,
              warnings: 0,
              failures: 0,
            },
          ],
        },
      ],
    },
  };
}
