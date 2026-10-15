export interface CliIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Write one line to stdout. */
  out(line: string): void;
  /** Write one line to stderr. */
  err(line: string): void;
  /** Transient progress text (overwritten in place on a TTY; dropped otherwise). */
  progress(text: string): void;
}

export interface Command {
  name: string;
  summary: string;
  /** Full help text shown by `opendrs <name> --help`. */
  help: string;
  run(args: string[], io: CliIo): Promise<number>;
}
