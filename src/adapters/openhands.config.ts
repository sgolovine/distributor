import type { HarnessConfig } from "./schema.js";

const config = {
  name: "openhands",
  displayName: "OpenHands",
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
      defaultPath: ".openhands/skills",
      createIfMissing: true,
      notes: "Deprecated OpenHands project location.",
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
      id: "openhands-user",
      item: "skills",
      support: "compatibility",
      scope: "user",
      defaultPath: "~/.openhands/skills",
      createIfMissing: true,
    },
  ],
  sources: ["https://docs.openhands.dev/overview/skills"],
  verifiedAt: "2026-07-12",
} satisfies HarnessConfig;

export default config;
