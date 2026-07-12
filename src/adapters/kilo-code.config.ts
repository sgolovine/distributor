import type { HarnessConfig } from "./schema.js";

const config = {
  name: "kilo-code",
  displayName: "Kilo Code",
  adapterStatus: "available",
  supportsNativeSkills: true,
  defaultProjectPlacementId: "project",
  placements: [
    {
      id: "project",
      item: "skills",
      support: "native",
      scope: "project",
      defaultPath: ".kilo/skills",
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
      defaultPath: "~/.kilo/skills",
      createIfMissing: true,
    },
  ],
  sources: ["https://kilo.ai/docs/customize/skills"],
  verifiedAt: "2026-07-12",
} satisfies HarnessConfig;

export default config;
