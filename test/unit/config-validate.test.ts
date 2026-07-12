import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DistributorError } from "../../src/errors.js";
import { validateProjectConfig } from "../../src/config/validate.js";

const discovered = {
  configPath: "/project/distributor.config.json",
  projectRoot: "/project",
};

const options = { homeDirectory: "/home/test", pathStyle: "posix" as const };

describe("validateProjectConfig", () => {
  it("applies the source default and sorts available harnesses", () => {
    const config = validateProjectConfig(
      { harnesses: ["opencode", "codex", "claude-code"] },
      discovered,
      options,
    );

    expect(config.sourceRoot).toBe(join("/project", ".agents/skills"));
    expect(config.harnesses.map((harness) => harness.name)).toEqual([
      "claude-code",
      "codex",
      "opencode",
    ]);
    expect(
      config.harnesses.every((harness) => harness.targets === undefined),
    ).toBe(true);
  });

  it("aggregates duplicate and unknown harness problems", () => {
    expect.assertions(5);

    try {
      validateProjectConfig(
        { harnesses: ["codex", "codex", "invented"] },
        discovered,
        options,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(DistributorError);
      const failure = error as DistributorError;
      expect(failure.exitCode).toBe(2);
      expect(failure.issues).toHaveLength(2);
      expect(failure.issues.map((issue) => issue.message).join("\n")).toContain(
        "duplicates harness",
      );
      expect(failure.issues.map((issue) => issue.message).join("\n")).toContain(
        "unknown harness",
      );
    }
  });

  it("retains placement metadata when a target path is overridden", () => {
    const config = validateProjectConfig(
      {
        harnesses: [
          {
            name: "claude-code",
            targets: [{ placement: "user", path: ".custom/claude" }],
          },
        ],
      },
      discovered,
      options,
    );

    expect(config.harnesses[0]?.targets?.[0]).toMatchObject({
      placement: {
        id: "user",
        scope: "user",
        createIfMissing: true,
      },
      targetRoot: "/project/.custom/claude",
      hasPathOverride: true,
    });
  });

  it("rejects known placements outside project and user scope", () => {
    expect(() =>
      validateProjectConfig(
        {
          harnesses: [{ name: "codex", targets: [{ placement: "admin" }] }],
        },
        discovered,
        options,
      ),
    ).toThrow(/distributor config/i);
  });

  it("rejects duplicate effective target roots", () => {
    try {
      validateProjectConfig(
        {
          harnesses: [
            {
              name: "opencode",
              targets: [
                { placement: "agents-project" },
                { placement: "project", path: ".agents/skills" },
              ],
            },
          ],
        },
        discovered,
        options,
      );
      expect.fail("Expected duplicate targets to fail");
    } catch (error) {
      expect((error as DistributorError).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("duplicates"),
          }),
        ]),
      );
    }
  });

  it("rejects unsupported expansion syntax with field context", () => {
    try {
      validateProjectConfig(
        { source: "$UNSUPPORTED/skills", harnesses: ["codex"] },
        discovered,
        options,
      );
      expect.fail("Expected invalid expansion to fail");
    } catch (error) {
      expect((error as DistributorError).issues).toEqual([
        expect.objectContaining({
          path: "source",
          received: "$UNSUPPORTED/skills",
        }),
      ]);
    }
  });

  it("reports strict nested schema errors with their field paths", () => {
    try {
      validateProjectConfig(
        {
          harnesses: [
            {
              name: "codex",
              targets: [{ path: ".custom", extra: true }],
            },
          ],
        },
        discovered,
        options,
      );
      expect.fail("Expected strict parsing to fail");
    } catch (error) {
      const failure = error as DistributorError;
      expect(failure.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: expect.stringContaining("harnesses[0].targets[0]"),
          }),
        ]),
      );
      expect(failure.context?.configPath).toBe(discovered.configPath);
    }
  });
});
