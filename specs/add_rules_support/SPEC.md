# Rules Support Specification

Status: Proposed

Research snapshot: 2026-07-18

Related documents:

- [HARNESS_RESEARCH.md](./HARNESS_RESEARCH.md) records the harness-by-harness evidence and support classification.
- [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) maps this design to the current codebase and test suite.

## 1. Summary

Distributor will synchronize a canonical collection of persistent agent rules in
addition to Agent Skills.

Rules are not standardized across harnesses. Some harnesses discover many rule
files, some load one specially named context file, and some require proprietary
frontmatter or filename suffixes. Distributor therefore cannot safely treat a
rule as an opaque skill file and link the same bytes to every destination.

This feature introduces:

- an optional canonical rules source;
- a portable rule format with always-on and path-scoped activation;
- rule capabilities and placements in adapter metadata;
- deterministic native rendering for supported harness formats;
- content-addressed generated files under `.distributor/generated`;
- managed symbolic links from harness locations to generated files;
- artifact-aware planning, state, status, removal, and output;
- strict rejection when a selected harness cannot preserve a rule's semantics.

Existing skill-only configurations and custom adapters remain valid and retain
their current behavior.

## 2. Research Conclusion

For this specification, a rule is persistent model guidance. Codex command
execution policy files such as `.codex/rules/*.rules` are not model guidance and
are not in scope.

Of Distributor's 16 built-in harnesses:

- 15 support persistent project instructions in some form.
- 8 have a dedicated modular rule collection: Claude Code, Cursor,
  Antigravity, GitHub Copilot, Cline, Qwen Code, Kilo Code, and Roo Code.
- OpenHands supports path-triggered guidance through Agent Skills, but does not
  have an independent rule directory suitable for direct rule placement.
- Codex CLI, OpenCode, Gemini CLI, OpenHands, Pi, Goose, and Crush support
  persistent singleton or hierarchical instruction files.
- ByteDance Trae Agent has no verified automatic rule or instruction discovery.

The full evidence and caveats are in `HARNESS_RESEARCH.md`.

## 3. Goals

1. Synchronize one canonical rule collection to every selected, compatible
   harness.
2. Preserve the meaning of always-on and path-scoped rules where the harness
   supports those activation modes.
3. Support both modular native rule directories and singleton instruction files.
4. Preserve Distributor's current preflight, no-overwrite, ownership, dry-run,
   and deterministic-output guarantees.
5. Plan skills and rules together so a conflict in either artifact prevents all
   target and state writes.
6. Keep existing skill-only project configuration and custom adapters valid.
7. Keep rule content as data. Rule Markdown and YAML must never execute.
8. Make unsupported or lossy mappings explicit errors rather than silent skips
   or semantic widening.

## 4. Non-Goals

The first rules release will not:

- manage Codex command-execution policy `.rules` files;
- support model-selected or manually invoked rule activation;
- translate arbitrary harness-native rule files into other native formats;
- merge into an unmanaged existing `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or
  equivalent file;
- edit `opencode.json`, `kilo.jsonc`, IDE settings, environment variables, or
  extension configuration to activate rules;
- rewrite `@` imports, Markdown links, or relative asset references;
- create OpenHands path-triggered Agent Skills from rules;
- manage Roo mode-specific rule directories;
- provide a rules-only `remove` command;
- add a general plugin API for custom renderer code;
- copy targets when symbolic links are unavailable;
- claim rules support for ByteDance Trae Agent.

## 5. Terminology

### Artifact kind

`skills` or `rules`. Artifact kind is a first-class domain discriminator and
must never be inferred from a path.

### Canonical rule

One validated Markdown file in the configured rule source. Its frontmatter
expresses portable metadata; its Markdown body expresses the instruction.

### Activation

- `always`: the rule applies throughout a session.
- `paths`: the rule applies when files matching one of its project-relative
  globs enter the harness context.

### Modular placement

A harness-owned directory that discovers multiple rule files.

### Aggregate placement

A harness-owned singleton instruction file. Distributor combines all always-on
canonical rules into one deterministic native document for this placement.

### Generated blob

An immutable, content-addressed native output stored below
`.distributor/generated/rules`. Harness targets remain symbolic links and point
to these blobs.

## 6. Configuration Contract

### 6.1 Additive shape

The existing skill fields remain unchanged. Rules are opt-in through a new
top-level `rules` object:

```json
{
  "source": ".agents/skills",
  "harnesses": ["codex", "claude-code"],
  "rules": {
    "source": ".agents/distributor-rules",
    "harnesses": ["codex", "claude-code", "cursor"]
  }
}
```

Type shape:

```ts
interface RulesSelection {
  source?: string;
  harnesses: HarnessSelection[];
}

