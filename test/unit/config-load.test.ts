import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadSelectedConfig } from "../../src/config/load.js";
import { useFixture } from "../helpers/fixture.js";

const expected = {
  source: ".agents/skills",
  harnesses: [{ name: "codex", useHarnessFolder: true }],
};

describe("loadSelectedConfig", () => {
  it("loads only an explicitly selected JSON config", async () => {
    await useFixture(async (root) => {
      const configPath = join(root, "distributor.config.json");
      await writeFile(configPath, JSON.stringify(expected), "utf8");

      await expect(loadSelectedConfig(configPath)).resolves.toEqual(expected);
    });
  });

  it("loads an explicitly selected JavaScript default export", async () => {
    await useFixture(async (root) => {
      await writeFile(join(root, "package.json"), '{"type":"module"}\n', "utf8");
      const configPath = join(root, "distributor.config.js");
      await writeFile(
        configPath,
        `export default ${JSON.stringify(expected)};\n`,
        "utf8",
      );

      await expect(loadSelectedConfig(configPath)).resolves.toEqual(expected);
    });
  });

  it("loads TypeScript through a scoped import", async () => {
    await useFixture(async (root) => {
      await mkdir(join(root, "nested"));
      const configPath = join(root, "nested", "distributor.config.ts");
      await writeFile(
        configPath,
        `const config = ${JSON.stringify(expected)};\nexport default config;\n`,
        "utf8",
      );

      await expect(loadSelectedConfig(configPath)).resolves.toEqual(expected);
    });
  });

  it("rejects unapproved config extensions", async () => {
    await expect(loadSelectedConfig("distributor.config.yaml")).rejects.toThrow(
      "Unsupported Distributor config extension",
    );
  });
});
