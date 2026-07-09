import { posix, win32 } from "node:path";

import { DistributorError, type FailureCategory } from "../errors.js";

export type PathStyle = "posix" | "win32";

export interface ConfigPathContext {
  readonly projectRoot: string;
  readonly homeDirectory?: string;
  readonly style?: PathStyle;
}

const DEFAULT_PATH_STYLE: PathStyle =
  process.platform === "win32" ? "win32" : "posix";

function pathApi(style: PathStyle): typeof posix {
  return style === "win32" ? win32 : posix;
}

function pathFailure(
  category: FailureCategory,
  message: string,
  received: unknown,
  correction: string,
): DistributorError {
  return new DistributorError(category, message, {
    operation: "resolve path",
    received,
    correction,
  });
}

function isWindowsDriveRelative(value: string, style: PathStyle): boolean {
  return style === "win32" && /^[a-z]:($|[^\\/])/i.test(value);
}

function isFullyQualifiedAbsolute(value: string, style: PathStyle): boolean {
  const api = pathApi(style);

  if (!api.isAbsolute(value)) {
    return false;
  }

  if (style === "posix") {
    return true;
  }

  const root = win32.parse(value).root;
  return (
    /^[a-z]:[\\/]$/i.test(root) ||
    root.startsWith("\\\\") ||
    root.startsWith("//")
  );
}

function normalizeAbsolute(
  value: string,
  style: PathStyle,
  category: FailureCategory,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw pathFailure(
      category,
      "Path must be a non-empty string.",
      value,
      "Provide a non-empty absolute path.",
    );
  }

  if (isWindowsDriveRelative(value, style)) {
    throw pathFailure(
      category,
      "Windows drive-relative paths are not deterministic.",
      value,
      "Use a fully qualified path such as C:\\project\\skills.",
    );
  }

  if (!isFullyQualifiedAbsolute(value, style)) {
    throw pathFailure(
      category,
      "Path must be absolute.",
      value,
      "Use a fully qualified absolute path.",
    );
  }

  const api = pathApi(style);
  const normalized = api.normalize(value);
  const root = api.parse(normalized).root;

  return normalized.length > root.length && normalized.endsWith(api.sep)
    ? normalized.slice(0, -1)
    : normalized;
}

function homePath(context: ConfigPathContext, style: PathStyle): string {
  if (
    context.homeDirectory === undefined ||
    context.homeDirectory.trim().length === 0
  ) {
    throw pathFailure(
      "config",
      "The home directory is unavailable for path expansion.",
      context.homeDirectory,
      "Set a home directory or replace the home reference with an explicit path.",
    );
  }

  return normalizeAbsolute(context.homeDirectory, style, "config");
}

function expandLeadingTilde(
  value: string,
  context: ConfigPathContext,
  style: PathStyle,
): string {
  if (!value.startsWith("~")) {
    return value;
  }

  const nextCharacter = value[1];
  const isSeparator =
    nextCharacter === undefined ||
    nextCharacter === "/" ||
    (style === "win32" && nextCharacter === "\\");

  if (!isSeparator) {
    throw pathFailure(
      "config",
      "Only the current user's home directory can be expanded.",
      value,
      "Use ~ by itself or at the beginning of a path segment such as ~/skills.",
    );
  }

  return `${homePath(context, style)}${value.slice(1)}`;
}

function expandVariables(
  value: string,
  projectRoot: string,
  context: ConfigPathContext,
  style: PathStyle,
): string {
  const expanded = value.replace(
    /\$[a-z_][a-z0-9_]*/gi,
    (variable): string => {
      if (variable === "$PROJECT_ROOT") {
        return projectRoot;
      }

      if (variable === "$HOME") {
        return homePath(context, style);
      }

      throw pathFailure(
        "config",
        `Unsupported or unresolved path variable ${variable}.`,
        value,
        "Use only $HOME or $PROJECT_ROOT, or provide an explicit path.",
      );
    },
  );

  if (expanded.includes("$") || /%[a-z_][a-z0-9_]*%/i.test(expanded)) {
    throw pathFailure(
      "config",
      "Unsupported path expansion syntax.",
      value,
      "Use only ~, $HOME, or $PROJECT_ROOT without braces.",
    );
  }

  return expanded;
}

