import { z } from "zod";

export const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const SkillFrontmatterSchema = z
  .object({
    name: SkillNameSchema,
    description: z.string().min(1).max(1_024),
    license: z.string().optional(),
    compatibility: z.string().min(1).max(500).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    "allowed-tools": z.string().optional(),
  })
  .passthrough();

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
