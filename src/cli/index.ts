#!/usr/bin/env node
import { runCli } from "./cli.js";

const tty = process.stderr.isTTY;
process.exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
  progress: (text) => {
    if (tty) process.stderr.write(`\r\x1b[2K${text}`);
  },
});
