import type { HarnessConfig } from "./schema.js";

const config = {
  name: "gemini-cli",
  displayName: "Gemini CLI",
  adapterStatus: "available",
  supportsNativeSkills: true,
  defaultProjectPlacementId: "project",
  placements: [
    {
      id: "project",
      item: "skills",
      support: "native",
      scope: "project",
      defaultPath: ".gemini/skills",
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
      defaultPath: "~/.gemini/skills",
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
  sources: ["https://geminicli.com/docs/cli/using-agent-skills/"],
  verifiedAt: "2026-07-12",
} satisfies HarnessConfig;

export default config;
