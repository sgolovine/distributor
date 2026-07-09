# Distributor Specification

## Overview

Distributor is a CLI tool for keeping agent skills synchronized across multiple
agent harnesses from one source of truth.

Different agent harnesses, such as Codex, Claude Code, OpenCode, and future
tools, expect skills to live in different folders and often package skill
metadata in slightly different ways. Maintaining separate hand-written copies
for each harness creates drift, stale instructions, and avoidable maintenance
work.

Distributor solves this by letting users maintain skills once, then run:

```sh
distributor sync
```

The command discovers the canonical skill source, creates file-level symbolic
links into the expected locations for each configured harness, and reports what
changed.

This document is the initial groundwork for the project. Details will be refined
as target harness requirements, skill formats, and distribution policies are
defined.

## Goals

- Provide one source of truth for skills.
- Sync skills into the correct folders for supported agent harnesses.
- Minimize manual file copying and harness-specific maintenance.
- Make harness target links predictable and inspectable.
- Detect and prevent accidental overwrites of unmanaged user files.
- Support incremental adoption in existing projects.
- Keep the command simple enough for routine use by individual developers and
  teams.

## Non-Goals

- Distributor is not an agent harness.
- Distributor does not execute skills.
- Distributor does not validate every semantic detail of each harness.
- Distributor does not replace harness-specific runtime behavior.
- Distributor does not require every harness to support the exact same feature
  set.

## Terminology

- **Source skill**: The canonical skill definition maintained by the project.
- **Target skill**: A harness-specific placement of a source skill.
- **Target file**: A file path in a harness target directory. By default this
  is a symbolic link to a source file.
- **Harness**: An agent environment that consumes skills, such as Codex, Claude
  Code, or OpenCode.
- **Adapter**: Distributor logic that maps source skills into a harness-specific
  target format and folder.
- **Sync**: The process of creating, updating, or removing target skills based
  on the source of truth.
- **Managed file**: A file or symbolic link created by Distributor and safe for
  Distributor to update on later runs.
- **Unmanaged file**: A file not known to be created by Distributor.

## CLI Scope

The initial public CLI should support:

```sh
distributor help
distributor version
distributor sync
distributor init
```

### `distributor help`

Print the CLI help page.

Expected responsibilities:

- Show available commands.
- Show supported command flags.
- Show short descriptions for each command.
- Exit successfully without requiring project configuration.

### `distributor version`

Print the Distributor version page.

Expected responsibilities:

- Show the current Distributor package version.
- Exit successfully without requiring project configuration.

### `distributor sync`

Synchronize skills from the configured source of truth directory into configured
target harness directories.

Supported flags:

- `--harness <harness>`: Sync only one configured harness target.

Expected responsibilities:

- Load project configuration.
- Discover source skills.
- Resolve enabled harness targets.
- When `--harness` is provided, validate that the harness is supported and
  enabled by the project configuration, then limit sync work to that harness.
- Compare source skills to existing target files.
- Create missing target directories when allowed by placement configuration.
- Create or update file-level symbolic links from target paths to source files.
- Skip unchanged files.
- Warn or fail before replacing unmanaged files.
- Print a concise summary of created, updated, skipped, removed, and failed
  operations.

### `distributor init`

Set up Distributor in a project.

Supported flags:

- `-y`: Accept all init defaults without prompting.

Expected responsibilities:

- Create placeholder folders required for the default source layout.
- Create a project configuration file when one does not already exist.
- Use conservative defaults suitable for a new project.
- Prompt before overwriting or replacing existing project files unless `-y` is
  provided and the operation is explicitly safe.
- Print a concise summary of created, skipped, and failed init operations.

Potential future commands:

```sh
distributor check
distributor list
distributor clean
distributor doctor
```

These are not required for the first implementation, but the architecture should
not make them difficult to add.

## Source Of Truth

The default source of truth for agent skills lives in the project at:

```text
.agents/skills
```

When the user runs `distributor sync`, Distributor reads skills from the project
configuration `source` path, defaulting to `.agents/skills`, and syncs their
files into each configured harness-specific placement.

Canonical structure:

```text
.agents/
  skills/
    skill-name/
      SKILL.md
      assets/
      references/
```

Minimal valid source tree:

```text
.agents/
  skills/
    skill-name/
      SKILL.md
```

