# Distributor Specification

## Status And Precedence

This document defines the required behavior for Distributor's initial release.
`CONFIG_SPEC.md` is authoritative for harness IDs, placement metadata, adapter
availability, and placement sources. `TECH_STACK.md` is authoritative for
implementation dependencies. If the documents conflict, behavior in this file
takes precedence over implementation suggestions, while concrete harness paths
in `CONFIG_SPEC.md` take precedence over examples in this file.

Requirements that use **must** are acceptance criteria for the initial release.
Requirements that use **may** are optional. Later-scope ideas are explicitly
separated from initial-release requirements.

## Overview

Distributor is a CLI tool for keeping Agent Skills synchronized across multiple
agent harnesses from one source of truth.

Different harnesses may discover skills from different folders. Some already
discover the shared `.agents/skills` location, while others require a
harness-specific directory. Distributor reads one canonical skill tree, plans
the minimum required target files, creates file-level symbolic links where a
target is actually needed, and reports what changed.

```sh
distributor sync
```

Distributor must not create duplicate placements when a harness already
discovers the configured source directory. That case is a successful,
reportable no-op.

## Goals

- Provide one source of truth for standards-compliant Agent Skills.
- Make the same skills discoverable by supported harnesses.
- Avoid duplicate skill discovery when the source is already in a compatible
  location.
- Make target links predictable and inspectable.
- Detect conflicts before writes and never overwrite unmanaged content.
- Support existing projects without requiring a new source layout.
- Behave deterministically on macOS, Linux, and Windows.
- Give humans and automation actionable output and stable exit codes.

## Non-Goals

- Distributor is not an agent harness and does not execute skill content.
- Distributor does not install or configure an agent harness.
- Distributor does not validate harness-specific runtime behavior.
- Distributor does not make non-standard skill features portable.
- Distributor does not copy files when symbolic links are unavailable.
- The initial release does not transform skill content, overwrite conflicts,
  remove stale targets, or auto-enable detected harnesses.

## Initial Release Scope

The initial release includes:

- `help`, `version`, `init`, and `sync` commands.
- `--help`, `--version`, `--harness`, and `--dry-run` flags.
- Agent Skills as the canonical source format.
- All harness adapters listed in `CONFIG_SPEC.md`.
- Project-scoped targets by default.
- User-scoped targets only when explicitly selected in project configuration.
- Direct, file-level symbolic links without content transformation.
- Project-local managed-file state and stale-target reporting.

Every stable harness ID in `CONFIG_SPEC.md` is available.

## Terminology

- **Project root**: The directory containing the loaded Distributor project
  configuration.
- **Source root**: The configured directory containing canonical skills.
- **Source skill**: One direct child directory of the source root containing a
  standards-compliant `SKILL.md`.
- **Target root**: A selected harness placement directory under which skills are
  emitted.
- **Target file**: A planned harness file path. In the initial release it is a
  symbolic link to one source file.
- **Placement**: A named, scoped directory a harness discovers, such as
  `project` or `user`.
- **Adapter**: Distributor logic and placement data for one harness.
- **Managed file**: A target symlink recorded by Distributor whose current link
  value still matches its recorded value.
- **Unmanaged content**: Any target file, symlink, or directory that does not
  satisfy the managed-file definition.
- **Satisfied placement**: A source root that the harness already discovers, so
  no target files are needed.
- **Stale target**: A managed target whose source file or configured target is no
  longer part of the current plan.
- **Sync plan**: The deterministic set of create, update, adopt, skip, stale,
  and conflict operations computed before writes begin.

## CLI Contract

The executable name is `distributor`.

```sh
distributor
distributor help
distributor version
distributor init
distributor sync
```

Global behavior:

- `distributor` with no command must print the same help page as
  `distributor help` and exit `0`.
- `-h` and `--help` must print help for the current command and exit `0`.
- `-V` and `--version` must print the package version followed by a newline and
  exit `0` without loading project configuration.
