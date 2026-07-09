import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function useFixture(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "distributor-test-"));

  try {
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}
