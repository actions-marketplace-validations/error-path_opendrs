/**
 * bench/verify: precision/recall study of `llm.verify` (the Phase 2 verification pass) against
 * the field-test corpus (docs/research/2026-10-19-field-test.md; bench/verify/labels.json).
 *
 * Needs a `dist/` build of the verification-pass core branches (Tasks 1-4 of
 * docs/superpowers/plans/2026-10-22-verification-pass.md — `llm.verify.enabled`,
 * `brief.verification`, etc. do not exist on `main` yet) and
 * ~/.config/opendrs/bench.env holding ANTHROPIC_API_KEY. See README.md for prerequisites, flags
 * and exit codes.
 *
 * Node >= 23.6 (type stripping), same style as bench/apachejit/run.ts.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { defaultConfig, type OpendrsConfig } from "../../dist/domain/config.js";
import { OpendrsError } from "../../dist/domain/types.js";
import type { LlmProvider, ReviewBrief } from "../../dist/domain/types.js";
import { scoreDiff } from "../../dist/engine.js";
import { createLlmProvider } from "../../dist/llm/provider.js";
import { VERSION } from "../../dist/version.js";
import {
  backoffDelayMs,
  checkStudyValidity,
  classifyProviderError,
  estimateCallCostUsd,
  evaluateDecisionRule,
  factId,
  flattenLabels,
  groupByFactId,
  liveFactIds,
  PRICES,
  reconcileActualSpend,
  reserveIfAffordable,
  tallyLabels,
  type Budget,
  type FlatLabelledFact,
  type LabelsFile,
} from "./lib.ts";

const execFileAsync = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const BENCH_ENV_PATH = join(homedir(), ".config/opendrs/bench.env");
const REPOS_DIR = join(homedir(), ".cache/opendrs/field-test/repos");
const STUDY_DIR_ROOT = join(homedir(), ".cache/opendrs/verify-study");
/** Rough estimate of the verifier's fixed system-prompt + schema overhead, in characters, until
 * the real VERIFY_SYSTEM_PROMPT/VERIFY_SCHEMA exist in dist/ (same role as apachejit/llm.ts's
 * PROMPT_CHARS constant for the judge). Re-measure once llm.ts's `verifyPromptHash()` is real. */
const VERIFY_SYSTEM_PROMPT_CHARS_ESTIMATE = 3_000;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

function usageError(message: string): never {
  console.error(message);
  process.exit(2);
}

/** Removes every occurrence of `secret` from `text`. Used on every error message/log line before
 * it is printed, written or included in a report — the key must never reach stdout, stderr, or a
 * file, under any error path. */
function scrub(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join("[REDACTED]") : text;
}

/** Parses `KEY=VALUE` lines (blank lines and `#` comments ignored); does not touch process.env. */
function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

/**
 * Reads ANTHROPIC_API_KEY from ~/.config/opendrs/bench.env. Refuses with a clear message if the
 * file or the key is missing — never falls back to process.env or any other source, so a stray
 * key in the worker's own shell can never be used by accident (rule 7: no API calls by the
 * worker; this script is only ever run by the lead, with their own key).
 */
async function loadApiKey(): Promise<string> {
  if (!existsSync(BENCH_ENV_PATH)) {
    usageError(
      `Missing ${BENCH_ENV_PATH}. Create it with one line, ANTHROPIC_API_KEY=sk-ant-..., and re-run. ` +
        `This script never reads the key from process.env or anywhere else, and never runs a paid call without it.`,
    );
  }
  const env = parseEnvFile(await readFile(BENCH_ENV_PATH, "utf8"));
  const key = env.ANTHROPIC_API_KEY;
  if (!key) {
    usageError(`${BENCH_ENV_PATH} has no ANTHROPIC_API_KEY=... line. Add one and re-run.`);
  }
  return key;
}

interface Options {
  model: string;
  maxUsd: number;
  repos?: string[];
  dryRun: boolean;
  keepClones: boolean;
  out: string;
}

