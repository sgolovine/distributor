import { z } from "zod";

const KebabCaseIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be lowercase kebab-case");

export const AdapterStatusSchema = z.enum([
  "available",
  "planned",
  "blocked",
]);

export const HarnessPlacementSupportSchema = z.enum([
  "native",
  "compatibility",
  "unverified",
]);

export const HarnessPlacementScopeSchema = z.enum([
  "project",
  "user",
  "admin",
  "system",
  "plugin",
  "package",
  "configured",
]);

export const HarnessPlacementSchema = z
  .object({
    id: z.string().min(1),
    item: z.string().min(1),
    support: HarnessPlacementSupportSchema,
    scope: HarnessPlacementScopeSchema,
    defaultPath: z.string().min(1),
    environmentVariables: z.array(z.string().min(1)).optional(),
    createIfMissing: z.boolean(),
    notes: z.string().min(1).optional(),
  })
  .strict();

export const HarnessConfigSchema = z
  .object({
    name: KebabCaseIdSchema,
    displayName: z.string().min(1),
    adapterStatus: AdapterStatusSchema,
    supportsNativeSkills: z.boolean(),
    defaultProjectPlacementId: z.string().min(1).optional(),
    placements: z.array(HarnessPlacementSchema).min(1),
    sources: z.array(z.string().url()).min(1).optional(),
    verifiedAt: z.iso.date().optional(),
  })
  .strict()
  .superRefine((config, context) => {
    const placementIndexes = new Map<string, number>();

    for (const [index, placement] of config.placements.entries()) {
      const priorIndex = placementIndexes.get(placement.id);
      if (priorIndex !== undefined) {
        context.addIssue({
          code: "custom",
          message: `duplicates placement ID declared at index ${priorIndex}`,
          path: ["placements", index, "id"],
        });
      } else {
        placementIndexes.set(placement.id, index);
      }
    }

    const defaultId =
      config.defaultProjectPlacementId ??
      (config.adapterStatus === "available" && config.placements.length === 1
        ? config.placements[0]?.id
        : undefined);
    if (config.adapterStatus === "available" && defaultId === undefined) {
      context.addIssue({
        code: "custom",
        message:
          "is required for an available adapter with multiple placements",
        path: ["defaultProjectPlacementId"],
      });
      return;
    }

    if (defaultId === undefined) {
      return;
    }

    const defaultPlacement = config.placements.find(
      (placement) => placement.id === defaultId,
    );
    if (defaultPlacement === undefined) {
      context.addIssue({
        code: "custom",
        message: `must reference a declared placement; received ${JSON.stringify(defaultId)}`,
        path: ["defaultProjectPlacementId"],
      });
      return;
    }

    if (defaultPlacement.scope !== "project") {
      context.addIssue({
        code: "custom",
        message: "must reference a project-scoped placement",
        path: ["defaultProjectPlacementId"],
      });
    }

    if (
      defaultPlacement.support !== "native" &&
      defaultPlacement.support !== "compatibility"
    ) {
      context.addIssue({
        code: "custom",
        message: "must reference a native or compatibility placement",
        path: ["defaultProjectPlacementId"],
      });
    }
  })
  .transform((config) =>
    config.adapterStatus === "available" &&
    config.defaultProjectPlacementId === undefined &&
    config.placements.length === 1
      ? {
          ...config,
          defaultProjectPlacementId: config.placements[0]!.id,
        }
      : config,
  );

export const AdapterCatalogEntrySchema = z
  .object({
    name: KebabCaseIdSchema,
    displayName: z.string().min(1),
    adapterStatus: AdapterStatusSchema,
  })
  .strict();

export const AdapterCatalogSchema = z
  .array(AdapterCatalogEntrySchema)
  .min(1)
  .superRefine((entries, context) => {
    const indexes = new Map<string, number>();

    for (const [index, entry] of entries.entries()) {
      const priorIndex = indexes.get(entry.name);
      if (priorIndex !== undefined) {
        context.addIssue({
          code: "custom",
          message: `duplicates adapter declared at index ${priorIndex}`,
          path: [index, "name"],
        });
      } else {
        indexes.set(entry.name, index);
      }
    }
  });

export function parseHarnessConfig(
  expectedName: string,
  config: unknown,
): HarnessConfig {
  return HarnessConfigSchema.refine(
    (value) => value.name === expectedName,
    {
      message: `must match adapter module name ${JSON.stringify(expectedName)}`,
      path: ["name"],
    },
  ).parse(config);
}

export type AdapterStatus = z.infer<typeof AdapterStatusSchema>;
export type HarnessPlacementSupport = z.infer<
  typeof HarnessPlacementSupportSchema
>;
export type HarnessPlacementScope = z.infer<
  typeof HarnessPlacementScopeSchema
>;
export type HarnessPlacement = z.infer<typeof HarnessPlacementSchema>;
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
export type AdapterCatalogEntry = z.infer<typeof AdapterCatalogEntrySchema>;
