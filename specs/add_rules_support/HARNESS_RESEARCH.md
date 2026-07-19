# Harness Rules Research

Research snapshot: 2026-07-18

## 1. Method and Definitions

This research covers the 16 harness IDs in `src/adapters/catalog.ts`.

Primary documentation and official repositories were preferred. "Persistent
instructions" means reusable model guidance loaded by the harness. "Modular
rules" means multiple independently discovered rule files, not Agent Skills,
one-shot prompts, command permission policies, or agent-generated memory.

Three support classes are used:

- `modular`: the harness discovers a collection of rule files;
- `context`: the harness automatically loads a singleton or hierarchical
  context/instruction file but has no zero-configuration modular rule directory;
- `none`: no built-in automatic project/user instruction discovery was found.

The support class describes the harness, not necessarily what Distributor can
map losslessly. The portable activation column reflects the initial feature in
`SPEC.md`.

## 2. Summary Matrix

| Harness ID | Persistent instructions | Native modular rules | Class | Initial portable activation |
| --- | --- | --- | --- | --- |
| `codex` | yes | no for model guidance | context | always |
| `claude-code` | yes | `.claude/rules/**/*.md` | modular | always, paths |
| `opencode` | yes | configured files only | context | always |
| `cursor` | yes | `.cursor/rules/**/*.mdc` | modular | always, paths |
| `gemini-cli` | yes | no dedicated directory | context | always |
| `antigravity` | yes | `.agents/rules/` | modular | gated/unavailable initially |
| `github-copilot` | yes | `.github/instructions/**/*.instructions.md` | modular | always, paths |
| `openhands` | yes | path rules are Agent Skills | context | always |
| `pi` | yes | no dedicated directory | context | always |
| `cline` | yes | `.cline/rules/` and `.clinerules/` | modular | always, paths |
| `goose` | yes | no dedicated directory | context | always |
| `crush` | yes | no native rule format | context | always |
| `qwen-code` | yes | `.qwen/rules/` | modular | aggregate always; modular gated |
| `kilo-code` | yes | `.kilo/rules/` plus compatibility paths | modular | gated/unavailable initially |
| `roo-code` | yes | `.roo/rules/` | modular | always |
| `trae-agent` | none found for ByteDance agent; adapter identity unresolved | no | none | unsupported |

Result: 15 of 16 support persistent instructions. Eight have a dedicated
modular rule collection independent of Agent Skills. OpenHands has modular
path-triggered guidance, but encodes it as skills and is intentionally classed
as context for Distributor's separate rules feature.

## 3. Harness Findings

### 3.1 Codex CLI

Verdict: persistent instructions yes; dedicated behavioral rule directory no.

- User instructions: `$CODEX_HOME/AGENTS.md`, normally
  `~/.codex/AGENTS.md`.
- Project instructions: hierarchical `AGENTS.md` or `AGENTS.override.md` from
  project root toward the launch working directory.
- Closer files are loaded later and take precedence as context.
- `.codex/rules/*.rules` is a Starlark command-execution policy mechanism. It
  must not receive behavioral Markdown.
- `AGENTS.md` is native, not compatibility fallback.

Distributor implication: use aggregate `AGENTS.md`; support always-on portable
rules only.

Primary sources:

- https://developers.openai.com/codex/agent-configuration/agents-md
- https://developers.openai.com/codex/agent-configuration/rules
- https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs

### 3.2 Claude Code

Verdict: full modular rule support.

- Project rules: `.claude/rules/**/*.md`.
- User rules: `~/.claude/rules/**/*.md`.
- Rules without `paths` load at session start.
- YAML `paths` globs provide conditional loading.
- Project instruction files also exist at `CLAUDE.md` and
  `.claude/CLAUDE.md`.
- Claude Code does not natively treat `AGENTS.md` as its primary instruction
  file; documentation recommends import or symlink compatibility.

Distributor implication: native modular renderer with always and paths.

Primary sources:

- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/en/claude-directory
- https://github.com/anthropics/claude-code

### 3.3 OpenCode

Verdict: persistent rules through `AGENTS.md`; arbitrary modular files require
configuration.

- Project: `AGENTS.md`, discovered from the working directory toward the
  worktree root.
- User: `~/.config/opencode/AGENTS.md`.
- `CLAUDE.md` is fallback compatibility when the corresponding `AGENTS.md` is
  absent.
- `instructions` in `opencode.json` may contain files, globs, or URLs, but no
  `.opencode/rules` directory is automatically discovered.

Distributor implication: aggregate `AGENTS.md`; do not edit `opencode.json`.

Primary sources:

- https://opencode.ai/docs/rules/
- https://opencode.ai/docs/config/
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/instruction.ts

### 3.4 Cursor

