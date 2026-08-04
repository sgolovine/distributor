import { z } from "zod";

export const DEFAULT_SOURCE_PATH = ".agents/skills";
export const DEFAULT_SYNC_SCOPE = "project";

export const SyncScopeSchema = z.enum(["project", "global"]);

export const TargetSelectionSchema = z
  .object({
    placement: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
  })
  .strict();

export const HarnessSelectionSchema = z
  .object({
    name: z.string().min(1),
    useHarnessFolder: z.boolean().default(false),
    targets: z.array(TargetSelectionSchema).min(1).optional(),
  })
  .strict();

export const DistributorConfigSchema = z
  .object({
    scope: SyncScopeSchema.default(DEFAULT_SYNC_SCOPE),
    source: z.string().min(1).default(DEFAULT_SOURCE_PATH),
    harnesses: z.array(HarnessSelectionSchema).min(1),
  })
  .strict();

export type DistributorConfig = z.input<typeof DistributorConfigSchema>;
export type ParsedDistributorConfig = z.output<typeof DistributorConfigSchema>;
export type SyncScope = z.infer<typeof SyncScopeSchema>;
export type HarnessSelection = z.infer<typeof HarnessSelectionSchema>;
export type TargetSelection = z.infer<typeof TargetSelectionSchema>;