interface DistributorConfig {
  source?: string;
  harnesses: HarnessSelection[];
  rules?: RulesSelection;
}
```

`rules.source` defaults to `.agents/distributor-rules` only when the `rules`
object exists. The neutral name deliberately does not equal any built-in native
rule target. Omitting `rules` means rules are not configured. Distributor must
not inspect, create, sync, report as empty, or remove unmanaged rules merely
because a `.agents/distributor-rules` directory exists.

### 6.2 Harness selection

Rule harness selections reuse the current string and expanded object forms:

```json
{
  "rules": {
    "source": ".agents/distributor-rules",
    "harnesses": [
      "claude-code",
      {
        "name": "cursor",
        "targets": [{ "placement": "project" }]
      },
      {
        "name": "cline",
        "targets": [
          { "placement": "project" },
          { "placement": "user" }
        ]
      }
    ]
  }
}
```

Rules:

- `rules.harnesses` is required and non-empty when `rules` exists.
- Harness IDs must be unique within `rules.harnesses`.
- A harness may appear once in skill `harnesses` and once in
  `rules.harnesses`.
- Rule targets resolve only against the adapter's rule placements.
- Existing skill targets resolve only against the adapter's existing skill
  placements.
- A string selection requests the adapter's automatic project rule placement.
- An expanded selection without `targets` has the same automatic behavior.
- An expanded selection with `targets` means exactly those rule targets.
- Each selected logical placement is an independent replication destination.
  Selecting project and user placements intentionally distributes every rule to
  both scopes. A logical placement may contain multiple internal outputs when
  native semantics require activation routing, as GitHub does. Those internal
  outputs collectively must accept every rule exactly once. Uncovered rules and
  ambiguous internal routes are source compatibility errors; routing is never a
  silent filter.
- `path` overrides retain the placement's target kind. A directory placement
  override must resolve to a directory root; a file placement override resolves
  to the exact target file.
- `path` is rejected for a composite logical placement because one string cannot
  safely override multiple native destinations.
- Project and explicitly selected user scopes are allowed. Existing rejection
  of admin, system, plugin, package, configured, and unverified placements
  remains in force.
- Selecting a harness without a verified rule capability is a configuration
  error with exit code `2`.
- Trae Agent therefore remains valid in skill `harnesses` but is invalid in
  `rules.harnesses`.

### 6.3 Path validation

`rules.source` supports the same project-relative, `~`, `$HOME`, and
`$PROJECT_ROOT` expansion as the skill source.

The resolved skill and rule source roots must be physically and lexically
disjoint:

- they cannot be equal;
- neither may contain the other;
- a symlink or physical alias may not make them overlap;
- no skill or rule target may write into either canonical source tree.

All source and target overlap checks are global across both artifact kinds.

The project-local `.distributor` tree is reserved implementation state.
Canonical rule sources and all skill/rule targets must be lexically and
physically disjoint from `.distributor`, including `state.json`, `.gitignore`,
`adapters`, `generated`, and atomic temporary files. Existing legacy skill
sources inside `.distributor` require an explicit migration diagnostic when
rules are enabled; Distributor must never place a target or generated output
there outside its own state APIs.

### 6.4 Command filtering

`distributor sync --harness <id>` selects that harness from the union of skill
and rule selections:

- if enabled for both, both artifact kinds are planned;
- if enabled only for skills, only skills are planned;
- if enabled only for rules, only rules are planned;
- if enabled for neither, the existing usage error applies.

Filtered state evaluation is scoped to the selected configured
`(artifactKind, harnessId)` pairs. Entries and blob references belonging only to
an unselected artifact kind are preserved, even when they have the same harness
ID. A full unfiltered sync remains responsible for staling removed
configuration.

No `--artifact` or `--rules-only` filter is added in the first release. This
avoids introducing another partial-state dimension before there is a concrete
need.

## 7. Canonical Rule Format

### 7.1 Source layout

The default source is:

```text
.agents/distributor-rules/
  code-style.md
  database-migrations.md
  tests.md
```

Rules are immediate regular files. Nested directories are not supported in the
first release.

Requirements:

- filenames must match `[a-z0-9]+(?:-[a-z0-9]+)*\.md`;
- the filename without `.md` is the rule ID;
- IDs are unique under platform path-comparison rules;
- files must be regular files and must not be symbolic links;
- the source root must be a real directory and must not be a symbolic link;
- hidden root entries are ignored;
- visible directories and visible non-Markdown files are source errors;
- special filesystem nodes are source errors;
- rule order is bytewise ascending by rule ID;
- UTF-8 is required;
- the Markdown body must contain at least one non-whitespace character.

The source root identity and every source file identity must be protected using
the same no-follow and race-detection principles as skill discovery.

### 7.2 Frontmatter

Frontmatter is optional. The portable schema is strict:

```yaml
---
description: Conventions for TypeScript source files.
paths:
  - "src/**/*.ts"
  - "test/**/*.ts"
