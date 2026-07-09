import { describe, expect, it } from "vitest";

import { SkillFrontmatterSchema } from "../../src/skills/schema.js";

describe("SkillFrontmatterSchema", () => {
  it("accepts the exact string length boundaries", () => {
    expect(
      SkillFrontmatterSchema.safeParse({
        name: "a".repeat(64),
        description: "a".repeat(1_024),
        compatibility: "a".repeat(500),
      }).success,
    ).toBe(true);
  });

  it("accepts standard optional fields and preserves unknown keys", () => {
    expect(
      SkillFrontmatterSchema.parse({
        name: "review-code",
        description: "Review a change.",
        license: "MIT",
        compatibility: "Requires Git.",
        metadata: { owner: "platform" },
        "allowed-tools": "Read Grep",
        extension: { enabled: true },
      }),
    ).toEqual({
      name: "review-code",
      description: "Review a change.",
      license: "MIT",
      compatibility: "Requires Git.",
      metadata: { owner: "platform" },
      "allowed-tools": "Read Grep",
      extension: { enabled: true },
    });
  });

  it.each([
    ["name", { name: "Uppercase", description: "Valid" }],
    ["name length", { name: "a".repeat(65), description: "Valid" }],
    ["description", { name: "valid", description: "" }],
    [
      "description length",
      { name: "valid", description: "a".repeat(1_025) },
    ],
    [
      "compatibility",
      { name: "valid", description: "Valid", compatibility: "" },
    ],
    [
      "compatibility length",
      {
        name: "valid",
        description: "Valid",
        compatibility: "a".repeat(501),
      },
    ],
    [
      "metadata value",
      { name: "valid", description: "Valid", metadata: { owner: 1 } },
    ],
    [
      "allowed-tools type",
      { name: "valid", description: "Valid", "allowed-tools": ["Read"] },
    ],
    [
      "license type",
      { name: "valid", description: "Valid", license: 1 },
    ],
  ])("rejects an invalid %s", (_label, frontmatter) => {
    expect(SkillFrontmatterSchema.safeParse(frontmatter).success).toBe(false);
  });
});
