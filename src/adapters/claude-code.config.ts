import type { HarnessConfig } from "./schema.js";

const config = {
  name: "claude-code",
  displayName: "Claude Code",
  adapterStatus: "available",
  supportsNativeSkills: true,
  defaultProjectPlacementId: "project",
  placements: [
    {
      id: "project",
      item: "skills",
      support: "native",
      scope: "project",
      defaultPath: ".claude/skills",
      createIfMissing: true,
    },
    {
      id: "user",
      item: "skills",
      support: "native",
      scope: "user",
      defaultPath: "~/.claude/skills",
      createIfMissing: true,
    },
  ],
  sources: ["https://code.claude.com/docs/en/skills"],
  verifiedAt: "2026-07-09",
} satisfies HarnessConfig;

export default config;
