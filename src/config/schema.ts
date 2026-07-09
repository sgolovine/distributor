import { z } from "zod";

export const TargetSelectionSchema = z
  .object({
    placement: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
  })
  .strict();

export const HarnessSelectionSchema = z.union([
  z.string().min(1),
  z
    .object({
      name: z.string().min(1),
      targets: z.array(TargetSelectionSchema).min(1).optional(),
    })
    .strict(),
]);

export const DistributorConfigSchema = z
  .object({
    source: z.string().min(1).optional(),
    harnesses: z.array(HarnessSelectionSchema).min(1),
  })
  .strict();

export type DistributorConfig = z.infer<typeof DistributorConfigSchema>;
export type HarnessSelection = z.infer<typeof HarnessSelectionSchema>;
export type TargetSelection = z.infer<typeof TargetSelectionSchema>;