- `distributor version` must behave like `--version`.
- Unknown commands, unknown flags, and missing flag values must print a concise
  usage error and exit `2`.
- Color and spinners must be disabled when stdout is not a TTY or when `NO_COLOR`
  is set. Machine-readable output is later scope.

Exit codes:

| Code | Meaning                                                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | The command completed successfully, including successful no-op and warning-only runs.                                                   |
| `1`  | Valid input was accepted, but an operational, conflict, or filesystem error prevented one or more requested operations from succeeding. |
| `2`  | The invocation or project configuration is invalid.                                                                                     |

Exit `2` applies to CLI syntax, config discovery conflicts, config schema
errors, unknown or unavailable adapters named by config, and a `--harness`
value that is unknown or not enabled. Exit `1` applies to missing or invalid
source content, path and target conflicts, invalid managed state, and apply-time
filesystem failures.

### `distributor help`

The help page must list commands, flags, short examples, and the three exit
codes. It must not require project configuration.

### `distributor version`

The version command must read the installed package version rather than a
second hard-coded value. It must not require project configuration.

### `distributor init`

```sh
distributor init
distributor init -y
distributor init --yes
```

`init` sets up Distributor without running a sync.

- The init root is the enclosing Git worktree root when one exists, otherwise
  the current working directory.
- Interactive init must prompt for the source path and enabled initial-release
  harnesses. Its displayed defaults are `.agents/skills` and all available
  adapters.
- `-y` and `--yes` accept those displayed defaults without prompting.
- A non-interactive invocation without `--yes` must fail with guidance to use
  `--yes`.
- Init must create the source directory when absent.
- Init must fail without changing other files when the selected source path
  exists but is not a directory.
- Init must create `distributor.config.json` when no supported config exists.
- Init must create `.distributor/.gitignore` containing `*` and `!.gitignore` so
  local managed-file state is not committed accidentally.
- Init must never overwrite an existing config or source content. `--yes` does
  not weaken this rule.
- If setup is already complete, init must report a successful no-op.

The default generated configuration is:

```json
{
  "source": ".agents/skills",
  "harnesses": [
    "codex",
    "claude-code",
    "opencode",
    "cursor",
    "gemini-cli",
    "antigravity",
    "github-copilot",
    "openhands",
    "pi",
    "cline",
    "goose",
    "crush",
    "qwen-code",
    "kilo-code",
    "roo-code",
    "trae-agent"
  ]
}
```

### `distributor sync`

```sh
distributor sync
distributor sync --harness claude-code
distributor sync --dry-run
```

Supported flags:

- `--harness <harness-id>` limits the run to one harness that is both available
  and enabled by project configuration. The flag may appear only once.
- `--dry-run` performs the complete read, validation, resolution, conflict, and
  diff-planning phases without creating directories, links, or state files.

Sync must:

1. Discover and validate project configuration.
2. Discover and validate all source skills.
3. Resolve requested adapters and placements.
4. Treat already-discoverable source roots as satisfied placements.
5. Load and validate managed-file state whenever it exists, including when the
   current plan needs no target files.
6. Build the complete sync plan and detect conflicts before writing.
7. In a non-dry run, apply non-conflicting operations in deterministic order.
8. Atomically record successful managed-file operations.
9. Print a concise per-harness and total summary.

Configuration, source-validation, unsupported-adapter, and planning-conflict
errors must abort the run before any target write. If a filesystem operation
fails after apply begins, Distributor must continue with independent planned
operations, record the operations that succeeded, and exit `1`.

## Project Configuration

### Discovery

Supported filenames are:

```text
distributor.config.json
distributor.config.js
distributor.config.ts
```

Starting at the current directory, Distributor must search parent directories
for the nearest supported file. In a Git worktree, the search stops after the
worktree root; outside Git, it stops at the filesystem root. The directory
containing the selected file becomes the project root.