Verdict: full modular project rule support.

- Project rules: `.cursor/rules/**/*.mdc`.
- Plain `.md` files in that directory are ignored by current Cursor.
- `alwaysApply: true` means always-on.
- `globs` with `alwaysApply: false` provides path activation.
- `description` without globs can support model-selected activation, which is
  outside the portable initial scope.
- User rules are configured through Cursor settings rather than a documented
  filesystem path.
- Nested `AGENTS.md` is also supported, but the dedicated rule format is the
  appropriate Distributor target.

Distributor implication: generate MDC; never rename a plain Markdown file
without generating required metadata.

Primary sources:

- https://cursor.com/docs/rules.md
- https://cursor.com/docs/cli/using.md
- https://cursor.com/docs/cli/overview.md

### 3.5 Gemini CLI

Verdict: hierarchical context files, no dedicated modular rule directory.

- User: `~/.gemini/GEMINI.md`.
- Project/workspace: hierarchical `GEMINI.md` files.
- `@path` imports can modularize one context file but do not form independently
  activated rules.
- `AGENTS.md` can be enabled through `context.fileName`; it is not the default.

Distributor implication: aggregate `GEMINI.md`; do not edit Gemini settings.

Primary sources:

- https://geminicli.com/docs/cli/gemini-md/
- https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md

### 3.6 Google Antigravity

Verdict: dedicated modular workspace rules.

- Workspace rules: `.agents/rules/`.
- Legacy `.agent/rules/` remains supported.
- Global instructions: `~/.gemini/GEMINI.md`.
- Documented activation modes include Manual, Always On, Model Decision, and
  Glob.
- `AGENTS.md` and `GEMINI.md` are also recognized as workspace context.
- Public docs do not fully expose the exact persisted metadata syntax used by
  the IDE for every activation mode.

Distributor implication: no initial native directory capability. Gate all
Antigravity rule output until a fixture proves that metadata-free `.md` files
are always-on and file symlinks are discovered; then separately gate path
metadata.

Primary sources:

- https://antigravity.google/docs/ide/rules
- https://antigravity.google/docs/rules-workflows
- https://antigravity.google/docs/cli/gcli-migration
- https://antigravity.google/changelog

### 3.7 GitHub Copilot

Verdict: full modular and path-specific instruction support, with a
surface-specific support matrix.

- Repository-wide singleton: `.github/copilot-instructions.md`.
- Path-specific collection:
  `.github/instructions/**/*.instructions.md`.
- YAML `applyTo` contains one or more comma-separated globs.
- Copilot CLI user files include `~/.copilot/copilot-instructions.md` and
  `~/.copilot/instructions/**/*.instructions.md`.
- `AGENTS.md` is supported by several Copilot agent surfaces.
- IDE, CLI, cloud agent, code review, and web surfaces do not all support the
  same subset.

Distributor implication: use the repository-wide singleton for always rules and
`.github/instructions` with `applyTo` for path rules. Scope generated symlink
support to local Copilot surfaces; hosted surfaces cannot resolve gitignored
local blobs from committed links.

Primary sources:

- https://docs.github.com/en/copilot/reference/custom-instructions-support
- https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot
- https://docs.github.com/en/copilot/concepts/prompting/response-customization

### 3.8 OpenHands

Verdict: persistent repository context plus path-triggered guidance represented
as Agent Skills.

- Root `AGENTS.md` is recommended and injected at conversation start.
- Root `GEMINI.md` and `CLAUDE.md` variants are supported.
- Path-triggered rules live under `.agents/skills/` and use `paths`
  frontmatter.
- Project skills override user skills from `~/.agents/skills/`.
- Path-triggered injection is not available in every ACP-backed conversation.

Distributor implication: use aggregate root `AGENTS.md` for always-on rules.
Do not synthesize path rules into the same `.agents/skills` tree Distributor
already manages as skills.

Primary sources:

- https://docs.openhands.dev/overview/skills
- https://docs.openhands.dev/overview/skills/path
- https://docs.openhands.dev/overview/skills/repo
- https://docs.openhands.dev/overview/skills/org

### 3.9 Pi

Verdict: hierarchical persistent context files, no dedicated rules directory.

- User: `~/.pi/agent/AGENTS.md`.
- Project: one context file per directory while walking from filesystem root to
  current working directory.
- Candidate names include `AGENTS.md` and `CLAUDE.md`, with `AGENTS.md`
  preferred in a directory.
- No path-scoped metadata is documented.

Distributor implication: aggregate project `AGENTS.md`; always only.

Primary sources:

- https://pi.dev/docs/latest/usage#context-files
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/resource-loader.ts
- https://github.com/badlogic/pi-mono

### 3.10 Cline