Each direct child directory of the configured source folder is treated as one
source skill:

```text
.agents/skills/
  skill-name/
    SKILL.md
  another-skill/
    SKILL.md
```

Initial assumptions:

- Each source skill lives in its own directory under the configured source
  folder.
- `SKILL.md` is the primary instruction document.
- Additional files under the skill directory are part of the skill unless
  excluded by configuration.
- Skill directory names are stable IDs unless explicit metadata overrides them.
- Source skills should remain harness-neutral where possible.
- Distributor should fail with a clear error if the configured source folder
  does not exist or contains no valid source skills.

Open decision:

- Whether the canonical skill format should exactly match one existing harness
  format, or be a Distributor-specific superset that adapters render into each
  harness.

## Target Harnesses

Distributor should support multiple harnesses through adapters.

Target harnesses are limited to harnesses with native Agent Skills support. The
authoritative harness set is the `Skill Placement Matrix` in
`CONFIG_SPEC.md`; this section mirrors that list for the product spec.

1. OpenCode
2. Claude Code
3. Cursor
4. Gemini CLI
5. Antigravity
6. Codex CLI
7. GitHub Copilot
8. OpenHands
9. Pi
10. Cline
11. Goose
12. Crush
13. Qwen Code
14. Kilo Code
15. Roo Code
16. Trae Agent

This list is a supported adapter target set, not a broader coding-agent market
backlog. Harnesses that only support adjacent concepts such as rules, custom
instructions, recipes, prompts, or convention files are excluded until they
expose native `SKILL.md` discovery or Distributor defines a separate transform
surface for those item types. Harnesses with unverified path details may appear
in this list, but their adapters must remain disabled until `CONFIG_SPEC.md`
contains a verified placement.

Each adapter must define:

- A harness configuration file named `<harness_name>.config.ts`.
- The target locations where that harness expects skill files to be placed.
- How to detect or override those target locations.
- Which source files are linked directly.
- Which source files are transformed.
- Any required metadata files.
- Any unsupported source features.
- How managed files are marked or identified.

Adapters should be isolated so adding a new harness does not require rewriting
the sync engine.

## Configuration

Distributor should support project-level configuration for user choices and
harness-level configuration for adapter placement rules.

### Project Configuration

Projects that use Distributor must define an app configuration file at the
project root. The file tells Distributor where the canonical skills folder lives
and which harnesses are supported by the project. `distributor sync` should fail
with a clear error if no supported project configuration file is found.

Supported filenames:

```text
distributor.config.js
distributor.config.ts
distributor.config.json
```

No other project configuration filenames are supported initially.

The project configuration must support:

- `source`: Optional path to the canonical skills folder. Defaults to
  `.agents/skills`.
- `harnesses`: Required list or object describing the harnesses supported by the
  project.
- Per-harness placement overrides when a project needs to link a supported
  harness item somewhere other than the harness default.

Minimal JSON example:

```json
{
  "harnesses": ["codex", "claude-code"]
}
```

Expanded JSON example:

```json
{
  "source": ".agents/skills",
  "harnesses": {
    "codex": {
      "placements": {
        "skills": ".codex/skills"
      }
    },
    "claude-code": true,
    "opencode": false
  }
}
```

TypeScript example:

```ts
import type { DistributorConfig } from "distributor";

const config: DistributorConfig = {
  source: ".agents/skills",
  harnesses: {
    codex: {
      placements: {
        skills: ".codex/skills"
      }
    },
    "claude-code": true
  }
};

export default config;
```

Distributor must validate loaded project configuration with Zod before using it.
Validation errors should identify the config file path, invalid field, received
value when useful, and expected shape.

The implementation should expose a TypeScript type inferred from the Zod schema
so the runtime validator and compile-time `DistributorConfig` type stay aligned.

### Harness Configuration

Every harness must have one consistent configuration module that defines where
items for that harness should be placed. Harness configurations must be stored
as:

```text
<harness_name>.config.ts
```

Examples:

```text
codex.config.ts
claude-code.config.ts
opencode.config.ts
```

Harness configuration modules should use a shared TypeScript type so adapters
describe placement in a consistent, testable shape.

Initial interface:

```ts
export type HarnessPlacement = {
  /**
   * Harness-relative logical name for the placed item.
   * Examples: "skills", "commands", "rules", "memory".
   */
  item: string;

  /**
   * Default directory where this item should be linked when no user override is
   * provided.
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
   * All output locations owned by this harness adapter.
   */
  placements: HarnessPlacement[];
};
```

