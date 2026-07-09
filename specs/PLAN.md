# Distributor CLI Implementation Plan

## Plan contract

- **Source specs:** `specs/SPEC.md`, `specs/CONFIG_SPEC.md`, and
  `specs/TECH_STACK.md`
- **Output:** `specs/PLAN.md`
- **Precedence:** `SPEC.md` controls behavior; `CONFIG_SPEC.md` controls harness
  IDs, adapter availability, placement metadata, and concrete harness paths;
  `TECH_STACK.md` controls implementation dependencies.
- **Goal:** ship the initial-release `distributor` npm package and CLI, with
  `help`, `version`, `init`, and `sync`, and demonstrate every acceptance
  criterion in `SPEC.md` with automated tests.

This is an execution guide, not a replacement for the specs. When implementing
a task, use the specs for exact validation limits, diagnostics context, and
adapter metadata. Keep later-scope features out of the implementation.

## Accepted clarifications and assumptions

The specs and current repository do not leave any material product decision
unresolved. Use these implementation-level assumptions:

1. Use a conventional `src/` and `test/` layout because the repository is only
   a package scaffold and has no architecture to preserve.
2. Start managed state at schema version `1`. Store sorted ownership
   attributions as `{ harnessId, placementId }` pairs so a deduplicated target
   can remain attributable to multiple harnesses.
3. Write ordinary help, version, progress, and summaries to stdout. Write usage,
   validation, conflict, and operational diagnostics to stderr.
4. Validate the current Agent Skills optional fields as follows: `license` is a
   string, `compatibility` is a 1-500 character string, `metadata` is a
   string-to-string mapping, and `allowed-tools` is a string. Preserve unknown
   frontmatter keys; warn only when an adapter has a relevant portability issue.
5. Reject unsupported source filesystem node types instead of silently ignoring
   them. Continue to ignore hidden entries directly under the source root as
   required by the spec.
6. Treat either a `.git` directory or `.git` file as a worktree marker during
   the filesystem-only root walk, which covers linked worktrees.
7. Centralize normalized path comparison. At minimum, case-fold comparison keys
   on Windows while preserving normalized path spelling for diagnostics and
   state. Never use comparison keys as filesystem paths.
8. Do not add a cross-process lock in the initial release. Revalidate target
   ownership and parent-directory safety immediately before each mutation to
   narrow time-of-check/time-of-use risk.
9. Do not add `ora` unless implementation proves a spinner is necessary. Stable
   plain output satisfies the initial release and avoids a second output mode.
10. Exact diagnostic prose may differ from examples, but exit semantics,
    operation counts, dry-run tense, contextual paths, and safe next actions
    must match the contract.
11. Treat non-interactive `init` without `--yes` as an invocation error (exit
    `2`); treat a selected source path that is not a directory and init-time
    filesystem failures as operational errors (exit `1`).
12. Init inspects supported config filenames only at the computed init root.
    When exactly one exists, preserve and validate it, then use its effective
    source path for the remaining source-directory and state-ignore setup.
    Prompt for source/harness selections, or apply their `--yes` defaults, only
    when init will create a new config. Nested supported configs do not move or
    otherwise change the computed init root.

## Scope boundaries

Do not implement copying, directory symlinks or junctions, cleanup/`--clean`, a
force flag, transforms, generated artifacts, machine-readable output, harness
auto-detection, process execution for sync or Git discovery, or any roadmap
adapter. Planned and blocked IDs must be recognized only so configuration can
return an unsupported-adapter error.

Do not execute or import source skill content. JavaScript and TypeScript project
configuration is the only trusted executable input and must be identified as
such in help and relevant errors.

## Proposed module and test map

The exact split may be adjusted to keep modules cohesive, but preserve the
boundaries between reading, pure planning, and mutation.

