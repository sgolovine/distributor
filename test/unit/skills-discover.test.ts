import {
  lstat,
  mkdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { once } from "node:events";

import { describe, expect, it } from "vitest";

import { useFixture } from "../helpers/fixture.js";
import {
  discoverSkills,
  SkillValidationError,
} from "../../src/skills/discover.js";

describe("discoverSkills", () => {
  it("returns an empty result for an empty source directory", async () => {
    await useFixture(async (root) => {
      const result = await discoverSkills(root);
      const stats = await lstat(root);

      expect(result).toEqual({
        sourceRoot: root,
        sourceRootIdentity: {
          realPath: await realpath(root),
          device: stats.dev,
          inode: stats.ino,
        },
        skills: [],
        helperFiles: [],
        warnings: [],
      });
    });
  });

  it("discovers deterministic skill and helper file lists and ignores hidden root entries", async () => {
    await useFixture(async (root) => {
      await mkdir(join(root, "zeta", "references"), { recursive: true });
      await mkdir(join(root, "zeta", "empty"));
      await mkdir(join(root, "_bqe-core-reference", "nested"), {
        recursive: true,
      });
      await mkdir(join(root, "alpha"));
      await mkdir(join(root, ".ignored"));
      await writeFile(join(root, ".ignored", "SKILL.md"), "not frontmatter");
      await symlink("missing", join(root, ".hidden-link"), "file");
      await writeFile(join(root, "notes.txt"), "ignored");
      await writeFile(
        join(root, "_bqe-core-reference", "nested", "schema.json"),
        "{}",
      );
      await writeSkill(root, "zeta", {
        extra: "preserved",
      });
      await writeSkill(root, "alpha");
      await writeFile(join(root, "zeta", ".nested"), "hidden but included");
      await writeFile(join(root, "zeta", "references", "b.md"), "b");
      await writeFile(join(root, "zeta", "references", "a.md"), "a");

      const result = await discoverSkills(root);

      expect(result.skills.map((skill) => skill.name)).toEqual([
        "alpha",
        "zeta",
      ]);
      expect(
        result.skills[1]?.files.map((file) => file.sourceRelativePath),
      ).toEqual([
        join("zeta", ".nested"),
        join("zeta", "SKILL.md"),
        join("zeta", "references", "a.md"),
        join("zeta", "references", "b.md"),
      ]);
      expect(result.skills[1]?.frontmatter.extra).toBe("preserved");
      expect(result.helperFiles).toEqual([
        {
          absolutePath: join(
            root,
            "_bqe-core-reference",
            "nested",
            "schema.json",
          ),
          sourceRelativePath: join(
            "_bqe-core-reference",
            "nested",
            "schema.json",
          ),
          helperName: "_bqe-core-reference",
        },
        {
          absolutePath: join(root, "notes.txt"),
          sourceRelativePath: "notes.txt",
          helperName: "notes.txt",
        },
      ]);
      expect(result.warnings).toEqual([]);
    });
  });

  it("skips invalid skills and reports their frontmatter problems", async () => {
    await useFixture(async (root) => {
      await mkdir(join(root, "first"));
      await mkdir(join(root, "second"));
      await writeFile(join(root, "first", "SKILL.md"), "No frontmatter");
      await writeFile(
        join(root, "second", "SKILL.md"),
        [
          "---",
          "name: another-name",
          "description: ''",
          "compatibility: ''",
          "---",
        ].join("\n"),
      );
      await writeFile(join(root, "ignored.txt"), "ignored");

      const result = await discoverSkills(root);

      expect(result.skills).toEqual([]);
      expect(result.helperFiles).toEqual([
        {
          absolutePath: join(root, "ignored.txt"),
          sourceRelativePath: "ignored.txt",
          helperName: "ignored.txt",
        },
      ]);
      expect(result.warnings).toEqual([
        {
          code: "invalid-skill",
          path: join(root, "first"),
          message: expect.stringMatching(/Skipped invalid skill "first".*must begin/),
        },
        {
          code: "invalid-skill",
          path: join(root, "second"),
          message: expect.stringMatching(
            /Skipped invalid skill "second".*description.*compatibility/,
          ),
        },
      ]);
    });
  });

  it("rejects non-string metadata keys from YAML", async () => {
    await useFixture(async (root) => {
      await mkdir(join(root, "metadata"));
      await writeFile(
        join(root, "metadata", "SKILL.md"),
        [
          "---",
          "name: metadata",
          "description: Valid",
          "metadata:",
          "  1: numeric key",
          "---",
        ].join("\n"),
      );

      const result = await discoverSkills(root);

      expect(result.skills).toEqual([]);
      expect(result.warnings).toEqual([
        expect.objectContaining({
          code: "invalid-skill",
          path: join(root, "metadata"),
          message: expect.stringMatching(/metadata.*Metadata keys must be strings/),
        }),
      ]);
    });
  });

  it("treats directories without exact SKILL.md casing as helpers", async () => {
    await useFixture(async (root) => {
      await mkdir(join(root, "lowercase"));
      await writeFile(join(root, "lowercase", "skill.md"), "ignored asset");

      const result = await discoverSkills(root);

      expect(result.helperFiles).toEqual([
        {
          absolutePath: join(root, "lowercase", "skill.md"),
          sourceRelativePath: join("lowercase", "skill.md"),
          helperName: "lowercase",
        },
      ]);
      expect(result.skills).toEqual([]);
    });
  });

  it("still validates directories containing SKILL.md as skills", async () => {
    await useFixture(async (root) => {
      await mkdir(join(root, "sequence"));
      await writeFile(
        join(root, "sequence", "SKILL.md"),
        "---\n- name: sequence\n- description: invalid\n---\n",
      );

      const result = await discoverSkills(root);

      expect(result.skills).toEqual([]);
      expect(result.warnings).toEqual([
        expect.objectContaining({
          code: "invalid-skill",
          path: join(root, "sequence"),
          message: expect.stringContaining("YAML mapping"),
        }),
      ]);
    });
  });

  it("rejects source roots that are missing, files, or symlinks", async () => {
    await useFixture(async (root) => {
      const missing = join(root, "missing");
      const file = join(root, "file");
      const link = join(root, "link");
      await writeFile(file, "not a directory");
      await symlink(root, link, "dir");

      await expect(discoverSkills(missing)).rejects.toBeInstanceOf(
        SkillValidationError,
      );
      await expect(discoverSkills(missing)).rejects.toMatchObject({
        category: "source",
        exitCode: 1,
        correction: expect.stringContaining("Correct"),
      });
      await expect(discoverSkills(file)).rejects.toThrow(
        "source root must be a directory",
      );
      await expect(discoverSkills(link)).rejects.toThrow("symbolic link");
    });
  });

  it("rejects visible root and nested symlinks, including broken links", async () => {
    await useFixture(async (root) => {
      await mkdir(join(root, "valid"));
      await writeSkill(root, "valid");
      await symlink("missing", join(root, "linked-skill"), "dir");
      await symlink(
        "missing.md",
        join(root, "valid", "broken.md"),
        "file",
      );

      const error = await validationError(discoverSkills(root));

      expect(error.problems).toEqual([
        expect.objectContaining({
          path: join(root, "linked-skill"),
          message: expect.stringContaining("symbolic link"),
        }),
      ]);
      expect(error.warnings).toEqual([
        expect.objectContaining({
          code: "invalid-skill",
          path: join(root, "valid"),
          message: expect.stringContaining("broken.md"),
        }),
      ]);
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects unsupported filesystem nodes",
    async () => {
      await useFixture(async (root) => {
        const socketPath = join(root, "source.socket");
        const server = createServer();
        server.listen(socketPath);
        await once(server, "listening");

        try {
          const error = await validationError(discoverSkills(root));
          expect(error.problems).toEqual([
            expect.objectContaining({
              path: socketPath,
              message: expect.stringContaining("socket"),
            }),
          ]);
        } finally {
          server.close();
          await once(server, "close");
        }
      });
    },
  );

  it("reports duplicate YAML keys without executing skill content", async () => {
    await useFixture(async (root) => {
      await mkdir(join(root, "duplicate"));
      await writeFile(
        join(root, "duplicate", "SKILL.md"),
        "---\nname: duplicate\nname: duplicate\ndescription: Valid\n---\n",
      );
      await writeFile(
        join(root, "duplicate", "script.js"),
        "throw new Error('must not execute');\n",
      );

      const result = await discoverSkills(root);

      expect(result.skills).toEqual([]);
      expect(result.warnings).toEqual([
        expect.objectContaining({
          code: "invalid-skill",
          path: join(root, "duplicate"),
          message: expect.stringContaining("Map keys must be unique"),
        }),
      ]);
    });
  });
});

async function writeSkill(
  sourceRoot: string,
  name: string,
  unknownFields: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(join(sourceRoot, name), { recursive: true });
  const unknownYaml = Object.entries(unknownFields).map(
    ([key, value]) => `${key}: ${JSON.stringify(value)}`,
  );
  await writeFile(
    join(sourceRoot, name, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${name} description`,
      ...unknownYaml,
      "---",
      "Body content is data only.",
    ].join("\n"),
  );
}

async function validationError(
  promise: Promise<unknown>,
): Promise<SkillValidationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SkillValidationError) {
      return error;
    }
    throw error;
  }

  throw new Error("Expected skill validation to fail.");
}
