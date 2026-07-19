# Rules Support Implementation Plan

This plan maps `SPEC.md` to the repository as it exists on 2026-07-18. It is
not a substitute for the behavioral requirements in the main specification.

## 1. Current Architectural Constraints

The current implementation is skill-specific at every main seam:

- `src/config/schema.ts` has one `source` and one skill harness collection.
- `src/skills/discover.ts` requires directory-per-skill layout and `SKILL.md`.
- `src/adapters/schema.ts` has one adapter-wide default and placements whose
  currently unused `item` is always `skills`.
- `src/sync/resolve-placements.ts` assumes one source root and maps all skill
  files below directory target roots.
- `src/sync/types.ts` identifies every planned file with `skillName`.
- `src/sync/plan.ts` and `src/sync/apply.ts` validate one source identity.
- state version 1 does not record artifact kind or generated files.
- `src/status/run-status.ts`, `src/sync/run-sync.ts`, and `src/output.ts` expose
  skill-only counts and wording.
- `src/init/run-init.ts` creates one source and serializes the legacy exact
  config shape.

Rules must be integrated into one aggregate plan. Running a skill plan followed
by a rule plan would mark the other artifact stale and violate global preflight.

## 2. Recommended Module Shape

Suggested additions and refactors:

```text
src/
  artifacts/
    types.ts
    source-filesystem.ts
  rules/
    schema.ts
    discover.ts
    render.ts
    renderers/
      aggregate-markdown.ts
      claude.ts
      cursor.ts
      github-copilot.ts
      cline.ts
      qwen.ts
      plain-markdown.ts
  generated/
    paths.ts
    plan.ts
    apply.ts
```

The exact split may stay smaller where code is not reusable. Do not create a
generic framework merely to avoid two clear discovery functions.

## 3. Phase 1: Artifact-Aware Domain Without Behavior Change

Goal: make current skill behavior artifact-aware before enabling rules.

### Production changes

- Add `ArtifactKind = "skills" | "rules"` in a shared internal module.
- Replace generic `skillName` fields in `src/sync/types.ts` with artifact kind
  and item name.
- Add artifact kind to resolved placements, satisfied placements, notices,
  failures, operation sorting, count keys, and attribution lookup.
- Generalize `PlacementResolution` from one source identity to a collection.
- Update `src/sync/plan.ts` and `src/sync/apply.ts` to select the correct source
  identity for each operation.
- Keep the only configured source as skills during this phase.
- Preserve exact sorting, paths, link values, output, and state bytes where
  practical.

### Tests

- `test/unit/sync-domain-types.test.ts`
- `test/unit/sync-resolve-placements.test.ts`
- `test/unit/sync-plan.test.ts`
- `test/unit/sync-apply.test.ts`
- `test/unit/sync-run.test.ts`
- `test/acceptance/distributor.test.ts`

All existing tests must pass before adding rule behavior.

## 4. Phase 2: Configuration and Adapter Contracts

### `src/config/schema.ts`

- Add `DEFAULT_RULE_SOURCE_PATH = ".agents/distributor-rules"`.
- Add strict `RulesSelectionSchema` with defaulted source and non-empty
  harnesses.
- Add optional `rules` to `DistributorConfigSchema`.
- Export public input types without changing existing field optionality.

### `src/config/validate.ts`

- Factor harness selection validation by artifact kind.
- Resolve rule targets against `adapter.rules.placements` only.
- Retain existing skill selection behavior exactly.
- Add `ValidatedRuleSelection` or a generic validated collection.
- Resolve and lexically validate both source roots.
- Reject equal or nested source roots and reserved `.distributor` paths.
- Perform physical alias/containment checks after discovery and revalidate them
  before apply; config validation alone cannot safely establish real identity.
- Detect duplicate target files as well as duplicate target roots.
- Preserve aggregated diagnostics and precise nested field paths.

### `src/adapters/schema.ts`

- Add strict renderer, target-kind, activation, rule placement, and rule
  capability schemas.
- Add optional `rules` to `HarnessConfigSchema`.
- Keep existing skill fields valid for custom adapters.
- Validate logical placement outputs, renderer/target combinations, internal
  activation routing, immutable renderer capabilities, and output byte limits.
- Keep rule citations and verification dates capability-local.

### Built-in adapters

Audit and update all 16 files in `src/adapters/*.config.ts`. Add `rules` only
after the implementation gate for that harness passes. Trae Agent intentionally
omits it.