```text
package.json
tsconfig.json
vitest.config.ts
src/
  bin.ts                         # shebang and top-level process boundary
  cli.ts                         # Commander program and command wiring
  index.ts                       # public schema-inferred types/API surface
  errors.ts                      # typed failures and exit-code classification
  output.ts                      # TTY/color policy and stable summaries
  init/
    find-root.ts
    run-init.ts
  config/
    schema.ts
    discover.ts
    load.ts
  adapters/
    schema.ts
    catalog.ts                   # stable ID/status registry
    index.ts
    codex.config.ts
    claude-code.config.ts
    opencode.config.ts
  skills/
    schema.ts
    discover.ts
  filesystem/
    paths.ts
    inspect.ts
    links.ts
    atomic-write.ts
  sync/
    types.ts
    resolve-placements.ts
    state-schema.ts
    state.ts
    plan.ts
    apply.ts
    run-sync.ts
test/
  helpers/
    fixture.ts
    cli.ts
    filesystem.ts
  unit/
  integration/
  acceptance/
.github/workflows/ci.yml
README.md
```

Keep dependency direction one-way: CLI commands call orchestration; orchestration
calls config/source/state readers and the pure planner; only init, the apply
layer, and atomic state persistence may write.

## Implementation tasks

### Phase 1 - Establish the package, build, and test baseline

Dependencies: none.

- [ ] **1.1 Configure the package as a publishable Node.js CLI.**
  - Require Node.js 22 or newer and pnpm 11.
  - Keep ESM and add a `distributor` binary pointing to compiled JavaScript.
  - Define package `exports` so consumers can import the public
    `DistributorConfig` type.
  - Add `build`, `typecheck`, `test`, and CLI smoke-test scripts. Compile both
    JavaScript and declarations with `tsc`; do not add a bundler.
  - Limit published files to compiled output plus the needed README/license
    material, and ensure the compiled binary remains executable and starts with
    a Node shebang.

- [ ] **1.2 Add only the approved implementation dependencies.**
  - Runtime: `commander`, `@clack/prompts`, `cosmiconfig`, `tsx`, `zod`, `yaml`,
    and `picocolors`.
  - Development: TypeScript and Vitest. Add `ora` only if a later task has a
    demonstrated TTY-progress need.
  - Do not add a shell/process runner for sync or Git-root discovery.

- [ ] **1.3 Enable strict TypeScript and deterministic tests.**
  - Use strict ESM-compatible compiler settings and declaration output.
  - Configure Vitest for isolated tests and stable non-TTY output.
  - Build fixture helpers around `node:fs/promises` temporary directories;
    never use the developer's real home or repository as a sync target.

**Phase gate:** a minimal binary builds, declarations emit, Vitest can run an
empty suite, and a package dry-run shows the intended binary and type files.

### Phase 2 - Define shared schemas, domain types, errors, and path primitives

Dependencies: Phase 1.

- [ ] **2.1 Create strict Zod schemas as the runtime source of truth.**
  - Model project config, target selections, harness config/placements, and
    managed state with strict objects that reject unknown fields.
  - Infer all matching TypeScript types from schemas. Export
    `DistributorConfig` from `src/index.ts`; do not maintain a parallel hand-
    written public interface.
  - Model plan operations explicitly: `create`, `update`, `adopt`, `skip`,
    `stale`, and `conflict`, plus satisfied placements, warnings, and failures.

- [ ] **2.2 Implement typed failure classification.**
  - Provide a structured error carrying exit category, operation/context, safe
    received values where useful, and a corrective action.
  - Map usage and project-config errors to `2`; source, state, conflict,
    unsupported filesystem behavior, and apply failures to `1`; success,
    warning-only, no-op, and stale-only runs to `0`.
  - Aggregate validation problems where the spec requires reporting all issues,
    rather than failing on the first skill or field.

- [ ] **2.3 Implement path normalization and containment helpers.**
  - Resolve without calling `process.chdir()`.
  - Support project-relative paths, `~`, `$HOME`, and `$PROJECT_ROOT` only where
    allowed. Reject empty paths, unresolved variables, and unsupported expansion
    syntax with contextual errors.
  - Provide exact/equivalent comparison keys, strict-child checks, project-
    relative display paths, and state path serialization/deserialization.
  - Serialize paths inside the project root as project-relative and outside
    paths as absolute. Never let `..` escape during reconstruction.

**Tests:** schema strictness and inferred-type compile fixture; error-to-exit-code
table; Unix/Windows path normalization, containment, expansion, undefined
variables, and serialization round trips.

### Phase 3 - Implement the adapter catalog and shipping configurations

Dependencies: Phase 2.