If more than one supported filename exists in the same directory, loading must
fail with a message that names every conflicting file. Distributor must not
read configuration from `package.json` or unrelated cosmiconfig filenames.

JavaScript and TypeScript configs are executable trusted code. Distributor must
document that trust boundary in errors and help text; the promise not to execute
skill content does not apply to a user-selected executable config file.

### Schema

The project configuration shape is intentionally singular. The initial release
does not support an alternative object-map shorthand.

```ts
export type TargetSelection = {
  /** Placement ID declared by the adapter. Defaults to its project placement. */
  placement?: string;

  /** Explicit target-root override. Relative paths use the project root. */
  path?: string;
};

export type HarnessSelection =
  | string
  | {
      name: string;
      /** Defaults to one automatic project target. */
      targets?: TargetSelection[];
    };

export type DistributorConfig = {
  /** Relative paths use the project root. Defaults to ".agents/skills". */
  source?: string;

  /** At least one unique, available harness ID is required. */
  harnesses: HarnessSelection[];
};
```

A string harness entry selects one automatic project target. An object entry
may select one or more explicit project or user placements. User scope requires
the object form and must never be selected through environment detection alone.
Admin, system, plugin, package, and configured scopes are rejected in the
initial release even if the adapter documents them for discovery.

Expanded JSON example:

```json
{
  "source": ".agents/skills",
  "harnesses": [
    "codex",
    {
      "name": "claude-code",
      "targets": [
        {
          "placement": "project",
          "path": ".custom/claude-skills"
        }
      ]
    }
  ]
}
```

TypeScript example:

```ts
import type { DistributorConfig } from "distributor";

const config = {
  source: ".agents/skills",
  harnesses: [
    "codex",
    "claude-code",
    "opencode",
    "cursor",
    "gemini-cli",
    "antigravity",
    "github-copilot",
    "openhands",
    "pi",
    "cline",
    "goose",
    "crush",
    "qwen-code",
    "kilo-code",
    "roo-code",
    "trae-agent",
  ],
} satisfies DistributorConfig;

export default config;
```

The runtime Zod schema is authoritative. `DistributorConfig` must be inferred
from that schema rather than maintained separately. Validation must reject:

- unknown top-level and nested fields;
- an empty `harnesses` array;
- duplicate harness IDs;
- unavailable or unknown harness IDs;
- a present but empty `targets` array;
- duplicate target selections for one harness;
- unknown placement IDs;
- placement IDs outside project or user scope;
- empty paths and unresolved path variables.

Errors must identify the config file, field path, received value when safe and
useful, expected shape, and a concrete correction.

## Canonical Source Format

