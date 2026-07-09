# Distributor Harness Configuration Specification

## Purpose

This document defines stable harness IDs, adapter availability, placement data,
and source evidence. It complements `SPEC.md`; it does not expand the initial
release merely by listing a roadmap harness.

Only harnesses with native Agent Skills support or documented compatibility
with the Agent Skills directory format belong in this matrix. Rules, prompts,
recipes, commands, and other adjacent concepts are out of scope unless a future
product surface explicitly supports them.

## Adapter And Placement Model

Each implemented adapter has one configuration module named:

```text
<harness-id>.config.ts
```

The module must default-export one `HarnessConfig` object. Adapter planning code
must consume this object and must not hard-code placement directories.

```ts
export type AdapterStatus = "available" | "planned" | "blocked";

export type HarnessPlacementSupport =
  | "native"
  | "compatibility"
  | "unverified";

export type HarnessPlacementScope =
  | "project"
  | "user"
  | "admin"
  | "system"
  | "plugin"
  | "package"
  | "configured";

export type HarnessPlacement = {
  /** Stable ID used in Distributor project configuration. */
  id: string;

  /** Harness-relative logical item name. The initial release uses "skills". */
  item: string;

  /** Whether the harness documents this as native, compatible, or unverified. */
  support: HarnessPlacementSupport;

  /** Scope at which the harness discovers the placement. */
  scope: HarnessPlacementScope;

  /**
   * Default directory for this placement. Relative paths use the Distributor
   * project root. "~", "$HOME", and "$PROJECT_ROOT" may be used.
   */
  defaultPath: string;

  /**
   * Ordered environment variables whose non-empty value may override this
   * placement after the placement is explicitly selected.
   */
  environmentVariables?: string[];

  /** Whether Distributor may create the directory when it is missing. */
  createIfMissing: boolean;

  /** Human-readable caveats, feature flags, or precedence notes. */
  notes?: string;
};

export type HarnessConfig = {
  /** Stable lowercase kebab-case ID used by config, CLI flags, and reports. */
  name: string;

  /** Human-readable product name. */
  displayName: string;

  /** Implementation availability, independent from documentation confidence. */
  adapterStatus: AdapterStatus;

  /** Whether the product consumes the Agent Skills directory format. */
  supportsNativeSkills: boolean;

  /**
   * Placement selected for an automatic project target when the source root is
   * not already one of the declared compatible project placements.
   */
  defaultProjectPlacementId?: string;

  /** Every placement the adapter uses for discovery or output decisions. */
  placements: HarnessPlacement[];

  /** Primary documentation or source-code URLs supporting the placement data. */
  sources: string[];

  /** ISO date on which the placement claims were last checked. */
  verifiedAt: string;
};
```

### Invariants

- `name` must match both the matrix ID and module filename.
- Placement IDs must be unique within an adapter.
- An `available` adapter must declare a `defaultProjectPlacementId` referencing
  a `project` placement whose support is `native` or `compatibility`.
- A `planned` adapter has sufficient placement evidence but no shipping
  implementation. It cannot be selected by project configuration.
- A `blocked` adapter lacks a verified, safe project output or has another
  documented blocker. It cannot be selected by project configuration.
- A placement marked `unverified` is evidence for future research only. It
  cannot satisfy a source location, be selected for output, or be the default.
- Project and user placements with the same logical item must have distinct IDs.
- Environment-variable order is significant. Empty variables are ignored; an
  undefined variable referenced by a selected default path is an error.
- `sources` must contain primary product documentation or first-party source
  code. Issues may supplement but not replace primary evidence for an available
  adapter.

## Stable Harness IDs And Roadmap