- [ ] **3.1 Create and validate the stable adapter catalog.**
  - Record every stable ID from `CONFIG_SPEC.md` with `available`, `planned`, or
    `blocked` status so unknown and unavailable IDs produce distinct errors.
  - Load planning behavior only for `codex`, `claude-code`, and `opencode`.
    Roadmap entries must not expose selectable adapters.
  - Validate filename/name agreement, unique placement IDs, source URLs,
    `verifiedAt`, and the invariant that an available default references a
    native/compatibility project placement.

- [ ] **3.2 Add one default-exported config module per available adapter.**
  - `codex.config.ts`: project `.agents/skills`, user `~/.agents/skills`, admin
    `/etc/codex/skills`; default is `project`, and admin is discoverable metadata
    but not selectable.
  - `claude-code.config.ts`: project `.claude/skills` and user
    `~/.claude/skills`; default is `project`.
  - `opencode.config.ts`: project `.opencode/skills`, compatible project
    `.agents/skills` and `.claude/skills`, user `~/.config/opencode/skills`, and
    compatible user `.agents/skills` and `.claude/skills`; default is `project`.
  - Copy the exact IDs, scopes, support levels, `createIfMissing` values, primary
    source URLs, and verification dates from `CONFIG_SPEC.md`. Planning code may
    not hard-code these target directories.

**Tests:** snapshot/assert every declared field and invariant; prove the default
`.agents/skills` source satisfies Codex and OpenCode but not Claude Code; prove
planned/blocked/unverified or non-project/user placements cannot be selected.

### Phase 4 - Discover, load, and validate project configuration

Dependencies: Phases 2-3.

- [ ] **4.1 Implement explicit upward discovery.**
  - From the invocation directory, inspect each directory for exactly
    `distributor.config.json`, `.js`, and `.ts`.
  - Select the nearest directory with a supported file. If more than one exists
    there, fail and name every conflicting file.
  - Stop after inspecting the enclosing Git worktree root; outside Git, continue
    through the filesystem root. Do not consider `package.json`, rc files, YAML,
    or global cosmiconfig locations.
  - If no supported config is found within that boundary, return exit `2` with
    the searched boundary and actionable guidance to run `distributor init` or
    create one of the three supported config files.

- [ ] **4.2 Load only the selected file.**
  - Call cosmiconfig's async `load()` for every explicitly selected config file;
    never call its broad `search()` defaults.
  - Configure a `.ts` cosmiconfig loader backed by scoped `tsx` `tsImport()` so
    TypeScript loading still flows through `load()` without registering a
    process-wide loader. Use the appropriate built-in/default loaders for the
    explicitly selected JSON and JavaScript files.
  - Accept the documented default export shape and identify executable JS/TS
    configs as trusted code in failure/help text.

- [ ] **4.3 Validate and normalize the singular config shape.**
  - Default `source` to `.agents/skills`; require a non-empty `harnesses` list.
  - Reject unknown fields, duplicate harness IDs, empty explicit target arrays,
    duplicate target selections, unknown/unavailable harness IDs, unknown or
    disallowed placement IDs, empty paths, and unresolved variables.
  - A string harness or object without `targets` means one automatic project
    target. Only explicit object targets may select user scope. Reject admin,
    system, plugin, package, and configured scopes.
  - Diagnostics must include config file, field path, safe received value,
    expected form, and a concrete correction.

**Tests:** discovery at/above cwd, worktree boundary as `.git` directory and
file, filesystem-root fallback, nearest precedence, same-directory conflicts,
no-config-found actionable exit `2`, all three `load()`-based loaders including
scoped TypeScript import, no package/rc discovery, strict schema errors,
trust-boundary text, defaults, duplicate detection, and unavailable adapters.

### Phase 5 - Discover and validate canonical Agent Skills

Dependencies: Phase 2; consume the normalized source path from Phase 4.

- [ ] **5.1 Implement safe deterministic source traversal.**
  - Fail if the source root is missing or is not a directory; return a valid
    empty result when it has no skills.
  - Sort all directory entries before processing.
  - Ignore hidden direct children (including `.gitkeep`) without traversing
    them. Warn and ignore other regular files directly under the source root.
  - Treat each non-hidden direct child directory as a skill and require a
    regular file named exactly `SKILL.md`.
  - Include every recursively contained regular file, including hidden files
    within a skill. Empty directories produce no planned output.
  - Use `lstat` and reject a symlink used as a non-hidden direct child of the
    source root or anywhere inside a skill. A hidden direct-root symlink remains
    ignored without traversal, just like every other hidden direct-root entry.
    Reject sockets, devices, and other unsupported nodes.

