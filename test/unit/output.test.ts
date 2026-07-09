import { describe, expect, it } from "vitest";

import { DistributorError } from "../../src/errors.js";
import {
  createOutput,
  formatDistributorError,
} from "../../src/output.js";

describe("terminal output", () => {
  it("formats structured diagnostics with a safe action", () => {
    const error = new DistributorError("config", "Invalid config.", {
      operation: "validate config",
      correction: "Fix the config and rerun Distributor.",
      issues: [
        {
          path: "harnesses[0]",
          message: "unknown harness",
          received: "future-tool",
          expected: "an available harness",
          correction: "Use codex, claude-code, or opencode.",
        },
      ],
    });

    expect(formatDistributorError(error)).toBe(`Error: Invalid config.
- harnesses[0]: unknown harness
  received: "future-tool"
  expected: an available harness
  action: Use codex, claude-code, or opencode.
Action: Fix the config and rerun Distributor.
`);
  });

  it("routes diagnostics to stderr without color outside a TTY", () => {
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

    output.printError(new DistributorError("source", "Missing source."));

    expect(stdout).toBe("");
    expect(stderr).toBe("Error: Missing source.\n");
    expect(stderr).not.toContain("\u001B[");
  });

  it("enables color only for a TTY when NO_COLOR is absent", () => {
    let colored = "";
    let plain = "";
    createOutput({
      writeErr: (text) => {
        colored += text;
      },
      stdoutIsTTY: true,
      noColor: false,
    }).printError(new DistributorError("source", "failure"));
    createOutput({
      writeErr: (text) => {
        plain += text;
      },
      stdoutIsTTY: true,
      noColor: true,
    }).printError(new DistributorError("source", "failure"));

    expect(colored).toContain("\u001B[");
    expect(plain).toBe("Error: failure\n");
  });

  it("reports created init artifacts and successful no-ops", () => {
    let text = "";
    const output = createOutput({
      writeOut: (chunk) => {
        text += chunk;
      },
    });
    const base = {
      projectRoot: "/project",
      configPath: "/project/distributor.config.json",
      sourceRoot: "/project/.agents/skills",
      outcomes: [
        {
          artifact: "config" as const,
          status: "created" as const,
          path: "/project/distributor.config.json",
        },
      ],
    };

    output.printInit({ ...base, noOp: false });
    expect(text).toContain("Initialized Distributor at /project.");
    expect(text).toContain("config: created");

    text = "";
    output.printInit({ ...base, noOp: true });
    expect(text).toBe("Distributor is already initialized at /project.\n");
  });
});
