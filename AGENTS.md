# Repository Instructions

## Required smoke test

- Before reporting any work as complete, build the current changes and smoke
  test the resulting behavior from the `smoke_test` directory.
- Run the relevant Distributor command from inside `smoke_test`; do not use the
  repository root as a substitute working directory.
- Inspect the generated files and command output to confirm the requested
  behavior. Unit tests and type checks do not replace this smoke test.
- Keep all smoke-test artifacts inside `smoke_test`.
