import { z } from "zod";

export const StateAttributionSchema = z
  .object({
    harnessId: z.string().min(1),
    placementId: z.string().min(1),
  })
  .strict();

export const StateEntrySchema = z
  .object({
    sourcePath: z.string().min(1),
    targetPath: z.string().min(1),
    linkValue: z.string().min(1),
    attributions: z.array(StateAttributionSchema).min(1),
  })
  .strict();

export const ManagedStateSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(StateEntrySchema),
  })
  .strict();

export type SerializedStateAttribution = z.infer<
  typeof StateAttributionSchema
>;
export type SerializedStateEntry = z.infer<typeof StateEntrySchema>;
export type SerializedManagedState = z.infer<typeof ManagedStateSchema>;