- [ ] **5.2 Parse and validate `SKILL.md` strictly as data.**
  - Require a leading YAML mapping between `---` delimiters and parse it with
    `yaml`; never import or execute Markdown, YAML, scripts, or assets.
  - Require `name` and `description`; enforce name length/pattern and exact
    directory match, description length, and the accepted optional-field rules.
  - Preserve unknown frontmatter keys. Return adapter portability warnings
    separately from structural errors.
  - Aggregate every validation problem across all skills before failing and
    include the affected skill path for each one.

**Tests:** valid single/multi-file skills; invalid/missing frontmatter; all name,
description, and optional-field boundaries; directory-name mismatch; unknown
key preservation; empty root; hidden root entries; ignored root file warning;
hidden nested file inclusion; missing `SKILL.md`; ignored hidden direct-root
symlink; rejected non-hidden root/nested/broken symlinks; unsupported nodes;
deterministic traversal.

### Phase 6 - Implement non-destructive `init`

Dependencies: Phases 2-4 and the output layer from Phase 1/2.

- [ ] **6.1 Determine init root and collect selections.**
  - Walk ancestors using filesystem inspection only. Use the nearest enclosing
    Git worktree root when present, otherwise the current working directory.
    Nested supported config files do not alter this computed root.
  - Inspect the three supported config filenames at that root. If exactly one
    exists, preserve and validate it and use its effective source value for all
    remaining setup; do not prompt for replacement source/harness selections.
  - Only when no supported config exists, interactive mode prompts through Clack
    for source path and enabled available harnesses, displaying
    `.agents/skills` and all three available adapters as defaults.
  - Only when creating a config, `-y`/`--yes` accepts exactly those displayed
    defaults without prompting. If config creation needs input while stdin is
    non-interactive and `--yes` is absent, fail with exit `2` and guidance to
    use `--yes`.

- [ ] **6.2 Preflight the entire init before writing.**
  - At the computed init root, fail on multiple supported configs and name each
    conflict; preserve and validate exactly one existing config without
    overwriting it. Ignore nested configs for init-root/config selection.
  - Resolve the selected source from the preserved config when present, or from
    the new-config selections otherwise, before evaluating any writes.
  - If the selected source exists but is not a directory, fail before changing
    any config, source, state directory, or ignore file.
  - Build a complete list of needed changes, preserving an existing source
    directory and all content. An existing setup that needs nothing is a
    successful, reportable no-op.

- [ ] **6.3 Apply only absent setup artifacts.**
  - Create the source directory when missing.
  - Create `distributor.config.json` only when no supported config exists at the
    computed init root, using the chosen interactive selections or the exact
    documented default shape for `--yes`.
  - Create `.distributor/.gitignore` only when absent, with exactly `*` and
    `!.gitignore` lines. Never replace an existing config, source content, or
    ignore file.
  - Report created, preserved, and no-op outcomes without running sync.

**Tests:** Git/non-Git root selection, prompt choices, default `--yes`, alias
`-y`, non-TTY rejection, invalid source preflight causing zero writes, existing
config validation and effective-source reuse without prompts, nested config not
changing the init root, source preservation, root config conflicts, exact JSON
and ignore contents, partial existing setup, repeated init no-op, and no
implicit sync.

### Phase 7 - Resolve harnesses and placements into desired mappings

Dependencies: Phases 3-5.

- [ ] **7.1 Resolve the requested harness set.**
  - A full sync uses every enabled configured harness.
  - `--harness` must occur at most once and must name an available adapter that
    is enabled in project config; otherwise return exit `2`.
  - Sort by harness ID independently of config insertion order.

