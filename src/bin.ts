#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { runCli } from "./cli.js";
import { createOutput } from "./output.js";

const output = createOutput({
  stdoutIsTTY: process.stdout.isTTY === true,
  noColor: process.env.NO_COLOR !== undefined,
});

try {
  const packageJsonUrl = new URL("../package.json", import.meta.url);
  const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8")) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== "string") {
    throw new Error("Installed package metadata does not contain a version.");
  }

  process.exitCode = await runCli(process.argv.slice(2), {
    version: packageJson.version,
    output,
  });
} catch (error) {
  output.printError(error);
  process.exitCode = 1;
}
