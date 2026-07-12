import type { HarnessConfig } from "./schema.js";

const config = {
  name: "goose",
  displayName: "Goose",
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
      notes: "Requires the built-in Summon extension in goose v1.25.0+.",
    },
    {
      id: "goose-project",
      item: "skills",
      support: "compatibility",
      scope: "project",
      defaultPath: ".goose/skills",
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
      defaultPath: "~/.agents/skills",
      createIfMissing: true,
    },
    {
      id: "claude-user",
      item: "skills",
      support: "compatibility",
      scope: "user",
      defaultPath: "~/.claude/skills",
      createIfMissing: true,
    },
  ],
  sources: [
    "https://goose-docs.ai/docs/guides/context-engineering/using-skills/",
  ],
  verifiedAt: "2026-07-12",
} satisfies HarnessConfig;

export default config;
