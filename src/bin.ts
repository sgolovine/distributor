#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { createProgram } from "./cli.js";

const packageJsonUrl = new URL("../package.json", import.meta.url);
const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8")) as {
  version: string;
};

await createProgram(packageJson.version).parseAsync(process.argv);
