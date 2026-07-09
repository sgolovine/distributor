import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { isMap, isScalar, parseDocument } from "yaml";

import { DistributorError } from "../errors.js";
import {
  SkillFrontmatterSchema,
  type SkillFrontmatter,
} from "./schema.js";

export interface SourceSkillFile {
  absolutePath: string;
  sourceRelativePath: string;
  skillRelativePath: string;
}

export interface SourceSkill {
  name: string;
  directoryPath: string;
  frontmatter: SkillFrontmatter;
  files: SourceSkillFile[];
}

export interface SkillDiscoveryWarning {
  code: "ignored-source-root-file";
  path: string;
  message: string;
}

export interface SkillValidationProblem {
  path: string;
  skillPath?: string;
  field?: string;
  message: string;
}

export interface SourceRootIdentity {
  realPath: string;
  device: number;
  inode: number;
}

export interface SkillDiscoveryResult {
  sourceRoot: string;
  sourceRootIdentity: SourceRootIdentity;
  skills: SourceSkill[];
  warnings: SkillDiscoveryWarning[];
}

export class SkillValidationError extends DistributorError {
  readonly problems: SkillValidationProblem[];
  readonly warnings: SkillDiscoveryWarning[];

  constructor(
    problems: SkillValidationProblem[],
    warnings: SkillDiscoveryWarning[] = [],
  ) {
    const message = [
        `Source skill validation failed with ${problems.length} problem${problems.length === 1 ? "" : "s"}:`,
        ...problems.map((problem) => {
          const field = problem.field === undefined ? "" : ` (${problem.field})`;
          return `- ${problem.path}${field}: ${problem.message}`;
        }),
      ].join("\n");
    super("source", message, {
      operation: "validate source skills",
      ...(problems[0] === undefined
        ? {}
        : { context: { sourcePath: problems[0].skillPath ?? problems[0].path } }),
      correction:
        "Correct every reported source problem without replacing content with symlinks, then rerun Distributor.",
      issues: problems.map((problem) => ({
        message: problem.message,
        path: problem.path,
        correction: "Correct this source entry or frontmatter field.",
      })),
    });
    this.name = "SkillValidationError";
    this.problems = problems;
    this.warnings = warnings;
  }
}

export async function discoverSkills(
  sourcePath: string,
): Promise<SkillDiscoveryResult> {
  const sourceRoot = resolve(sourcePath);
  const rootStats = await inspectSourceRoot(sourceRoot);

  if (!rootStats.isDirectory()) {
    const nodeType = describeNode(rootStats);
    throw new SkillValidationError([
      {
        path: sourceRoot,
        message: `The source root must be a directory; found ${nodeType}.`,
      },
    ]);
  }
  const sourceRootIdentity = await captureSourceRootIdentity(
    sourceRoot,
    rootStats,
  );

  const problems: SkillValidationProblem[] = [];
  const warnings: SkillDiscoveryWarning[] = [];
  const skills: SourceSkill[] = [];
  const rootEntries = await readDirectory(sourceRoot, problems);

  for (const name of rootEntries) {
    if (name.startsWith(".")) {
      continue;
    }

    const entryPath = join(sourceRoot, name);
    const stats = await inspectEntry(entryPath, problems);
    if (stats === undefined) {
      continue;
    }

    if (stats.isDirectory()) {
      const skill = await inspectSkill(sourceRoot, entryPath, name, problems);
      if (skill !== undefined) {
        skills.push(skill);
      }
      continue;
    }

    if (stats.isFile()) {
      warnings.push({
        code: "ignored-source-root-file",
        path: entryPath,
        message: "Regular files directly under the source root are ignored.",
      });
      continue;
    }

    problems.push({
      path: entryPath,
      skillPath: entryPath,
      message: `Source root entries must be skill directories; found ${describeNode(stats)}.`,
    });
  }

  if (problems.length > 0) {
    throw new SkillValidationError(problems, warnings);
  }

  await requireSourceRootIdentity(sourceRoot, sourceRootIdentity);

  return { sourceRoot, sourceRootIdentity, skills, warnings };
}

async function inspectSourceRoot(sourceRoot: string): Promise<Stats> {
  try {
    return await lstat(sourceRoot);
  } catch (error) {
    throw new SkillValidationError([
      {
        path: sourceRoot,
        message: `Unable to inspect the source root: ${errorMessage(error)}.`,
      },
    ]);
  }
}

