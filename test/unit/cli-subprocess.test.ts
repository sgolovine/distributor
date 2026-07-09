import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const binPath = fileURLToPath(new URL("../../src/bin.ts", import.meta.url));

describe("Distributor CLI subprocess", () => {
  it("prints the installed package version exactly", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", binPath, "--version"],
      { cwd: projectRoot, env: { ...process.env, NO_COLOR: "1" } },
    );

    expect(stdout).toBe(`${packageJson.version}\n`);
    expect(stderr).toBe("");
  });

  it("returns exit 2 without a stack for an unknown command", async () => {
    try {
      await execFileAsync(
        process.execPath,
        ["--import", "tsx", binPath, "unknown-command"],
        { cwd: projectRoot, env: { ...process.env, NO_COLOR: "1" } },
      );
      throw new Error("Expected subprocess to fail.");
    } catch (error) {
      const failure = error as Error & {
        readonly code: number;
        readonly stdout: string;
        readonly stderr: string;
      };
      expect(failure.code).toBe(2);
      expect(failure.stdout).toBe("");
      expect(failure.stderr).toContain("Error: unknown command");
      expect(failure.stderr).not.toContain("at ");
    }
  });
});