- [ ] **7.2 Resolve automatic and explicit placements from adapter data.**
  - For automatic selection, first compare the source root with every declared
    native/compatibility project placement. Mark an exact match satisfied and
    plan no files; otherwise use the declared default project placement.
  - For every explicit target, first resolve the named placement, or the
    adapter's default project placement when `placement` is omitted. That
    placement always supplies the scope authorization, `createIfMissing`
    policy, placement ID, diagnostics, reporting, and state attribution.
  - A target `path` overrides only the resolved target-root path; it does not
    create or replace placement metadata. When `path` is absent, apply the
    resolved placement's first ordered non-empty environment override and then
    fall back to its declared default path.
  - Environment variables never override an explicit `path` and never select a
    broader scope. Undefined variables referenced by the selected fallback
    path are errors.
  - A target equal to source is satisfied. A target strictly inside source is
    invalid. An outside-standard path requires an explicit config `path`.
    Warn when a project-local source feeds a target outside the project root.

- [ ] **7.3 Map regular source files to target files.**
  - Preserve each path relative to the source root and emit at most one mapping
    per source file per selected target root.
  - Calculate the desired raw link value: relative from target parent when both
    endpoints are inside project root; otherwise absolute source path.
  - Deduplicate identical target/source mappings while retaining sorted
    harness/placement attribution. Fail before writes when one target maps to
    different sources or when normalized comparison keys collide unsafely.
  - Sort desired mappings by harness ID, placement ID, skill name, and target
    path, using an explicit stable tie-breaker for shared mappings.

**Tests:** automatic satisfied/default selection; named/default placement is
resolved before a path override; override retains placement ID, scope,
`createIfMissing`, reporting, and state attribution; environment precedence only
when `path` is absent; user-scope opt-in; empty environment variables;
equal/child/external paths; external warning; relative versus absolute link
values; duplicate attribution; source collision; config-order and enumeration-
order independence.

### Phase 8 - Load, validate, and serialize managed state

Dependencies: Phases 2 and 7.

- [ ] **8.1 Define state schema version 1 and ownership checks.**
  - Load managed state only from the canonical path
    `<project-root>/.distributor/state.json`; do not search for or accept an
    alternate state location.
  - Store schema version and sorted entries containing source path, target path,
    exact raw symlink value, and sorted harness/placement attributions.
  - Reject invalid JSON, unknown versions, unknown fields, invalid paths,
    duplicate normalized targets, or duplicate attribution with recovery
    guidance. Never discard or repair corrupt state automatically.
  - Load and validate existing state even when current placement resolution is
    entirely satisfied and no targets are desired.
  - Apply ownership/tamper checks to every entry in the current state evaluation
    scope, including entries absent from the desired plan. A target replaced by
    another node type or a symlink whose raw value changed is a global planning
    conflict, even when that target would otherwise only be stale.
  - A missing recorded target is not owned or stale. If it is still desired,
    it may be planned as `create`; if it is no longer desired, omit it from the
    next successfully written state. Never treat absence as proof of ownership.

- [ ] **8.2 Implement deterministic path-safe persistence models.**
  - Round-trip project-relative versus absolute paths using the project root.
  - Sort entries and emitted JSON keys deterministically and end the file with a
    newline.
  - Treat an entry as owned only if `lstat` still sees a symlink and `readlink`
    exactly equals the recorded raw value. Within the current evaluation scope,
    replacement, changed raw link value, or path-type change is a conflict
    whether or not the target appears in the desired plan.

- [ ] **8.3 Scope stale evaluation correctly.**
  - A full sync reports every recorded, still-owned target absent from the full
    desired plan as stale.
  - A selected-harness sync evaluates/removes no attribution belonging to other
    harnesses and reports stale only for the selected harness. Preserve shared
    and untouched attribution when merging successful results into state.
  - Stale targets and their still-valid state entries remain in place; initial
    release never deletes them.
  - Drop an entry for a missing target from the next state within the evaluation
    scope when it is not desired; do not report it as stale. Preserve entries
    outside a selected-harness evaluation scope unchanged.

**Tests:** absent/valid/corrupt/unknown-version state; duplicate targets; relative
and external serialization; key/entry order; raw-link tampering; regular-file
replacement and changed symlink as global conflicts even without a desired
mapping; desired missing target becomes create; undesired missing target is
neither owned nor stale and is dropped from next state; broken-but-unchanged
managed link; canonical state path; full and selected stale scope; shared
attribution preservation.

