import type { HarnessConfig } from "./schema.js";

const config = {
  name: "crush",
  displayName: "Crush",
  adapterStatus: "available",
  supportsNativeSkills: true,
  defaultProjectPlacementId: "project",
  placements: [
    {
      id: "project",
      item: "skills",
      support: "native",
      scope: "project",
      defaultPath: ".crush/skills",
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
      id: "claude-project",
      item: "skills",
      support: "compatibility",
      scope: "project",
      defaultPath: ".claude/skills",
      createIfMissing: true,
    },
    {
      id: "cursor-project",
      item: "skills",
      support: "compatibility",
      scope: "project",
      defaultPath: ".cursor/skills",
      createIfMissing: true,
    },
    {
      id: "user",
      item: "skills",
      support: "native",
      scope: "user",
      defaultPath: "~/.config/crush/skills",
      environmentVariables: ["CRUSH_SKILLS_DIR"],
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
    {
      id: "claude-user",
      item: "skills",
      support: "compatibility",
      scope: "user",
      defaultPath: "~/.claude/skills",
      createIfMissing: true,
    },
  ],
  sources: ["https://github.com/charmbracelet/crush#agent-skills"],
  verifiedAt: "2026-07-12",
} satisfies HarnessConfig;

export default config;