async function captureSourceRootIdentity(
  sourceRoot: string,
  initialStats: Stats,
): Promise<SourceRootIdentity> {
  try {
    const realPath = await realpath(sourceRoot);
    const currentStats = await lstat(sourceRoot);
    if (!currentStats.isDirectory() || !sameNodeIdentity(initialStats, currentStats)) {
      throw new Error("the source root changed while its identity was captured");
    }
    return {
      realPath,
      device: currentStats.dev,
      inode: currentStats.ino,
    };
  } catch (error) {
    throw sourceRootIdentityError(sourceRoot, error);
  }
}

async function requireSourceRootIdentity(
  sourceRoot: string,
  expected: SourceRootIdentity,
): Promise<void> {
  try {
    const stats = await lstat(sourceRoot);
    const realPath = await realpath(sourceRoot);
    if (
      !stats.isDirectory() ||
      stats.dev !== expected.device ||
      stats.ino !== expected.inode ||
      realPath !== expected.realPath
    ) {
      throw new Error("the source root changed while skills were being discovered");
    }
  } catch (error) {
    throw sourceRootIdentityError(sourceRoot, error);
  }
}

function sourceRootIdentityError(
  sourceRoot: string,
  error: unknown,
): SkillValidationError {
  return new SkillValidationError([
    {
      path: sourceRoot,
      message: `Unable to establish a stable source root: ${errorMessage(error)}.`,
    },
  ]);
}

async function inspectSkill(
  sourceRoot: string,
  skillPath: string,
  directoryName: string,
  problems: SkillValidationProblem[],
): Promise<SourceSkill | undefined> {
  const firstProblem = problems.length;
  const files: SourceSkillFile[] = [];

  await collectSkillFiles(sourceRoot, skillPath, skillPath, files, problems);
  files.sort((left, right) =>
    compareText(left.sourceRelativePath, right.sourceRelativePath),
  );

  const skillFile = files.find(
    (file) => file.skillRelativePath === "SKILL.md",
  );
  let frontmatter: SkillFrontmatter | undefined;

  if (skillFile === undefined) {
    const skillFilePath = join(skillPath, "SKILL.md");
    const alreadyReported = problems
      .slice(firstProblem)
      .some((problem) => problem.path === skillFilePath);

    if (!alreadyReported) {
      problems.push({
        path: skillFilePath,
        skillPath,
        message: "Each skill must contain a regular file named exactly SKILL.md.",
      });
    }
  } else {
    frontmatter = await readFrontmatter(
      skillFile.absolutePath,
      skillPath,
      problems,
    );
    if (frontmatter !== undefined && frontmatter.name !== directoryName) {
      problems.push({
        path: skillFile.absolutePath,
        skillPath,
        field: "name",
        message: `The skill name must exactly match its directory (${JSON.stringify(directoryName)}).`,
      });
    }
  }

  if (frontmatter === undefined || problems.length > firstProblem) {
    return undefined;
  }

  return {
    name: frontmatter.name,
    directoryPath: skillPath,
    frontmatter,
    files,
  };
}

async function collectSkillFiles(
  sourceRoot: string,
  skillPath: string,
  directoryPath: string,
  files: SourceSkillFile[],
  problems: SkillValidationProblem[],
): Promise<void> {
  const entries = await readDirectory(directoryPath, problems, skillPath);

  for (const name of entries) {
    const entryPath = join(directoryPath, name);
    const stats = await inspectEntry(entryPath, problems, skillPath);
    if (stats === undefined) {
      continue;
    }

    if (stats.isDirectory()) {
      await collectSkillFiles(
        sourceRoot,
        skillPath,
        entryPath,
        files,
        problems,
      );
      continue;
    }

    if (stats.isFile()) {
      files.push({
        absolutePath: entryPath,
        sourceRelativePath: relative(sourceRoot, entryPath),
        skillRelativePath: relative(skillPath, entryPath),
      });
      continue;
    }

    problems.push({
      path: entryPath,
      skillPath,
      message: `Skills may contain only regular files and directories; found ${describeNode(stats)}.`,
    });
  }
}