| Harness ID | Display name | Adapter status | Placement confidence |
| --- | --- | --- | --- |
| `codex` | Codex CLI | available | verified |
| `claude-code` | Claude Code | available | verified |
| `opencode` | OpenCode | available | verified |
| `cursor` | Cursor | planned | verified |
| `gemini-cli` | Gemini CLI | planned | verified |
| `antigravity` | Antigravity | planned | verified with variant caveats |
| `github-copilot` | GitHub Copilot | planned | verified |
| `openhands` | OpenHands | planned | verified with installer caveats |
| `pi` | Pi | planned | verified |
| `cline` | Cline | planned | verified |
| `goose` | Goose | planned | verified with extension caveat |
| `crush` | Crush | blocked | unverified |
| `qwen-code` | Qwen Code | blocked | exact paths unverified |
| `kilo-code` | Kilo Code | planned | verified |
| `roo-code` | Roo Code | planned | verified |
| `trae-agent` | Trae Agent | blocked | exact path unverified |

Only `available` rows are part of the initial public CLI. Moving a row to
`available` requires an implemented config module, adapter tests, a current
primary source, and an update to the acceptance coverage in `SPEC.md`.

## Skill Placement Matrix

“Fallback output” is used only when the configured source root is not already a
placement the harness discovers. With the default `.agents/skills` source, many
rows are satisfied in place and require no link. This avoids duplicate catalog
entries in harnesses that scan both their product-specific directory and
`.agents/skills`.

| Harness | Fallback project output | Other discovered locations or notes | Sources |
| --- | --- | --- | --- |
| OpenCode | `.opencode/skills/<name>/SKILL.md` | Also discovers `.agents/skills`, `.claude/skills`, `~/.config/opencode/skills`, `~/.agents/skills`, and `~/.claude/skills`. The default source is therefore satisfied in place. | https://opencode.ai/docs/skills/ |
| Claude Code | `.claude/skills/<name>/SKILL.md` | User skills use `~/.claude/skills`; plugin and enterprise scopes also exist. Claude Code does not document `.agents/skills` as a project discovery path. | https://code.claude.com/docs/en/skills |
| Codex CLI | `.agents/skills/<name>/SKILL.md` | Repository discovery scans `.agents/skills` from the working directory to the repo root. User and admin locations are `~/.agents/skills` and `/etc/codex/skills`. The default source is satisfied in place. | https://developers.openai.com/codex/skills |
| Cursor | `.cursor/skills/<name>/SKILL.md` | Also discovers project and user `.agents/skills`, plus documented compatibility locations. The default source will be satisfied in place once the adapter ships. | https://cursor.com/docs/skills |
| Gemini CLI | `.gemini/skills/<name>/SKILL.md` | Also discovers `.agents/skills` and `~/.agents/skills`; extension-bundled skills are another tier. | https://geminicli.com/docs/cli/skills/ |
| Antigravity | `.agents/skills/<name>/SKILL.md` | Global paths vary across CLI and IDE variants, including paths under `~/.gemini`; implementation must pin supported product variants. | https://antigravity.google/docs/skills, https://antigravity.google/docs/cli/plugins |
| GitHub Copilot | `.github/skills/<name>/SKILL.md` | Also documents project `.agents/skills` and `.claude/skills`; personal skills include `~/.copilot/skills` and `~/.agents/skills`. | https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills, https://code.visualstudio.com/docs/agent-customization/agent-skills |
| OpenHands | `.agents/skills/<name>/SKILL.md` | SDK-installed skills under `~/.openhands/skills/installed` use installer metadata and are not a safe direct-link target without additional design. | https://docs.openhands.dev/overview/skills, https://docs.openhands.dev/sdk/guides/skill |
| Pi | `.pi/skills/<name>/SKILL.md` | Also discovers ancestor `.agents/skills`, user `.agents/skills`, package skills, configured arrays, and explicit `--skill` paths. | https://pi.dev/docs/latest/skills |
| Cline | `.cline/skills/<name>/SKILL.md` | Also discovers `.clinerules/skills` and `.claude/skills`; the global Windows location differs syntactically. | https://docs.cline.bot/customization/skills |
| Goose | `.agents/skills/<name>/SKILL.md` | Requires the built-in Summon extension in documented versions and has backward-compatible `.goose/skills` and `.claude/skills` locations. | https://goose-docs.ai/docs/guides/context-engineering/using-skills/ |
| Crush | Unverified; no output permitted | Public issue discussion mentions `.crush/skills`, but an available adapter requires first-party documentation or verified source behavior for the supported version. | https://github.com/charmbracelet/crush, https://github.com/charmbracelet/crush/issues/2072 |
| Qwen Code | Unverified; no output permitted | Native skills are documented, but exact filesystem paths and precedence must be confirmed from static first-party docs or source before implementation. | https://qwenlm.github.io/qwen-code-docs/en/users/features/skills/, https://github.com/QwenLM/qwen-code |
| Kilo Code | `.kilo/skills/<name>/SKILL.md` | Also loads `.agents/skills`; `.claude/skills` depends on Claude Code Compatibility. Extra paths may be configured in `kilo.jsonc`. | https://kilo.ai/docs/customize/skills |
| Roo Code | `.roo/skills/<name>/SKILL.md` | Also supports `.agents/skills`, user locations, and mode-specific `skills-{mode}` variants. | https://docs.roocode.com/features/skills |
| Trae Agent | Unverified; no output permitted | `SKILL.md` support is documented, but a stable filesystem path was not verified. | https://docs.trae.ai/ide/skills |

