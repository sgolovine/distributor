# Distributor Technical Stack

This file defines the implementation baseline for the initial release. New
dependencies require a concrete capability not covered by Node.js or the tools
below.

## Runtime And Packaging

- Node.js 22 or newer on macOS, Linux, and Windows.
- TypeScript in strict mode with ECMAScript modules.
- pnpm 11 for dependency and workspace management.
- An npm package named `distributor` exposing a `distributor` binary and public
  `DistributorConfig` TypeScript type.
- `tsc` for JavaScript and declaration output; no application bundler is
  required initially.

## CLI And Interaction

- [`commander`](https://www.npmjs.com/package/commander) for commands, flags,
  help, usage errors, and exit-code plumbing.
- [`@clack/prompts`](https://www.npmjs.com/package/@clack/prompts) for
  interactive `init` only.

Prompts must never run during `sync`, in non-interactive mode, or when `--yes`
is supplied.

## Configuration And Skill Parsing

- [`cosmiconfig`](https://www.npmjs.com/package/cosmiconfig) using its async
  `load()` API after Distributor's explicit upward search selects one of the
  three filenames in `SPEC.md`. Distributor must not call cosmiconfig's broad
  `search()` defaults, which would include package properties, rc files, YAML,
  or global config locations.
- [`tsx`](https://tsx.is/dev-api/ts-import) through its scoped `tsImport()` API
  for loading the selected `distributor.config.ts` without registering a
  process-wide loader.
- [`zod`](https://www.npmjs.com/package/zod) for project config, adapter config,
  and state validation. Public TypeScript types are inferred from Zod schemas.
- [`yaml`](https://www.npmjs.com/package/yaml) for parsing `SKILL.md`
  frontmatter without executing it.

Executable JavaScript and TypeScript project configs are trusted input. Skill
Markdown and YAML are always data.

## Filesystem And Paths

- Node.js `node:fs/promises`, `node:path`, `node:os`, and `node:url` APIs for
  discovery, `lstat` inspection, directory creation, symbolic links, and atomic
  state replacement.
- No shell command is needed for sync behavior, so `execa` or another process
  execution dependency must not be added for the initial release.
- Git-root discovery for `init` may use a small filesystem walk for `.git`; it
  must not require invoking Git.

## Terminal Output

- [`picocolors`](https://www.npmjs.com/package/picocolors) for conditional
  color.
- [`ora`](https://www.npmjs.com/package/ora) only for TTY progress that can be
  disabled completely. Tests and non-TTY output must use stable plain text.

## Testing

- [`vitest`](https://www.npmjs.com/package/vitest) for unit and filesystem
  integration tests.
- Temporary directories created through Node.js APIs for all sync fixtures.
- Windows CI before release, in addition to macOS or Linux CI.

The required test surface and acceptance cases are defined in `SPEC.md`.
