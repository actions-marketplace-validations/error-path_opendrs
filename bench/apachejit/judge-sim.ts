/**
 * Simulations for the next LLM-judge experiment, from cached judgements and replay rows only (no
 * API calls, no clones):
 * 1. Routing at equal spend: the LLM reviews every judged test commit, a random subset, or only
 *    the riskiest X % by opendrs's free calibrated score; bugs flagged per dollar and bugs missed.
 * 2. Power: calibrated AUC with and without the llm.* signals and a riskySnippets count, and
 *    paired bootstrap SEs of the AUC differences; the requireSafe gate with Wilson intervals.
 * 3. Decision layer: the LLM alone vs LLM + opendrs (the judge's outputs inside the calibrated
 *    model, and the requireSafe gate with opendrs's score), at fixed review budgets.
 * Run `npm run build` first, then `node bench/apachejit/judge-sim.ts [judgement-cache.jsonl]`
 * (default: the Sonnet 5 cache).
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelWeights, Signal } from "../../dist/domain/types.js";
import { fitModel } from "../../dist/model/calibrate.js";
import { DEFAULT_WEIGHTS } from "../../dist/model/defaults.js";
import { mulberry32 } from "../../dist/model/fit.js";
import { scoreSignals } from "../../dist/model/logistic.js";
import type { ReplayRow } from "../../dist/model/replay.js";
import { llmSignals } from "../../dist/signals/llm.js";
import { aucOf, parseApacheJit } from "./lib.ts";

const W = join(homedir(), ".cache/opendrs/apachejit");
const CACHE = process.argv[2] ?? join(W, "llm/claude-sonnet-5.1ad58d7b3c33.jsonl");
const BOOTSTRAP = 2000;
const Z = 1.96 + 0.8416; // two-sided 5 %, 80 % power

const judged = new Map<string, any>();
for (const line of readFileSync(CACHE, "utf8").split("\n").filter(Boolean)) {
  const e = JSON.parse(line);
  if (e.judgement) judged.set(e.sha, e.judgement);
}
const shas = (file: string) => new Set(parseApacheJit(readFileSync(join(W, "data", file), "utf8")).map((r) => r.sha));
const trainShas = shas("apachejit_train.csv");
const testShas = shas("apachejit_test_large.csv");

const rows: ReplayRow[] = [];
const allTrain: ReplayRow[] = [];
for (const f of readdirSync(join(W, "rows")).filter((f) => f.includes("0ea8800cbfb8") && !f.startsWith("hadoop."))) {
  for (const line of readFileSync(join(W, "rows", f), "utf8").split("\n").filter(Boolean).slice(1)) {
    const parsed = JSON.parse(line) as ReplayRow;
    const r = { ...parsed, signals: parsed.signals.map((s: Signal) => ({ ...s, summary: "", evidence: [] })) };
    if (judged.has(r.sha)) rows.push(r);
    if (trainShas.has(r.sha)) allTrain.push(r);
  }
}

const snippets = (sha: string): Signal => ({ id: "llm.snippets", value: Math.log1p(judged.get(sha).riskySnippets.length), status: "inferred", summary: "", evidence: [] });
const variants: Record<string, (r: ReplayRow) => Promise<Signal[]>> = {
  calibrated: async (r) => r.signals,
  "calibrated + llm": async (r) => [...r.signals, ...(await llmSignals({ llm: { judgement: judged.get(r.sha) } } as any))],
  "calibrated + snippets": async (r) => [...r.signals, snippets(r.sha)],
  "calibrated + llm + snippets": async (r) => [...r.signals, ...(await llmSignals({ llm: { judgement: judged.get(r.sha) } } as any)), snippets(r.sha)],
};

const train = rows.filter((r) => trainShas.has(r.sha));
const test = rows.filter((r) => testShas.has(r.sha));
const y = test.map((r) => r.label);
console.log(`judged sample: train ${train.length} (${train.filter((r) => r.label).length} positive), test ${test.length} (${y.filter(Boolean).length} positive)\n`);

// ---- 1. Routing at equal spend ----
// opendrs's free score: calibrate fitted on every replayed training commit, as the benchmark does.
const free = fitModel(allTrain, DEFAULT_WEIGHTS, "apachejit");
const risk = test.map((r) => scoreSignals(r.signals, free).score);
console.log(`opendrs free score on the judged test sample: AUC ${aucOf(risk, y)!.toFixed(3)} (fitted on ${allTrain.length} training commits)`);
// Estimated Sonnet 5 tokens per judgement: the prompt (~3,900 chars + ~600 schema tokens), the diff
// (~45 chars per changed line, ~310 per hunk of context and header, cut at 60,000 chars), the reply
// as cached, and ~1,000 thinking tokens at effort "low" (which brings the mean near the ~$0.034 per
// judgement the first run cost).
const lines = (r: ReplayRow) => Math.round(Math.expm1(r.signals.find((s) => s.id === "size.churn")!.value));
const inputTokens = test.map((r) => (3_900 + Math.min(60_000, 45 * lines(r) + 310 * judged.get(r.sha).hunks.length + 200)) / 3.5 + 600);
const outputTokens = test.map((r) => JSON.stringify(judged.get(r.sha)).length / 3.5 + 1_000);
const dollars = test.map((_, i) => (inputTokens[i]! * 2 + outputTokens[i]! * 10) / 1e6);
const tokens = test.map((_, i) => inputTokens[i]! + outputTokens[i]!);
const total = { dollars: dollars.reduce((a, b) => a + b, 0), tokens: tokens.reduce((a, b) => a + b, 0) };
const bugs = y.filter(Boolean).length;
console.log(`estimated cost of judging all ${test.length}: $${total.dollars.toFixed(2)} ($${(total.dollars / test.length).toFixed(4)} per commit), ${(total.tokens / 1e6).toFixed(2)} M tokens\n`);

const flagRules: Array<[string, (i: number) => boolean]> = [
  ["≥1 risky snippet", (i) => judged.get(test[i]!.sha).riskySnippets.length >= 1],
  ["≥2 risky snippets", (i) => judged.get(test[i]!.sha).riskySnippets.length >= 2],
  ["requireSafe fails (conf 8)", (i) => {
    const j = judged.get(test[i]!.sha);
    return j.truncated || j.unclassified.length > 0 || !j.hunks.every((h: any) => h.safe && h.confidence >= 8);
  }],
];
const order = test.map((_, i) => i).sort((a, b) => risk[b]! - risk[a]!);
const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
for (const [rule, flagged] of flagRules) {
  const caught = (set: number[]) => set.filter((i) => y[i] && flagged(i)).length;
  const raised = (set: number[]) => set.filter((i) => flagged(i)).length;
  const all = test.map((_, i) => i);
  const flaggedAll = all.filter(flagged);
  console.log(`LLM flag rule "${rule}": LLM-only on every commit flags ${flaggedAll.length} (${pct(flaggedAll.length / test.length)}), precision ${pct(caught(all) / flaggedAll.length)}, catches ${caught(all)} of ${bugs} bugs (${pct(caught(all) / bugs)}) for $${total.dollars.toFixed(2)}`);
  console.log("  | Reviewed share | Arm | Commits reviewed | Spend | Commits flagged | Bugs flagged | Precision | Missed (of " + bugs + ") | Bugs per $ |");
  for (const x of [0.1, 0.3, 0.5]) {
    const top = order.slice(0, Math.round(test.length * x));
    const spend = top.reduce((a, i) => a + dollars[i]!, 0);
    const c = caught(top);
    // Random arm at the same dollar budget: shuffle, review until the budget is spent; mean of 1,000 draws.
    const rand = mulberry32(11);
    let sumCaught = 0, sumN = 0, sumRaised = 0;
    for (let k = 0; k < 1000; k++) {
      const perm = all.slice();
      for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [perm[i], perm[j]] = [perm[j]!, perm[i]!]; }
      let left = spend; const chosen: number[] = [];
      for (const i of perm) { if (dollars[i]! > left) continue; left -= dollars[i]!; chosen.push(i); }
      sumCaught += caught(chosen); sumN += chosen.length; sumRaised += raised(chosen);
    }
    const rc = sumCaught / 1000;
    const rr = sumRaised / 1000;
    console.log(`  | ${pct(x)} | opendrs routes the riskiest | ${top.length} | $${spend.toFixed(2)} (${pct(spend / total.dollars)}) | ${raised(top)} | ${c} | ${pct(c / raised(top))} | ${bugs - c} | ${(c / spend).toFixed(1)} |`);
    console.log(`  | ${pct(x)} | random, same spend | ${(sumN / 1000).toFixed(0)} | $${spend.toFixed(2)} | ${rr.toFixed(0)} | ${rc.toFixed(1)} | ${pct(rc / rr)} | ${(bugs - rc).toFixed(1)} | ${(rc / spend).toFixed(1)} |`);
  }
  const sameLoad = order.slice(0, raised(all)).filter((i) => y[i]).length;
  console.log(`  opendrs alone, no LLM, sending its riskiest ${raised(all)} commits (the LLM's flag count) to a human: ${sameLoad} bugs (${pct(sameLoad / bugs)}), precision ${pct(sameLoad / raised(all))}, $0`);
  console.log(`  | 100 % | LLM on every commit | ${test.length} | $${total.dollars.toFixed(2)} | ${raised(all)} | ${caught(all)} | ${pct(caught(all) / raised(all))} | ${bugs - caught(all)} | ${(caught(all) / total.dollars).toFixed(1)} |\n`);
}
const topShare = (x: number) => { const top = order.slice(0, Math.round(test.length * x)); return { bugs: top.filter((i) => y[i]).length, dollars: top.reduce((a, i) => a + dollars[i]!, 0) / total.dollars }; };
for (const x of [0.1, 0.3, 0.5]) {
  const t = topShare(x);
  console.log(`opendrs riskiest ${pct(x)}: holds ${t.bugs} of ${bugs} bugs (${pct(t.bugs / bugs)}) and ${pct(t.dollars)} of the judging spend`);
}
console.log("");

// ---- 2. Power and baselines for the prompt variants ----
const scores: Record<string, number[]> = {};
for (const [name, signals] of Object.entries(variants)) {
  const fitRows = await Promise.all(train.map(async (r) => ({ ...r, signals: await signals(r) })));
  const model: ModelWeights = fitModel(fitRows, DEFAULT_WEIGHTS, "judge-power");
  scores[name] = await Promise.all(test.map(async (r) => scoreSignals(await signals(r), model).score));
  console.log(`${name}: AUC ${aucOf(scores[name]!, y)!.toFixed(3)}${model.weights["llm.snippets"] !== undefined ? `, llm.snippets weight ${model.weights["llm.snippets"]!.toFixed(2)}` : ""}`);
}

// ---- 3. Decision layer: LLM alone vs LLM + opendrs, at fixed review budgets ----
// "LLM alone" ranks by the judge's own outputs only: its risky-snippet count, ties broken by its
// risk, and a logistic fit on the llm.* signals and the snippet count with no opendrs signal.
const llmOnly = async (r: ReplayRow) => [...(await llmSignals({ llm: { judgement: judged.get(r.sha) } } as any)), snippets(r.sha)];
const llmOnlyModel = fitModel(await Promise.all(train.map(async (r) => ({ ...r, signals: await llmOnly(r) }))), DEFAULT_WEIGHTS, "judge-sim");
const rankings: Record<string, number[]> = {
  "LLM alone (snippet count, then risk)": test.map((r) => judged.get(r.sha).riskySnippets.length + judged.get(r.sha).risk / 2),
  "LLM alone (fitted on its own outputs)": await Promise.all(test.map(async (r) => scoreSignals(await llmOnly(r), llmOnlyModel).score)),
  "opendrs alone (free score)": risk,
  "LLM + opendrs (calibrated + llm + snippets)": scores["calibrated + llm + snippets"]!,
};
const negatives = y.length - bugs;
console.log(`decision layer on the ${test.length} judged test commits (${bugs} buggy), LLM tokens for all of them ≈ ${(total.tokens / 1e6).toFixed(2)} M:`);
console.log("| Ranking | AUC | Review budget | Bugs caught (recall) | Precision | False-positive rate | LLM tokens per bug caught |");
const topK = (sc: number[], k: number) => sc.map((_, i) => i).sort((a, b) => sc[b]! - sc[a]!).slice(0, k);
for (const [name, sc] of Object.entries(rankings)) {
  for (const x of [0.1, 0.3, 0.5]) {
    const top = topK(sc, Math.round(test.length * x));
    const tp = top.filter((i) => y[i]).length;
    const perBug = name.startsWith("opendrs") ? "0" : `${Math.round(total.tokens / tp / 1000)} k`;
    console.log(`| ${name} | ${aucOf(sc, y)!.toFixed(3)} | ${pct(x)} | ${tp} (${pct(tp / bugs)}) | ${pct(tp / top.length)} | ${pct((top.length - tp) / negatives)} | ${perBug} |`);
  }
}
{
  const a = rankings["LLM + opendrs (calibrated + llm + snippets)"]!, b = rankings["LLM alone (fitted on its own outputs)"]!;
  const r2 = mulberry32(5), dAuc: number[] = [], dRec: number[] = [];
  for (let i = 0; i < BOOTSTRAP; i++) {
    const idx = Array.from({ length: y.length }, () => Math.floor(r2() * y.length));
    const yy = idx.map((j) => y[j]!), sa = idx.map((j) => a[j]!), sb = idx.map((j) => b[j]!);
    dAuc.push(aucOf(sa, yy)! - aucOf(sb, yy)!);
    const k = Math.round(y.length * 0.3);
    const rec = (sc: number[]) => topK(sc, k).filter((j) => yy[j]).length / Math.max(1, yy.filter(Boolean).length);
    dRec.push(rec(sa) - rec(sb));
  }
  const ci = (d: number[]) => { const s2 = [...d].sort((p, q) => p - q); return `${s2[Math.floor(d.length * 0.025)]!.toFixed(3)} to ${s2[Math.floor(d.length * 0.975)]!.toFixed(3)}`; };
  console.log(`LLM + opendrs − LLM alone (fitted): AUC 95 % CI ${ci(dAuc)}; recall at a 30 % review budget, 95 % CI ${ci(dRec)}`);
}
// The requireSafe gate as the decision: LLM alone auto-approves when every hunk is safe at
// confidence 8; LLM + opendrs auto-approves only when that holds and opendrs's free score is in
// its lower half (median of the scores on the training commits).
{
  const safe = (i: number) => { const j = judged.get(test[i]!.sha); return !j.truncated && j.unclassified.length === 0 && j.hunks.every((h: any) => h.safe && h.confidence >= 8); };
  const trainRisk = allTrain.map((r) => scoreSignals(r.signals, free).score).sort((p, q) => p - q);
  const median = trainRisk[Math.floor(trainRisk.length / 2)]!;
  for (const [name, approve] of [["LLM alone: requireSafe", (i: number) => safe(i)], ["LLM + opendrs: requireSafe and score below the training median", (i: number) => safe(i) && risk[i]! < median]] as const) {
    const passed = test.map((_, i) => i).filter(approve);
    const buggyPassed = passed.filter((i) => y[i]).length;
    console.log(`gate "${name}": auto-approves ${passed.length} (${pct(passed.length / test.length)}), ${buggyPassed} of them buggy (${pct(buggyPassed / passed.length)}); sends ${test.length - passed.length} to review, catching ${bugs - buggyPassed} bugs (${pct((bugs - buggyPassed) / bugs)})`);
  }
}
console.log("");

const rand = mulberry32(7);
console.log("\npaired bootstrap of the AUC difference (test commits resampled together):");
for (const [a, b] of [["calibrated + llm", "calibrated"], ["calibrated + snippets", "calibrated"], ["calibrated + llm + snippets", "calibrated + llm"]] as const) {
  const d: number[] = [];
  for (let i = 0; i < BOOTSTRAP; i++) {
    const idx = Array.from({ length: y.length }, () => Math.floor(rand() * y.length));
    const yy = idx.map((j) => y[j]!);
    d.push(aucOf(idx.map((j) => scores[a]![j]!), yy)! - aucOf(idx.map((j) => scores[b]![j]!), yy)!);
  }
  d.sort((p, q) => p - q);
  const mean = d.reduce((s, x) => s + x, 0) / d.length;
  const se = Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / (d.length - 1));
  const n = (delta: number) => Math.ceil(y.length * ((Z * se) / delta) ** 2);
  console.log(`  ${a} − ${b}: ${mean >= 0 ? "+" : ""}${mean.toFixed(3)} (95 % CI ${d[Math.floor(d.length * 0.025)]!.toFixed(3)} to ${d[Math.floor(d.length * 0.975)]!.toFixed(3)}), SE ${se.toFixed(4)}; test commits for 80 % power: +0.02 → ${n(0.02)}, +0.03 → ${n(0.03)}`);
}

const wilson = (k: number, n: number) => {
  const p = k / n, z = 1.96, c = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return `${((c - h) * 100).toFixed(1)}–${((c + h) * 100).toFixed(1)} %`;
};
console.log("\nrequireSafe gate on the test sample:");
for (const minConfidence of [6, 8, 9]) {
  const pass = test.filter((r) => {
    const j = judged.get(r.sha);
    return !j.truncated && j.unclassified.length === 0 && j.hunks.every((h: any) => h.safe && h.confidence >= minConfidence);
  });
  const k = pass.filter((r) => r.label).length;
  console.log(`  minConfidence ${minConfidence}: ${pass.length} pass (${((pass.length / test.length) * 100).toFixed(1)} %), ${k} buggy (${((k / pass.length) * 100).toFixed(1)} %, Wilson 95 % ${wilson(k, pass.length)})`);
}
console.log("\nbuggy rate by riskySnippets count (test sample):");
for (const n of [0, 1, 2, 3, 4, 5]) {
  const group = test.filter((r) => Math.min(judged.get(r.sha).riskySnippets.length, 5) === n);
  if (group.length) console.log(`  ${n}${n === 5 ? "+" : ""}: ${group.length} commits, ${((group.filter((r) => r.label).length / group.length) * 100).toFixed(1)} % buggy`);
}
