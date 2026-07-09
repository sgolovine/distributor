import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

interface AtomicWriteHandle {
  writeFile(
    contents: string,
    options: { readonly encoding: "utf8" },
  ): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicWriteDependencies {
  readonly temporaryPath: (destinationPath: string) => string;
  readonly open: (
    path: string,
    flags: "wx",
  ) => Promise<AtomicWriteHandle>;
  readonly rename: (oldPath: string, newPath: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
}

const defaultDependencies: AtomicWriteDependencies = {
  temporaryPath: (destinationPath) =>
    join(
      dirname(destinationPath),
      `.${basename(destinationPath)}.${process.pid}.${randomUUID()}.tmp`,
    ),
  open: async (path, flags) => open(path, flags),
  rename,
  unlink,
};

async function ignoreFailure(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch {
    // Preserve the failure that interrupted the atomic write.
  }
}

export async function atomicWriteFile(
  destinationPath: string,
  contents: string,
  dependencies: AtomicWriteDependencies = defaultDependencies,
): Promise<void> {
  const temporaryPath = dependencies.temporaryPath(destinationPath);
  let handle: AtomicWriteHandle | undefined;
  let ownsTemporaryFile = false;

  try {
    handle = await dependencies.open(temporaryPath, "wx");
    ownsTemporaryFile = true;
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await dependencies.rename(temporaryPath, destinationPath);
    ownsTemporaryFile = false;
  } catch (error) {
    if (handle !== undefined) {
      const openHandle = handle;
      await ignoreFailure(() => openHandle.close());
    }
    if (ownsTemporaryFile) {
      await ignoreFailure(() => dependencies.unlink(temporaryPath));
    }
    throw error;
  }
}
