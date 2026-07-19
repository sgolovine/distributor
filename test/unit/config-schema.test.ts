import { describe, expect, it } from "vitest";

import { DistributorConfigSchema } from "../../src/config/schema.js";

describe("DistributorConfigSchema", () => {
  it("accepts the documented default configuration", () => {
    expect(
      DistributorConfigSchema.parse({
        source: ".agents/skills",
        harnesses: ["codex", "claude-code", "opencode"],
      }),
    ).toEqual({
      scope: "project",
      source: ".agents/skills",
      harnesses: ["codex", "claude-code", "opencode"],
    });
  });

  it("rejects unknown fields", () => {
    expect(() =>
      DistributorConfigSchema.parse({
        harnesses: ["codex"],
        unexpected: true,
      }),
    ).toThrow();
  });

  it("applies the runtime source default", () => {
    expect(DistributorConfigSchema.parse({ harnesses: ["codex"] })).toEqual({
      scope: "project",
      source: ".agents/skills",
      harnesses: ["codex"],
    });
  });

  it("accepts global automatic placement", () => {
    expect(
      DistributorConfigSchema.parse({
        scope: "global",
        harnesses: ["opencode"],
      }).scope,
    ).toBe("global");
  });
});