Example harness configuration:

```ts
import type { HarnessConfig } from "./types";

const config: HarnessConfig = {
  name: "codex",
  displayName: "Codex CLI",
  placements: [
    {
      item: "skills",
      defaultPath: "~/.codex/skills",
      environmentVariables: ["CODEX_HOME"],
      createIfMissing: true
    }
  ]
};

export default config;
```

Adapters must read their placement rules from their harness configuration file
rather than hard-coding target directories in transformation logic.

Configuration should eventually support:

- Source directory through the `source` project config field.
- Supported harnesses through the `harnesses` project config field.
- Target placement overrides keyed by harness and placement item.
- Include and exclude patterns.
- Dry-run behavior.
- Conflict policy.
- Cleanup policy for removed source skills.

## Target Directory Resolution

Target directories are resolved from harness placement configuration.

Each harness must define every placement item it supports in its
`<harness_name>.config.ts` file. For example, a harness that supports skills and
commands should define separate placements for `skills` and `commands` rather
than burying those paths inside adapter code.

Resolved placement paths may come from:

- Explicit project-level configuration.
- Harness-specific environment variables.
- Well-known default paths declared by the harness configuration.
- Project-local folders.

The exact order must be defined per adapter. Explicit configuration should take
precedence over auto-detection.

Distributor should avoid creating links outside expected skill directories unless
the user explicitly configures a target path.

## Sync Semantics

`distributor sync` should be deterministic:

- The same inputs and configuration should produce the same target files.
- Unchanged source skills should not recreate target links unnecessarily.
- Target output should be stable across platforms where possible.

For each source file emitted by an adapter, Distributor should decide whether to:

- Create the parent target directory when it is missing and the placement allows
  directory creation.
- Create a symbolic link when the target path is missing.
- Update a managed symbolic link when it points to a stale source path.
- Skip a symbolic link when it already points to the expected source file.
- Remove a managed symbolic link when the source file was removed and cleanup is
  enabled.
- Fail or warn when a target path contains unmanaged content.

Default behavior should be conservative:

- Do not delete target skills unless cleanup is explicitly enabled.
- Do not overwrite unmanaged target files without an explicit policy.
- Prefer clear errors over silent data loss.

### Symbolic Link Behavior

`distributor sync` must create links at the file level, not by linking whole
skill directories. A source skill may contain `SKILL.md`, assets, references, or
other files, and each emitted target file must have its own target symlink. This
keeps adapters free to place different files in different harness-specific
locations instead of assuming every harness stores an entire skill under
`.<harness_config_dir>/skills`.

Example source tree:

```text
.agents/skills/review/SKILL.md
.agents/skills/review/references/checklist.md
```

Example target tree:

```text
.claude/skills/review/SKILL.md -> ../../../.agents/skills/review/SKILL.md
.claude/skills/review/references/checklist.md -> ../../../../.agents/skills/review/references/checklist.md
```

Adapters are responsible for mapping each source file to a target file path. The
sync engine is responsible for creating the target parent directories and the
symbolic links described by that plan.

Directory handling requirements:

- If a target parent directory does not exist and `createIfMissing` is `true`
  for the placement, Distributor must create it before creating the symlink.
- If a target parent directory does not exist and `createIfMissing` is `false`
  or omitted, Distributor must fail with a clear error for that target file.
- If Distributor attempts to create a symlink at a target path and a directory
  already exists at that exact path, Distributor must fail. It must not replace,
  merge into, or delete the directory.
- If Distributor attempts to create a symlink at a target path and a regular
  file already exists there, Distributor must fail unless the file is known to be
  managed by Distributor and the configured conflict policy allows replacement.
- If Distributor attempts to create a symlink at a target path and a symlink
  already exists there, Distributor may update it only when it is known to be
  managed by Distributor or already points to the expected source file.

Platform requirements:

- On macOS and Linux, Distributor should use POSIX symbolic links for target
  files. Links should use relative targets when both paths are on the same
  filesystem subtree so checked-out projects remain movable.
- On Windows, Distributor should create file symbolic links when supported by
  the current OS and user privileges. The implementation should use the
  Node.js-compatible `file` symlink type for files, not the `junction` type.
