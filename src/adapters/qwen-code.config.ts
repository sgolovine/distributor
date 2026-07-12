import type { HarnessConfig } from "./schema.js";

const config = {
  name: "qwen-code",
  displayName: "Qwen Code",
  adapterStatus: "available",
  supportsNativeSkills: true,
  defaultProjectPlacementId: "project",
  placements: [
    {
      id: "project",
      item: "skills",
      support: "native",
      scope: "project",
      defaultPath: ".qwen/skills",
      createIfMissing: true,
    },
    {
      id: "user",
      item: "skills",
      support: "native",
      scope: "user",
      defaultPath: "~/.qwen/skills",
      createIfMissing: true,
    },
  ],
  sources: [
    "https://qwenlm.github.io/qwen-code-docs/en/users/features/skills/",
  ],
  verifiedAt: "2026-07-12",
} satisfies HarnessConfig;

export default config;
