import { describe, expect, it } from "vitest";

import type {
  PlanOperation,
  PlanOperationKind,
  SyncPlan,
} from "../../src/sync/types.js";

const baseFile = {
  skillName: "review",
  sourcePath: "/project/.agents/skills/review/SKILL.md",
  targetPath: "/project/.claude/skills/review/SKILL.md",
  linkValue: "../../../.agents/skills/review/SKILL.md",
  attributions: [{ harnessId: "claude-code", placementId: "project" }],
} as const;

const operations = [
  { ...baseFile, kind: "create" },
  { ...baseFile, kind: "update" },
  { ...baseFile, kind: "adopt" },
  { ...baseFile, kind: "skip" },
  { ...baseFile, kind: "stale" },
  { ...baseFile, kind: "conflict", reason: "Target is unmanaged." },
] satisfies readonly PlanOperation[];

describe("sync domain types", () => {
  it("models every operation as an explicit discriminated variant", () => {
    expect(operations.map((operation) => operation.kind)).toEqual<
      PlanOperationKind[]
    >(["create", "update", "adopt", "skip", "stale", "conflict"]);
    expect(operations.at(-1)).toMatchObject({
      kind: "conflict",
      reason: "Target is unmanaged.",
    });
  });

  it("keeps plan notices and satisfied placements separate from file operations", () => {
    const plan = {
      operations,
      satisfiedPlacements: [
        {
          harnessId: "codex",
          placementId: "project",
          sourceRoot: "/project/.agents/skills",
        },
      ],
      warnings: [{ message: "External target may break if the project moves." }],
      failures: [],
    } satisfies SyncPlan;

    expect(plan.operations).toHaveLength(6);
    expect(plan.satisfiedPlacements[0]?.harnessId).toBe("codex");
  });
});