Verdict: full modular rules support with active path migration.

- Project paths currently include `.cline/rules/` and `.clinerules/`.
- Legacy root `.clinerules` remains supported.
- User paths include `~/.cline/rules/` and the older
  `~/Documents/Cline/Rules/`.
- Markdown and text rules are supported.
- YAML `paths` globs provide conditional activation; no frontmatter means
  always active.
- Root and nested `AGENTS.md` compatibility is also implemented.

Distributor implication: use the established `.clinerules` path as the initial
default. Add `.cline/rules` as native only after its current preference is
pinned because official pages reflect an ongoing migration.

Primary sources:

- https://docs.cline.bot/customization/cline-rules
- https://docs.cline.bot/getting-started/config
- https://github.com/cline/cline/blob/main/sdk/packages/shared/src/storage/paths.ts
- https://github.com/cline/cline/blob/main/apps/vscode/src/core/context/instructions/user-instructions/rule-conditionals.ts

### 3.11 Goose

Verdict: persistent hierarchical context files, no dedicated rules directory.

- Default context names: `.goosehints` and `AGENTS.md`.
- Global hints: `~/.config/goose/.goosehints`.
- Project context is loaded from Git root toward the working directory and can
  load deeper files as paths are accessed.
- `CONTEXT_FILE_NAMES` can configure additional names, but Distributor must not
  mutate it.
- Official documentation says hint loading requires the Developer extension.

Distributor implication: aggregate `AGENTS.md`; emit a prerequisite warning
that Distributor cannot verify extension activation.

Primary sources:

- https://goose-docs.ai/docs/guides/context-engineering/using-goosehints
- https://goose-docs.ai/docs/guides/context-engineering/using-persistent-instructions
- https://github.com/aaif-goose/goose/blob/main/crates/goose/src/hints/load_hints.rs

### 3.12 Crush

Verdict: persistent context files and configurable context directories, but no
Crush-native conditional rule format.