function parseOptions(args: string[]): Options {
  const { values } = parseArgs({
    args,
    options: {
      model: { type: "string", default: "claude-sonnet-5" },
      "max-usd": { type: "string", default: "5.00" },
      repos: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "keep-clones": { type: "boolean", default: false },
      out: { type: "string", default: fileURLToPath(new URL("results.md", import.meta.url)) },
    },
  });
  if (!PRICES[values.model]) usageError(`--model must be one of ${Object.keys(PRICES).join(", ")} (needed for the spend cap)`);
  const maxUsd = Number(values["max-usd"]);
  if (!(maxUsd > 0)) usageError(`--max-usd must be a positive number, got "${values["max-usd"]}"`);
  return {
    model: values.model,
    maxUsd,
    repos: values.repos?.split(",").map((s) => s.trim()),
    dryRun: values["dry-run"],
    keepClones: values["keep-clones"],
    out: values.out,
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 1 << 30 });
  return stdout.trim();
}

interface LabelledRepoLike {
  repo: string;
  slug: string;
  head: string;
  cloneMode?: string;
  config?: Record<string, unknown>;
}

/** Clones `repo` under REPOS_DIR/<slug> at its pinned head, reusing an existing clone. Blobless
 * (`--filter=blob:none`) unless `cloneMode` names a full clone (fastlane needs one; see
 * labels.json's meta.setupQuirks.fastlane). */
async function ensureClone(repo: LabelledRepoLike): Promise<string> {
  const dir = join(REPOS_DIR, repo.slug);
  const url = `https://github.com/${repo.repo}.git`;
  if (!existsSync(dir)) {
    const partial = `${dir}.partial`;
    await rm(partial, { recursive: true, force: true });
    await mkdir(dirname(dir), { recursive: true });
    const full = repo.cloneMode?.toLowerCase().includes("full") ?? false;
    console.error(`${repo.slug}: cloning ${url}${full ? " (full clone)" : " (blobless)"}`);
    const args = full ? ["clone", "-q", url, partial] : ["clone", "-q", "--filter=blob:none", url, partial];
    await execFileAsync("git", args, { maxBuffer: 1 << 30 });
    await git(partial, ["rename" as never]).catch(() => undefined); // no-op guard; rename is done by fs below
  }
  if (existsSync(`${dir}.partial`) && !existsSync(dir)) {
    const { rename } = await import("node:fs/promises");
    await rename(`${dir}.partial`, dir);
  }
  await git(dir, ["rev-parse", "--verify", `${repo.head}^{commit}`]).catch(() => {
    throw new Error(`${repo.slug}: pinned head ${repo.head} not found in the clone at ${dir}`);
  });
  return dir;
}

/** Applies a repo's labels.json `config` overrides (currently only fastlane's history.* tuning)
 * onto a fresh defaultConfig(). Keys are dotted ("history.maxCommits"); unknown/non-numeric keys
 * (e.g. the human-readable "note" field) are skipped. */
function applyConfigOverrides(config: OpendrsConfig, overrides: Record<string, unknown> | undefined): void {
  if (!overrides) return;
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== "number") continue; // skips "note"
    if (key === "history.maxCommits") config.history.maxCommits = value;
    else if (key === "history.lookbackDays") config.history.lookbackDays = value;
  }
}

/** The config every scored PR (and the preflight check) shares: real defaults plus the verifier
 * turned on. Guarded so a dist build that predates Phase 2 (Tasks 1-4 of the verification-pass
 * plan) fails with a clear message instead of a silent no-op. */
function buildVerifyConfig(model: string): OpendrsConfig {
  const config = defaultConfig();
  config.llm.enabled = true;
  config.llm.provider = "anthropic";
  config.llm.model = model;
  if (!("verify" in config.llm)) {
    throw new Error("config.llm.verify is missing: this dist/ build predates the verification-pass core branches (Tasks 1-4). Build from a branch that includes them first.");
  }
  (config.llm as unknown as { verify: { enabled: boolean } }).verify.enabled = true;
  return config;
}

/** Builds the config one PR scores with: buildVerifyConfig() plus the repo's setup quirks. */
function buildConfig(repo: LabelledRepoLike, model: string): OpendrsConfig {
  const config = buildVerifyConfig(model);
  applyConfigOverrides(config, repo.config);
  return config;
}

/** Thrown by preflightCheck to abort the whole run before any clone or brief is built; carries
 * its own clear message (already scrubbed of the API key by the caller). */
class PreflightError extends Error {}

/**
 * A single cheap `provider.verify()` call, made before cloning anything or building any of the
 * (up to) 48 briefs, so an account-level problem (bad key, wrong workspace scope, no permission)
 * is caught in one request instead of silently fail-opening 48 times for $0 of real signal (see
 * the previous run's HTTP 400 on every PR, logged in the orchestrator ledger). A transient error
 * (429/5xx/timeout) is retried with backoff a few times first; a fatal one (any other 4xx) aborts
 * immediately. The call's real cost is reserved from and reconciled against `budget`.
 */
