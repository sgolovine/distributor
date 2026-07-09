import picocolors from "picocolors";

import { DistributorError } from "./errors.js";
import type { InitResult } from "./init/run-init.js";

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
  printInit(result: InitResult): void;
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
  };
}
