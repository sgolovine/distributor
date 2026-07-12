import type { HarnessConfig } from "./schema.js";

const config = {
  name: "roo-code",
  displayName: "Roo Code",
  adapterStatus: "available",
  supportsNativeSkills: true,
  defaultProjectPlacementId: "project",
  placements: [
    {
      id: "project",
      item: "skills",
      support: "native",
      scope: "project",
      defaultPath: ".roo/skills",
      createIfMissing: true,
    },
    {
      id: "agents-project",
      item: "skills",
      support: "compatibility",
      scope: "project",
      defaultPath: ".agents/skills",
      createIfMissing: true,
    },
    {
      id: "user",
      item: "skills",
      support: "native",
      scope: "user",
      defaultPath: "~/.roo/skills",
      createIfMissing: true,
    },
    {
      id: "agents-user",
      item: "skills",
      support: "compatibility",
      scope: "user",
      defaultPath: "~/.agents/skills",
      createIfMissing: true,
    },
  ],
  sources: ["https://docs.roocode.com/features/skills"],
  verifiedAt: "2026-07-12",
} satisfies HarnessConfig;

export default config;
