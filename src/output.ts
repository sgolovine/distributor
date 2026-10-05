import { AsciiTable3 } from "ascii-table3";
import picocolors from "picocolors";

import { DistributorError } from "./errors.js";
import { displayPath } from "./filesystem/paths.js";
import type { RunImportResult } from "./import/run-import.js";
import type { InitResult } from "./init/run-init.js";
import type { RunRemoveResult } from "./remove/run-remove.js";
import type { RunStatusResult } from "./status/run-status.js";
import type { RunSyncResult } from "./sync/run-sync.js";

type Colors = ReturnType<typeof picocolors.createColors>;

export interface OutputOptions {
  readonly writeOut?: (text: string) => void;
  readonly writeErr?: (text: string) => void;
  readonly stdoutIsTTY?: boolean;
  readonly noColor?: boolean;
}

export interface CliOutput {
  readonly colors: Colors;
  writeOut(text: string): void;
  writeErr(text: string): void;
  printError(error: unknown): void;
  printImport(result: RunImportResult): void;
  printInit(result: InitResult): void;
  printRemove(result: RunRemoveResult): void;
  printStatus(result: RunStatusResult): void;
  printSync(result: RunSyncResult): void;
}

function safeValue(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return "[unprintable value]";
  }
}

export function formatDistributorError(error: DistributorError): string {
  const lines = [`Error: ${error.message}`];

  for (const issue of error.issues) {
    const location = issue.path === undefined ? "" : `${issue.path}: `;
    lines.push(`- ${location}${issue.message}`);
    if (issue.received !== undefined) {
      lines.push(`  received: ${safeValue(issue.received)}`);
    }
    if (issue.expected !== undefined) {
      lines.push(`  expected: ${issue.expected}`);
    }
    if (issue.correction !== undefined) {
      lines.push(`  action: ${issue.correction}`);
    }
  }

  if (error.issues.length === 0 && error.operation !== undefined) {
    lines.push(`operation: ${error.operation}`);
  }
  if (error.correction !== undefined) {
    lines.push(`Action: ${error.correction}`);
  }

  return `${lines.join("\n")}\n`;
}

