import { describe, expect, it } from "vitest";

import { DistributorError } from "../../src/errors.js";
import {
  deserializeStatePath,
  displayPath,
  isStrictChildPath,
  normalizeAbsolutePath,
  pathComparisonKey,
  pathsAreEquivalent,
  resolveConfigPath,
  serializeStatePath,
} from "../../src/filesystem/paths.js";

describe("resolveConfigPath", () => {
  const posixContext = {
    projectRoot: "/work/project",
    homeDirectory: "/home/dev",
    style: "posix" as const,
  };

  it("resolves project-relative paths without using the process cwd", () => {
    expect(resolveConfigPath("skills/../skills/review", posixContext)).toBe(
      "/work/project/skills/review",
    );
  });

  it.each([
    ["~/skills", "/home/dev/skills"],
    ["$HOME/skills", "/home/dev/skills"],
    ["$PROJECT_ROOT/.agents/skills", "/work/project/.agents/skills"],
    ["/shared/skills", "/shared/skills"],
  ])("expands %s", (configuredPath, expected) => {
    expect(resolveConfigPath(configuredPath, posixContext)).toBe(expected);
  });

  it("resolves Windows paths with explicit win32 semantics", () => {
    const context = {
      projectRoot: "C:\\work\\project",
      homeDirectory: "D:\\Users\\dev",
      style: "win32" as const,
    };

    expect(resolveConfigPath(".agents\\skills", context)).toBe(
      "C:\\work\\project\\.agents\\skills",
    );
    expect(resolveConfigPath("~\\skills", context)).toBe(
      "D:\\Users\\dev\\skills",
    );
    expect(resolveConfigPath("\\shared\\skills", context)).toBe(
      "C:\\shared\\skills",
    );
  });

  it.each(["", "   ", "$UNKNOWN/skills", "${HOME}/skills", "%HOME%/skills"])(
    "rejects unsupported configured path %j",
    (configuredPath) => {
      expect(() => resolveConfigPath(configuredPath, posixContext)).toThrow(
        DistributorError,
      );
    },
  );

  it("rejects home expansion when the home directory is unavailable", () => {
    expect(() =>
      resolveConfigPath("~/skills", {
        projectRoot: "/work/project",
        style: "posix",
      }),
    ).toThrow("home directory is unavailable");
  });

  it("rejects named-home and Windows drive-relative paths", () => {
    expect(() => resolveConfigPath("~other/skills", posixContext)).toThrow(
      "current user's home",
    );
    expect(() =>
      resolveConfigPath("D:skills", {
        projectRoot: "C:\\work\\project",
        style: "win32",
      }),
    ).toThrow("drive-relative");
  });
});

describe("path comparison and containment", () => {
  it("normalizes absolute paths without resolving relative input", () => {
    expect(normalizeAbsolutePath("/work/project/skills/..", "posix")).toBe(
      "/work/project",
    );
    expect(() => normalizeAbsolutePath("relative/path", "posix")).toThrow(
      "must be absolute",
    );
    expect(() => normalizeAbsolutePath("C:relative", "win32")).toThrow(
      "drive-relative",
    );
    expect(normalizeAbsolutePath("//server/share/skills", "win32")).toBe(
      "\\\\server\\share\\skills",
    );
  });

  it("uses case-sensitive POSIX and case-insensitive Windows keys", () => {
    expect(pathsAreEquivalent("/Project/Skills", "/project/skills", "posix")).toBe(
      false,
    );
    expect(
      pathsAreEquivalent(
        "C:\\Project\\Skills\\",
        "c:\\project\\skills",
        "win32",
      ),
    ).toBe(true);
    expect(pathComparisonKey("C:\\PROJECT\\skills", "win32")).toBe(
      "c:\\project\\skills",
    );
  });

  it("recognizes only strict descendants", () => {
    expect(isStrictChildPath("/project", "/project/skills", "posix")).toBe(true);
    expect(isStrictChildPath("/project", "/project", "posix")).toBe(false);
    expect(isStrictChildPath("/project", "/project-other", "posix")).toBe(false);
    expect(isStrictChildPath("/project", "/outside", "posix")).toBe(false);
    expect(
      isStrictChildPath(
        "C:\\Project",
        "c:\\project\\Skills",
        "win32",
      ),
    ).toBe(true);
    expect(
      isStrictChildPath("C:\\Project", "D:\\Project\\Skills", "win32"),
    ).toBe(false);
  });

  it("uses project-relative diagnostic paths only for project-local values", () => {
    expect(displayPath("/project/skills/review", "/project", "posix")).toBe(
      "skills/review",
    );
    expect(displayPath("/project", "/project", "posix")).toBe(".");
    expect(displayPath("/shared/skills", "/project", "posix")).toBe(
      "/shared/skills",
    );
  });
});

describe("managed-state path representation", () => {
  it("round-trips project-local and external POSIX paths", () => {
    const root = "/project";

    expect(serializeStatePath("/project/skills/review", root, "posix")).toBe(
      "skills/review",
    );
    expect(deserializeStatePath("skills/review", root, "posix")).toBe(
      "/project/skills/review",
    );
    expect(serializeStatePath("/project", root, "posix")).toBe(".");
    expect(deserializeStatePath(".", root, "posix")).toBe("/project");
    expect(serializeStatePath("/shared/skills", root, "posix")).toBe(
      "/shared/skills",
    );
    expect(deserializeStatePath("/shared/skills", root, "posix")).toBe(
      "/shared/skills",
    );
  });

  it("round-trips Windows paths and preserves external drive qualification", () => {
    const root = "C:\\project";

    expect(
      serializeStatePath("c:\\PROJECT\\skills\\review", root, "win32"),
    ).toBe("skills\\review");
    expect(deserializeStatePath("skills\\review", root, "win32")).toBe(
      "C:\\project\\skills\\review",
    );
    expect(deserializeStatePath("D:\\shared\\skills", root, "win32")).toBe(
      "D:\\shared\\skills",
    );
  });

  it.each(["../outside", "skills/../../outside"])(
    "rejects relative state escape %s",
    (storedPath) => {
      expect(() =>
        deserializeStatePath(storedPath, "/project", "posix"),
      ).toThrow("escapes the project root");
    },
  );

  it("rejects noncanonical and drive-relative state paths", () => {
    expect(() =>
      deserializeStatePath("/project/skills", "/project", "posix"),
    ).toThrow("must use project-relative form");
    expect(() =>
      deserializeStatePath("C:skills", "C:\\project", "win32"),
    ).toThrow("drive-relative");
  });
});
