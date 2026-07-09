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
      source: ".agents/skills",
      harnesses: ["codex"],
    });
  });
});