export function resolveConfigPath(
  value: string,
  context: ConfigPathContext,
): string {
  const style = context.style ?? DEFAULT_PATH_STYLE;
  const api = pathApi(style);
  const projectRoot = normalizeAbsolute(context.projectRoot, style, "config");

  if (typeof value !== "string" || value.trim().length === 0) {
    throw pathFailure(
      "config",
      "Configured path must be a non-empty string.",
      value,
      "Provide a path relative to the project root or an absolute path.",
    );
  }

  const withHome = expandLeadingTilde(value, context, style);
  const expanded = expandVariables(withHome, projectRoot, context, style);

  if (isWindowsDriveRelative(expanded, style)) {
    throw pathFailure(
      "config",
      "Windows drive-relative paths are not deterministic.",
      value,
      "Use a project-relative path or a fully qualified path such as C:\\skills.",
    );
  }

  return normalizeAbsolute(api.resolve(projectRoot, expanded), style, "config");
}

export function normalizeAbsolutePath(
  value: string,
  style: PathStyle = DEFAULT_PATH_STYLE,
): string {
  return normalizeAbsolute(value, style, "config");
}

export function pathComparisonKey(
  value: string,
  style: PathStyle = DEFAULT_PATH_STYLE,
): string {
  const normalized = normalizeAbsolutePath(value, style);
  return style === "win32" ? normalized.toLowerCase() : normalized;
}

export function pathsAreEquivalent(
  left: string,
  right: string,
  style: PathStyle = DEFAULT_PATH_STYLE,
): boolean {
  return pathComparisonKey(left, style) === pathComparisonKey(right, style);
}

export function isStrictChildPath(
  parent: string,
  candidate: string,
  style: PathStyle = DEFAULT_PATH_STYLE,
): boolean {
  const api = pathApi(style);
  const normalizedParent = normalizeAbsolutePath(parent, style);
  const normalizedCandidate = normalizeAbsolutePath(candidate, style);
  const relative = api.relative(normalizedParent, normalizedCandidate);

  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${api.sep}`) &&
    !api.isAbsolute(relative)
  );
}

function isProjectLocal(
  value: string,
  projectRoot: string,
  style: PathStyle,
): boolean {
  return (
    pathsAreEquivalent(value, projectRoot, style) ||
    isStrictChildPath(projectRoot, value, style)
  );
}

export function displayPath(
  value: string,
  projectRoot: string,
  style: PathStyle = DEFAULT_PATH_STYLE,
): string {
  const api = pathApi(style);
  const normalizedValue = normalizeAbsolutePath(value, style);
  const normalizedRoot = normalizeAbsolutePath(projectRoot, style);

  if (!isProjectLocal(normalizedValue, normalizedRoot, style)) {
    return normalizedValue;
  }

  return api.relative(normalizedRoot, normalizedValue) || ".";
}

export function serializeStatePath(
  value: string,
  projectRoot: string,
  style: PathStyle = DEFAULT_PATH_STYLE,
): string {
  return displayPath(value, projectRoot, style);
}

export function deserializeStatePath(
  value: string,
  projectRoot: string,
  style: PathStyle = DEFAULT_PATH_STYLE,
): string {
  const api = pathApi(style);
  const normalizedRoot = normalizeAbsolute(projectRoot, style, "state");

  if (typeof value !== "string" || value.trim().length === 0) {
    throw pathFailure(
      "state",
      "Stored path must be a non-empty string.",
      value,
      "Repair or remove the invalid managed-state file before syncing.",
    );
  }

  if (isWindowsDriveRelative(value, style)) {
    throw pathFailure(
      "state",
      "Stored Windows path is drive-relative and cannot be reconstructed safely.",
      value,
      "Replace it with a project-relative or fully qualified absolute path.",
    );
  }

  if (api.isAbsolute(value)) {
    const normalizedValue = normalizeAbsolute(value, style, "state");

    if (isProjectLocal(normalizedValue, normalizedRoot, style)) {
      throw pathFailure(
        "state",
        "A project-local stored path must use project-relative form.",
        value,
        "Rewrite the project-local path relative to the project root.",
      );
    }

    return normalizedValue;
  }

  const reconstructed = normalizeAbsolute(
    api.resolve(normalizedRoot, value),
    style,
    "state",
  );

  if (!isProjectLocal(reconstructed, normalizedRoot, style)) {
    throw pathFailure(
      "state",
      "Stored relative path escapes the project root.",
      value,
      "Use a project-relative path without parent traversal, or an absolute external path.",
    );
  }

  return reconstructed;
}
