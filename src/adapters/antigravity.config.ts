import type { HarnessConfig } from "./schema.js";

const config = {
  name: "antigravity",
  displayName: "Antigravity",
  adapterStatus: "available",
  supportsNativeSkills: true,
  defaultProjectPlacementId: "project",
  placements: [
    {
      id: "project",
      item: "skills",
      support: "native",
      scope: "project",
      defaultPath: ".agents/skills",
      createIfMissing: true,
    },
    {
      id: "legacy-project",
      item: "skills",
      support: "compatibility",
      scope: "project",
      defaultPath: ".agent/skills",
      createIfMissing: true,
      notes: "Backward-compatible Antigravity workspace location.",
    },
    {
      id: "user",
      item: "skills",
      support: "native",
      scope: "user",
      defaultPath: "~/.gemini/config/skills",
      createIfMissing: true,
    },
  ],
  sources: ["https://antigravity.google/docs/skills"],
  verifiedAt: "2026-07-12",
} satisfies HarnessConfig;

export default config;