### Phase 9 - Build the complete read-only sync planner

Dependencies: Phases 5, 7, and 8.

- [ ] **9.1 Inspect targets and parent chains without mutation.**
  - Use `lstat` so broken links remain visible.
  - Inspect existing ancestors under each resolved target root. Identify missing
    parents, non-directory blockers, and symlinked parents whose resolved path
    escapes the target root. Do not call `mkdir`, create state artifacts, or
    otherwise repair anything while planning.
  - If a required parent is absent and its placement disallows creation, return
    a planning conflict. A directory or regular file at a target-file path is
    always a conflict.

- [ ] **9.2 Classify exactly one operation per desired target.**
  - `create`: target is absent.
  - `update`: state owns the unchanged symlink but its recorded mapping differs
    from the desired mapping.
  - `adopt`: no state entry records the target, but its symlink raw value is
    exactly the desired value or lexically resolves to the exact expected
    source. A target with a recorded-but-tampered state entry is a conflict,
    even if its current symlink happens to resolve to the desired source.
  - `skip`: state owns the target and it is already correct.
  - `conflict`: any unmanaged file/directory/symlink or modified managed target.
  - Add `stale` classifications independently using Phase 8 scoping.

- [ ] **9.3 Make applicability global and output deterministic.**
  - Finish inspection for all requested harnesses before deciding to apply.
  - Any config, source, unsupported-adapter, state, unsafe-parent, collision, or
    target conflict aborts all target and state writes. Return all useful
    independent diagnostics in stable order.
  - Produce immutable plan counts by skills versus files and by harness,
    placement, operation, stale, warning, and failure. The same inputs must
    produce byte-for-byte stable plain-text summaries.

**Tests:** every operation classification; exact and equivalent-link adoption
only for targets absent from state; recorded-but-tampered target conflicts even
when it resolves to the expected source; broken links; changed managed links;
file/directory collisions; missing parent create policy; safe/escaping parent
symlinks; all-harness preflight; global conflict abort; stable ordering/counts;
state loading on satisfied-only plans.

### Phase 10 - Apply an applicable plan and persist successful ownership

Dependencies: Phase 9.

- [ ] **10.1 Create target parents safely.**
  - Process applicable operations in deterministic plan order.
  - Create only required directories for placements with `createIfMissing`.
    Reinspect each ancestor immediately before use and reject any changed type or
    symlink escape.
  - Never create a directory symlink or junction and never follow a parent path
    outside the resolved target root.

- [ ] **10.2 Apply file-link operations with ownership revalidation.**
  - `create` makes a file symlink; `adopt` changes state only; `skip` makes no
    filesystem call; `update` first confirms the current raw link still equals
    recorded ownership, then replaces only that link.
  - Use POSIX file symlinks on macOS/Linux and Node's `file` symlink type on
    Windows. On privilege/Developer Mode failure, emit actionable guidance and
    never copy, junction, or silently fall back.
  - If one apply operation fails, record the failure and continue only with
    independent operations. Recheck shared parents/targets so one failure cannot
    invalidate later assumptions silently.

- [ ] **10.3 Build post-apply state from observed successes.**
  - Include successfully created, updated, or adopted mappings; include skipped
    and stale entries only while their ownership remains valid; preserve
    untouched harness attributions in a selected-harness run.
  - After a failed mutation, reinspect the target. Retain the prior state entry
    only when the target still satisfies that entry's exact recorded ownership;
    for example, an update failure that leaves the original raw symlink value
    intact remains a still-valid managed mapping. Otherwise exclude the failed
    mapping. Never record a new desired mapping unless its link operation or
    adoption actually succeeded. Keep enough failure detail for a safe rerun.
  - Before a needed state write, create `.distributor/.gitignore` only if absent
    with the init-defined contents. Never replace it; warn if an existing file
    does not ignore `state.json`.
  - Write state to a sibling temporary file, flush/close it, and atomically
    rename it to `state.json`. Clean up the temp file on failure where safe.
    State-write failure exits `1` and must not claim ownership was recorded.

**Tests:** each mutation's exact filesystem calls; second-run zero writes;
revalidation race simulations; parent creation; partial independent failures;
update failures before and after removal retaining state only when the old raw
link is still present; Windows error mapping/no fallback; state merge; atomic
rename and temp cleanup; absent/existing/wrong `.gitignore` behavior.

