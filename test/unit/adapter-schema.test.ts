import { describe, expect, it } from "vitest";

import {
  AdapterCatalogSchema,
  HarnessConfigSchema,
  HarnessPlacementSchema,
  parseHarnessConfig,
} from "../../src/adapters/schema.js";

function validConfig(overrides: Record<string, unknown> = {}): unknown {
  return {
    name: "example",
    displayName: "Example",
    adapterStatus: "available",
    supportsNativeSkills: true,
    defaultProjectPlacementId: "project",
    placements: [
      {
        id: "project",
        item: "skills",
        support: "native",
        scope: "project",
        defaultPath: ".example/skills",
        createIfMissing: true,
      },
    ],
    sources: ["https://example.com/skills"],
    verifiedAt: "2026-07-09",
    ...overrides,
  };
}

describe("HarnessPlacementSchema", () => {
  it("accepts every declared optional placement field", () => {
    expect(
      HarnessPlacementSchema.parse({
        id: "project",
        item: "skills",
        support: "compatibility",
        scope: "project",
        defaultPath: "$PROJECT_ROOT/.example/skills",
        environmentVariables: ["EXAMPLE_SKILLS", "FALLBACK_SKILLS"],
        createIfMissing: true,
        notes: "Example compatibility placement.",
      }),
    ).toEqual({
      id: "project",
      item: "skills",
      support: "compatibility",
      scope: "project",
      defaultPath: "$PROJECT_ROOT/.example/skills",
      environmentVariables: ["EXAMPLE_SKILLS", "FALLBACK_SKILLS"],
      createIfMissing: true,
      notes: "Example compatibility placement.",
    });
  });

  it("rejects unknown placement fields", () => {
    expect(() =>
      HarnessPlacementSchema.parse({
        id: "project",
        item: "skills",
        support: "native",
        scope: "project",
        defaultPath: ".example/skills",
        createIfMissing: true,
        unexpected: true,
      }),
    ).toThrow();
  });

  it.each([
    ["support", "experimental"],
    ["scope", "workspace"],
  ])("rejects an unknown %s enum value", (field, value) => {
    const placement = {
      id: "project",
      item: "skills",
      support: "native",
      scope: "project",
      defaultPath: ".example/skills",
      createIfMissing: true,
      [field]: value,
    };

    expect(() => HarnessPlacementSchema.parse(placement)).toThrow();
  });
});

describe("HarnessConfigSchema", () => {
  it("parses a valid available adapter", () => {
    expect(HarnessConfigSchema.parse(validConfig())).toEqual(validConfig());
  });

  it("allows sources and verifiedAt to be omitted", () => {
    const config = validConfig({
      sources: undefined,
      verifiedAt: undefined,
    });

    expect(HarnessConfigSchema.parse(config)).toEqual(config);
  });

  it("rejects unknown config fields", () => {
    expect(() =>
      HarnessConfigSchema.parse(validConfig({ unexpected: true })),
    ).toThrow();
  });

  it.each([
    ["Example", "name"],
    ["example", "verifiedAt", "2026-7-9"],
    ["example", "sources", ["not a URL"]],
  ])(
    "rejects malformed adapter metadata %#",
    (name, field, value = name) => {
      expect(() =>
        HarnessConfigSchema.parse(validConfig({ name, [field]: value })),
      ).toThrow();
    },
  );

  it("requires a default project placement for an available adapter", () => {
    const result = HarnessConfigSchema.safeParse(
      validConfig({ defaultProjectPlacementId: undefined }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["defaultProjectPlacementId"],
            message: "is required for an available adapter",
          }),
        ]),
      );
    }
  });

  it("rejects duplicate placement IDs", () => {
    const duplicate = {
      id: "project",
      item: "skills",
      support: "compatibility",
      scope: "project",
      defaultPath: ".agents/skills",
      createIfMissing: true,
    };
    const result = HarnessConfigSchema.safeParse(
      validConfig({
        placements: [
          {
            id: "project",
            item: "skills",
            support: "native",
            scope: "project",
            defaultPath: ".example/skills",
            createIfMissing: true,
          },
          duplicate,
        ],
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["placements", 1, "id"]);
    }
  });

  it("requires the default ID to reference a declared placement", () => {
    expect(() =>
      HarnessConfigSchema.parse(
        validConfig({ defaultProjectPlacementId: "missing" }),
      ),
    ).toThrow(/must reference a declared placement/);
  });

  it("requires the default placement to be project-scoped", () => {
    expect(() =>
      HarnessConfigSchema.parse(
        validConfig({
          defaultProjectPlacementId: "user",
          placements: [
            {
              id: "user",
              item: "skills",
              support: "native",
              scope: "user",
              defaultPath: "~/.example/skills",
              createIfMissing: true,
            },
          ],
        }),
      ),
    ).toThrow(/must reference a project-scoped placement/);
  });

  it("rejects an unverified default placement", () => {
    expect(() =>
      HarnessConfigSchema.parse(
        validConfig({
          placements: [
            {
              id: "project",
              item: "skills",
              support: "unverified",
              scope: "project",
              defaultPath: ".example/skills",
              createIfMissing: false,
            },
          ],
        }),
      ),
    ).toThrow(/must reference a native or compatibility placement/);
  });

  it("allows a roadmap adapter to omit a default", () => {
    expect(
      HarnessConfigSchema.parse(
        validConfig({
          adapterStatus: "planned",
          defaultProjectPlacementId: undefined,
        }),
      ).defaultProjectPlacementId,
    ).toBeUndefined();
  });

  it("validates config name against its module identity", () => {
    expect(() => parseHarnessConfig("different", validConfig())).toThrow(
      /must match adapter module name/,
    );
  });
});

describe("AdapterCatalogSchema", () => {
  it("rejects unknown catalog entry fields", () => {
    expect(() =>
      AdapterCatalogSchema.parse([
        {
          name: "example",
          displayName: "Example",
          adapterStatus: "planned",
          unexpected: true,
        },
      ]),
    ).toThrow();
  });

  it("rejects duplicate adapter IDs", () => {
    expect(() =>
      AdapterCatalogSchema.parse([
        {
          name: "example",
          displayName: "Example",
          adapterStatus: "available",
        },
        {
          name: "example",
          displayName: "Example Again",
          adapterStatus: "planned",
        },
      ]),
    ).toThrow(/duplicates adapter declared at index 0/);
  });
});