async function preflightCheck(model: string, apiKeyEnv: NodeJS.ProcessEnv, budget: Budget): Promise<void> {
  const config = buildVerifyConfig(model);
  const provider = createLlmProvider(config, apiKeyEnv);
  if (!provider.verify) throw new PreflightError(`provider "${provider.name}" does not implement verify()`);
  const probe = {
    title: "opendrs bench/verify preflight check",
    candidates: [{ id: "preflight", kind: "check" as const, file: "preflight", text: "Does this deserve a reviewer's attention?", excerpt: "", status: "new" as const }],
    partners: {},
  };
  const promptChars = VERIFY_SYSTEM_PROMPT_CHARS_ESTIMATE + JSON.stringify(probe).length;
  const reserved = reserveIfAffordable(budget, promptChars);
  if (!reserved.ok) {
    throw new PreflightError(`the preflight check alone would cost ~$${reserved.estimatedCost.toFixed(4)}, more than the entire --max-usd budget ($${budget.left.toFixed(4)} left)`);
  }

  const MAX_TRANSIENT_ATTEMPTS = 4; // 1 initial try + 3 retries
  for (let attempt = 0; ; attempt++) {
    try {
      const { usage } = await provider.verify(probe);
      reconcileActualSpend(budget, reserved.estimatedCost, usage);
      return;
    } catch (e) {
      const message = errorMessage(e);
      const fatal = classifyProviderError(message) === "fatal";
      if (fatal || attempt >= MAX_TRANSIENT_ATTEMPTS - 1) {
        budget.left += reserved.estimatedCost; // refund: no usage was ever charged
        throw new PreflightError(
          fatal
            ? `Preflight check failed with an account-level error (not transient) — aborting before building any briefs:\n${message}`
            : `Preflight check failed after ${attempt + 1} attempts (transient errors: 429/5xx/timeout):\n${message}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(attempt)));
    }
  }
}

/** A rough proxy for the verifier prompt's size before the real VERIFY_SYSTEM_PROMPT/VERIFY_SCHEMA
 * exist: the baseline (verify-off) brief's own JSON size, which scales with the same candidate
 * pools (facts, reviewFirst hunks, checks) the verifier call would see, plus a fixed overhead. */
function estimatePromptChars(baseline: ReviewBrief): number {
  return VERIFY_SYSTEM_PROMPT_CHARS_ESTIMATE + JSON.stringify({ facts: baseline.captain?.facts ?? [], reviewFirst: baseline.reviewFirst, checks: baseline.checks }).length;
}

interface PrOutcome {
  repoSlug: string;
  prSlug: string;
  skipped?: string;
  baseline?: ReviewBrief;
  verified?: ReviewBrief;
  estimatedCost?: number;
  actualCost?: number;
}

async function scorePr(repoDir: string, repo: LabelledRepoLike, pr: { base: string; head: string; slug: string }, model: string, dryRun: boolean, apiKeyEnv: Record<string, string> | undefined, budget: Budget | undefined): Promise<PrOutcome> {
  const baselineConfig = defaultConfig();
  applyConfigOverrides(baselineConfig, repo.config);
  const baselineResult = await scoreDiff({ repoDir, config: baselineConfig, base: pr.base, head: pr.head, llm: null, brief: {} });
  if (!baselineResult.brief) return { repoSlug: repo.slug, prSlug: pr.slug, skipped: "scoreDiff did not build a baseline brief" };
  const baseline = baselineResult.brief;

  if (dryRun) return { repoSlug: repo.slug, prSlug: pr.slug, baseline };

  const estimatedCost = estimateCallCostUsd(estimatePromptChars(baseline), PRICES[model]!);
  if (!budget) return { repoSlug: repo.slug, prSlug: pr.slug, baseline, estimatedCost };
  const reserved = reserveIfAffordable(budget, estimatePromptChars(baseline));
  if (!reserved.ok) {
    return { repoSlug: repo.slug, prSlug: pr.slug, baseline, estimatedCost: reserved.estimatedCost, skipped: "budget" };
  }

  const config = buildConfig(repo, model);
  let provider: LlmProvider | undefined;
  try {
    provider = createLlmProvider(config, apiKeyEnv as unknown as NodeJS.ProcessEnv);
  } catch (e) {
    budget.left += reserved.estimatedCost; // refund: the call never happened
    throw e instanceof OpendrsError ? new Error(scrub(e.message, undefined)) : e;
  }
  const result = await scoreDiff({ repoDir, config, base: pr.base, head: pr.head, llm: provider, brief: {} });
  const verified = result.brief ?? baseline;
  const usage = verified.verification?.usage;
  const actualCost = usage ? reconcileActualSpend(budget, reserved.estimatedCost, usage) : (budget.left += reserved.estimatedCost, 0);
  return { repoSlug: repo.slug, prSlug: pr.slug, baseline, verified, estimatedCost: reserved.estimatedCost, actualCost };
}

/** Recall/precision bookkeeping for one labelled fact group (several field-test instances can
 * share one factId; see lib.ts's groupByFactId doc comment). `verdict` is the live
 * `brief.verification.verdicts[id]` entry, when the PR was actually scored with verify on.
 * `firedAtDetector` is whether `id` ever appeared in the baseline (verify-off) brief at all —
 * see docs/experiments.md's 2026-10-23 amendment for why this matters for WRONG fires. */
interface Judged {
  id: string;
  facts: FlatLabelledFact[];
  verdict?: { action: string; status: string; reason?: string; source: string; droppedClass?: string };
  detectorHandledClass?: "A" | "B" | "C"; // inferred from the labelled note mentioning the deterministic classes, spec §3.8
  firedAtDetector: boolean;
}

function judgeGroup(id: string, facts: FlatLabelledFact[], baseline: ReviewBrief | undefined, verified: ReviewBrief | undefined): Judged {
  const verdict = verified?.verification?.verdicts?.[id];
  const note = facts.map((f) => f.note ?? "").join(" ");
  const detectorHandledClass = /class a \(retired file\)/i.test(note) ? "A" : /class b \(partner lacks/i.test(note) ? "B" : /class c \(test fired/i.test(note) ? "C" : undefined;
  const firedAtDetector = liveFactIds(baseline).has(id);
  return { id, facts, verdict, detectorHandledClass, firedAtDetector };
}

async function main(): Promise<number> {
  const o = parseOptions(process.argv.slice(2));
  const labels = JSON.parse(await readFile(join(HERE, "labels.json"), "utf8")) as LabelsFile;
  const flat = flattenLabels(labels);
  console.error("Traced label totals:", tallyLabels(flat));

  const apiKey = o.dryRun ? undefined : await loadApiKey();
  const apiKeyEnv = apiKey ? { ...process.env, ANTHROPIC_API_KEY: apiKey } : undefined;
  const budget: Budget | undefined = o.dryRun ? undefined : { left: o.maxUsd, prices: PRICES[o.model]! };

  // Fail fast: one cheap real call before cloning anything or building any of the (up to) 48
  // briefs, so an account-level error (bad key, wrong workspace scope, no permission) aborts
  // here instead of fail-opening silently through the whole corpus for $0 of real signal.
  if (budget) {
    console.error("Preflight check: one verify() call to confirm the key works before building any briefs...");
    try {
      await preflightCheck(o.model, apiKeyEnv as unknown as NodeJS.ProcessEnv, budget);
    } catch (e) {
      console.error(scrub(errorMessage(e), apiKey));
      return 4;
    }
    console.error(`Preflight check passed. $${budget.left.toFixed(4)} left of --max-usd ${o.maxUsd}.`);
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const studyDir = join(STUDY_DIR_ROOT, runId);
  await mkdir(studyDir, { recursive: true });

  const repos = labels.repos.filter((r) => !o.repos || o.repos.includes(r.slug));
  const outcomes: PrOutcome[] = [];
  const clonedDirs: string[] = [];
  let aborted = false;

  outer: for (const repo of repos) {
    let repoDir: string;
    try {
      repoDir = await ensureClone(repo);
      clonedDirs.push(repoDir);
    } catch (e) {
      console.error(`${repo.slug}: skipped, ${scrub(errorMessage(e), apiKey)}`);
      continue;
    }
    for (const pr of repo.prs) {
      if (aborted) break outer;
      let outcome: PrOutcome;
      try {
        outcome = await scorePr(repoDir, repo, { base: pr.base, head: pr.head, slug: pr.slug }, o.model, o.dryRun, apiKeyEnv, budget);
      } catch (e) {
        outcome = { repoSlug: repo.slug, prSlug: pr.slug, skipped: scrub(errorMessage(e), apiKey) };
      }
      if (outcome.skipped === "budget") {
        console.error(`ABORTING: ${repo.slug}/${pr.slug} would need ~$${outcome.estimatedCost?.toFixed(4)}, only $${budget?.left.toFixed(4)} left of --max-usd ${o.maxUsd}. Stopping before any further calls.`);
        aborted = true;
        outcomes.push(outcome);
        break outer;
      }
      if (!o.dryRun) console.error(`spend so far: $${(o.maxUsd - (budget?.left ?? o.maxUsd)).toFixed(4)} of $${o.maxUsd}`);
      outcomes.push(outcome);
      if (outcome.verified) {
        await writeFile(join(studyDir, `${repo.slug}-${pr.slug}.json`), JSON.stringify(outcome.verified, null, 2));
      } else if (outcome.baseline) {
        await writeFile(join(studyDir, `${repo.slug}-${pr.slug}.baseline.json`), JSON.stringify(outcome.baseline, null, 2));
      }
    }
  }

  // --- recall / precision / cost, from the labelled facts matched against live verdicts ---
  const outcomeByPr = new Map(outcomes.map((o2) => [`${o2.repoSlug}:${o2.prSlug}`, o2]));
  const groups = groupByFactId(flat);
  const judged: Judged[] = [];
  for (const [id, facts] of groups) {
    const first = facts[0]!;
    const outcome = outcomeByPr.get(`${first.repoSlug}:${first.prSlug}`);
    judged.push(judgeGroup(id, facts, outcome?.baseline, outcome?.verified));
  }

  const trueUsefulGroups = judged.filter((j) => j.facts.some((f) => f.label === "true-useful"));
  const trueUsefulWronglyDropped = trueUsefulGroups.filter((j) => j.verdict?.action === "drop").length;
  const trueUsefulTotal = flat.filter((f) => f.label === "true-useful").length;

  const couplingGroups = judged.filter((j) => j.facts.some((f) => f.id === "coupling.missing" && f.label === "noise"));
  const couplingNoiseTotal = flat.filter((f) => f.id === "coupling.missing" && f.label === "noise").length;
  const couplingHandledByDetector = couplingGroups.filter((j) => j.detectorHandledClass !== undefined).reduce((n, j) => n + j.facts.length, 0);
  const couplingHandledByVerifier = couplingGroups.filter((j) => j.detectorHandledClass === undefined && (j.verdict?.action === "drop" || j.verdict?.action === "downgrade")).reduce((n, j) => n + j.facts.length, 0);
  const couplingNoiseHandled = Math.min(couplingNoiseTotal, couplingHandledByDetector + couplingHandledByVerifier);

  // §3.8-style amendment (docs/experiments.md, 2026-10-23): a WRONG fire the detector no longer
  // produces at all (`firedAtDetector` false — it's absent from the baseline, verify-off brief)
  // is just as handled as one the verifier dropped/downgraded — the reviewer is never misled
  // either way. Reported separately, same as coupling.missing's detector-vs-verifier split above.
  const wrongGroups = judged.filter((j) => j.facts.some((f) => f.label === "wrong"));
  const wrongFiresTotal = flat.filter((f) => f.label === "wrong").length;
  const wrongFiresEliminated = wrongGroups.filter((j) => !j.firedAtDetector).reduce((n, j) => n + j.facts.length, 0);
  const wrongFiresHandledByVerifier = wrongGroups.filter((j) => j.firedAtDetector && (j.verdict?.action === "drop" || j.verdict?.action === "downgrade")).reduce((n, j) => n + j.facts.length, 0);
  const wrongFiresHandled = wrongFiresEliminated + wrongFiresHandledByVerifier;

  const scoredPrs = outcomes.filter((o2) => o2.actualCost !== undefined);
  const totalCost = scoredPrs.reduce((n, o2) => n + (o2.actualCost ?? 0), 0);
  const costPerPrUsd = scoredPrs.length > 0 ? totalCost / scoredPrs.length : 0;

  // Safety net independent of the preflight check (above): if the verifier's own fail-open
  // contract (src/brief/verify.ts: "any error fails open") triggered for most scored PRs, this
  // run is an outage, not a measurement — never let that read as a precision FAIL.
  const verifiedOutcomes = outcomes.filter((o2) => o2.verified !== undefined);
  const verifyFailedCount = verifiedOutcomes.filter((o2) => o2.verified?.verification?.outcome === "failed").length;
  const validity = o.dryRun ? undefined : checkStudyValidity(verifyFailedCount, verifiedOutcomes.length);

  const decision = o.dryRun || validity?.invalid
    ? undefined
    : evaluateDecisionRule({ trueUsefulWronglyDropped, trueUsefulTotal, couplingNoiseHandled, couplingNoiseTotal, wrongFiresHandled, wrongFiresTotal, costPerPrUsd });

  const lines: string[] = [
    "# Verifier precision study: results",
    "",
    `Run: ${runId} · opendrs ${VERSION} · model ${o.model}${o.dryRun ? " · DRY RUN (no API calls)" : ""}`,
    `Raw per-PR JSON: ${studyDir}`,
    "",
    "## Recall (spec §3.7.1)",
    `${trueUsefulWronglyDropped} of ${trueUsefulTotal} true+useful facts wrongly dropped (bar: at most 1).`,
    "",
    "## Precision — coupling.missing (spec §3.7.2, §3.8 amendment)",
    `${couplingNoiseHandled} of ${couplingNoiseTotal} handled (detector classes A-C: ${couplingHandledByDetector}; verifier only: ${couplingHandledByVerifier}) — bar: >= 13 of 18 (70%).`,
    "",
    "## Precision — contract.dependency WRONG fires (spec §3.7.2, §3.8-style amendment 2026-10-23)",
    `${wrongFiresHandled} of ${wrongFiresTotal} handled (eliminated at the detector, no longer fires at all: ${wrongFiresEliminated}; marked drop/downgrade by the verifier: ${wrongFiresHandledByVerifier}) — bar: both.`,
    "",
    "## Cost",
    `$${totalCost.toFixed(4)} total over ${scoredPrs.length} scored PRs; $${costPerPrUsd.toFixed(4)}/PR (bar: <= $0.02/PR). Model ${o.model}.`,
    "",
    "## Decision (spec §3.7, applied as written)",
    decision
      ? `recall: ${decision.recallPass ? "PASS" : "FAIL"} · precision: ${decision.precisionChecked ? (decision.precisionPass ? "PASS" : "FAIL") : "not checked (recall failed first)"} · cost: ${decision.costPass ? "PASS" : "FAIL"} · overall: ${decision.overall}`
      : validity?.invalid
        ? `INVALID — the verifier failed open (\`verification.outcome: "failed"\`) for ${validity.failedCount} of ${validity.scoredCount} scored PRs (${(validity.failedShare * 100).toFixed(0)}%, more than half). This reflects a provider outage or persistent account-level error, not a measurement of the verifier's real precision/recall — no decision rule was applied. See "Verifier failures" below for the reasons; fix the cause and re-run.`
        : "DRY RUN — no decision (no API calls were made; this only checks label matching against the baseline, verify-off brief).",
    "",
    ...(verifyFailedCount > 0
      ? ["## Verifier failures", ...verifiedOutcomes.filter((o2) => o2.verified?.verification?.outcome === "failed").map((o2) => `- ${o2.repoSlug}/${o2.prSlug}: ${o2.verified?.verification?.note ?? "(no note recorded)"}`), ""]
      : []),
    "## Skipped / aborted PRs",
    ...outcomes.filter((o2) => o2.skipped).map((o2) => `- ${o2.repoSlug}/${o2.prSlug}: ${o2.skipped}`),
    aborted ? "\n**Run aborted by the budget cap before every labelled PR was scored.** Numbers above are partial." : "",
  ];
  await writeFile(o.out, `${lines.join("\n")}\n`);
  process.stdout.write(`${lines.slice(0, lines.indexOf("## Skipped / aborted PRs")).join("\n")}\n`);

  if (!o.keepClones) {
    for (const dir of clonedDirs) await rm(dir, { recursive: true, force: true });
    console.error(`deleted ${clonedDirs.length} clone(s) under ${REPOS_DIR} (rule 7; pass --keep-clones to keep them)`);
  }

  if (aborted) return 3;
  if (outcomes.some((o2) => o2.skipped && o2.skipped !== "budget")) return 1;
  if (validity?.invalid) return 5;
  return 0;
}

process.exitCode = await main();