## Available Adapter Configurations

The shipping modules must contain at least the following placements.

### Codex CLI

| Placement ID | Support | Scope | Path | Create? |
| --- | --- | --- | --- | --- |
| `project` | native | project | `.agents/skills` | yes |
| `user` | native | user | `~/.agents/skills` | yes |
| `admin` | native | admin | `/etc/codex/skills` | no |

`defaultProjectPlacementId` is `project`. Admin scope is documented for
discovery but is not selectable in the initial release because project config
may select only project or user scope.

### Claude Code

| Placement ID | Support | Scope | Path | Create? |
| --- | --- | --- | --- | --- |
| `project` | native | project | `.claude/skills` | yes |
| `user` | native | user | `~/.claude/skills` | yes |

`defaultProjectPlacementId` is `project`. Plugin and enterprise placements are
not general filesystem targets and are omitted from the initial adapter.

### OpenCode

| Placement ID | Support | Scope | Path | Create? |
| --- | --- | --- | --- | --- |
| `project` | native | project | `.opencode/skills` | yes |
| `agents-project` | compatibility | project | `.agents/skills` | yes |
| `claude-project` | compatibility | project | `.claude/skills` | yes |
| `user` | native | user | `~/.config/opencode/skills` | yes |
| `agents-user` | compatibility | user | `~/.agents/skills` | yes |
| `claude-user` | compatibility | user | `~/.claude/skills` | yes |

`defaultProjectPlacementId` is `project`. The automatic resolution rule in
`SPEC.md` still treats the default `.agents/skills` source as satisfied because
`agents-project` is a declared compatible project placement.

## Example Configuration Module

```ts
import type { HarnessConfig } from "./types";

const config = {
  name: "opencode",
  displayName: "OpenCode",
  adapterStatus: "available",
  supportsNativeSkills: true,
  defaultProjectPlacementId: "project",
  placements: [
    {
      id: "project",
      item: "skills",
      support: "native",
      scope: "project",
      defaultPath: ".opencode/skills",
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
      id: "user",
      item: "skills",
      support: "native",
      scope: "user",
      defaultPath: "~/.config/opencode/skills",
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
  sources: ["https://opencode.ai/docs/skills/"],
  verifiedAt: "2026-07-09",
} satisfies HarnessConfig;

export default config;
```

## Default Adapter Rules

- Source compatibility is checked before fallback output selection.
- Harness-specific fallback paths are not created when the source already lives
  in a declared native or compatibility project placement.
- Automatic selection is project-scoped only.
- User scope requires an explicit object target selection in project config.
- Admin, system, plugin, package, and configured scopes are not selectable in
  the initial release.
- A selected `unverified` placement is always an error.
- A planned or blocked adapter is always an error, even when its matrix path
  appears verified.
- Adapter tests must assert all declared placement IDs, scopes, source URLs, and
  default-resolution behavior.

## Research Freshness

The Agent Skills format and the three available adapters were rechecked against
primary documentation on July 9, 2026. Roadmap rows retain research gathered on
July 8, 2026 and must be rechecked before implementation and again before a
release that enables them. A changed path updates this file and its adapter test
fixture in the same commit.
