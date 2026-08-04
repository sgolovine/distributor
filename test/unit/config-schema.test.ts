import { describe, expect, it } from "vitest";

import { DistributorConfigSchema } from "../../src/config/schema.js";

describe("DistributorConfigSchema", () => {
  const harnesses = [
    { name: "codex", useHarnessFolder: false },
    { name: "claude-code", useHarnessFolder: false },
    { name: "opencode", useHarnessFolder: true },
  ];

  it("accepts the documented default configuration", () => {
    expect(
      DistributorConfigSchema.parse({
        source: ".agents/skills",
        harnesses,
      }),
    ).toEqual({
      scope: "project",
      source: ".agents/skills",
      harnesses,
    });
  });

  it("rejects unknown fields", () => {
    expect(() =>
      DistributorConfigSchema.parse({
        harnesses: [{ name: "codex", useHarnessFolder: false }],
        unexpected: true,
      }),
    ).toThrow();
  });

  it("applies the runtime source default", () => {
    expect(
      DistributorConfigSchema.parse({
        harnesses: [{ name: "codex", useHarnessFolder: false }],
      }),
    ).toEqual({
      scope: "project",
      source: ".agents/skills",
      harnesses: [{ name: "codex", useHarnessFolder: false }],
    });
  });

  it("accepts global automatic placement", () => {
    expect(
      DistributorConfigSchema.parse({
        scope: "global",
        harnesses: [{ name: "opencode", useHarnessFolder: true }],
      }).scope,
    ).toBe("global");
  });

  it("rejects legacy string harness entries and defaults the folder policy", () => {
    expect(() =>
      DistributorConfigSchema.parse({ harnesses: ["codex"] }),
    ).toThrow();
    expect(
      DistributorConfigSchema.parse({ harnesses: [{ name: "codex" }] }),
    ).toMatchObject({
      harnesses: [{ name: "codex", useHarnessFolder: false }],
    });
  });
});
