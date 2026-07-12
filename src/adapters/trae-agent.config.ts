import type { HarnessConfig } from "./schema.js";

const config = {
  name: "trae-agent",
  displayName: "Trae Agent",
  adapterStatus: "available",
  supportsNativeSkills: true,
  defaultProjectPlacementId: "project",
  placements: [
    {
      id: "project",
      item: "skills",
      support: "native",
      scope: "project",
      defaultPath: ".trae/skills",
      createIfMissing: true,
    },
    {
      id: "user",
      item: "skills",
      support: "native",
      scope: "user",
      defaultPath: "~/.trae/skills",
      createIfMissing: true,
    },
  ],
  sources: ["https://docs.trae.ai/ide/skills"],
  verifiedAt: "2026-07-12",
} satisfies HarnessConfig;

export default config;
