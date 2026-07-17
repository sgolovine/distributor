import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  getRegistryAvailableConfig,
  loadAdapterRegistry,
} from "../../src/adapters/index.js";
import type { HarnessConfig } from "../../src/adapters/schema.js";
import { DistributorError } from "../../src/errors.js";
import { runInit } from "../../src/init/run-init.js";
import { runSync } from "../../src/sync/run-sync.js";
import { useFixture } from "../helpers/fixture.js";

describe("custom adapter registry", () => {
  it("loads immediate JSON, JavaScript, and TypeScript files using their name fields", async () => {
    await useFixture(async (root) => {
      const directory = join(root, ".distributor", "adapters");
      await mkdir(join(directory, "nested"), { recursive: true });
      await writeFile(
        join(root, "package.json"),
        '{"type":"module"}\n',
        "utf8",
      );
      await writeFile(
        join(directory, "01-arbitrary-filename.json"),
        JSON.stringify(customAdapter("json-harness", ".json/skills")),
        "utf8",
      );
      await writeFile(
        join(directory, "02-adapter.js"),
        `export default ${JSON.stringify(customAdapter("javascript-harness", ".javascript/skills"))};\n`,
        "utf8",
      );
      await writeFile(
        join(directory, "03-adapter.ts"),
        `const adapter: unknown = ${JSON.stringify(customAdapter("typescript-harness", ".typescript/skills"))};\nexport default adapter;\n`,
        "utf8",
      );
      await writeFile(
        join(directory, "ignored.yaml"),
        "name: ignored\n",
        "utf8",
      );
      await writeFile(
        join(directory, "nested", "ignored.json"),
        JSON.stringify(customAdapter("nested-harness", ".nested/skills")),
        "utf8",
      );

      const registry = await loadAdapterRegistry(root);
      const customNames = registry.catalog
        .slice(-3)
        .map((entry) => entry.name);

      expect(customNames).toEqual([
        "json-harness",
        "javascript-harness",
        "typescript-harness",
      ]);
      const jsonAdapter = getRegistryAvailableConfig(
        registry,
        "json-harness",
      );
      expect(jsonAdapter).toMatchObject({
        defaultProjectPlacementId: "project",
      });
      expect(jsonAdapter).not.toHaveProperty("sources");
      expect(jsonAdapter).not.toHaveProperty("verifiedAt");
      expect(
        getRegistryAvailableConfig(registry, "nested-harness"),
      ).toBeUndefined();

      const nestedInvocation = join(root, "workspace");
      await mkdir(nestedInvocation);
      const nestedRegistry = await loadAdapterRegistry(nestedInvocation);
      expect(
        getRegistryAvailableConfig(nestedRegistry, "json-harness"),
      ).toBeUndefined();
    });
  });

  it("rejects IDs that duplicate a built-in adapter", async () => {
    await useFixture(async (root) => {
      await writeAdapter(root, "duplicate.json", customAdapter("codex"));

      const error = await captureDistributorError(loadAdapterRegistry(root));

      expect(error.message).toContain("Duplicate adapter ID");
      expect(error.issues).toEqual([
        expect.objectContaining({
          message: "duplicates a built-in adapter",
          received: "codex",
        }),
      ]);
    });
  });

  it("rejects IDs duplicated by two custom adapter files", async () => {
    await useFixture(async (root) => {
      await writeAdapter(root, "first.json", customAdapter("duplicate"));
      await writeAdapter(root, "second.json", customAdapter("duplicate"));

      const error = await captureDistributorError(loadAdapterRegistry(root));

      expect(error.message).toContain("Duplicate adapter ID");
      expect(error.issues[0]?.message).toContain("first.json");
    });
  });

  it("includes available custom adapters in init --yes", async () => {
    await useFixture(async (root) => {
      const adapterPath = await writeAdapter(
        root,
        "team.json",
        customAdapter("team-harness"),
      );

      const result = await runInit({ cwd: root, yes: true });
      const config = JSON.parse(
        await readFile(result.configPath, "utf8"),
      ) as { harnesses: string[] };

      expect(config.harnesses.at(-1)).toBe("team-harness");
      expect(JSON.parse(await readFile(adapterPath, "utf8"))).toMatchObject({
        name: "team-harness",
      });
      expect(
        await readFile(join(root, ".distributor", ".gitignore"), "utf8"),
      ).toContain("!adapters/**");
    });
  });

  it("uses a custom adapter during sync", async () => {
    await useFixture(async (root) => {
      await writeAdapter(
        root,
        "team.json",
        customAdapter("team-harness", ".team/skills"),
      );
      await writeFile(
        join(root, "distributor.config.json"),
        '{"source":".agents/skills","harnesses":["team-harness"]}\n',
        "utf8",
      );
      const skillPath = join(
        root,
        ".agents",
        "skills",
        "review",
        "SKILL.md",
      );
      await mkdir(dirname(skillPath), { recursive: true });
      await writeFile(
        skillPath,
        "---\nname: review\ndescription: Review code.\n---\n",
        "utf8",
      );

      const result = await runSync({ cwd: root, dryRun: true });

      expect(result.counts.harnesses.map((entry) => entry.harnessId)).toEqual([
        "team-harness",
      ]);
      expect(result.plan.operations).toEqual([
        expect.objectContaining({
          targetPath: join(root, ".team", "skills", "review", "SKILL.md"),
          kind: "create",
        }),
      ]);
    });
  });
});

function customAdapter(
  name: string,
  defaultPath = ".custom/skills",
): HarnessConfig {
  return {
    name,
    displayName: `${name} display`,
    adapterStatus: "available",
    supportsNativeSkills: true,
    placements: [
      {
        id: "project",
        item: "skills",
        support: "native",
        scope: "project",
        defaultPath,
        createIfMissing: true,
      },
    ],
  };
}

async function writeAdapter(
  root: string,
  filename: string,
  adapter: HarnessConfig,
): Promise<string> {
  const filepath = join(root, ".distributor", "adapters", filename);
  await mkdir(dirname(filepath), { recursive: true });
  await writeFile(filepath, JSON.stringify(adapter), "utf8");
  return filepath;
}

async function captureDistributorError(
  promise: Promise<unknown>,
): Promise<DistributorError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DistributorError) {
      return error;
    }
    throw error;
  }

  throw new Error("Expected DistributorError.");
}
