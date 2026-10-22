import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { isMap, isScalar, parseDocument } from "yaml";

import { DistributorError } from "../errors.js";
import {
  type SkillFrontmatter,
  SkillFrontmatterSchema,
} from "./schema.js";

export interface SourceSkillFile {
  absolutePath: string;
  sourceRelativePath: string;
  skillRelativePath: string;
}

export interface SourceHelperFile {
  absolutePath: string;
  sourceRelativePath: string;
  helperName: string;
}

export interface SourceSkill {
  name: string;
  directoryPath: string;
  frontmatter: SkillFrontmatter;
  files: SourceSkillFile[];
}

export interface SkillDiscoveryWarning {
  code: "ignored-source-root-file" | "invalid-skill";
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
  helperFiles: SourceHelperFile[];
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
        "Correct every reported source problem, then rerun Distributor.",
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

interface SkillDiscoveryOptions {
  projectRoot?: string;
  allowNestedSymlinks?: boolean;
}

export async function discoverSkills(
  sourcePath: string,
  options: SkillDiscoveryOptions = {},
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

  const allowedRootRealPath = await skillLinkBoundary(sourceRootIdentity, options);
  const problems: SkillValidationProblem[] = [];
  const warnings: SkillDiscoveryWarning[] = [];
  const skills: SourceSkill[] = [];
  const helperFiles: SourceHelperFile[] = [];
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
      const entries = await readDirectory(entryPath, problems, entryPath);
      if (entries.includes("SKILL.md")) {
        const skillProblems: SkillValidationProblem[] = [];
        const skill = await inspectSkill(
          sourceRoot,
          entryPath,
          name,
          skillProblems,
          options.allowNestedSymlinks === false ? undefined : allowedRootRealPath,
        );
        if (skill === undefined) {
          warnings.push(invalidSkillWarning(entryPath, name, skillProblems));
        } else {
          skills.push(skill);
        }
      } else {
        await collectHelperFiles(
          sourceRoot,
          entryPath,
          name,
          helperFiles,
          problems,
        );
      }
      continue;
    }

    if (stats.isFile()) {
      helperFiles.push({
        absolutePath: entryPath,
        sourceRelativePath: relative(sourceRoot, entryPath),
        helperName: name,
      });
      continue;
    }

    problems.push({
      path: entryPath,
      skillPath: entryPath,
      message: `Source root entries must be regular files or directories; found ${describeNode(stats)}.`,
    });
  }

  if (problems.length > 0) {
    throw new SkillValidationError(problems, warnings);
  }

  await requireSourceRootIdentity(sourceRoot, sourceRootIdentity);
  helperFiles.sort((left, right) =>
    compareText(left.sourceRelativePath, right.sourceRelativePath),
  );

  return { sourceRoot, sourceRootIdentity, skills, helperFiles, warnings };
}

export async function discoverSkill(
  sourcePath: string,
  directoryName: string,
  options: SkillDiscoveryOptions = {},
): Promise<SourceSkill> {
  const sourceRoot = resolve(sourcePath);
  const rootStats = await inspectSourceRoot(sourceRoot);
  if (!rootStats.isDirectory()) {
    throw new SkillValidationError([
      {
        path: sourceRoot,
        message: `The source root must be a directory; found ${describeNode(rootStats)}.`,
      },
    ]);
  }
  const sourceRootIdentity = await captureSourceRootIdentity(
    sourceRoot,
    rootStats,
  );
  const allowedRootRealPath = await skillLinkBoundary(sourceRootIdentity, options);
  const skillPath = join(sourceRoot, directoryName);
  const problems: SkillValidationProblem[] = [];
  const stats = await inspectEntry(skillPath, problems, skillPath);
  let skill: SourceSkill | undefined;

  if (stats !== undefined && !stats.isDirectory()) {
    problems.push({
      path: skillPath,
      skillPath,
      message: `A skill must be a directory; found ${describeNode(stats)}.`,
    });
  } else if (stats !== undefined) {
    skill = await inspectSkill(
      sourceRoot,
      skillPath,
      directoryName,
      problems,
      options.allowNestedSymlinks === false ? undefined : allowedRootRealPath,
    );
  }

  if (problems.length > 0 || skill === undefined) {
    if (problems.length === 0) {
      problems.push({
        path: skillPath,
        skillPath,
        message: "Unable to discover the skill directory.",
      });
    }
    throw new SkillValidationError(problems);
  }

  await requireSourceRootIdentity(sourceRoot, sourceRootIdentity);
  return skill;
}