---
```

Fields:

- `description`: optional non-empty string, maximum 1,000 Unicode scalar
  values;
- `paths`: optional non-empty array of unique, non-empty POSIX glob strings.

Unknown fields are errors. A rule without `paths` has `always` activation. A
rule with `paths` has `paths` activation.

Portable glob restrictions:

- paths are relative to the project root;
- `/` is the separator regardless of host operating system;
- only literal path characters, `*`, and complete-segment `**` are accepted;
- `*` matches zero or more non-`/` characters, including a leading dot;
- a `**` segment matches zero or more complete path segments;
- leading `/`, backslashes, NUL, `.` and `..` path segments, brace expansion,
  extglobs, negation, commas, ASCII control characters, `?`, and character
  classes are rejected;
- multiple patterns use OR semantics;
- patterns are passed to native renderers without semantic broadening.

The implementation must use one documented glob parser/validator for source
validation. It must not claim matching semantics that a target harness cannot
preserve.

### 7.3 Body handling

The body is Markdown data. Renderer-specific frontmatter is generated from the
portable metadata. The body is otherwise preserved exactly after normalizing
only the frontmatter boundary and ensuring one final newline in generated
output.

Relative imports and assets are not rewritten. The first release does not
guarantee that a relative `@file`, Markdown link, or image path will resolve
from a generated destination. Documentation must tell users to use repository-
root-relative references or self-contained rule bodies.

## 8. Compatibility Rules

### 8.1 No silent semantic widening

Every rule placement declares the activation modes its renderer can preserve.

If any selected placement cannot preserve a discovered rule's activation,
planning fails before all writes. For example, an aggregate `AGENTS.md`
placement cannot receive a path-scoped rule because that would make the rule
always active.

Distributor must not:

- drop incompatible rules;
- turn a path-scoped rule into an always-on rule;
- guess a model-selected description;
- translate a path glob to a broader pattern;
- emit warnings and continue with incomplete output.

The error identifies the rule ID, activation, harness, placement, and corrective
options. Corrective options include removing that harness from rule selection,
removing `paths`, or choosing a compatible placement.

A selected placement with a prerequisite Distributor cannot verify emits one
deterministic warning naming that prerequisite. Goose's Developer extension is
the initial case. If primary evidence establishes that a prerequisite prevents
automatic discovery entirely, the placement is unavailable rather than merely
warning.

### 8.2 Portable support matrix

The initial renderer capability is:

| Harness | Default project output | Always | Paths |
| --- | --- | --- | --- |
| Codex CLI | `AGENTS.md` aggregate | yes | no |
| Claude Code | `.claude/rules/<id>.md` | yes | yes |
| OpenCode | `AGENTS.md` aggregate | yes | no |
| Cursor | `.cursor/rules/<id>.mdc` | yes | yes |
| Gemini CLI | `GEMINI.md` aggregate | yes | no |
| Antigravity | gated; no initial automatic default | gated | gated |
| GitHub Copilot | repository-wide file plus `.github/instructions/` | yes | yes |
| OpenHands | `AGENTS.md` aggregate | yes | no |
| Pi | `AGENTS.md` aggregate | yes | no |
| Cline | `.clinerules/<id>.md` | yes | yes |
| Goose | `AGENTS.md` aggregate | yes | no |
| Crush | `AGENTS.md` aggregate | yes | no |
| Qwen Code | `QWEN.md` aggregate | yes | no; modular symlinks gated |
| Kilo Code | gated; no initial automatic default | gated | gated |
| Roo Code | `.roo/rules/<id>.md` | yes | no |
| Trae Agent | unsupported | no | no |

Antigravity has no initial rule capability until an official product fixture
proves metadata-free always-on behavior and file-symlink discovery. Kilo also
has no initial rule capability: native automatic discovery of `.kilo/rules`
must pass its implementation gate before the adapter gains one. Qwen uses its
singleton `QWEN.md` context for always-on rules initially because the pinned
modular scanner ignores file symlinks. Distributor never falls back silently to
an unverified or deprecated path.

### 8.3 Shared aggregate targets

Several harnesses use project-root `AGENTS.md`. When the rendered bytes and
target path are identical, Distributor creates one physical target link and
records every harness/placement attribution, as it already does for identical
skill mappings.

If two selected placements map the same target path to different bytes, the
plan is a conflict. There is no renderer precedence or last-writer behavior.

## 9. Native Rendering

### 9.1 Renderer contract

Renderers are pure and deterministic. Their input is:

```ts
interface CanonicalRule {
  id: string;
  description?: string;
  paths?: readonly string[];
  body: string;
  sourcePath: string;
  sourceDigest: string;
}
```

Their output contains:

```ts
interface RenderedRuleOutput {
  renderer: RuleRendererId;
  logicalName: string;
  targetRelativePath?: string;
  bytes: Uint8Array;
  sourceRuleIds: readonly string[];
  digest: string;
}
```

Digest is lowercase SHA-256 over exact output bytes.

Built-in renderer IDs:

- `aggregate-markdown`;
- `claude-rules-markdown`;
- `cursor-mdc`;
- `github-instructions`;
- `cline-rules-markdown`;
- `qwen-rules-markdown`;
- `plain-markdown-rules`.

`qwen-rules-markdown` may be implemented and fixture-tested but is not exposed
by a placement while Qwen's scanner ignores symlink entries.

Custom adapters may select a built-in renderer. Arbitrary custom JavaScript
renderer functions are out of scope even though custom JS/TS adapter files are
trusted executable code.

### 9.2 Aggregate Markdown

Aggregate output contains every always-on rule in rule ID order:

```markdown
<!-- Generated by Distributor. Do not edit this file directly. -->