async function readFrontmatter(
  skillFilePath: string,
  skillPath: string,
  problems: SkillValidationProblem[],
): Promise<SkillFrontmatter | undefined> {
  let contents: string;
  try {
    contents = await readRegularSourceFile(skillFilePath);
  } catch (error) {
    problems.push({
      path: skillFilePath,
      skillPath,
      message: `Unable to read SKILL.md: ${errorMessage(error)}.`,
    });
    return undefined;
  }

  const lines = contents.split(/\r\n|\n/);
  if (lines[0] !== "---") {
    problems.push({
      path: skillFilePath,
      skillPath,
      message: "SKILL.md must begin with a YAML frontmatter delimiter (---).",
    });
    return undefined;
  }

  const closingDelimiter = lines.indexOf("---", 1);
  if (closingDelimiter === -1) {
    problems.push({
      path: skillFilePath,
      skillPath,
      message: "SKILL.md frontmatter must end with a YAML delimiter (---).",
    });
    return undefined;
  }

  const yaml = lines.slice(1, closingDelimiter).join("\n");
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(yaml, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
  } catch (error) {
    problems.push({
      path: skillFilePath,
      skillPath,
      message: `Invalid YAML frontmatter: ${errorMessage(error)}.`,
    });
    return undefined;
  }

  const yamlProblems = [...document.errors, ...document.warnings];
  if (yamlProblems.length > 0) {
    for (const problem of yamlProblems) {
      problems.push({
        path: skillFilePath,
        skillPath,
        message: `Invalid YAML frontmatter: ${problem.message}`,
      });
    }
    return undefined;
  }

  if (!isMap(document.contents)) {
    problems.push({
      path: skillFilePath,
      skillPath,
      message: "SKILL.md frontmatter must be a YAML mapping.",
    });
    return undefined;
  }

  const metadata = document.contents.items.find(
    (pair) => isScalar(pair.key) && pair.key.value === "metadata",
  );
  if (
    metadata !== undefined &&
    isMap(metadata.value) &&
    metadata.value.items.some(
      (pair) => !isScalar(pair.key) || typeof pair.key.value !== "string",
    )
  ) {
    problems.push({
      path: skillFilePath,
      skillPath,
      field: "metadata",
      message: "Metadata keys must be strings.",
    });
    return undefined;
  }

  let value: unknown;
  try {
    value = document.toJS();
  } catch (error) {
    problems.push({
      path: skillFilePath,
      skillPath,
      message: `Unable to read YAML frontmatter as data: ${errorMessage(error)}.`,
    });
    return undefined;
  }

  const parsed = SkillFrontmatterSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path.map(String).join(".");
      problems.push({
        path: skillFilePath,
        skillPath,
        ...(field === "" ? {} : { field }),
        message: issue.message,
      });
    }
    return undefined;
  }

  return parsed.data;
}

async function readRegularSourceFile(path: string): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile()) {
    throw new Error("SKILL.md changed and is no longer a regular file.");
  }

  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    const visible = await lstat(path);
    if (!visible.isFile() || !sameNodeIdentity(opened, visible)) {
      throw new Error("SKILL.md changed while it was being opened.");
    }

    const contents = await handle.readFile({ encoding: "utf8" });
    const after = await lstat(path);
    if (!after.isFile() || !sameNodeIdentity(opened, after)) {
      throw new Error("SKILL.md changed while it was being read.");
    }
    return contents;
  } finally {
    await handle.close();
  }
}

function sameNodeIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readDirectory(
  directoryPath: string,
  problems: SkillValidationProblem[],
  skillPath?: string,
): Promise<string[]> {
  try {
    return (await readdir(directoryPath)).sort(compareText);
  } catch (error) {
    problems.push({
      path: directoryPath,
      ...(skillPath === undefined ? {} : { skillPath }),
      message: `Unable to read directory: ${errorMessage(error)}.`,
    });
    return [];
  }
}

async function inspectEntry(
  entryPath: string,
  problems: SkillValidationProblem[],
  skillPath?: string,
): Promise<Stats | undefined> {
  try {
    return await lstat(entryPath);
  } catch (error) {
    problems.push({
      path: entryPath,
      ...(skillPath === undefined ? {} : { skillPath }),
      message: `Unable to inspect source entry: ${errorMessage(error)}.`,
    });
    return undefined;
  }
}

function describeNode(stats: Stats): string {
  if (stats.isSymbolicLink()) {
    return "a symbolic link";
  }
  if (stats.isSocket()) {
    return "a socket";
  }
  if (stats.isFIFO()) {
    return "a FIFO";
  }
  if (stats.isBlockDevice()) {
    return "a block device";
  }
  if (stats.isCharacterDevice()) {
    return "a character device";
  }
  if (stats.isFile()) {
    return "a regular file";
  }
  if (stats.isDirectory()) {
    return "a directory";
  }
  return "an unsupported filesystem node";
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
