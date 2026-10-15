import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

/** GitHub Actions workflow commands and environment files, without @actions/core. */
export interface WorkflowIO {
  info(message: string): void;
  notice(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  group<T>(name: string, fn: () => Promise<T>): Promise<T>;
  setOutput(name: string, value: string): void;
  summary(markdown: string): void;
}

const escapeData = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

export function createWorkflowIO(env: NodeJS.ProcessEnv, write: (s: string) => void = (s) => void process.stdout.write(s)): WorkflowIO {
  const command = (name: string, message: string) => write(`::${name}::${escapeData(message)}\n`);
  return {
    info: (m) => write(m + "\n"),
    notice: (m) => command("notice", m),
    warning: (m) => command("warning", m),
    error: (m) => command("error", m),
    async group(name, fn) {
      write(`::group::${escapeData(name)}\n`);
      try {
        return await fn();
      } finally {
        write("::endgroup::\n");
      }
    },
    setOutput(name, value) {
      if (!env.GITHUB_OUTPUT) return;
      const delimiter = `opendrs_${randomUUID()}`;
      appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
    },
    summary(markdown) {
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown + "\n");
    },
  };
}