- On Windows, if file symlink creation fails because Developer Mode or the
  required privileges are unavailable, Distributor must fail with an actionable
  error explaining that file symlink support is required. It must not silently
  fall back to copying files.
- Distributor must never create directory symlinks or junctions for source skill
  directories as part of `distributor sync`.

## Managed File Tracking

Distributor needs a way to know which files it owns.

Possible approaches:

- Track managed file symlinks in a manifest.
- Write a manifest in the target directory.
- Maintain a project-local state file.
- Use checksums embedded in a manifest.

The first implementation should choose a strategy that is reliable across
multi-file skills, distinguishes managed symlinks from user-authored files, and
does not require mutating source content.

Open decision:

- Whether Distributor should use a target-local manifest, a project-local state
  file, or both to identify managed symlinks.

## Transformation Model

Most harnesses should receive direct symbolic links to source files. Others may
need transformed frontmatter, renamed files, generated metadata, or filtered
content.

Adapters should expose a small transformation interface:

- Read canonical skill input.
- Produce a list of source-file-to-target-file links.
- Produce warnings for unsupported features.
- Produce metadata needed for managed-file tracking.

Transformations should be explicit and testable. Avoid adapter behavior that
depends on hidden global state.

When an adapter must transform content, the transformed artifact is no longer a
direct symlink to the original source file. That behavior must be explicit in the
adapter plan and must still follow the same conflict and managed-file tracking
rules.

## Error Handling

Distributor should produce actionable errors.

Examples:

- Missing source directory.
- Invalid configuration.
- Unknown harness name.
- Target directory cannot be created.
- Target path is a directory where a symlink should be created.
- Target file exists but is unmanaged.
- File symlink creation is unavailable on the current platform.
- Source skill is malformed.
- Adapter cannot represent a source feature.

Errors should identify:

- The affected skill.
- The affected harness.
- The file path involved.
- The recommended next action when obvious.

## Output

The default output should be concise and suitable for humans.

Example:

```text
Synced 8 skills to 2 harnesses.

Codex: 3 created, 5 updated, 0 skipped
Claude Code: 2 created, 6 updated, 0 skipped
Warnings: 1
```

Verbose output may later include per-file operations.

Machine-readable output, such as JSON, can be considered after the core workflow
is stable.

## Dry Run

A dry-run mode should be supported, either in the first implementation or soon
after:

```sh
distributor sync --dry-run
```

Dry run should perform discovery, resolution, validation, and diff planning
without writing files.

## Cleanup

When a source skill is removed, old target skills may become stale.

Initial default:

- Do not delete target skills automatically.
- Report stale managed target skills if they can be detected.

Possible future flag:

```sh
distributor sync --clean
```

Cleanup must only remove files known to be managed by Distributor.

## Cross-Platform Requirements

Distributor should work on:

- macOS
- Linux
- Windows

Path handling must use platform-aware APIs. Tests should avoid assuming POSIX
path separators except where harnesses require POSIX-like paths.

## Testing Strategy

The implementation should include focused tests for:

- Config loading.
- Source skill discovery.
- Harness adapter output.
- Target path resolution.
- Managed-file conflict detection.
- File-level symlink creation.
- Directory collision failures when a symlink target path is already a
  directory.
- Windows symlink failure handling when file symlink privileges are unavailable.
- Sync plan generation.
- Dry-run behavior.
- Cleanup behavior once implemented.

Adapter tests should use fixture directories for source skills and expected
target output.

## Security And Safety

Distributor creates links in user and project directories, so safety matters.

Requirements:

- Never execute source skill content.
- Normalize and validate configured paths.
- Prevent path traversal from skill names or source file paths.
- Avoid overwriting unmanaged files by default.
- Avoid following unsafe symlinks when validating or replacing existing targets.
- Keep target links deterministic and reviewable.

## Open Questions

- What exact source skill format should Distributor own?
- Which harness should be supported first?
- What are the precise target directories and file formats for Codex, Claude
  Code, and OpenCode?
- Should Distributor sync global user skills, project-local skills, or both?
- Should target harnesses be enabled automatically when detected?
- How should per-harness skill content differences be represented?
- Should source skills support frontmatter?
- Should the CLI be distributed as an npm package, standalone binary, or both?
- What should the default conflict policy be?
- What should the default cleanup policy be?
