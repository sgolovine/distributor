import { describe, expect, it } from "vitest";

import {
  DistributorError,
  exitCodeForFailure,
  validationError,
  type FailureCategory,
} from "../../src/errors.js";

describe("DistributorError", () => {
  it.each<[FailureCategory, 1 | 2]>([
    ["usage", 2],
    ["config", 2],
    ["source", 1],
    ["state", 1],
    ["conflict", 1],
    ["filesystem", 1],
  ])("maps %s failures to exit %i", (category, exitCode) => {
    expect(exitCodeForFailure(category)).toBe(exitCode);
    expect(new DistributorError(category, "failed").exitCode).toBe(exitCode);
  });

  it("retains structured diagnostic context", () => {
    const cause = new Error("permission denied");
    const error = new DistributorError("filesystem", "Could not create link.", {
      operation: "create symlink",
      context: {
        harness: "claude-code",
        target: ".claude/skills/review/SKILL.md",
      },
      received: "EACCES",
      correction: "Enable file symlinks and retry.",
      cause,
    });

    expect(error).toMatchObject({
      name: "DistributorError",
      category: "filesystem",
      exitCode: 1,
      operation: "create symlink",
      received: "EACCES",
      correction: "Enable file symlinks and retry.",
    });
    expect(error.context).toEqual({
      harness: "claude-code",
      target: ".claude/skills/review/SKILL.md",
    });
    expect(error.cause).toBe(cause);
    expect(error.issues).toEqual([]);
  });

  it("aggregates every validation issue", () => {
    const issues = [
      {
        path: "harnesses[0]",
        message: "Unknown harness.",
        received: "unknown",
        expected: "An available harness ID.",
        correction: "Choose codex, claude-code, or opencode.",
      },
      {
        path: "source",
        message: "Path is empty.",
        expected: "A non-empty path.",
      },
    ];

    const error = validationError(
      "config",
      "Project configuration is invalid.",
      issues,
      { context: { config: "/project/distributor.config.json" } },
    );
    issues.pop();

    expect(error.exitCode).toBe(2);
    expect(error.issues).toHaveLength(2);
    expect(error.issues.map((issue) => issue.path)).toEqual([
      "harnesses[0]",
      "source",
    ]);
  });

  it("rejects an empty validation aggregate", () => {
    expect(() =>
      validationError("source", "Source skills are invalid.", []),
    ).toThrow("requires at least one issue");
  });
});
