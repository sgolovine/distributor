# Distributor Configuration Specification

## Purpose

This document defines the harness placement data that Distributor adapters must
provide. It complements `SPEC.md` by turning the target harness backlog into
concrete configuration defaults for skill output locations.

This spec only includes harnesses with native Agent Skills support. Harnesses
that only expose adjacent concepts such as rules, project instructions,
workflows, recipes, or custom commands are intentionally excluded.

## Placement Model

Each harness configuration module must export a `HarnessConfig` object from a
file named `<harness_name>.config.ts`.

```ts
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
  /**
   * Harness-relative logical name for the placed item.
   * Example: "skills".
   */
  item: string;

  /**
   * Whether this placement is a native skill location or a compatibility
   * location discovered by the harness.
   */
  support: HarnessPlacementSupport;

  /**
   * Scope where the harness discovers this placement.
   */
  scope: HarnessPlacementScope;

  /**
   * Default directory where this item should be linked when no user override is
   * provided. Paths may use "~" and variables such as "$CWD" or "$REPO_ROOT".
   */
  defaultPath: string;

  /**
   * Optional environment variables that can override or help discover the path.
   */
  environmentVariables?: string[];

  /**
   * Whether Distributor may create the directory when it is missing.
   */
  createIfMissing?: boolean;

  /**
   * Human-readable note for caveats such as compatibility aliases,
   * mode-specific variants, or required feature flags.
   */
  notes?: string;
};

export type HarnessConfig = {
  /**
   * Stable harness ID used by project configuration and reports.
   */
  name: string;

  /**
   * Human-readable harness name.
   */
  displayName: string;

  /**
   * Whether Distributor can emit native Agent Skills for this harness.
   */
  supportsNativeSkills: boolean;

  /**
   * All output locations owned by this harness adapter.
   */
  placements: HarnessPlacement[];

  /**
   * Source URLs used to verify placement behavior.
   */
  sources: string[];
};
```

Adapter code must read placements from the harness configuration file. It must
not hard-code target directories in transformation logic.

## Skill Placement Matrix

The table below starts from the target harness list in `SPEC.md` and includes
additional native skill hosts that Distributor should support. Recommended
Distributor output is the safest default for a first adapter implementation.
Harnesses without native skills support are omitted.