# Project Rules

## code-style

<body>

## tests

<body>
```

The comment is informational, not the ownership mechanism. Distributor still
requires state and exact link ownership.

An empty canonical rule source produces no aggregate target. Previously managed
aggregate targets become stale and are removed safely during sync.

### 9.3 Claude and Cline

Each canonical rule becomes one `.md` output. `paths` is emitted in the native
YAML frontmatter accepted by that renderer. No `paths` frontmatter is emitted
for always-on rules. `description` is emitted only where official behavior
defines it; otherwise it is omitted from native metadata and retained only in
the canonical source.

### 9.4 Cursor

Each rule becomes `<id>.mdc`.

- Always-on rules emit `alwaysApply: true` and no `globs`.
- Path rules emit `alwaysApply: false` and `globs` preserving the canonical
  patterns.
- `description` is emitted when present.

The renderer must produce Cursor's documented current MDC frontmatter. Plain
`.md` files must never be emitted into `.cursor/rules` because current Cursor
ignores them.

### 9.5 GitHub Copilot

GitHub uses a composite automatic placement:

- always-on rules are aggregated into `.github/copilot-instructions.md`;
- each path rule becomes
  `.github/instructions/<id>.instructions.md` with canonical patterns in
  GitHub's documented comma-separated `applyTo` representation.

`applyTo: "**"` is not used as an always-on substitute because path-specific
instructions are not guaranteed to apply to fileless prompts.

The renderer must quote and escape the YAML value deterministically. It does
not emit surface exclusions unless a future canonical field explicitly models
them.

This placement is supported only for local Copilot surfaces proven to discover
and follow the generated symlinks. GitHub-hosted cloud agent, code review, and
web surfaces cannot resolve gitignored local blobs from committed symlinks and
are explicitly outside this capability.

### 9.6 Plain Markdown directories

Roo receives `<id>.md` containing the canonical body. Only always-on rules are
accepted for this placement. No unsupported portable frontmatter is leaked into
the target file. Antigravity and Kilo remain unavailable until their gates
close. Qwen always-on rules use aggregate `QWEN.md`; its modular renderer remains
disabled while the official scanner ignores symlink entries.

## 10. Adapter Metadata

### 10.1 Additive capability

`HarnessConfig` gains an optional `rules` capability. Omission means the
adapter does not support Distributor-managed rules.

```ts
interface HarnessRulesCapability {
  defaultProjectPlacementId: string;
  placements: RulePlacement[];
  sources: string[];
  verifiedAt: string;
}

interface RulePlacement {
  id: string;
  support: "native" | "compatibility" | "unverified";
  scope: HarnessPlacementScope;
  outputs: RulePlacementOutput[];
  prerequisites?: string[];
  notes?: string;
}

interface RulePlacementOutput {
  id: string;
  targetKind: "directory" | "file";
  defaultPath: string;
  environmentVariables?: string[];
  createIfMissing: boolean;
  renderer: RuleRendererId;
  activations: ("always" | "paths")[];
  maxOutputBytes?: number;
}
```

The existing top-level `placements`, `defaultProjectPlacementId`,
`supportsNativeSkills`, `sources`, and `verifiedAt` remain the skill capability.
This avoids breaking existing custom adapters.

No `supportsNativeRules` boolean is added. An actionable verified rule
capability and placement list is the source of truth.

### 10.2 Validation

Adapter schema validation must enforce:

- unique rule placement IDs within the rule capability and unique output IDs
  within each placement;
- one default that references a declared project placement;
- a native or compatibility default, never unverified;
- at least one output and one activation per output;
- `maxOutputBytes`, when present, is a positive safe integer;
- valid renderer and target-kind combinations;
- aggregate renderer only with `targetKind: "file"`;
- modular renderers only with `targetKind: "directory"`;
- non-empty capability-local official sources;
- an ISO verification date;
- no automatic default whose discovery requires unperformed configuration;
- outputs within each logical placement route every placement-supported
  activation exactly once unless identical target bytes and paths intentionally
  deduplicate;
- no Trae rule capability until primary evidence exists.

Rule placement IDs may repeat skill placement IDs because lookups are scoped by
artifact kind.

Renderer capabilities are immutable built-in metadata, not adapter claims.
Each renderer defines target kind, supported activations, output cardinality,
and naming behavior. A custom adapter output may declare only an activation
subset of its renderer and cannot make `aggregate-markdown` or
`plain-markdown-rules` path-aware by assertion.

### 10.3 Citations

Rule citations live inside the `rules` capability rather than reusing the
adapter's skill citations. Adapter-wide skill evidence does not substantiate a
rule path or renderer.

## 11. Discovery and Domain Model

### 11.1 Separate discovery

Skill and rule discovery remain separate because their source contracts differ.
Shared root identity, no-follow file inspection, directory reading, and node
description logic should be extracted into an internal source-filesystem
module rather than duplicated.

Normalized source model:

```ts
type ArtifactKind = "skills" | "rules";

