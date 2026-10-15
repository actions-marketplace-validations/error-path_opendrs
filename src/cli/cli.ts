import { OpendrsError } from "../domain/types.js";
import { VERSION } from "../version.js";
import { explainCommand } from "./commands/explain.js";
import { backtestCommand, calibrateCommand } from "./commands/history.js";
import { initCommand } from "./commands/init.js";
import { mcpCommand } from "./commands/mcp.js";
import { scoreCommand } from "./commands/score.js";
import type { CliIo, Command } from "./types.js";

const COMMANDS: Command[] = [scoreCommand, explainCommand, calibrateCommand, backtestCommand, initCommand, mcpCommand()];

const HELP = `Usage: opendrs <command> [options]

Diff Risk Score: a calibrated 0-1 risk score for a change.

Commands:
${COMMANDS.map((c) => `  ${c.name.padEnd(11)}${c.summary}`).join("\n")}

Options:
  --help, -h   Show help (also: opendrs <command> --help)
  --version    Print the version

Exit codes: 0 ok, 1 score above --fail-above, 2 error.`;

const isHelp = (a: string) => a === "--help" || a === "-h";

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [name, ...rest] = argv;
  if (name === "--version" || name === "-v") {
    io.out(VERSION);
    return 0;
  }
  if (name === undefined) {
    io.err(HELP);
    return 2;
  }
  if (isHelp(name) || (name === "help" && rest.length === 0)) {
    io.out(HELP);
    return 0;
  }
  const target = name === "help" ? rest[0] : name;
  const command = COMMANDS.find((c) => c.name === target);
  if (!command) {
    io.err(`opendrs: unknown command '${target}'. Run 'opendrs --help'.`);
    return 2;
  }
  if (name === "help" || rest.some(isHelp)) {
    io.out(command.help);
    return 0;
  }
  try {
    return await command.run(rest, io);
  } catch (e) {
    reportError(e, command.name, io);
    return 2;
  }
}

function reportError(e: unknown, command: string, io: CliIo): void {
  const err = e instanceof Error ? e : new Error(String(e));
  const code = (err as { code?: unknown }).code;
  const usage = (e instanceof OpendrsError && e.code === "usage") || (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS"));
  if (usage) io.err(`opendrs ${command}: ${err.message}\nRun 'opendrs ${command} --help' for usage.`);
  else io.err(`opendrs: ${err.message}`);
  if (io.env.OPENDRS_DEBUG === "1" && err.stack) io.err(err.stack);
}
