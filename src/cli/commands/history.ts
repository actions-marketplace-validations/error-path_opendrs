import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../../domain/config.js";
import type { BacktestMetrics } from "../../domain/types.js";
import { loadModel } from "../../engine.js";
import { backtest } from "../../model/backtest.js";
import { calibrate, type HistoryRunOptions } from "../../model/calibrate.js";
import { parsePositiveInt, pct } from "../args.js";
import { repoRoot } from "../repo.js";
import type { CliIo, Command } from "../types.js";

const HISTORY_OPTIONS = `  --since <date>       Only use commits after this date (e.g. 2026-01-01)
  --max-commits <n>    Use at most n commits (default: history.maxCommits)`;

/** Meta's published LR baseline (arXiv 2410.06351): SEVs captured at 5/10/50 % gated. */
const META_LR = { "5": 0.187, "10": 0.279, "50": 0.846 };

async function historyRun(args: string[], io: CliIo, label: string) {
  const { values } = parseArgs({
    args,
    options: { since: { type: "string" }, "max-commits": { type: "string" }, json: { type: "boolean" } },
  });
  const maxCommits = parsePositiveInt("--max-commits", values["max-commits"]);
  const repoDir = await repoRoot(io.cwd);
  const opts: HistoryRunOptions = {
    repoDir,
    config: await loadConfig(repoDir),
    since: values.since,
    maxCommits,
    onProgress: (done, total) => io.progress(`${label}: ${done}/${total} commits`),
  };
  return { opts, json: values.json === true };
}

export const calibrateCommand: Command = {
  name: "calibrate",
  summary: "Fit the model to this repository's history",
  help: `Usage: opendrs calibrate [options]

Label past commits (reverts, SZZ-blamed fixes, .opendrs/incidents.jsonl), fit the
logistic model on the oldest 80 %, evaluate on the newest 20 %, and write the
model to config.model (default .opendrs/model.json). Commit that file.

Options:
${HISTORY_OPTIONS}`,

  async run(args, io) {
    const { opts } = await historyRun(args, io, "calibrate");
    const model = await calibrate(opts);
    io.progress("");
    const file = join(opts.repoDir, opts.config.model);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(model, null, 2) + "\n");

    io.out(`Wrote calibrated model to ${opts.config.model}`);
    const t = model.trainedOn;
    if (t) io.out(`Trained on ${t.commits} commits (${t.positives} positive), ${t.from} to ${t.to}`);
    const m = model.metrics;
    if (m) {
      io.out(
        `Held-out newest 20 %:  captured@5%  ${pct(m.capturedAt["5"])}   @10%  ${pct(m.capturedAt["10"])}   @50%  ${pct(m.capturedAt["50"])}   AUC ${m.auc.toFixed(2)}`,
      );
    } else {
      io.out("The model has no held-out metrics (too few labelled commits to evaluate).");
    }
    io.out("Run `opendrs backtest` to compare it with the default priors.");
    return 0;
  },
};

function row(name: string, c: Record<string, number | undefined>, m?: BacktestMetrics): string {
  const cells = [pct(c["5"]), pct(c["10"]), pct(c["50"])].map((s) => s.padStart(14));
  const rest = m
    ? [m.auc.toFixed(2).padStart(6), String(m.commits).padStart(9), String(m.positives).padStart(10), pct(m.baseRate).padStart(10)]
    : ["-".padStart(6), "-".padStart(9), "-".padStart(10), "-".padStart(10)];
  return name.padEnd(28) + cells.join("") + rest.join("");
}

export const backtestCommand: Command = {
  name: "backtest",
  summary: "Replay history and measure how many incident-linked commits the score catches",
  help: `Usage: opendrs backtest [options]

Score past commits point-in-time and report the share of incident-linked commits
captured when gating the riskiest 5 / 10 / 50 % of commits, plus ROC-AUC, for the
default priors and (when config.model exists) the calibrated model.

Options:
${HISTORY_OPTIONS}
  --json               Print the raw report as JSON`,

  async run(args, io) {
    const { opts, json } = await historyRun(args, io, "backtest");
    const { model, kind } = await loadModel(opts.repoDir, opts.config);
    const report = await backtest({ ...opts, model: kind === "calibrated" ? model : undefined });
    io.progress("");
    if (json) {
      io.out(JSON.stringify(report, null, 2));
      return 0;
    }
    io.out(header());
    io.out(row("default priors", report.default.capturedAt, report.default));
    if (report.calibrated) io.out(row("calibrated (held-out)", report.calibrated.capturedAt, report.calibrated));
    if (report.defaultOnHeldOut) io.out(row("default priors (held-out)", report.defaultOnHeldOut.capturedAt, report.defaultOnHeldOut));
    io.out(row("Meta LR baseline *", META_LR));
    io.out("");
    if (kind !== "calibrated") io.out(`No calibrated model at ${opts.config.model}. Run \`opendrs calibrate\` to fit one.`);
    io.out("captured@X%: share of incident-linked commits that fall in the riskiest X % of commits.");
    if (report.calibrated) io.out("held-out: commits newer than the calibrated model's training window; compare the two held-out rows.");
    for (const note of report.notes) io.out(`Note: ${note}`);
    io.out(
      "* Meta's in-house results for its LR baseline on Meta's own diffs and SEVs (arXiv 2410.06351). " +
        "Shown for orientation only: different code, labels and population, so not comparable data.",
    );
    return 0;
  },
};

function header(): string {
  return (
    "model".padEnd(28) +
    ["captured@5%", "captured@10%", "captured@50%"].map((s) => s.padStart(14)).join("") +
    ["AUC".padStart(6), "commits".padStart(9), "positives".padStart(10), "base rate".padStart(10)].join("")
  );
}
