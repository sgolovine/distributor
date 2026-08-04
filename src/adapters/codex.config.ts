import type { HarnessConfig } from "./schema.js";

const config = {
  name: "codex",
  displayName: "Codex CLI",
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
      id: "user",
      item: "skills",
      support: "native",
      scope: "user",
      defaultPath: "~/.codex/skills",
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
      id: "admin",
      item: "skills",
      support: "native",
      scope: "admin",
      defaultPath: "/etc/codex/skills",
      createIfMissing: false,
    },
  ],
  sources: ["https://developers.openai.com/codex/skills"],
  verifiedAt: "2026-07-12",
} satisfies HarnessConfig;

export default config;