- Project defaults include root `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, Crush
  variants, `.github/copilot-instructions.md`, `.cursorrules`, and
  `.cursor/rules/`.
- User defaults include `~/.config/crush/CRUSH.md` and
  `~/.config/AGENTS.md`.
- Configured context directories are recursively loaded as ordinary context;
  Cursor conditional metadata is not documented as interpreted.

Distributor implication: aggregate project `AGENTS.md`; always only.

Primary sources:

- https://github.com/charmbracelet/crush#global-context-files
- https://github.com/charmbracelet/crush/blob/main/internal/config/config.go
- https://github.com/charmbracelet/crush/blob/main/internal/agent/prompt/prompt.go

### 3.13 Qwen Code

Verdict: hierarchical context and implemented modular rules.

- Project modular rules: `<git-root>/.qwen/rules/`.
- User modular rules: `~/.qwen/rules/`.
- Markdown files are recursively loaded in deterministic order.
- Rules without `paths` load at startup; rules with `paths` are injected when a
  filesystem tool accesses a matching project path.
- `QWEN.md` and `AGENTS.md` are both default hierarchical context filenames.
- The public memory page underdocuments `.qwen/rules`; current official source
  and tests establish the behavior.

Distributor implication: the pinned modular scanner accepts only directory
entries whose `Dirent.isFile()` is true, which excludes Distributor's file
symlinks. Keep modular output unavailable. Use aggregate `QWEN.md` for always-on
rules only after a fixture proves that context-file symlinks are followed.

Primary sources:

- https://qwenlm.github.io/qwen-code-docs/en/users/features/memory/
- https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/#context-files-hierarchical-instructional-context
- https://github.com/QwenLM/qwen-code/blob/e11509d3b3b63597b35fa1a5a5252a88a47329fd/packages/core/src/utils/rulesDiscovery.ts
- https://github.com/QwenLM/qwen-code/blob/e11509d3b3b63597b35fa1a5a5252a88a47329fd/packages/core/src/memory/const.ts

### 3.14 Kilo Code

Verdict: modular rules exist, but current recommended configuration and
automatic migration behavior need a final implementation check.

- Current documentation presents `instructions` in project `kilo.jsonc` and
  user `~/.config/kilo/kilo.jsonc`.
- `.kilo/rules/` is the conventional current directory.
- Compatibility discovery includes `.kilocode/rules/` and `.kilocoderules`.
- Project and user `AGENTS.md` are also supported.
- Source code includes migration/discovery behavior for current and legacy rule
  directories, but the exact zero-configuration guarantee is less clear than
  for Claude or Cursor.

Distributor implication: no initial rule capability. Do not edit Kilo config.
Enable `.kilo/rules` only after a fixture proves automatic loading in the
supported client; otherwise leave Kilo rules unavailable rather than defaulting
to deprecated behavior.

Primary sources:

- https://kilo.ai/docs/customize/custom-rules
- https://kilo.ai/docs/customize/custom-instructions
- https://kilo.ai/docs/customize/agents-md
- https://github.com/Kilo-Org/kilocode/blob/938919ab72e3977d1512e0363417270e3337c7b1/packages/opencode/src/kilocode/rules-migrator.ts
- https://github.com/Kilo-Org/kilocode/blob/938919ab72e3977d1512e0363417270e3337c7b1/packages/opencode/src/session/instruction.ts

### 3.15 Roo Code

Verdict: full modular rule directories in the final official release, but the
project is archived.

- Project: `.roo/rules/` and mode-specific `.roo/rules-{modeSlug}/`.
- User: `~/.roo/rules/` and mode-specific equivalents.
- Project rules take precedence over global rules.
- Root `.roorules` files are fallback forms.
- Root `AGENTS.md` is optionally enabled.
- The official repository was archived and the extension shut down in May
  2026; successor forks may differ.

Distributor implication: retain generic always-on `.roo/rules` behavior as a
legacy adapter capability. Mode-specific generation is out of scope.

Primary sources:

- https://docs.roocode.com/features/custom-instructions
- https://github.com/RooCodeInc/Roo-Code

### 3.16 ByteDance Trae Agent

Verdict for ByteDance's open-source Trae Agent: no built-in automatic
persistent instruction discovery was found.

- The open-source agent constructs task context from a fixed system prompt,
  project path, and supplied task/issue.
- `trae-cli run --file` supplies a one-shot task description, not persistent
  rules.
- Configuration covers models, tools, MCP, and execution settings, not rule or
  memory files.
- No `AGENTS.md` loader or modular rule directory was found.
- The shipped Distributor adapter currently cites Trae IDE skill documentation
  while its ID and display name say Trae Agent. The adapter identity is therefore
  unresolved and must be corrected before adding rule metadata.

Distributor implication: no rule capability while identity is unresolved. A
Trae IDE rules page is not evidence for ByteDance Trae Agent, and ByteDance
Trae Agent source is not evidence about Trae IDE.

Primary sources:

- https://github.com/bytedance/trae-agent
- https://github.com/bytedance/trae-agent/blob/e839e559ac61bdd0e057c375dd1dee391fee797d/trae_agent/agent/trae_agent.py
- https://github.com/bytedance/trae-agent/blob/e839e559ac61bdd0e057c375dd1dee391fee797d/trae_agent/utils/config.py
- https://github.com/bytedance/trae-agent/blob/e839e559ac61bdd0e057c375dd1dee391fee797d/trae_agent/prompt/agent_prompt.py

## 4. Cross-Harness Findings

### 4.1 `AGENTS.md` is broad but not universal

Codex, OpenCode, Cursor, Antigravity, GitHub Copilot surfaces, OpenHands, Pi,
Cline, Goose, Crush, Qwen, and Kilo support `AGENTS.md` in some form. Claude
Code does not use it as a native primary file, Gemini requires configuration to
include it, and Trae Agent does not load it.

`AGENTS.md` therefore provides a useful aggregate target for several harnesses,
but not a universal byte-identical placement.

### 4.2 Conditional metadata is not standardized

- Claude, Cline, and Qwen use `paths`.
- Cursor uses `globs` and `alwaysApply` in MDC.
- GitHub Copilot uses `applyTo` in `.instructions.md`.
- Antigravity exposes Glob activation but does not fully document persisted
  metadata publicly.
- OpenHands uses `paths` inside an Agent Skill rather than a separate rule.
- Singleton context files generally cannot preserve conditional activation.

This is why `SPEC.md` defines one portable activation model and native
renderers, then rejects incompatible placements.

### 4.3 File suffixes are behavior

Cursor ignores plain `.md` in `.cursor/rules`, and GitHub path instructions
require `.instructions.md`. A direct symlink preserving only source bytes is not
enough. Target names and native frontmatter must be generated deliberately.

### 4.4 User scope is not uniform

Some harnesses have filesystem user-rule directories, some use a singleton
global context file, and Cursor stores user rules in UI settings. Distributor
must expose only verified filesystem user placements. It must never claim UI or
organization policy support through a local path.

### 4.5 Harness products are not interchangeable

- GitHub Copilot CLI, IDE integrations, cloud agent, code review, and web chat
  support different instruction subsets.
- OpenHands local and ACP-backed conversations differ for path-triggered rules.
- Trae Agent and Trae IDE are distinct products.
- Roo Code's archived release and successor forks may differ.
- Goose moved repositories, and Pi's repository redirects, so source links may
  have historical names.

Adapter notes and documentation must retain these qualifications.