### Public exports

Update `src/adapters/index.ts` and `src/index.ts` with public rule capability
types. Do not export internal render or plan APIs.

### Tests

- `test/unit/config-schema.test.ts`
- `test/unit/config-validate.test.ts`
- `test/unit/config-load.test.ts`
- `test/unit/adapter-schema.test.ts`
- `test/unit/adapter-catalog.test.ts`
- `test/unit/adapter-registry.test.ts`
- `test/unit/public-types.test.ts`

Critical compatibility cases:

- old project config still parses;
- old custom adapter still parses and is skill-only;
- same harness is valid once in each artifact collection;
- missing rule capability is a config error only when selected for rules;
- placement IDs may repeat across skill and rule capabilities;
- explicit skill targets never gain implicit rule destinations.

## 5. Phase 3: Rule Discovery

### Shared filesystem safety

Extract only the reusable low-level pieces from `src/skills/discover.ts`:

- source root inspection and identity capture;
- no-follow regular-file open;
- stable node identity checks;
- deterministic directory reads;
- filesystem node descriptions and safe errors.

Skill semantics and rule semantics remain separate callers.

### New rule modules

`src/rules/schema.ts` validates strict frontmatter and portable globs.

`src/rules/discover.ts`:

- validates the real source directory;
- ignores hidden entries;
- accepts immediate canonical `.md` files only;
- rejects directories, non-Markdown files, links, and special nodes;
- reads UTF-8 with a configured size cap;
- parses frontmatter without executing content;
- returns stable source file identities and SHA-256 digests;
- rechecks root identity after discovery;
- aggregates every independent source problem.

### Tests

Add:

- `test/unit/rules-schema.test.ts`
- `test/unit/rules-discover.test.ts`

Cover empty source, ordering, case collisions, malformed UTF-8, malformed YAML,
unknown fields, all glob restrictions, symlink roots/files, root replacement,
file replacement during read, special nodes where supported, limits, and
non-execution of content.

## 6. Phase 4: Native Renderers

### Pure renderer layer

Implement renderers as side-effect-free functions. They receive validated
canonical rules and return exact bytes plus metadata. They do not inspect the
filesystem, environment, or current date.

Use stable YAML serialization owned by Distributor. Do not depend on incidental
key ordering from a general serializer.

### Fixture strategy

Add exact byte fixtures for:

- aggregate Markdown;
- Claude always and paths;
- Cursor always and globs;
- GitHub always and multiple `applyTo` globs;
- Cline always and paths;
- Qwen aggregate output, plus disabled modular renderer fixtures for its gate;
- plain Markdown.

Fixtures must include quoting, spaces, `*`/`**`, final newline, descriptions
containing YAML-sensitive characters, and multiple rules in deterministic
order. Rejection fixtures cover commas, control characters, `?`, character
classes, and every other non-portable glob form.

### Compatibility validation

Before placement mapping, replicate each rule to every selected logical
placement, then route it to exactly one compatible internal output within that
placement. Return all uncovered or ambiguous internal routes in one source
error. Do not render or map only a compatible subset.

## 7. Phase 5: Generated Blob and State Model

### Generated paths

Add a single helper deriving a blob path from validated lowercase SHA-256. It
must prove containment below `.distributor/generated/rules/sha256` on both
POSIX and Windows path styles.

### State v2

Update:

- `src/sync/state-schema.ts`
- `src/sync/state.ts`
- `src/remove/run-remove.ts`

Implement a strict union reader for v1 and v2. Normalize v1 entries to skills
in memory while retaining original version/dirty status. Serialize only v2
after a real state mutation. Add generated blob records, normalized uniqueness,
entry-to-blob referential integrity, and digest/path consistency checks.

Add a strict durable recovery-journal schema and recovery-on-load path. The
journal is persisted before mutations and removed only after state succeeds.

### Planning

Update `src/sync/plan.ts` to classify required generated blobs before targets.
Blob conflicts make the global plan non-applicable. Add a separate
`generatedOperations` collection with create, adopt, skip, stale, and conflict.
Include blob work in read-only planning without presenting it as a harness
target link count.

### Apply

Update `src/sync/apply.ts` to:

- revalidate canonical rule source identity and digest;
- publish immutable blobs with a no-clobber primitive, never rename over a
  digest destination;
- validate existing blobs through no-follow descriptors, link-count-one checks,
  pre/post identity checks, and exact hash;