interface ArtifactSourceIdentity {
  artifactKind: ArtifactKind;
  sourceRoot: string;
  realPath: string;
  device: number;
  inode: number;
}
```

`PlacementResolution` contains every configured source identity, not one
singular skill root.

### 11.2 Planned mapping

Replace `skillName` in generic sync operations with a physical-output identity:

```ts
interface ArtifactIdentity {
  artifactKind: "skills" | "rules";
  itemNames: readonly string[];
  sourceKind: "canonical-skill" | "generated-rule-blob";
}
```

Every placement, satisfied placement, notice, failure, mapping, operation, and
count carries artifact kind where relevant.

An aggregate rule mapping lists every contributing rule ID. A generated-rule
mapping carries its expected blob digest and is validated against the generated
plan, not against canonical source-root containment.

Target mappings remain globally keyed by normalized target path. Identical
physical targets may share attributions only when artifact kind, exact source,
exact link value, and rendered bytes agree. Cross-artifact target sharing is
rejected even if paths happen to resolve to the same bytes.

## 12. Generated Blob Store

### 12.1 Location

Rendered bytes are stored at:

```text
.distributor/generated/rules/sha256/<first-two-hex>/<full-digest>
```

The blob path has no harness-specific extension. The harness observes the
extension of its target symlink. Identical rendered bytes share one blob.

The generated tree remains covered by `.distributor/.gitignore` and all smoke
test blobs remain inside `smoke_test`.

### 12.2 Immutability

A digest path is immutable:

- absent blob: publish atomically without replacement;
- existing regular file with matching digest: reuse or adopt;
- existing regular file with different bytes: conflict;
- symlink, directory, or special node at a blob path: conflict;
- blob publication uses a no-clobber primitive. A temporary file may be linked
  or published exclusively, but ordinary rename-over-destination is forbidden.
  If another writer wins, Distributor reopens and hashes the winner.

Created, reused, and adopted blobs are opened through a no-follow file
descriptor, must have link count one, and are hashed between pre/post identity
checks. Distributor performs one final identity/digest check before creating a
target link. Multi-link files are rejected because another path could mutate
the supposedly immutable blob.

Every contributing source rule is revalidated for node identity, size, and
digest before any blob reuse, adoption, creation, or target mutation. This
applies even when the desired blob already exists. If a source file or source
root changed after discovery, apply fails rather than linking stale output.

### 12.3 Generated plan operations

`SyncPlan` has a separate `generatedOperations` collection. Generated operation
kinds are:

- `create`: desired blob is absent;
- `adopt`: exact desired blob exists but is not in state;
- `skip`: state and exact blob agree;
- `stale`: a recorded blob is no longer referenced;
- `conflict`: path type, digest, physical alias, or ownership disagrees.

Adoption is state-changing. A generated conflict makes the entire plan
non-applicable. Generated operations are reported separately and never inflate
harness target-link counts.

### 12.4 Apply order

Within one globally preflighted plan:

1. ensure `.distributor/.gitignore` safely covers `state.json`,
   `recovery.json`, and `generated/**` before the first blob write;
2. create, adopt, or validate required generated blobs;
3. create, adopt, update, or skip target symlinks;
4. remove safely owned stale target symlinks;
5. remove unreferenced generated blobs only after no retained state entry uses
   them;
6. remove empty managed generated directories;
7. persist state atomically.

Partial apply failures retain every blob needed by either old state or a
successfully updated target. Garbage collection must never make a retained
target link broken.

If state persistence fails, the existing target reconciliation path is extended
to generated dependencies: restore prior target links first, then remove only
new blobs that are unreferenced after reconciliation, and restore any safely
removed old blob before restoring an old link. A failed rollback is reported
and its artifact is retained for manual recovery; it is never hidden by
returning the pre-apply state as though rollback succeeded.

Generated directories are recorded when Distributor creates them. Only
recorded, real, empty directories are removed, deepest first. Pre-existing
directories are never claimed merely because Distributor writes a child blob.

If `.distributor/.gitignore` is absent, apply may create the documented default
before the first blob. If an existing file does not ignore `state.json`,
`recovery.json`, and `generated/**`, planning fails with instructions to update
it manually;
Distributor never rewrites an existing ignore file. Generated files must not be
made visible to Git silently.

### 12.5 Durable recovery journal

Before the first target or blob mutation, apply atomically writes and syncs
`.distributor/recovery.json`. The strict journal records:

- the digest and version of loaded state;
- every target's prior and desired exact raw link state;
- every generated blob's prior and desired path/digest state;
- created-directory ownership needed for rollback.

After state persists successfully, apply removes the journal. If persistence or
rollback fails, the journal remains. Every state-loading command detects it
before ordinary planning or removal and either completes safe reconciliation or
returns an operational error with the retained journal path. Recovery uses the
same exact-link, digest, no-follow, and physical-alias checks as normal apply; it
never overwrites a user-modified artifact.

The recovery journal is ignored by Git, is never treated as ordinary managed
state, and is not created by dry run. This journal is required because a failed
state write and failed rollback otherwise leave newly generated ownership with
no durable record.

### 12.6 Dry run

Dry run computes native bytes and digests in memory. It must not create the
generated directory, blobs, target directories, links, state, or filesystem
metadata.

## 13. Planning and Ownership

### 13.1 One aggregate plan

Skills and rules are discovered and resolved before one `buildSyncPlan` call.
Two independent plans are forbidden because each would interpret the other's
state as stale and because a late rule conflict could occur after skill writes.

One conflict in skills, rules, generated storage, targets, or state makes the
entire plan non-applicable. No blob, target, directory, or state write occurs.

### 13.2 Existing target semantics

Rules retain current target ownership behavior:

- absent target becomes `create`;
- an unmanaged symlink resolving to the exact desired blob may be `adopt`;
- a managed link with exact raw link value and desired source is `skip`;
- a safely owned link whose desired blob changed is `update`;
- any unmanaged file, directory, different link, changed managed link, or
  physical alias conflict blocks the plan;
- no existing regular instruction file is merged or overwritten.

The exact recorded raw link value remains the ownership token after adoption.

For `targetKind: "file"`, `defaultPath` and a `path` override are the exact
target file. Placement ownership matches equality rather than strict descent.
`createIfMissing` controls creation of the file's parent directories. Parent
inspection, physical-alias detection, rollback, and directory ownership use the
parent path, not the file path as a target root.

### 13.3 Link values

Generated blobs are project-local. Project-local target links use relative raw
link values. Explicit user or other external targets use absolute raw link
values and receive the existing portability warning because deleting or moving
the project breaks them.

### 13.4 Stale behavior

A managed rule target becomes stale when:

- its canonical rule disappears;
- its selected rule harness or placement disappears;
- rules are removed from project configuration;
- rendering changes its output path;
- an aggregate becomes empty;
- renderer metadata changes the desired native output.

Stale targets are removed only if exact link ownership remains intact. Changed
targets are preserved and reported as conflicts. Generated blobs are collected
only after all references are absent from retained state.

## 14. Managed State Version 2

State version 2 is required. Version 1 historically means skills only and is
read through an explicit migration path.

```json
{
  "version": 2,
  "entries": [
    {
      "artifactKind": "rules",
      "sourcePath": ".distributor/generated/rules/sha256/ab/abc...",
      "targetPath": ".cursor/rules/tests.mdc",
      "linkValue": "../../.distributor/generated/rules/sha256/ab/abc...",
      "attributions": [
        {
          "harnessId": "cursor",
          "placementId": "project"
        }
      ]
    }
  ],
  "generated": [
    {
      "path": ".distributor/generated/rules/sha256/ab/abc...",
      "sha256": "abc..."
    }
  ],
  "directories": []
}
```

Requirements:

- v1 entries normalize in memory to `artifactKind: "skills"`;
- v1 is rewritten as v2 only on a state-changing operation;
- v2 requires `artifactKind` on every target entry;
- `generated` contains only Distributor-owned blobs still referenced by state;
- generated paths must remain under the project's exact generated root;
- generated digest must match the path and use lowercase SHA-256;
- normalized generated paths are unique;
- every rule target entry references exactly one generated record and every
  generated record is referenced by at least one retained rule target;
- normalized target paths remain globally unique;
- attribution uniqueness remains harness plus placement within one entry;
- cross-artifact ownership of one target is rejected;
- unknown fields and unknown versions remain errors;
- serialization is deterministic;
- the loaded schema version or an explicit dirty flag is retained so an
  all-skip v1 run preserves its original state bytes;
- older Distributor releases may reject v2 safely and must not be expected to
  downgrade it.

`remove` continues to work from state without loading current project config.
It pre-inspects each target/blob dependency group before mutating it. If a
shared blob is modified, the blob record and every target entry that references
it are retained and those target links are not removed. Independent owned
groups may still be removed. This preserves state referential integrity and
never abandons a modified artifact in Distributor's reserved tree.

## 15. Command Behavior

### 15.1 `sync`

Order:

1. load adapters and configuration;
2. discover every configured artifact source;
3. validate source compatibility against selected placements;
4. render rules and compute blob digests in memory;
5. resolve all skill and rule placements;
6. load and normalize state;
7. build one plan;
8. return dry-run output or apply once;
9. report artifact-aware counts.

Example output shape:

```text
Synced 2 skills (5 files) and 3 rules to 4 harnesses.
claude-code skills: 5 created, 0 updated, 0 adopted, 0 skipped
claude-code rules: 3 created, 0 updated, 0 adopted, 0 skipped
codex skills: satisfied at .agents/skills (no links needed)
codex rules: 1 created, 0 updated, 0 adopted, 0 skipped
stale: 0, warnings: 0, failures: 0
```

Physical operations and logical artifact references must remain distinct.
Several canonical rules aggregated into one `AGENTS.md` are several logical
rule references but one physical target operation. One rule replicated to
project and user logical placements is two references. Multiple internal outputs
inside one composite placement do not multiply the reference count.

### 15.2 `status`

Status remains read-only and uses the same discovery, rendering, resolution,
state, and plan path as sync.

When rules are configured or managed rule state exists, output distinguishes
absent and empty rules:

```text
Skills: 2
Active skill references: 6
Rules: 3
Active rule references: 9
References are up to date.
```

If `rules` is absent:

```text
Rules: not configured
```

If configured but empty:

```text
Rules: 0
Active rule references: 0
```

`upToDate` is true only when the combined plan is applicable and all desired
target and generated operations are skips, with no stale work.

When neither configuration nor managed state contains rules, status and sync
preserve the current skill-only output byte-for-byte. Artifact-qualified output
and `Rules: not configured` begin only when rules are configured or managed rule
state exists.

### 15.3 `remove`

`remove` removes all managed skill links, rule links, generated rule blobs, and
empty managed directories. It does not remove canonical skill or rule sources.

Output may retain the generic "managed links" summary and add a generated blob
summary when blobs were inspected.

### 15.4 `init`

Backward compatibility is concrete because `init --yes` is shipped behavior.
Therefore:

- existing valid configs are preserved byte-for-byte and never upgraded;
- `init --yes` retains the current skill-only generated config;
- interactive `init` asks whether to configure rules after skill selections,
  defaulting to no;
- a new `--rules` option opts into rule initialization non-interactively;
- `init --yes --rules` creates `.agents/distributor-rules` and selects every
  built-in or custom adapter with an available automatic project rule
  placement;
- Trae Agent and adapters without rule capability are omitted from rule
  defaults;
- interactive rule choices include only rule-capable adapters;
- initialization preflights both sources and all config/state artifacts before
  creating anything.

`--rules` is valid only with `--yes` and only when creating a new config. It
never upgrades an existing config. `init --yes --rules` against an existing
skill-only config returns a usage error explaining that Distributor does not
rewrite existing configuration. Interactive init uses its prompt instead of
the flag.

## 16. Errors and Exit Codes

Existing exit categories remain:

| Condition | Category | Exit |
| --- | --- | --- |
| Invalid rule config or unsupported rule harness | `config` | `2` |
| Invalid `--harness` or init option use | `usage` | `2` |
| Invalid canonical rule source/frontmatter | `source` | `1` |
| Rule activation unsupported by selected placement | `source` | `1` |
| Existing target/blob conflict | `conflict` | `1` |
| State, rendering, or filesystem failure | existing operational category | `1` |

Validation continues to aggregate independent problems. Diagnostics include
field paths such as `rules.harnesses[1].targets[0].placement` and source paths
such as `.agents/distributor-rules/tests.md (paths[0])`.

## 17. Security and Trust Boundaries

- Rule Markdown and YAML are untrusted data and are never executed.
- JavaScript and TypeScript Distributor configs and custom adapters remain
  trusted executable code.
- No renderer fetches URLs or resolves remote includes.
- All generated paths are derived from validated IDs or cryptographic digests.
- Source and target reads use no-follow checks where ownership or race safety
  depends on node identity.
- Rendering has fixed limits of 1 MiB per source rule and 16 MiB per rendered
  aggregate, further restricted by each placement's `maxOutputBytes`.
- A placement with a documented harness limit declares `maxOutputBytes`.
  Rendering above the smallest limit among attributions is a pre-write source
  compatibility error. Codex's default combined project-instruction limit is
  32 KiB unless future evidence and configuration support establish otherwise.
- Generated files use mode `0o600` subject to process umask; target links retain
  normal symlink semantics.
- External user placements remain explicit and warn that project deletion or
  movement breaks their links.
- A generated comment is not an ownership marker. Exact state, link value, and
  blob digest establish ownership.

## 18. Public API

The package root exports the additive public types:

```ts
export type {
  DistributorConfig,
  RulesSelection,
  HarnessSelection,
  TargetSelection,
};

export type {
  HarnessConfig,
  HarnessRulesCapability,
  RulePlacement,
  RuleRendererId,
};
```

Existing documented `DistributorConfig` and `HarnessConfig` values continue to
compile unchanged. Runtime schemas and internal planning/state types remain
private unless separately promoted as supported API.

## 19. Documentation Requirements

The implementation updates:

- package and CLI descriptions to "skills and rules";
- getting-started examples without changing legacy `init --yes` output;
- configuration reference for `rules`;
- canonical rule format and glob restrictions;
- adapter tables with rule support, target kind, activation support, caveats,
  and verification date;
- custom adapter documentation;
- ownership and generated blob behavior;
- status and sync examples;
- trust-boundary wording;
- the initial-scope section that currently excludes generated artifacts and
  transforms.

Documentation must distinguish persistent model rules from Codex command
policies and distinguish ByteDance Trae Agent from the separate Trae IDE.

## 20. Acceptance Criteria

The feature is complete only when all criteria pass:

1. Every existing skill-only config, custom adapter, target path, link value,
   dry-run result, generated config byte sequence, skill-only sync/status output,
   and acceptance scenario remains valid, except configurations that newly
   enable rules while placing canonical or target data in Distributor's
   reserved state tree. Help text and interactive prompts intentionally change.
2. Omitted `rules` causes no rule source access or rule-related writes.
3. A canonical always-on rule syncs to one modular harness and one aggregate
   harness with exact documented native output.
4. A canonical path rule syncs to Claude, Cursor, GitHub Copilot, and Cline with
   exact native metadata fixtures. Qwen modular path support remains gated while
   its official scanner ignores file symlinks.
5. A path rule selected for Codex or another aggregate-only placement blocks
   the entire plan before any write.
6. Trae Agent under `rules.harnesses` is a clear config error.
7. A conflict in a rule target prevents otherwise valid skill writes and a
   skill conflict prevents rule/blob writes.
8. Dry run creates no generated files, directories, targets, or state.
9. A real sync creates content-addressed blobs and target links with expected
   relative or absolute raw values.
10. A second sync is idempotent and leaves targets, blobs, and state unchanged.
11. Changing a rule produces a new blob, updates safely owned targets, and
    collects the old blob only when unreferenced.
12. Removing a rule produces only its target stale work, except that aggregates
    are regenerated as required.
13. Removing the `rules` config safely stales all previously managed rule
    targets without touching canonical sources.
14. Modified target links and modified generated blobs are preserved and
    reported as conflicts.
15. Version 1 state loads as skills and migrates to version 2 only on a
    state-changing operation.
16. Harness-filtered sync preserves untouched artifact and harness
    attributions.
17. Shared `AGENTS.md` output deduplicates physical work while preserving all
    attributions.
18. `status` distinguishes unconfigured, empty, and populated rule sources and
    performs no writes.
19. `remove` safely removes mixed skill/rule links and generated blobs while
    preserving changed content.
20. Interactive init can configure rules; `init --yes` remains skill-only; and
    `init --yes --rules` produces the documented rule defaults.
21. Public type and packaged-consumer checks compile both legacy and
    rules-capable configs/adapters.
22. The full build, tests, package verification, and required behavioral smoke
    test pass from the documented working directories.
23. A fixture for an Antigravity capability, when its gate closes, proves the
    neutral default source can sync to `.agents/rules` without source/target
    collision.
24. Canonical sources and target overrides cannot alias `.distributor` state,
    adapters, generated blobs, ignore metadata, or atomic temporary paths.
25. Concurrent blob publication never replaces another writer's destination.
26. Source mutation is detected even when the desired generated blob already
    exists.
27. Exact file placements are attributed, inspected, rolled back, and cleaned
    correctly.
28. Modified shared blobs block removal of their dependency group without
    blocking safe independent groups.
29. Aggregate size limits and generated-ignore coverage fail safely before
    target writes.
30. State persistence failure after blob/target creation retains recoverable
    ownership and never garbage-collects a still-linked blob.

## 21. Release Strategy

Implementation is staged internally but released only when the end-to-end
acceptance criteria pass:

1. Add artifact-aware domain and state migration while retaining skill-only
   behavior.
2. Add rule discovery, canonical validation, and render fixtures.
3. Add generated blob planning, apply, garbage collection, and removal.
4. Add verified built-in rule capabilities.
5. Add CLI/init/status/output/docs and package checks.
6. Run full acceptance and smoke verification.

This can be a minor release only if legacy public config and custom adapter
inputs remain source compatible as specified. Any implementation that requires
existing custom adapters to change is a major release.

## 22. Implementation Gates

Before enabling a built-in rule capability, its test fixture must establish
from primary evidence or the official implementation:

- exact project and user paths;
- automatic versus configured discovery;
- accepted filename suffix;
- frontmatter keys and serialization;
- recursive discovery behavior;
- activation behavior;
- symlink compatibility where the harness documents or tests it.

Implementation-derived claims use commit-pinned official source and test URLs,
not mutable `main` branches. Documentation URLs remain current-product evidence
but do not replace a pinned fixture for undocumented behavior.

The following known gates must be closed during implementation:

- confirm Antigravity metadata-free always-on behavior and file-symlink
  discovery before adding any rule capability, then confirm persisted metadata
  before enabling `paths`;
- confirm Kilo's `.kilo/rules` automatic discovery without requiring config
  mutation before adding any Kilo rule capability;
- retain `.clinerules` as the initial Cline default and add `.cline/rules` only
  after its current preference is pinned;
- keep Qwen modular rules disabled while its pinned scanner ignores symlink
  entries; use aggregate `QWEN.md` for always-on rules only after its symlink
  behavior is proven;
- pin renderer fixtures to current Cursor MDC and GitHub `applyTo` syntax;
- retain Roo support as legacy/archived behavior and label it accordingly;
- resolve whether the existing `trae-agent` adapter represents ByteDance Trae
  Agent or Trae IDE. Its current skill citation and name refer to different
  products. Keep rules unsupported and audit the existing skill capability
  until that identity is corrected.

An unresolved gate leaves that placement or activation unavailable. It never
justifies an unverified automatic default.