export function createOutput(options: OutputOptions = {}): CliOutput {
  const writeOut = options.writeOut ?? ((text: string) => process.stdout.write(text));
  const writeErr = options.writeErr ?? ((text: string) => process.stderr.write(text));
  const colors = picocolors.createColors(
    options.stdoutIsTTY === true && options.noColor !== true,
  );

  return {
    colors,
    writeOut,
    writeErr,
    printError(error) {
      if (error instanceof DistributorError) {
        writeErr(colors.red(formatDistributorError(error)));
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      writeErr(colors.red(`Error: ${message}\n`));
    },
    printInit(result) {
      if (result.noOp) {
        writeOut(`Distributor is already initialized at ${result.projectRoot}.\n`);
        return;
      }

      writeOut(`Initialized Distributor at ${result.projectRoot}.\n`);
      for (const outcome of result.outcomes) {
        writeOut(`${outcome.artifact}: ${outcome.status} ${outcome.path}\n`);
      }
    },
    printImport(result) {
      if (result.initialized !== undefined) {
        if (result.initialized.noOp) {
          writeOut(
            `Distributor is already initialized at ${result.initialized.projectRoot}.\n`,
          );
        } else {
          writeOut(`Initialized Distributor at ${result.initialized.projectRoot}.\n`);
          for (const outcome of result.initialized.outcomes) {
            writeOut(`${outcome.artifact}: ${outcome.status} ${outcome.path}\n`);
          }
        }
      }
      for (const warning of result.warnings) {
        writeOut(
          colors.yellow(
            `Warning: ${formatDiagnosticPath(warning.path, result.projectRoot)}: ${warning.message}\n`,
          ),
        );
      }
      if (result.candidates.length === 0) {
        writeOut("No importable skills found in supported harness directories.\n");
        return;
      }
      if (result.declined) {
        writeOut("Skill import skipped.\n");
        return;
      }
      if (result.imported.length === 0) {
        writeOut("No skills selected for import.\n");
        return;
      }
      writeOut(
        `Imported ${result.imported.length} skill${result.imported.length === 1 ? "" : "s"} into ${result.sourceRoot}.\n`,
      );
      for (const imported of result.imported) {
        writeOut(
          `${imported.name}: ${formatDiagnosticPath(imported.sourcePath, result.projectRoot)} -> ${formatDiagnosticPath(imported.destinationPath, result.projectRoot)}\n`,
        );
      }
    },
    printRemove(result) {
      writeOut(
        `Removed ${result.counts.removed} managed link${result.counts.removed === 1 ? "" : "s"}; ${result.counts.missing} already missing, ${result.counts.failed} failed.\n`,
      );
      const directoryCounts = result.directoryCounts;
      if (
        directoryCounts !== undefined &&
        directoryCounts.removed + directoryCounts.missing + directoryCounts.failed > 0
      ) {
        writeOut(
          `Removed ${directoryCounts.removed} managed director${directoryCounts.removed === 1 ? "y" : "ies"}; ${directoryCounts.missing} already missing, ${directoryCounts.failed} failed.\n`,
        );
      }
      for (const warning of result.warnings) {
        const location =
          warning.path === undefined
            ? ""
            : `${formatDiagnosticPath(warning.path, result.projectRoot)}: `;
        writeOut(colors.yellow(`Warning: ${location}${warning.message}\n`));
      }
      for (const operation of result.operations) {
        if (operation.status === "failed") {
          writeErr(
            colors.red(
              `Error: ${formatDiagnosticPath(operation.targetPath, result.projectRoot)}: ${operation.message ?? "Removal failed."}\n`,
            ),
          );
        }
      }
    },
    printStatus(result) {
      writeOut(formatReferenceTable(result));
      writeOut("\n");
      writeOut(formatStatusTable(result));
      writeOut("\n");
      writeOut(formatStoragePathsTable(result));
      writeOut("\n");
      for (const warning of result.warnings) {
        writeOut(
          colors.yellow(
            `Warning: ${formatDiagnosticPath(warning.path, result.projectRoot)}: ${warning.message}\n`,
          ),
        );
      }
      if (result.upToDate) {
        writeOut("References are up to date.\n");
        return;
      }
      writeOut("References are out of date.\n");
      writeOut("Run `distributor sync` to bring your references up to date.\n");
    },
    printSync(result) {
      writeOut(formatSyncHeading(result));

      const rows = syncSkillRows(result);
      const changedNames = new Set(
        rows.filter((row) => !row.unchanged).map((row) => row.skill),
      );
      const changed = rows.filter((row) => changedNames.has(row.skill));
      const unchanged = rows.filter((row) => !changedNames.has(row.skill));
      if (changed.length > 0) {
        writeOut(
          `\n${formatSyncSkillsTable("Skill changes", changed, result)}\n`,
        );
      } else {
        writeOut("No skill changes.\n");
      }
      writeOut(`\n${formatSyncSummaryTable(result)}\n`);
      writeOut(
        `Stale: ${result.counts.stale}, warnings: ${result.counts.warnings}, failures: ${result.counts.failures}\n`,
      );

      for (const warning of result.warnings) {
        const location =
          warning.path === undefined
            ? ""
            : `${formatDiagnosticPath(warning.path, result.projectRoot)}: `;
        writeOut(colors.yellow(`Warning: ${location}${warning.message}\n`));
      }
      for (const failure of result.failures) {
        writeErr(
          colors.red(
            `Error: ${formatDiagnosticPath(failure.path, result.projectRoot)}: ${failure.message}\nAction: ${failure.correction}\n`,
          ),
        );
      }
      if (unchanged.length > 0) {
        writeOut(
          `\n${formatSyncSkillsTable("Unchanged skills", unchanged, result)}\n`,
        );
      }
    },
  };
}

function formatReferenceTable(result: RunStatusResult): string {
  return new AsciiTable3("References")
    .setHeading("Harness", "References")
    .setAlignRight(2)
    .addRowMatrix([
      ...result.harnesses.map((harness) => [
        harness.harnessId,
        harness.references,
      ]),
      ["Total references", result.references],
      ["Total skills", result.skills],
    ])
    .toString();
}

function formatStatusTable(result: RunStatusResult): string {
  const harnessIds = result.harnesses.map((harness) => harness.harnessId);
  const table = new AsciiTable3("Skills")
    .setHeading("Skill", ...harnessIds)
    .addRowMatrix(
      result.skillStatuses.map((skill) => [
        skill.name,
        ...harnessIds.map((harnessId) =>
          skill.harnesses.find((harness) => harness.harnessId === harnessId)
            ?.status === "configured"
            ? "✓"
            : "⚠",
        ),
      ]),
    );

  for (let index = 2; index <= harnessIds.length + 1; index += 1) {
    table.setAlignCenter(index);
  }

  return table.toString();
}

function formatStoragePathsTable(result: RunStatusResult): string {
  return new AsciiTable3("Skill storage paths")
    .setHeading("Storage", "Path")
    .addRowMatrix([
      ["source", formatDiagnosticPath(result.sourceRoot, result.projectRoot)],
      ...result.harnesses.flatMap((harness) =>
        harness.storagePaths.map((path) => [
          harness.harnessId,
          formatDiagnosticPath(path, result.projectRoot),
        ]),
      ),
    ])
    .toString();
}

function formatSyncHeading(result: RunSyncResult): string {
  const { skills, files } = result.counts.source;
  const harnesses = result.counts.harnesses.length;
  if (skills === 0 && files === 0) {
    return `No skills found in ${result.sourceRoot}. Add a skill directory containing SKILL.md.\n`;
  }

  const skillLabel = skills === 1 ? "skill" : "skills";
  const fileLabel = files === 1 ? "file" : "files";
  const harnessLabel = harnesses === 1 ? "harness" : "harnesses";
  if (result.dryRun) {
    return `Dry run: ${skills} ${skillLabel} (${files} ${fileLabel}) would sync to ${harnesses} ${harnessLabel}.\n`;
  }
  if (result.exitCode === 1) {
    return `Sync completed with failures for ${skills} ${skillLabel} (${files} ${fileLabel}) across ${harnesses} ${harnessLabel}.\n`;
  }
  return `Synced ${skills} ${skillLabel} (${files} ${fileLabel}) to ${harnesses} ${harnessLabel}.\n`;
}

interface SyncSkillRow {
  readonly skill: string;
  readonly harness: string;
  readonly outcomes: Set<string>;
  unchanged: boolean;
}

function syncSkillRows(result: RunSyncResult): SyncSkillRow[] {
  const rows = new Map<string, SyncSkillRow>();
  const add = (
    skill: string,
    harness: string,
    outcome: string,
    unchanged: boolean,
  ) => {
    const key = JSON.stringify([skill, harness]);
    const row = rows.get(key) ?? {
      skill,
      harness,
      outcomes: new Set<string>(),
      unchanged: true,
    };
    row.outcomes.add(outcome);
    row.unchanged &&= unchanged;
    rows.set(key, row);
  };
  const completed = new Map(
    result.applyResult?.operations.map((entry) => [
      entry.operation.targetPath,
      entry.status,
    ]),
  );
  const labels = {
    create: "Created",
    update: "Updated",
    adopt: "Adopted",
    skip: "Unchanged",
    stale: "Stale (retained)",
    conflict: "Conflict",
  };
  for (const operation of result.plan.operations) {
    const status = completed.get(operation.targetPath);
    const notApplied =
      !result.dryRun &&
      result.applyResult !== undefined &&
      status === undefined;
    const unchanged =
      operation.kind === "skip" && status !== "failed" && !notApplied;
    const outcome =
      status === "failed"
        ? "Failed"
        : notApplied
          ? "Not applied"
          : result.dryRun && !unchanged && operation.kind !== "stale"
            ? `Would ${operation.kind}`
            : labels[operation.kind];
    const skill =
      operation.skillName === "<stale>"
        ? formatDiagnosticPath(operation.sourcePath, result.sourceRoot)
        : operation.skillName;
    for (const attribution of operation.attributions) {
      add(skill, attribution.harnessId, outcome, unchanged);
    }
  }
  for (const placement of result.plan.satisfiedPlacements) {
    for (const skill of result.skillNames) {
      add(skill, placement.harnessId, "Satisfied", true);
    }
  }
  return [...rows.values()].sort(
    (left, right) =>
      compareText(left.skill, right.skill) ||
      compareText(left.harness, right.harness),
  );
}

function formatSyncSkillsTable(
  title: string,
  rows: readonly SyncSkillRow[],
  result: RunSyncResult,
): string {
  const harnessIds = result.counts.harnesses.map(
    (harness) => harness.harnessId,
  );
  const skills = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const harnesses = skills.get(row.skill) ?? new Map<string, string>();
    harnesses.set(row.harness, [...row.outcomes].join(", "));
    skills.set(row.skill, harnesses);
  }
  const table = new AsciiTable3(title)
    .setHeading("Skill", ...harnessIds)
    .addRowMatrix(
      [...skills].map(([skill, harnesses]) => [
        skill,
        ...harnessIds.map((harnessId) => harnesses.get(harnessId) ?? "—"),
      ]),
    );
  for (let index = 2; index <= harnessIds.length + 1; index += 1) {
    table.setAlignCenter(index);
  }
  return table.toString();
}

function formatSyncSummaryTable(result: RunSyncResult): string {
  const table = new AsciiTable3(
    result.dryRun ? "Planned sync summary" : "Sync summary",
  )
    .setHeading(
      "Harness",
      ...(result.dryRun
        ? ["To create", "To update", "To adopt", "To skip"]
        : ["Created", "Updated", "Adopted", "Skipped"]),
      "Stale",
      "Failures",
    )
    .addRowMatrix(
      result.counts.harnesses.map((harness) => [
        harness.harnessId,
        harness.operations.create,
        harness.operations.update,
        harness.operations.adopt,
        harness.operations.skip,
        harness.operations.stale,
        harness.failures,
      ]),
    );
  for (let index = 2; index <= 7; index += 1) {
    table.setAlignRight(index);
  }
  return table.toString();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatDiagnosticPath(path: string, projectRoot: string): string {
  try {
    return displayPath(path, projectRoot);
  } catch {
    return path;
  }
}