The canonical format is the open [Agent Skills
specification](https://agentskills.io/specification), not a
Distributor-specific superset. Distributor preserves all source files and does
not rewrite frontmatter in the initial release.

The default source root is:

```text
.agents/skills
```

Canonical structure:

```text
.agents/
  skills/
    skill-name/
      SKILL.md
      assets/
      references/
      scripts/
```

Source-root rules:

- A missing source root or a source path that is not a directory is an error.
- An empty source root is a successful no-op with guidance to add a skill.
- Each non-hidden direct child directory is one source skill and must contain a
  regular file named exactly `SKILL.md`.
- `.gitkeep` and hidden entries directly under the source root are ignored.
- Any other regular file directly under the source root produces a warning and
  is ignored.
- Every regular file recursively contained by a valid skill is part of that
  skill, including hidden files inside the skill directory.
- Empty directories have no emitted target representation.
- A symlink encountered as a non-hidden direct child of the source root or
  anywhere while traversing a skill is rejected. Hidden entries directly under
  the source root remain ignored without being traversed. This prevents source
  traversal and ambiguous link chains in the initial release.

Distributor must validate the standard's structural and required frontmatter
rules before planning writes. `SKILL.md` must begin with a YAML mapping between
`---` delimiters. `name` and `description` are required strings. `name` must be
1-64 characters, match `^[a-z0-9]+(-[a-z0-9]+)*$`, and exactly match the parent
directory. `description` must contain 1-1024 characters. Distributor must also
validate the types and length limits of optional fields defined by the Agent
Skills specification. Unknown frontmatter keys must be preserved and may
produce adapter-specific portability warnings, but they are not a generic
validation error.

If any source skill is invalid, the complete sync must fail before target
writes. The error must name the skill path and each validation problem.

## Harnesses And Adapters

Stable harness IDs and adapter availability are defined in `CONFIG_SPEC.md`.
Initial-release IDs are:

| Harness ID    | Display name | Initial behavior with the default source                        |
| ------------- | ------------ | --------------------------------------------------------------- |
| `codex`       | Codex CLI    | Satisfied in place because Codex discovers `.agents/skills`.    |
| `claude-code` | Claude Code  | Links into `.claude/skills` by default.                         |
| `opencode`    | OpenCode     | Satisfied in place because OpenCode discovers `.agents/skills`. |

Each available adapter must:

- have one `<harness-id>.config.ts` module conforming to `CONFIG_SPEC.md`;
- declare every placement used for discovery or output;
- declare a default project placement;
- identify compatible project placements, including `.agents/skills` when the
  harness supports it;
- map every source file to at most one path per selected target root;
- preserve the source-relative path for initial-release direct-link adapters;
- expose warnings for known unsupported or non-portable fields;
- contain no hard-coded target directories outside its configuration module.

## Placement Resolution

Paths are resolved without changing the process working directory.

- Relative config paths are resolved from the project root.
- `~` expands to the current user's home directory.
- Adapter-declared variables such as `$HOME` and `$PROJECT_ROOT` are expanded
  explicitly. An undefined referenced variable is an error.
- All paths are normalized to absolute paths for comparison, while user-facing
  diagnostics prefer project-relative paths when possible.

For a string harness selection or an object without `targets`, resolution is:

1. If the source root exactly matches any project-scoped placement the adapter
   declares as `native` or `compatibility`, mark the harness satisfied and plan
   no links.
2. Otherwise, select the adapter's declared default project placement.

For each explicit target selection, resolution is:

1. Use `path` when provided.
2. Otherwise select the named `placement`, or the adapter's default project
   placement when `placement` is omitted.
3. Apply an environment-variable override only when that selected placement
   explicitly declares one. Environment variables must not select a broader
   scope implicitly.
4. Fall back to the placement's declared default path.

Additional safety rules:

- A target root equal to the source root is a satisfied placement, never a
  self-link plan.
- A target root strictly inside the source root is invalid because it could make
  discovery recursive.
- An output path outside expected adapter directories is allowed only through an
  explicit project-config `path`.
- A plan that links a project-local source into a target outside the project
  root must warn that moving or deleting the project will break that target.
- If multiple harnesses plan an identical target/source mapping, the filesystem
  operation is deduplicated and attributed to each harness in the report.
- If two planned mappings would write different sources to one target path,
  planning fails before writes.

## Sync Semantics

The same source tree, configuration, adapter data, environment, and managed
state must produce the same ordered plan.

Planning order is lexicographic by harness ID, placement ID, skill name, and
target path. Filesystem enumeration order and project-config object insertion
order must not affect output.

For every planned target file, Distributor must choose exactly one operation:

- **create**: target is absent;
- **update**: target is managed and its recorded source mapping is stale;
- **adopt**: target is an unrecorded symlink that already has the exact expected
  link value or resolves to the exact expected source file;
- **skip**: target is managed and already correct;
- **conflict**: target contains unmanaged or modified content.

Separately, every prior managed target in the state scope that is absent from
the current plan is classified as **stale**. A full sync evaluates all state
entries. A `--harness` sync evaluates stale entries only for the selected
harness and leaves other entries unchanged.

Adoption is safe because it changes only state; it does not replace the existing
symlink. Stale targets are reported but not removed in the initial release.

The planner must inspect all requested harnesses before apply begins. Any
conflict makes the plan non-applicable and exits `1` without target or state
writes, including when only one harness conflicts.

### File-Level Symbolic Links

Distributor must link files, not whole skill directories.

```text
.agents/skills/review/SKILL.md
.agents/skills/review/references/checklist.md
```

may produce:

```text
.claude/skills/review/SKILL.md -> ../../../.agents/skills/review/SKILL.md
.claude/skills/review/references/checklist.md -> ../../../../.agents/skills/review/references/checklist.md
```

Requirements:

- The adapter maps source-relative file paths to target-relative file paths.
- The sync engine creates missing parent directories only when
  `createIfMissing` is true for the selected placement.
- If a required parent is absent and creation is disallowed, planning fails.
- A directory at an intended target-file path is always a conflict.
- A regular file at an intended target-file path is always a conflict in the
  initial release.
- A symlink may be changed only when it is managed and unchanged since the last
  recorded sync.
- Broken symlinks must be inspected as symlinks, not treated as absent files.
- Links between paths that are both inside the project root use relative link
  values so the checkout remains movable.
- A link with either endpoint outside the project root uses an absolute source
  value to avoid dependence on an external directory layout.
- Distributor never creates directory symlinks or junctions.

On macOS and Linux, Distributor uses POSIX file symlinks. On Windows it uses the
Node.js `file` symlink type. If Windows privileges or Developer Mode do not allow
file symlinks, Distributor must fail with an actionable message and must not
copy files or create junctions.

### Managed-File State

Managed state is stored at:

```text
<project-root>/.distributor/state.json
```

The state file is local implementation state and must not be required in version
control. It contains a schema version plus, for every managed target:

- harness IDs and placement ID;
- normalized source and target paths;
- the exact recorded symlink value.

Paths inside the project root must be serialized project-relative; external
paths must be serialized absolute. State entries and emitted JSON keys must be
sorted deterministically.

Ownership and tamper rules:

- A state entry grants ownership only when the target is still a symlink and its
  current raw link value matches the recorded value.
- If a recorded target was replaced or its link value changed, it becomes a
  conflict and Distributor must not restore it automatically.
- When state is absent, an exact expected symlink may be adopted; every other
  existing target is unmanaged.
- Invalid JSON, an unknown state schema version, or duplicate target entries is
  a planning error with recovery guidance. Distributor must not discard corrupt
  state automatically.
- State must be written to a temporary file and atomically renamed after target
  operations. It must include only successful or still-valid managed mappings.
- Before writing state, Distributor must create `.distributor/.gitignore` with
  the init-defined contents when it is absent. It must not replace an existing
  `.gitignore`; an existing file that does not ignore `state.json` produces a
  warning.
- Dry run must not create or repair the state directory or file.

### Stale Targets And Cleanup

A target becomes stale when its source file disappears, its harness is removed
from config, or placement resolution changes. Initial-release sync must report
stale managed targets and leave them untouched.

Automatic cleanup and a future `--clean` flag may remove only targets that still
satisfy the managed ownership and tamper checks. Cleanup is not an
initial-release requirement.

## Transformation Model

Initial-release adapters must produce direct source-to-target link mappings only.
They must not rewrite frontmatter, rename `SKILL.md`, generate metadata, or copy
content. If a harness cannot consume the canonical source without a transform,
its adapter remains unavailable.

A later transform API may produce generated files, but generated artifacts must
use the same planning, conflict, state, dry-run, and stale-target rules. That API
is not required by the initial architecture beyond keeping adapter planning
separate from filesystem application.

## Errors And Diagnostics

Errors must identify, when applicable:

- the project config path and field;
- the source skill;
- the harness and placement;
- the source and target paths;
- the failed operation;
- the next safe action.

Required error cases include:

- missing or invalid project configuration;
- missing source root or malformed source skill;
- unknown, unavailable, or disabled harness;
- unknown placement or invalid path expansion;
- recursive or colliding target paths;
- unmanaged or modified target content;
- a target-file path occupied by a directory;
- target parent creation disallowed or failed;
- corrupt or incompatible managed state;
- unavailable file symlink support.

Diagnostics must never suggest deleting or overwriting a path unless the message
also explains why Distributor considers it unmanaged. The initial release does
not offer a force flag.

## Output

Human output must distinguish skill counts from file-operation counts. Per-file
details are printed only for warnings and errors in the initial release.

Example:

```text
Synced 8 skills (23 files) to 3 harnesses.

claude-code: 23 created, 0 updated, 0 adopted, 0 skipped
codex: satisfied at .agents/skills (no links needed)
opencode: satisfied at .agents/skills (no links needed)
stale: 0, warnings: 0, failures: 0
```

Dry run must use future tense or a clear `Dry run` label and report the same plan
counts without claiming files were changed. Empty-source sync must say that no
skills were found and exit `0`.

## Security And Safety

Distributor writes links into project and explicitly selected user directories.
It must:

- never execute or import source skill content;
- treat JavaScript and TypeScript config as trusted executable configuration;
- use `lstat`-style inspection so broken or unsafe target symlinks are visible;
- reject source symlinks and source-relative traversal;
- validate skill names before using them in target paths;
- normalize paths before containment and collision checks;
- prevent writes through symlinked target parent directories that escape the
  resolved target root;
- avoid time-of-check/time-of-use replacement where platform APIs permit;
- never overwrite unmanaged or user-modified content;
- never broaden from project scope to user, admin, or system scope implicitly;
- keep dry run strictly read-only.

## Testing Strategy

Tests use isolated temporary directories and platform-aware path assertions.
Required coverage:

- config discovery, precedence, executable-config loading, and Zod errors;
- source discovery and Agent Skills frontmatter validation;
- empty sources, hidden root entries, and rejected source symlinks;
- adapter availability and placement resolution;
- already-discoverable source no-ops and self-link prevention;
- deterministic plan ordering and duplicate-operation deduplication;
- target creation, exact-link adoption, skip, update, and conflict behavior;
- state ownership, tamper detection, corrupt state, and atomic state writes;
- stale-target reporting without deletion;
- dry run producing no filesystem writes;
- directory collisions and symlinked-parent escape attempts;
- relative project links and absolute external links;
- Windows file-symlink privilege failures without copy fallback;
- help, version, non-TTY output, and exit codes;
- init defaults, non-interactive behavior, and no-overwrite behavior.

Tests for Windows-specific behavior may mock the failing Node.js symlink call on
non-Windows CI, but at least one Windows CI job must exercise real path and
symlink behavior when the repository begins shipping releases.

## Initial Release Acceptance Criteria

The initial release is complete only when all of the following are demonstrated
by automated tests:

1. `init --yes` creates a valid, non-destructive default setup.
2. Syncing an empty initialized source is a successful no-op.
3. A valid multi-file skill is linked into Claude Code with preserved relative
   structure.
4. The same default source is reported as already satisfied for Codex and
   OpenCode without creating duplicate placements.
5. A second identical sync performs no target writes.
6. An unmanaged file, directory, changed symlink, or unsafe parent prevents all
   planned writes.
7. Dry run reports the same applicable plan as sync and changes no filesystem
   metadata or content.
8. Removing a source file reports its prior managed target as stale without
   deleting it.
9. Invalid config, invalid skills, unknown adapters, and Windows symlink
   limitations produce the specified exit code and actionable error.
10. The examples and shared types in all three spec files agree.

## Later Scope

Later releases may add transformed artifacts, include/exclude
patterns, machine-readable output, explicit conflict-resolution workflows,
managed cleanup, skill package/plugin distribution, and additional config
formats.
None of these may weaken the initial release's ownership, conflict, scope, or
dry-run guarantees.
