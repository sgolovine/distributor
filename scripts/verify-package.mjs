import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const workspace = await mkdtemp(join(tmpdir(), "distributor-package-smoke-"));

try {
  const tarballDirectory = join(workspace, "tarball");
  const unpackDirectory = join(workspace, "unpacked");
  await mkdir(tarballDirectory);
  await mkdir(unpackDirectory);

  await runPnpm(["pack"], {
    env: {
      ...process.env,
      pnpm_config_pack_destination: tarballDirectory,
    },
  });

  const tarballs = (await readdir(tarballDirectory)).filter((name) =>
    name.endsWith(".tgz"),
  );
  assert.equal(
    tarballs.length,
    1,
    `Expected one packed tarball, found ${tarballs.length}.`,
  );

  const tarballPath = join(tarballDirectory, tarballs[0]);
  await run("tar", ["-xzf", tarballPath, "-C", unpackDirectory]);

  const packageRoot = join(unpackDirectory, "package");
  const packageJson = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  const consumerRoot = await installConsumer(tarballPath, packageJson);

  await verifyContents(packageRoot);
  await verifyBin(packageRoot, packageJson, consumerRoot);
  await verifyTypeConsumer(consumerRoot);

  console.log(`Packed package verified: ${tarballs[0]}`);
} finally {
  await rm(workspace, {
    force: true,
    maxRetries: 3,
    recursive: true,
    retryDelay: 100,
  });
}

async function verifyContents(packageRoot) {
  const files = await listFiles(packageRoot);
  const requiredFiles = [
    "LICENSE",
    "README.md",
    "dist/bin.js",
    "dist/index.d.ts",
    "dist/index.js",
    "package.json",
  ];

  for (const requiredFile of requiredFiles) {
    assert(
      files.includes(requiredFile),
      `Packed package is missing ${requiredFile}.`,
    );
  }

  const unexpectedFiles = files.filter(
    (file) =>
      file !== "LICENSE" &&
      file !== "README.md" &&
      file !== "package.json" &&
      !file.startsWith("dist/"),
  );
  assert.deepEqual(
    unexpectedFiles,
    [],
    `Packed package contains unexpected files: ${unexpectedFiles.join(", ")}`,
  );
}

async function installConsumer(tarballPath, packageJson) {
  const consumerRoot = join(workspace, "consumer");
  const typescriptVersion = packageJson.devDependencies?.typescript;
  assert.equal(
    typeof typescriptVersion,
    "string",
    "Packed package metadata must retain the TypeScript smoke-test version.",
  );
  const tarballReference = `file:${relative(consumerRoot, tarballPath)
    .split("\\")
    .join("/")}`;

  await mkdir(consumerRoot);
  await writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: { distributor: tarballReference },
        devDependencies: { typescript: typescriptVersion },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(consumerRoot, "pnpm-workspace.yaml"),
    "allowBuilds:\n  esbuild: true\n",
    "utf8",
  );
  await runPnpm(["install"], { cwd: consumerRoot });
  return consumerRoot;
}

async function verifyBin(packageRoot, packageJson, consumerRoot) {
  assert.deepEqual(packageJson.bin, { distributor: "./dist/bin.js" });
  assert.equal(packageJson.main, "./dist/index.js");
  assert.equal(packageJson.types, "./dist/index.d.ts");
  assert.equal(packageJson.exports?.["."]?.types, "./dist/index.d.ts");
  assert.equal(packageJson.exports?.["."]?.import, "./dist/index.js");
  assert.equal(typeof packageJson.version, "string");

  const binPath = join(packageRoot, "dist", "bin.js");
  const binContents = await readFile(binPath, "utf8");
  assert.equal(binContents.split(/\r?\n/u, 1)[0], "#!/usr/bin/env node");

  if (process.platform !== "win32") {
    const stats = await lstat(binPath);
    assert.notEqual(
      stats.mode & 0o111,
      0,
      "Packed distributor binary is not executable.",
    );
  }

  const help = await runPnpm(["exec", "distributor", "--help"], {
    cwd: consumerRoot,
  });
  const shortHelp = await runPnpm(["exec", "distributor", "-h"], {
    cwd: consumerRoot,
  });
  assert.equal(shortHelp.stdout, help.stdout);
  assert.equal(shortHelp.stderr, "");
  assert.match(help.stdout, /^Usage: distributor \[options\] \[command\]/mu);
  assert.match(help.stdout, /Commands:\s+[\s\S]*\binit \[options\]/u);
  assert.match(help.stdout, /Commands:\s+[\s\S]*\bsync \[options\]/u);
  assert.doesNotMatch(
    help.stdout,
    /--(?:clean|force|json|transform)\b/u,
    "Packed help advertises a later-scope feature.",
  );
  assert.equal(help.stderr, "");

  const version = await runPnpm(["exec", "distributor", "--version"], {
    cwd: consumerRoot,
  });
  const shortVersion = await runPnpm(["exec", "distributor", "-V"], {
    cwd: consumerRoot,
  });
  assert.equal(version.stdout, `${packageJson.version}\n`);
  assert.equal(version.stderr, "");
  assert.equal(shortVersion.stdout, version.stdout);
  assert.equal(shortVersion.stderr, "");
}

async function verifyTypeConsumer(consumerRoot) {
  await writeFile(
    join(consumerRoot, "consumer.ts"),
    `import type { DistributorConfig } from "distributor";

const config: DistributorConfig = {
  source: ".agents/skills",
  harnesses: ["codex"],
};

export default config;
`,
    "utf8",
  );
  await writeFile(
    join(consumerRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          target: "ES2023",
          types: [],
        },
        files: ["consumer.ts"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await run(
    process.execPath,
    [
      join(consumerRoot, "node_modules", "typescript", "bin", "tsc"),
      "--project",
      "tsconfig.json",
    ],
    { cwd: consumerRoot },
  );
}

async function listFiles(directory) {
  const files = [];

  async function visit(currentDirectory) {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const entryPath = join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else {
        files.push(relative(directory, entryPath).split("\\").join("/"));
      }
    }
  }

  await visit(directory);
  return files;
}

async function runPnpm(args, options = {}) {
  if (process.platform === "win32") {
    for (const arg of args) {
      assert.match(
        arg,
        /^[a-z0-9@._:/=+-]+$/iu,
        `Unsafe Windows pnpm argument: ${arg}`,
      );
    }
    return run(`pnpm.cmd ${args.join(" ")}`, [], {
      ...options,
      argumentsAreEmbedded: true,
      shell: true,
    });
  }
  return run("pnpm", args, options);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const spawnOptions = {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
    };
    const child = options.argumentsAreEmbedded === true
      ? spawn(command, spawnOptions)
      : spawn(command, args, spawnOptions);
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ stderr, stdout });
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} failed` +
            (signal === null ? ` with exit code ${code}.` : ` on ${signal}.`) +
            `\n${stdout}${stderr}`,
        ),
      );
    });
  });
}
