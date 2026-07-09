import { lstat, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "win32") {
  console.log("Windows symlink capability check skipped on this platform.");
} else {
  const directory = await mkdtemp(join(tmpdir(), "distributor-symlink-check-"));

  try {
    const sourcePath = join(directory, "source.txt");
    const linkPath = join(directory, "link.txt");
    const linkValue = "source.txt";

    await writeFile(sourcePath, "symlink capability check\n", "utf8");
    await symlink(linkValue, linkPath, "file");

    const stats = await lstat(linkPath);
    if (!stats.isSymbolicLink()) {
      throw new Error("Windows created something other than a file symlink.");
    }
    if ((await readlink(linkPath)) !== linkValue) {
      throw new Error("Windows did not preserve the relative file-link value.");
    }
    if ((await readFile(linkPath, "utf8")) !== "symlink capability check\n") {
      throw new Error("The Windows file symlink does not resolve to its source.");
    }

    console.log("Windows can create and resolve real relative file symlinks.");
  } catch (error) {
    if (isPermissionError(error)) {
      console.error(
        "Real Windows symlink tests require Windows Developer Mode or the " +
          '"Create symbolic links" privilege. Enable Developer Mode under ' +
          "Settings > System > Advanced > For developers, then rerun CI. " +
          "This check is intentionally not skipped because Distributor does " +
          "not fall back to copies or junctions.",
      );
    }
    throw error;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function isPermissionError(error) {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "EPERM" || error.code === "EACCES")
  );
}