### Phase 11 - Orchestrate `sync` and enforce a truly read-only dry run

Dependencies: Phases 4-5 and 7-10.

- [ ] **11.1 Implement the required sync pipeline.**
  - In order: discover/validate config; discover/validate all skills; resolve
    harnesses and placements; identify satisfied placements; load state; build
    the full plan; reject non-applicable plans; conditionally apply; atomically
    record successful ownership; render summary.
  - Never prompt during sync. Do not let output/progress mutate filesystem state.
  - Configuration, source validation, unavailable adapters, invalid state, and
    planning conflicts stop before target/state writes. Apply-time errors
    continue independently, persist successes when possible, and exit `1`.

- [ ] **11.2 Make dry run share the exact read/plan path.**
  - `--dry-run` performs config, source, adapter, state, target, conflict, and
    diff inspection, then stops before the first write-capable function.
  - It must not create target parents, `.distributor`, `.gitignore`, temporary
    files, state, or repair filesystem metadata.
  - Render the same counts with an explicit `Dry run` label or future tense and
    never claim a mutation occurred.

- [ ] **11.3 Render human summaries and warnings.**
  - Distinguish skill counts from file-operation counts. Show per-harness
    created/updated/adopted/skipped counts, satisfied placement messages, and
    total stale/warning/failure counts.
  - Print per-file details only for warnings and errors. Empty source is a clear
    success/no-op with guidance to add a skill. Stale-only and warning-only runs
    exit `0`.

**Tests:** pipeline order and early-abort write spies; full and filtered sync;
empty and satisfied-only sync; dry-run plan parity plus before/after recursive
metadata snapshot; partial apply exit/state; summary grammar/counts and streams.

### Phase 12 - Finish the CLI contract and terminal behavior

Dependencies: Phases 6 and 11.

- [ ] **12.1 Wire Commander without allowing it to terminate tests.**
  - Support no command, `help`, `version`, `init`, and `sync`.
  - Support `-h`/`--help`, `-V`/`--version`, init `-y`/`--yes`, and sync's single
    `--harness <id>` and `--dry-run`.
  - Configure explicit parse/error handling so unknown commands/flags, missing
    values, and repeated `--harness` produce concise usage errors and exit `2`.
  - No command renders the same page as `help`; command help is contextual.

- [ ] **12.2 Source version and help content correctly.**
  - Read the installed package's version at runtime from package metadata; do
    not duplicate a constant. `version`, `-V`, and `--version` print exactly the
    version plus newline and never load project config.
  - Help lists commands, global/command flags, short examples, all three exit
    codes, and the executable-config trust boundary. Help also must not load
    project config.

- [ ] **12.3 Centralize terminal capability policy.**
  - Enable color only when stdout is a TTY and `NO_COLOR` is unset. Tests and
    redirected output remain stable plain text.
  - If progress is later added, use the same policy so it is completely absent
    in non-TTY and `NO_COLOR` modes.
  - The binary boundary catches expected typed failures, routes output to the
    correct stream, sets the stable exit code, and avoids raw stack traces for
    user-correctable errors.

**Tests:** subprocess coverage for every command/flag alias; no-command/help
equivalence; command help; exact version newline; no config reads for help and
version; syntax failures/repeated option; stdout/stderr; TTY/non-TTY/`NO_COLOR`;
exit-code matrix.

### Phase 13 - Harden security and cross-platform behavior

Dependencies: Phases 5 and 7-12. This phase is a focused review plus adversarial
tests, not a separate replacement implementation.

- [ ] **13.1 Audit every read/write boundary.**
  - Confirm skill content is parsed only as Markdown/YAML data and source names
    cannot inject traversal.
  - Confirm normalized containment checks run before target creation and again
    before mutation; use `lstat`/`readlink` wherever symlink identity matters.
  - Confirm no diagnostic recommends deletion/overwrite without explaining why
    the path is unmanaged, and that no `force` path exists.

