import { describe, expect, it } from "vitest";
import type { input } from "zod";

import type { DistributorConfig } from "../../src/index.js";
import { DistributorConfigSchema } from "../../src/config/schema.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;

const publicTypeIsSchemaInput: Equal<
  DistributorConfig,
  input<typeof DistributorConfigSchema>
> = true;

const documentedConfig = {
  harnesses: ["codex", "claude-code", "opencode"],
} satisfies DistributorConfig;

describe("public DistributorConfig type", () => {
  it("is inferred from the runtime schema input", () => {
    expect(publicTypeIsSchemaInput).toBe(true);
    expect(DistributorConfigSchema.parse(documentedConfig).source).toBe(
      ".agents/skills",
    );
  });
});
