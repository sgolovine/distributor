import type { HarnessConfig } from "./schema.js";

const config = {
  name: "cline",
  displayName: "Cline",
  adapterStatus: "available",
  supportsNativeSkills: true,
  defaultProjectPlacementId: "project",
  placements: [
    {
      id: "project",
      item: "skills",
      support: "native",
      scope: "project",
      defaultPath: ".cline/skills",
      createIfMissing: true,
    },
    {
      id: "clinerules-project",
      item: "skills",
      support: "compatibility",
      scope: "project",
      defaultPath: ".clinerules/skills",
      createIfMissing: true,
    },
    {
      id: "claude-project",
      item: "skills",
      support: "compatibility",
      scope: "project",
      defaultPath: ".claude/skills",
      createIfMissing: true,
    },
    {
      id: "user",
      item: "skills",
      support: "native",
      scope: "user",
      defaultPath: "~/.cline/skills",
      createIfMissing: true,
    },
  ],
  sources: ["https://docs.cline.bot/customization/skills"],
  verifiedAt: "2026-07-12",
} satisfies HarnessConfig;

export default config;