- [ ] **13.2 Exercise platform-specific path and link behavior.**
  - Use platform-aware separators and relative-link expectations.
  - Test absolute links whenever either endpoint is outside project root.
  - Mock Windows privilege failures on non-Windows, and run real path/symlink
    integration tests on Windows CI before release.
  - Include case/collision, broken-link, external-home, deep-relative-link, and
    symlink-parent escape fixtures.

**Phase gate:** adversarial fixtures cannot cause writes outside selected target
roots, overwrite unmanaged content, execute skill content, or make dry run
write. Unix and Windows suites agree on plan semantics.

### Phase 14 - Complete documentation, CI, and release verification

Dependencies: all implementation phases.

- [ ] **14.1 Replace the scaffold README with user documentation.**
  - Document installation, commands, examples, configuration forms, all three
    available harnesses, automatic satisfied placements, explicit user targets,
    dry run, state/stale behavior, exit codes, and Windows symlink prerequisites.
  - Explain that JS/TS config is trusted executable code while skills are never
    executed. Explain that external targets break if their project-local source
    moves and that conflicts are never overwritten.
  - Keep roadmap adapters, cleanup, transforms, and force behavior clearly out
    of initial-release examples.

- [ ] **14.2 Add a cross-platform CI matrix.**
  - Run install, format/lint if configured, typecheck, build, unit/integration/
    acceptance tests, and package smoke tests on Node 22 with pnpm 11.
  - Include Windows and at least one of macOS/Linux; prefer all three for path
    confidence. Ensure a Windows job executes real symlink/path coverage with
    clear handling of the runner's Developer Mode capability.

- [ ] **14.3 Verify publish artifacts and spec agreement.**
  - Run the packed tarball's binary for help/version and type-import a consumer
    fixture against its declarations.
  - Compare adapter fixtures, default generated config, public types, README
    examples, and all three source specs. Do not release if examples or shared
    types disagree.
  - Confirm the repository contains no implementation or docs suggesting a
    later-scope feature is available.

## Acceptance test matrix

Create named tests that map directly to the ten release criteria so a future
agent can prove completion without inferring coverage from unit tests.

| Criterion | Required end-to-end proof |
| --- | --- |
| 1 | `init --yes` creates the exact default config, source directory, and local-state ignore file without overwriting pre-existing content. |
| 2 | Syncing that empty initialized source reports a successful no-op and writes no target or state artifacts. |
| 3 | A valid multi-file skill produces file-level Claude Code symlinks with preserved nested relative structure and correct raw link values. |
| 4 | The same default source satisfies Codex and OpenCode without creating their fallback directories. |
| 5 | A second identical sync performs no target writes, reports skips, and retains deterministic state/output. |
| 6 | Each unmanaged file, directory, changed managed symlink, and escaping parent case prevents every planned target/state write. |
| 7 | Dry run produces the same applicable plan/counts as sync while a recursive before/after snapshot proves no metadata or content changed. |
| 8 | Removing a source file reports its previously managed target as stale without deleting the target or ownership record. |
| 9 | Invalid config, invalid skills, unavailable adapters, and Windows symlink limitations emit actionable context and the specified exit code. |
| 10 | Compile/snapshot tests prove config examples, adapter metadata, generated defaults, and schema-inferred public types agree across the specs. |

Also retain focused coverage for every bullet in `SPEC.md`'s Testing Strategy;
the acceptance suite complements rather than replaces unit and integration
coverage.

## Final completion checklist

- [ ] `pnpm typecheck`, `pnpm build`, and all Vitest suites pass from a clean
  checkout on the supported Node/pnpm baseline.
- [ ] The packed npm artifact exposes a working `distributor` binary and public
  `DistributorConfig` declaration.
- [ ] Help and version work without project config; every invocation maps to
  exit `0`, `1`, or `2` according to the spec.
- [ ] The planner is deterministic and mutation-free; dry run reaches it but
  cannot reach write-capable code.
- [ ] All target conflicts are discovered before apply and no unmanaged content
  can be overwritten.
- [ ] Partial apply failures preserve successful ownership atomically and remain
  safe to rerun.
- [ ] State, stale reporting, selected-harness scope, and shared attribution are
  covered by integration tests.
- [ ] Real Windows and Unix CI validate file symlink behavior, with no copy or
  junction fallback.
- [ ] All ten acceptance tests pass, README examples are exercised, and no
  unresolved spec-to-plan questions remain.