| Harness          | Native skills?                              | Recommended Distributor output                                                                                            | Other discovered locations or notes                                                                                                                                                                                                          | Sources                                                                                                |
| ---------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| OpenCode         | Yes                                         | `.opencode/skills/<name>/SKILL.md` for project output; `~/.config/opencode/skills/<name>/SKILL.md` for user output        | Also discovers `.claude/skills`, `~/.claude/skills`, `.agents/skills`, and `~/.agents/skills`.                                                                                                                                               | https://opencode.ai/docs/skills/                                                                       |
| Claude Code      | Yes                                         | `.claude/skills/<name>/SKILL.md` for project output; `~/.claude/skills/<name>/SKILL.md` for user output                   | Also supports plugin skills at `<plugin>/skills/<name>/SKILL.md`, enterprise-managed skills, nested project `.claude/skills`, and legacy `.claude/commands` behavior.                                                                        | https://code.claude.com/docs/en/skills                                                                 |
| Cursor           | Yes                                         | `.cursor/skills/<name>/SKILL.md` for project output; `~/.cursor/skills/<name>/SKILL.md` for user output                   | Also discovers `.agents/skills`, `~/.agents/skills`, `.claude/skills`, `.codex/skills`, `~/.claude/skills`, and `~/.codex/skills`. Nested `.cursor/skills` and `.agents/skills` directories are picked up in repositories.                 | https://cursor.com/docs/skills                                                                         |
| Gemini CLI       | Yes                                         | `.gemini/skills/<name>/SKILL.md` for workspace output; `~/.gemini/skills/<name>/SKILL.md` for user output                 | Also discovers `.agents/skills` and `~/.agents/skills`; extension-bundled skills are another tier.                                                                                                                                           | https://geminicli.com/docs/cli/skills/                                                                 |
| Antigravity      | Yes                                         | `.agents/skills/<name>/SKILL.md` for workspace output; `~/.gemini/config/skills/<name>/SKILL.md` for global output        | Antigravity CLI and IDE variants document additional global paths such as `~/.gemini/antigravity-cli/skills/<name>/SKILL.md`, `~/.gemini/antigravity/skills/<name>/SKILL.md`, and shared `~/.gemini/skills/<name>/SKILL.md`.                | https://antigravity.google/docs/skills, https://antigravity.google/docs/cli/plugins                    |
| Codex CLI        | Yes                                         | `.agents/skills/<name>/SKILL.md` for repository output; `~/.agents/skills/<name>/SKILL.md` for user output                | Also reads parent `.agents/skills` directories up to the repo root, `/etc/codex/skills`, and bundled system skills. `CODEX_HOME` affects config, but current skills docs name `~/.agents/skills`.                                            | https://developers.openai.com/codex/skills                                                             |
| GitHub Copilot   | Yes                                         | `.github/skills/<name>/SKILL.md` for project output; `~/.copilot/skills/<name>/SKILL.md` for user output                  | Project skills may also live in `.claude/skills` or `.agents/skills`; personal skills may also live in `~/.agents/skills`. VS Code can configure additional project skill locations with `chat.agentSkillsLocations`.                      | https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills, https://code.visualstudio.com/docs/agent-customization/agent-skills |
| OpenHands        | Yes                                         | `.agents/skills/<name>/SKILL.md` for repository output                                                                    | SDK-installed skills are stored under `~/.openhands/skills/installed/` with `.installed.json`; legacy repo skills may be `.agents/skills/*.md`.                                                                                              | https://docs.openhands.dev/overview/skills, https://docs.openhands.dev/sdk/guides/skill                |
| Pi               | Yes                                         | `.pi/skills/<name>/SKILL.md` for project output; `~/.pi/agent/skills/<name>/SKILL.md` for user output                     | Also discovers `.agents/skills` in cwd/ancestors, `~/.agents/skills`, package `skills/`, configured `skills` arrays, and explicit `--skill` paths.                                                                                           | https://pi.dev/docs/latest/skills                                                                      |
| Cline            | Yes                                         | `.cline/skills/<name>/SKILL.md` for workspace output; `~/.cline/skills/<name>/SKILL.md` for user output                   | Also discovers `.clinerules/skills` and `.claude/skills` for project compatibility. Windows global path is `C:\Users\USERNAME\.cline\skills\`.                                                                                               | https://docs.cline.bot/customization/skills                                                            |
| Goose            | Yes                                         | `.agents/skills/<name>/SKILL.md` for project output; `~/.agents/skills/<name>/SKILL.md` for user output                   | Requires the built-in Summon extension in documented versions. Also discovers plugin skills under `~/.agents/plugins/<plugin-name>/` and backward-compatible `.goose/skills`, `.claude/skills`, and `~/.claude/skills`.                      | https://goose-docs.ai/docs/guides/context-engineering/using-skills/                                    |
| Crush            | Partial or unverified                       | `.crush/skills/<name>/SKILL.md` only after adapter verification                                                           | Public issue discussion states Crush currently looks for project-specific `.crush/skills`; standardized `~/.agents/skills` support was requested. Treat as `unverified` until official docs or code confirm behavior for the target version. | https://github.com/charmbracelet/crush, https://github.com/charmbracelet/crush/issues/2072             |
| Qwen Code        | Yes, path details need adapter verification | Prefer `.qwen/skills/<name>/SKILL.md` and `~/.qwen/skills/<name>/SKILL.md` only after confirming exact docs/code behavior | Qwen Code has an official Agent Skills page and `/skills` command discussion. Because the docs page is client-rendered, exact path precedence must be verified from code or static docs before implementation.                               | https://qwenlm.github.io/qwen-code-docs/en/users/features/skills/, https://github.com/QwenLM/qwen-code |
| Kilo Code        | Yes                                         | `.kilo/skills/<name>/SKILL.md` for project output; `~/.kilo/skills/<name>/SKILL.md` for user output                       | Also loads `.agents/skills` by default and `.claude/skills` when Claude Code Compatibility is enabled. Extra paths and remote URLs can be configured in `kilo.jsonc`.                                                                        | https://kilo.ai/docs/customize/skills                                                                  |
| Roo Code         | Yes                                         | `.roo/skills/<name>/SKILL.md` for project output; `~/.roo/skills/<name>/SKILL.md` for user output                         | Also supports `.agents/skills`, `~/.agents/skills`, and mode-specific `skills-{mode}` directories under both `.roo` and `.agents`.                                                                                                           | https://docs.roocode.com/features/skills                                                               |
| Trae Agent       | Yes                                         | Exact path unverified; adapter must verify before linking                                                                 | TRAE documents skills through `SKILL.md`, but the reviewed page did not expose a stable filesystem path. Do not implement a default path until official docs or local app behavior identifies it.                                            | https://docs.trae.ai/ide/skills                                                                        |

## Default Adapter Rules

- If `supportsNativeSkills` is `true`, adapters may link source skill files into
  the recommended native path unless project configuration overrides it.
- If a harness supports both harness-specific and `.agents/skills` locations,
  the harness-specific location is the default when it has higher priority or is
  the product's recommended path.
- If a harness recommends `.agents/skills` as the standard path, Distributor
  should use `.agents/skills` rather than creating a harness-specific alias.
- If research found a likely location but not a stable primary source, set
  `support: "unverified"` and do not enable the adapter by default.
- User-level link creation must require explicit project configuration or an
  explicit CLI flag. The default `distributor sync` workflow should prefer
  project-local paths so target links are inspectable and versionable.

## Example Configurations

```ts
import type { HarnessConfig } from "./types";

const config: HarnessConfig = {
  name: "claude-code",
  displayName: "Claude Code",
  supportsNativeSkills: true,
  placements: [
    {
      item: "skills",
      support: "native",
      scope: "project",
      defaultPath: ".claude/skills",
      createIfMissing: true,
    },
    {
      item: "skills",
      support: "native",
      scope: "user",
      defaultPath: "~/.claude/skills",
      createIfMissing: true,
    },
  ],
  sources: ["https://code.claude.com/docs/en/skills"],
};

export default config;
```

## Research Notes

Research was performed on July 8, 2026. Harness skill discovery is changing
quickly, so adapter implementation should re-check the linked primary sources
before shipping support, especially for harnesses marked `unverified`.