- create or update target links only after their blobs exist;
- revalidate every contributing source even when a blob already exists;
- preserve enough old and new state after partial failure;
- garbage collect only blobs unreferenced by retained next state;
- never remove a modified blob;
- establish ignore coverage before the first blob write;
- extend state-persistence rollback to targets and generated dependencies.

### Removal

`remove` remains config-independent. Pre-inspect target/blob dependency groups.
Remove exact target links, then exact generated blobs, then recorded empty
managed directories only for a fully owned group. Retain a modified blob and
all target entries that reference it while allowing independent groups to
proceed.

### Tests

- `test/unit/state.test.ts`
- `test/unit/sync-plan.test.ts`
- `test/unit/sync-apply.test.ts`
- `test/unit/remove-run.test.ts`
- `test/unit/atomic-write.test.ts` if blob writes extend its API

Test v1 migration without no-op rewrite, deterministic v2, changed blobs, case
aliases, concurrent no-clobber publication, source races with an existing blob,
target/blob partial failures, state-persistence rollback, shared blob
references, modified-blob removal groups, generated ignore coverage, recorded
directory ownership, stale collection, recovery-journal replay, filtered sync by
artifact/harness pair, and remove with malformed or missing current config.

## 8. Phase 6: Aggregate Resolution and Orchestration

### `src/sync/resolve-placements.ts`

Refactor placement selection into an artifact-parameterized helper while
keeping artifact-specific file mapping explicit.

- Skills preserve current relative tree mapping and Codex-only OpenAI metadata
  filter.
- Rules map rendered output names to directory placements or one aggregate to
  exact file placements.
- Every target is checked against both canonical sources and the entire
  reserved `.distributor` tree.
- Global normalized and physical target collision detection sees both kinds.
- Identical aggregate `AGENTS.md` mappings can merge attributions.
- Exact file placements use equality-based ownership and parent-directory
  creation/rollback; directory placements retain descendant ownership.

### `src/sync/run-sync.ts`

Orchestration becomes:

```text
load config and registry
discover configured skills
discover configured rules if present
validate compatibility and render in memory
resolve all placements and mappings
load state
build one plan
dry run or apply once
build artifact-aware counts
```

The runtime dependency interface must allow unit tests to inject rule discovery
and rendering without weakening current test isolation.

### `src/status/run-status.ts`

Use the same aggregate read-only pipeline. Count logical skill and rule
references independently. Do not estimate physical links by multiplying total
items by all placements when aggregate rule placements are involved.

### Tests

- `test/unit/sync-resolve-placements.test.ts`
- `test/unit/sync-run.test.ts`
- `test/unit/status-run.test.ts`
- `test/acceptance/distributor.test.ts`

The acceptance suite must prove that one rule conflict blocks skill writes and
vice versa.

## 9. Phase 7: CLI, Init, Output, Docs, and Package

### CLI and output

Update:

- `src/cli.ts`
- `src/output.ts`
- `package.json`

Add `init --rules`, update help/trust wording, and report artifact-aware source,
placement, operation, warning, and failure counts. Keep expected errors on
stderr without stacks. Preserve exact legacy skill-only output when neither
configuration nor state contains rules.

### Init

Update `src/init/run-init.ts` to support optional rule selections and two source
directories. Preserve existing config bytes and existing `init --yes` output.
All source/config/state path checks complete before the first write. `--rules`
is valid only with `--yes` while creating a new config and never upgrades an
existing config.

### README and package checks

Update `README.md` and `scripts/verify-package.mjs`. The packaged consumer must
compile:

- the current legacy config;
- a config with rules;
- the current legacy custom adapter;
- a custom adapter selecting a built-in rule renderer.

README JSON-block assertions in acceptance tests should become marker-based if
new examples make exact block counts brittle.

### Tests

- `test/unit/init-run.test.ts`
- `test/unit/cli.test.ts`
- `test/unit/cli-subprocess.test.ts`
- `test/unit/output.test.ts`
- `test/unit/public-types.test.ts`
- `test/acceptance/distributor.test.ts`

## 10. Built-In Adapter Rollout Checklist

For each adapter, record in its config and tests:

- official source URLs;
- verification date;
- default project placement;
- optional explicit user placement;
- file versus directory target;
- renderer ID;
- supported activation modes;
- prerequisites and product-surface caveats.

