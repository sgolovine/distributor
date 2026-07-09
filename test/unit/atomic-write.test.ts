import {
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  atomicWriteFile,
  type AtomicWriteDependencies,
} from "../../src/filesystem/atomic-write.js";
import { useFixture } from "../helpers/fixture.js";

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

describe("atomicWriteFile", () => {
  it("replaces a file through a sibling temporary file", async () => {
    await useFixture(async (root) => {
      const destination = join(root, "state.json");
      await writeFile(destination, "old contents\n", "utf8");

      await atomicWriteFile(destination, "new contents\n");

      expect(await readFile(destination, "utf8")).toBe("new contents\n");
      expect(await readdir(root)).toEqual(["state.json"]);
    });
  });

  it("does not create a missing destination directory", async () => {
    await useFixture(async (root) => {
      const parent = join(root, "missing");

      await expect(
        atomicWriteFile(join(parent, "state.json"), "{}\n"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await exists(parent)).toBe(false);
    });
  });

  it("cleans up the temporary file when a real rename fails", async () => {
    await useFixture(async (root) => {
      const destination = join(root, "state.json");
      await mkdir(destination);

      await expect(
        atomicWriteFile(destination, "new contents\n"),
      ).rejects.toBeDefined();

      expect((await lstat(destination)).isDirectory()).toBe(true);
      expect(await readdir(root)).toEqual(["state.json"]);
    });
  });

  it("opens exclusively, writes, flushes, closes, then renames", async () => {
    const events: string[] = [];
    const destination = "/project/.distributor/state.json";
    const temporary = "/project/.distributor/.state.tmp";
    const dependencies: AtomicWriteDependencies = {
      temporaryPath: () => temporary,
      open: async (path, flags) => {
        events.push(`open:${path}:${flags}`);
        return {
          writeFile: async (contents, options) => {
            events.push(`write:${contents}:${options.encoding}`);
          },
          sync: async () => {
            events.push("sync");
          },
          close: async () => {
            events.push("close");
          },
        };
      },
      rename: async (oldPath, newPath) => {
        events.push(`rename:${oldPath}:${newPath}`);
      },
      unlink: async (path) => {
        events.push(`unlink:${path}`);
      },
    };

    await atomicWriteFile(destination, "contents", dependencies);

    expect(events).toEqual([
      `open:${temporary}:wx`,
      "write:contents:utf8",
      "sync",
      "close",
      `rename:${temporary}:${destination}`,
    ]);
  });

  it.each(["write", "sync", "close", "rename"] as const)(
    "closes and cleans up after a %s failure",
    async (failurePoint) => {
      const failure = new Error(`${failurePoint} failed`);
      const events: string[] = [];
      const dependencies: AtomicWriteDependencies = {
        temporaryPath: () => "/project/.state.tmp",
        open: async () => {
          events.push("open");
          return {
            writeFile: async () => {
              events.push("write");
              if (failurePoint === "write") {
                throw failure;
              }
            },
            sync: async () => {
              events.push("sync");
              if (failurePoint === "sync") {
                throw failure;
              }
            },
            close: async () => {
              events.push("close");
              if (failurePoint === "close") {
                throw failure;
              }
            },
          };
        },
        rename: async () => {
          events.push("rename");
          if (failurePoint === "rename") {
            throw failure;
          }
        },
        unlink: async () => {
          events.push("unlink");
        },
      };

      await expect(
        atomicWriteFile("/project/state.json", "contents", dependencies),
      ).rejects.toBe(failure);
      expect(events).toEqual({
        write: ["open", "write", "close", "unlink"],
        sync: ["open", "write", "sync", "close", "unlink"],
        close: ["open", "write", "sync", "close", "close", "unlink"],
        rename: ["open", "write", "sync", "close", "rename", "unlink"],
      }[failurePoint]);
    },
  );

  it("does not unlink a temporary path when exclusive open fails", async () => {
    const openFailure = Object.assign(new Error("already exists"), {
      code: "EEXIST",
    });
    const unlink = vi.fn(async () => undefined);
    const dependencies: AtomicWriteDependencies = {
      temporaryPath: () => "/project/.state.tmp",
      open: async () => {
        throw openFailure;
      },
      rename: async () => undefined,
      unlink,
    };

    await expect(
      atomicWriteFile("/project/state.json", "contents", dependencies),
    ).rejects.toBe(openFailure);
    expect(unlink).not.toHaveBeenCalled();
  });

  it("preserves the original failure when temporary cleanup also fails", async () => {
    const renameFailure = new Error("rename failed");
    const dependencies: AtomicWriteDependencies = {
      temporaryPath: () => "/project/.state.tmp",
      open: async () => ({
        writeFile: async () => undefined,
        sync: async () => undefined,
        close: async () => undefined,
      }),
      rename: async () => {
        throw renameFailure;
      },
      unlink: async () => {
        throw new Error("cleanup failed");
      },
    };

    await expect(
      atomicWriteFile("/project/state.json", "contents", dependencies),
    ).rejects.toBe(renameFailure);
  });
});
