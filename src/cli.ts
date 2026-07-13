import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from "commander";

import type { ExitCode } from "./errors.js";
import { DistributorError } from "./errors.js";
import { runInit } from "./init/run-init.js";
import { createOutput, type CliOutput } from "./output.js";
import { runRemove } from "./remove/run-remove.js";
import { runSync } from "./sync/run-sync.js";

export interface CliRuntime {
  readonly runInit: typeof runInit;
  readonly runRemove: typeof runRemove;
  readonly runSync: typeof runSync;
}

export interface CliProgramOptions {
  readonly output?: CliOutput;
  readonly runtime?: Partial<CliRuntime>;
  readonly cwd?: string;
  readonly isInteractive?: boolean;
  readonly onExitCode?: (code: ExitCode) => void;
}

export interface RunCliOptions extends CliProgramOptions {
  readonly version: string;
}

const defaultRuntime: CliRuntime = { runInit, runRemove, runSync };

export function createProgram(
  version: string,
  options: CliProgramOptions = {},
): Command {
  const output = options.output ?? defaultOutput();
  const runtime: CliRuntime = { ...defaultRuntime, ...options.runtime };
  const reportExitCode = options.onExitCode ?? (() => undefined);
  const program = new Command();

  program
    .name("distributor")
    .description("Synchronize Agent Skills across supported agent harnesses.")
    .helpOption("-h, --help", "Display help for the current command.")
    .version(version, "-V, --version", "Print the installed version.")
    .showSuggestionAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: output.writeOut,
      writeErr: output.writeErr,
      outputError: (text, write) =>
        write(text.replace(/^error:/i, "Error:")),
    });

  program.addHelpCommand(
    new Command("help")
      .description("Display help for distributor or one command.")
      .argument("[command]", "command to describe"),
  );

  program
    .command("version")
    .description("Print the installed version.")
    .action(() => {
      output.writeOut(`${version}\n`);
    });

  program
    .command("init")
    .description("Initialize Distributor without syncing.")
    .option("-y, --yes", "Accept the displayed defaults without prompting.")
    .action(async (commandOptions: { readonly yes?: boolean }) => {
      const result = await runtime.runInit({
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        yes: commandOptions.yes === true,
        ...(options.isInteractive === undefined
          ? {}
          : { isInteractive: options.isInteractive }),
      });
      output.printInit(result);
    });

  program
    .command("remove")
    .description("Remove every unchanged symbolic link managed by Distributor.")
    .action(async () => {
      const result = await runtime.runRemove({
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      });
      output.printRemove(result);
      reportExitCode(result.exitCode);
    });

  const harnessOption = new Option(
    "--harness <harness-id>",
    "Limit sync to one enabled harness.",
  ).argParser((value: string, previous: string | undefined) => {
    if (previous !== undefined) {
      throw new InvalidArgumentError("may be specified only once");
    }
    return value;
  });

  program
    .command("sync")
    .description("Plan and synchronize configured Agent Skills.")
    .addOption(harnessOption)
    .option("--dry-run", "Inspect and report the plan without writing.")
    .action(
      async (commandOptions: {
        readonly harness?: string;
        readonly dryRun?: boolean;
      }) => {
        const result = await runtime.runSync({
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(commandOptions.harness === undefined
            ? {}
            : { harness: commandOptions.harness }),
          dryRun: commandOptions.dryRun === true,
        });
        output.printSync(result);
        reportExitCode(result.exitCode);
      },
    );

  program.addHelpText(
    "after",
    `
Command flags:
  distributor init [-y|--yes]
  distributor remove
  distributor sync [--harness <harness-id>] [--dry-run]

Examples:
  distributor init --yes
  distributor sync
  distributor sync --harness claude-code
  distributor sync --dry-run
  distributor remove

Exit codes:
  0  success, including no-op and warning-only runs
  1  operational, conflict, or filesystem failure
  2  invalid invocation or project configuration

Trust boundary:
  JavaScript and TypeScript project configs are trusted executable code.
  Skill Markdown, YAML, scripts, and assets are read as data and never executed.
`,
  );

  return program;
}

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions,
): Promise<ExitCode> {
  const output = options.output ?? defaultOutput();
  let exitCode: ExitCode = 0;
  const program = createProgram(options.version, {
    ...options,
    output,
    onExitCode: (code) => {
      exitCode = code;
      options.onExitCode?.(code);
    },
  });

  try {
    if (argv.length === 0) {
      program.outputHelp();
      return 0;
    }
    await program.parseAsync([...argv], { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? 0 : 2;
    }
    if (error instanceof DistributorError) {
      output.printError(error);
      return error.exitCode;
    }

    output.printError(error);
    return 1;
  }
}

function defaultOutput(): CliOutput {
  return createOutput({
    stdoutIsTTY: process.stdout.isTTY === true,
    noColor: process.env.NO_COLOR !== undefined,
  });
}