A selected placement with an unverifiable prerequisite emits one deterministic
warning naming the prerequisite. Goose's Developer extension is the first such
case. If official behavior establishes that the prerequisite prevents all
automatic discovery, the placement remains unavailable instead of warning.

Expected initial defaults, subject to the gates in `SPEC.md`:

| Harness | Rule default |
| --- | --- |
| Codex | project `AGENTS.md` file |
| Claude Code | project `.claude/rules` directory |
| OpenCode | project `AGENTS.md` file |
| Cursor | project `.cursor/rules` directory |
| Gemini CLI | project `GEMINI.md` file |
| Antigravity | unavailable until always-on metadata and symlinks are proven |
| GitHub Copilot | local project singleton plus path-instructions composite |
| OpenHands | project `AGENTS.md` file |
| Pi | project `AGENTS.md` file |
| Cline | project `.clinerules` directory |
| Goose | project `AGENTS.md` file with prerequisite note |
| Crush | project `AGENTS.md` file |
| Qwen Code | project `QWEN.md` aggregate after context-symlink fixture; modular unavailable |
| Kilo Code | unavailable until automatic discovery is proven |
| Roo Code | project `.roo/rules` directory, archived note |
| Trae Agent | no capability |

## 11. High-Risk Cases

1. Multiple source roots currently have no representation in apply-time race
   checks.
2. State v1 is strict and must not be silently reinterpreted as rules.
3. Generated content updates can leave broken links if blobs are collected too
   early.
4. Aggregate rule placements have many logical rules but one physical target.
5. Shared root `AGENTS.md` can combine multiple harness attributions and must
   conflict if renderer bytes differ.
6. Existing unmanaged instruction files must never be merged or overwritten.
7. Path-scoped rules must never be widened for context-only harnesses.
8. Cursor and GitHub filename suffixes are required behavior, not cosmetic
   naming.
9. OpenHands path rules overlap the skill namespace and must remain out of the
   first rule implementation.
10. Kilo configured discovery must not be mistaken for automatic discovery.
11. Trae IDE evidence must not leak into the Trae Agent adapter.
12. Filtered sync must preserve untouched skill and rule attributions and blobs.
13. Exact file placements require equality-based owner matching in plan/apply;
    `createIfMissing` applies to their parent directories.
14. Generated ignore coverage must be established before the first blob write.
15. Aggregate output must honor the smallest documented harness byte limit.
16. The existing Trae adapter identity must not mix Trae IDE and ByteDance
    Trae Agent evidence.
17. Qwen's modular scanner ignores file symlinks; do not enable its directory
    placement without a supported behavior change.
18. GitHub-hosted Copilot surfaces cannot consume gitignored local blobs through
    committed symlinks; scope the capability to verified local surfaces.
19. A recovery journal is required before mutations because rollback and state
    persistence can both fail.

## 12. Verification Commands

Run focused tests during implementation, then the full repository verification:

```sh
pnpm exec biome check .
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
pnpm package:smoke
```

Repository instructions additionally require a behavioral smoke test from
inside `smoke_test`; unit tests and type checks do not replace it.

## 13. Required Behavioral Smoke Scenario

Keep all artifacts under `smoke_test/rules-support`. After `pnpm build`, run the
compiled CLI from that directory and verify:

1. a mixed skill/rule config with Claude Code, Cursor, and Codex using an
   always-on rule;
2. a separate modular-only config with one always rule and one path rule;
3. the neutral `.agents/distributor-rules` canonical default and exact generated
   native destinations;
4. `sync --dry-run` creates nothing;
5. real sync creates expected generated blobs and target symlinks;
6. target link raw values and native rendered bytes are exact;
7. state is version 2 with skill/rule kinds and generated digests;
8. second sync is a no-op;
9. `status` reports correct skill/rule logical references;
10. editing one canonical rule creates a new blob and updates only affected
    targets;
11. an unmanaged target blocks the entire mixed plan;
12. `remove` removes managed links/blobs but preserves canonical sources.

Inspect generated files and command output directly. Do not substitute running
the command from the repository root.

## 14. Definition of Done

- All acceptance criteria in `SPEC.md` pass.
- Every enabled adapter rule claim has primary evidence and an exact fixture.
- Existing skill behavior has no unintended diff.
- Full verification commands pass.
- Required smoke behavior is run from `smoke_test` and inspected.
- README, generated config behavior, public types, adapter metadata, and package
  consumer checks agree.
