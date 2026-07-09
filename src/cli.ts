import { Command } from "commander";

export function createProgram(version: string): Command {
  const program = new Command();

  program
    .name("distributor")
    .description("Synchronize Agent Skills across supported agent harnesses.")
    .version(version)
    .showHelpAfterError()
    .action(() => program.outputHelp());

  program.command("version").description("Print the installed version.").action(() => {
    process.stdout.write(`${version}\n`);
  });

  return program;
}