async function skillLinkBoundary(
  sourceRoot: SourceRootIdentity,
  options: SkillDiscoveryOptions,
): Promise<string> {
  if (options.projectRoot === undefined) {
    return sourceRoot.realPath;
  }
  const projectRoot = await realpath(options.projectRoot);
  return isWithinDirectory(relative(projectRoot, sourceRoot.realPath))
    ? projectRoot
    : sourceRoot.realPath;
}

function isWithinDirectory(relativePath: string): boolean {
  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
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
  allowedRootRealPath: string | undefined,
): Promise<SourceSkill | undefined> {
  const firstProblem = problems.length;
  const files: SourceSkillFile[] = [];

  await collectSourceDirectoryFiles(
    sourceRoot,
    skillPath,
    skillPath,
    files,
    problems,
    allowedRootRealPath === undefined
      ? undefined
      : { allowedRootRealPath, ancestors: new Set() },
  );
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

async function collectSourceDirectoryFiles(
  sourceRoot: string,
  skillPath: string,
  directoryPath: string,
  files: SourceSkillFile[],
  problems: SkillValidationProblem[],
  links?: { allowedRootRealPath: string; ancestors: Set<string> },
): Promise<void> {
  if (links !== undefined) {
    const directoryRealPath = await resolveSkillEntry(
      directoryPath,
      skillPath,
      links.allowedRootRealPath,
      problems,
    );
    if (directoryRealPath === undefined) {
      return;
    }
    if (links.ancestors.has(directoryRealPath)) {
      problems.push({
        path: directoryPath,
        skillPath,
        message: "Symbolic link creates a directory cycle.",
      });
      return;
    }
    links = {
      ...links,
      ancestors: new Set([...links.ancestors, directoryRealPath]),
    };
  }
  const entries = await readDirectory(directoryPath, problems, skillPath);

  for (const name of entries) {
    const entryPath = join(directoryPath, name);
    let stats = await inspectEntry(entryPath, problems, skillPath);
    if (stats === undefined) {
      continue;
    }

    if (
      stats.isSymbolicLink() &&
      links !== undefined &&
      entryPath !== join(skillPath, "SKILL.md")
    ) {
      const targetPath = await resolveSkillEntry(
        entryPath,
        skillPath,
        links.allowedRootRealPath,
        problems,
      );
      if (targetPath === undefined) {
        continue;
      }
      stats = await inspectEntry(targetPath, problems, skillPath);
      if (stats === undefined) {
        continue;
      }
    }

    if (stats.isDirectory()) {
      await collectSourceDirectoryFiles(
        sourceRoot,
        skillPath,
        entryPath,
        files,
        problems,
        links,
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
      message: `Source directories may contain only regular files and directories; found ${describeNode(stats)}.`,
    });
  }
}

async function resolveSkillEntry(
  entryPath: string,
  skillPath: string,
  allowedRootRealPath: string,
  problems: SkillValidationProblem[],
): Promise<string | undefined> {
  try {
    const targetPath = await realpath(entryPath);
    const targetRelativePath = relative(allowedRootRealPath, targetPath);
    if (!isWithinDirectory(targetRelativePath)) {
      problems.push({
        path: entryPath,
        skillPath,
        message: `Symbolic link target must stay within the allowed root ${JSON.stringify(allowedRootRealPath)}.`,
      });
      return undefined;
    }
    return targetPath;
  } catch (error) {
    problems.push({
      path: entryPath,
      skillPath,
      message: `Unable to resolve source entry (broken or cyclic symbolic link): ${errorMessage(error)}.`,
    });
    return undefined;
  }
}

async function collectHelperFiles(
  sourceRoot: string,
  directoryPath: string,
  helperName: string,
  files: SourceHelperFile[],
  problems: SkillValidationProblem[],
): Promise<void> {
  const discovered: SourceSkillFile[] = [];
  await collectSourceDirectoryFiles(
    sourceRoot,
    directoryPath,
    directoryPath,
    discovered,
    problems,
  );
  for (const file of discovered) {
    files.push({
      absolutePath: file.absolutePath,
      sourceRelativePath: file.sourceRelativePath,
      helperName,
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

function invalidSkillWarning(
  skillPath: string,
  directoryName: string,
  problems: readonly SkillValidationProblem[],
): SkillDiscoveryWarning {
  const details = problems
    .map((problem) => {
      const problemPath = relative(skillPath, problem.path) || ".";
      const field = problem.field === undefined ? "" : ` (${problem.field})`;
      return `${problemPath}${field}: ${problem.message}`;
    })
    .join("; ");

  return {
    code: "invalid-skill",
    path: skillPath,
    message: `Skipped invalid skill ${JSON.stringify(directoryName)}: ${details || "validation failed."}`,
  };
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
