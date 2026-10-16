import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { Incident } from "../../domain/types.js";
import { OpendrsError } from "../../domain/types.js";
import { git, gitMaybe } from "../../git/exec.js";
import { INCIDENTS_FILE, loadIncidents } from "../../model/label.js";
import { repoRoot } from "../repo.js";
import type { Command } from "../types.js";

/** Full sha of `ref`, or undefined when it does not name a commit. */
async function resolveMaybe(repoDir: string, ref: string): Promise<string | undefined> {
  const sha = await gitMaybe(repoDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return sha?.trim();
}

async function resolveCommit(repoDir: string, ref: string): Promise<string> {
  const sha = await resolveMaybe(repoDir, ref);
  if (!sha) throw new OpendrsError(`unknown commit: ${ref}`, "git");
  return sha;
}

/** Commits that landed PR #n on HEAD: the squash commit, or every non-merge commit a merge commit brought in. */
async function prCommits(repoDir: string, pr: string): Promise<string[]> {
  // git narrows to messages that mention the PR anywhere; the subject is re-checked below.
  const log = await git(repoDir, ["log", "-E", `--grep=\\(#${pr}\\)$`, `--grep=^Merge pull request #${pr} `, "--format=%H%x1f%P%x1f%s", "HEAD"]);
  for (const line of log.split("\n")) {
    const [sha, parents, subject] = line.split("\x1f");
    if (!sha || subject === undefined) continue;
    const squash = subject.endsWith(`(#${pr})`);
    const merge = subject.startsWith(`Merge pull request #${pr} `);
    if (!squash && !merge) continue;
    const parentShas = (parents ?? "").split(" ").filter(Boolean);
    if (parentShas.length < 2) return [sha];
    const list = await git(repoDir, ["rev-list", "--no-merges", `${sha}^1..${sha}^2`]);
    return list.split("\n").filter(Boolean);
  }
  throw new OpendrsError(`no commit on the current branch landed PR #${pr} (looked for a subject ending in "(#${pr})" or "Merge pull request #${pr} ")`, "usage");
}

export const feedbackCommand: Command = {
  name: "feedback",
  summary: "Record an incident-inducing change in .opendrs/incidents.jsonl",
  help: `Usage: opendrs feedback --inducing <sha|ref> [--fix <sha|ref>] [--paths a,b] [--note <text>]
       opendrs feedback --pr <number> --was-incident [--fix <sha|ref>] [--paths a,b] [--note <text>]

Append one line per inducing commit to .opendrs/incidents.jsonl. calibrate and
backtest label those commits positive, and the history.incident signal flags later
PRs that touch the recorded paths. Commit the file afterwards.

Options:
  --inducing <ref>   The commit that caused the incident
  --pr <number>      Instead of --inducing: the commit that landed PR #number on the
                     current branch (squash "(#N)" subject or "Merge pull request #N")
  --was-incident     Required with --pr: confirms the PR caused an incident
  --fix <ref>        The commit that fixed it
  --paths <a,b>      Files or folders involved, comma-separated
  --note <text>      Free text, e.g. "SEV-12: checkout 500s"`,

  async run(args, io) {
    const { values } = parseArgs({
      args,
      options: {
        inducing: { type: "string" },
        pr: { type: "string" },
        "was-incident": { type: "boolean" },
        fix: { type: "string" },
        paths: { type: "string" },
        note: { type: "string" },
      },
    });
    if ((values.inducing === undefined) === (values.pr === undefined)) {
      throw new OpendrsError("feedback needs exactly one of --inducing <ref> or --pr <number>", "usage");
    }
    if (values.pr !== undefined && !/^\d+$/.test(values.pr)) throw new OpendrsError(`--pr must be a PR number, got '${values.pr}'`, "usage");
    if (values.pr !== undefined && !values["was-incident"]) throw new OpendrsError("--pr requires --was-incident", "usage");

    const repoDir = await repoRoot(io.cwd);
    const inducing = values.inducing !== undefined ? [await resolveCommit(repoDir, values.inducing)] : await prCommits(repoDir, values.pr!);
    const fix = values.fix === undefined ? undefined : await resolveCommit(repoDir, values.fix);
    const paths = values.paths?.split(",").map((p) => p.trim()).filter(Boolean);
    // Recorded shas may be abbreviated: compare full shas (an unresolvable one matches nothing).
    const existing = await Promise.all(
      (await loadIncidents(repoDir)).map(async (i) => ({
        inducing: i.inducing === undefined ? undefined : ((await resolveMaybe(repoDir, i.inducing)) ?? null),
        fix: i.fix === undefined ? undefined : ((await resolveMaybe(repoDir, i.fix)) ?? null),
      })),
    );

    const lines: string[] = [];
    for (const sha of inducing) {
      if (existing.some((i) => i.inducing === sha && i.fix === fix)) {
        io.out(`Already recorded in ${INCIDENTS_FILE}: ${sha}${fix ? ` (fix ${fix})` : ""}`);
        continue;
      }
      const incident: Incident = { inducing: sha };
      if (fix) incident.fix = fix;
      if (paths?.length) incident.paths = paths;
      if (values.note) incident.note = values.note;
      lines.push(JSON.stringify(incident));
    }
    if (lines.length === 0) return 0;

    const file = join(repoDir, INCIDENTS_FILE);
    await mkdir(dirname(file), { recursive: true });
    const current = await readFile(file, "utf8").catch(() => "");
    const separator = current && !current.endsWith("\n") ? "\n" : "";
    await appendFile(file, separator + lines.join("\n") + "\n");
    for (const line of lines) io.out(`Wrote to ${INCIDENTS_FILE}: ${line}`);
    io.out(`Commit ${INCIDENTS_FILE} (it is a blocked path, so that PR goes to a human reviewer).`);
    return 0;
  },
};
