import { sortFacts } from "../architecture/index.js";
import { OpendrsError, type ArchitectureFact, type Hunk, type LlmProvider, type ReviewBrief, type ScoringContext, type Verification, type VerifyCandidate, type VerifyStatus } from "../domain/types.js";
import { gitMaybe } from "../git/exec.js";
import { hunkText } from "../llm/prompt.js";
import { buildVerifyMessages, verifyPromptHash } from "../llm/verify.js";
import { estimateTokens } from "./budget.js";
import { shortenWhy } from "./build.js";
import { FACTS_FILE, factHash, parseFactMemory, type FactVerdict } from "./facts-memory.js";
import { checkId, factIds, hunkId } from "./selfcheck.js";

/** Per candidate: enough of a hunk (or a partner file) to judge it by, never the whole diff (verification spec §3.2). */
const MAX_EXCERPT = 2000;

type VerificationMeta = NonNullable<ReviewBrief["verification"]>;

const unverified = (status: VerifyStatus): Verification => ({ action: "keep", status, source: "unverified" });

/** The hunk of `file` holding new line `line`, else the file's first hunk, else nothing (not in the diff). */
function hunkOf(ctx: ScoringContext, file: string, line: number | undefined): Hunk | undefined {
  const f = ctx.diff.files.find((f) => f.path === file);
  if (!f || line === undefined) return f?.hunks[0];
  return f.hunks.find((h) => line >= h.newStart && line < h.newStart + Math.max(h.newLines, 1)) ?? f.hunks[0];
}

const excerptOf = (h: Hunk | undefined) => (h ? hunkText(h).slice(0, MAX_EXCERPT) : "");

/**
 * Verification spec §3.9: pre_existing when every non-blank added line already occurs verbatim in
 * the file at base, else new. A pure deletion or a new file introduces its change, so it is new.
 */
function statusOf(h: Hunk | undefined, baseLines: Set<string> | undefined): VerifyStatus {
  if (!h || !baseLines) return "new";
  const added = h.lines.filter((l) => l.startsWith("+")).map((l) => l.slice(1)).filter((l) => l.trim() !== "");
  return added.length > 0 && added.every((l) => baseLines.has(l)) ? "pre_existing" : "new";
}

/** Facts, shown hunks and checks with Phase 1's ids, in the brief's order, each with its excerpt and deterministic status. */
export async function collectCandidates(brief: ReviewBrief, ctx: ScoringContext): Promise<{ candidates: VerifyCandidate[]; partners: Record<string, string> }> {
  const baseCache = new Map<string, Promise<string | undefined>>();
  const readBase = (path: string) => {
    let text = baseCache.get(path);
    if (!text) baseCache.set(path, (text = ctx.readBase(path)));
    return text;
  };
  const baseLines = async (path: string) => {
    const text = await readBase(path);
    return text === undefined ? undefined : new Set(text.split("\n"));
  };

  const candidates: VerifyCandidate[] = [];
  const partners: Record<string, string> = {};
  const facts = brief.captain?.facts ?? [];
  const factCandidateIds = factIds(facts);
  for (const [i, fact] of facts.entries()) {
    const id = factCandidateIds[i]!;
    // Captain facts are new by construction; coupling.missing has no new/pre-existing axis (spec §3.3).
    candidates.push({ id, kind: "fact", file: fact.file, line: fact.line, text: fact.text, excerpt: excerptOf(hunkOf(ctx, fact.file, fact.line)), status: fact.id === "coupling.missing" ? "unknown" : "new" });
    if (fact.id !== "coupling.missing") continue;
    // The partner is the first backticked path that is not the firing file (class D needs both sides, spec §3.8).
    const partner = [...fact.text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!).find((p) => p !== fact.file);
    const text = partner === undefined ? undefined : await readBase(partner);
    if (text !== undefined) partners[id] = text.slice(0, MAX_EXCERPT);
  }
  for (const file of brief.reviewFirst) {
    const changed = ctx.diff.files.find((f) => f.path === file.file);
    const lines = await baseLines(file.file);
    for (const hunk of file.hunks) {
      const h = changed?.hunks.find((x) => x.newStart === hunk.newStart && x.oldStart === hunk.oldStart);
      candidates.push({ id: hunkId(file.file, hunk.id), kind: "hunk", file: file.file, line: hunk.newStart, text: hunk.reasons.map((r) => r.text).join("; ") || `hunk ${hunk.id}`, excerpt: excerptOf(h), status: statusOf(h, lines) });
    }
  }
  const seenAt = new Map<string, number>();
  for (const check of brief.checks) {
    const key = `${check.file}:${check.line ?? "-"}`;
    const index = seenAt.get(key) ?? 0;
    seenAt.set(key, index + 1);
    const h = hunkOf(ctx, check.file, check.line);
    candidates.push({ id: checkId(check.file, check.line, index), kind: "check", file: check.file, line: check.line, text: check.question, excerpt: excerptOf(h), status: statusOf(h, await baseLines(check.file)) });
  }
  return { candidates, partners };
}

/**
 * Rewrite the brief from final verdicts (verification spec §3.5, §3.9): a drop removes the item and
 * leaves a note, a downgrade demotes it (fact to info, hunk and check to the end), everything that
 * survives carries its verification. `captain.why` follows the surviving facts; `captain.priority`
 * is never touched (spec §3.4). An id without a verdict counts as unverified.
 */
export function applyVerification(brief: ReviewBrief, verdicts: Map<string, Verification>, meta: VerificationMeta): ReviewBrief {
  const notes = [...brief.notes];
  const dropped: VerificationMeta["dropped"] = [];
  const all: Record<string, Verification> = {};
  const decide = (id: string): Verification => (all[id] = verdicts.get(id) ?? unverified("unknown"));
  const drop = (id: string, v: Verification) => {
    dropped.push({ id, droppedClass: v.droppedClass!, reason: v.reason ?? "" });
    notes.push(`dropped by verifier: ${v.droppedClass} — ${v.reason} (${id})`);
  };

  let captain = brief.captain;
  if (captain) {
    const facts: ArchitectureFact[] = [];
    const ids = factIds(captain.facts);
    for (const [i, f] of captain.facts.entries()) {
      const id = ids[i]!;
      const v = decide(id);
      if (v.action === "drop") drop(id, v);
      else facts.push({ ...f, ...(v.action === "downgrade" ? { weight: "info" as const } : {}), verification: v });
    }
    const sorted = sortFacts(facts);
    captain = { ...captain, facts: sorted, why: sorted.slice(0, 2).map(shortenWhy) };
  }

  // A downgraded hunk stops counting toward its file, so files re-sort by their remaining hunks (score, then path).
  const files = brief.reviewFirst.flatMap((f) => {
    const kept: typeof f.hunks = [];
    const down: typeof f.hunks = [];
    for (const h of f.hunks) {
      const id = hunkId(f.file, h.id);
      const v = decide(id);
      if (v.action === "drop") drop(id, v);
      else (v.action === "downgrade" ? down : kept).push({ ...h, verification: v });
    }
    const hunks = [...kept, ...down];
    return hunks.length === 0 ? [] : [{ entry: { ...f, hunks }, score: Math.max(0, ...kept.map((h) => h.score)) }];
  });
  const reviewFirst = files.sort((a, b) => b.score - a.score || a.entry.file.localeCompare(b.entry.file)).map((x) => x.entry);

  const seenAt = new Map<string, number>();
  const kept: ReviewBrief["checks"] = [];
  const down: ReviewBrief["checks"] = [];
  for (const c of brief.checks) {
    const key = `${c.file}:${c.line ?? "-"}`;
    const index = seenAt.get(key) ?? 0;
    seenAt.set(key, index + 1);
    const id = checkId(c.file, c.line, index);
    const v = decide(id);
    if (v.action === "drop") drop(id, v);
    else (v.action === "downgrade" ? down : kept).push({ ...c, verification: v });
  }

  return { ...brief, reviewFirst, checks: [...kept, ...down], notes, captain, verification: { ...meta, verdicts: all, dropped } };
}

/**
 * The verification pass (verification spec §3.4): dismissal memory from base, then the risk-depth
 * and token-cap skips, then one batched provider call. Any error fails open: nothing is dropped or
 * downgraded by the model, every candidate renders [unverified], one note says why.
 */
export async function verifyBrief(brief: ReviewBrief, ctx: ScoringContext, provider: LlmProvider): Promise<ReviewBrief> {
  const meta: VerificationMeta = { outcome: "verified", model: ctx.config.llm.model, promptHash: verifyPromptHash(), verdicts: {}, dropped: [] };
  const verdicts = new Map<string, Verification>();
  let candidates: VerifyCandidate[] = [];
  const finish = (line: string, extra: Partial<VerificationMeta>) => {
    for (const c of candidates) if (!verdicts.has(c.id)) verdicts.set(c.id, unverified(c.status));
    return applyVerification({ ...brief, notes: [...brief.notes, line] }, verdicts, { ...meta, ...extra });
  };
  const skip = (note: string) => finish(`verifier skipped: ${note}`, { outcome: "skipped", note });

  try {
    const collected = await collectCandidates(brief, ctx);
    candidates = collected.candidates;

    // (1) From the base commit, like incidents: a PR cannot dismiss its own facts (spec §3.9).
    const memory = new Map<string, FactVerdict>();
    const text = await gitMaybe(ctx.repoDir, ["show", `${ctx.diff.base}:${FACTS_FILE}`]);
    if (text !== undefined) for (const e of parseFactMemory(text)) memory.set(e.hash, e.verdict);
    const captainFacts = brief.captain?.facts ?? [];
    const facts = new Map(factIds(captainFacts).map((id, i) => [id, captainFacts[i]!]));
    const pinned = new Set<string>();
    const toAsk = candidates.filter((c) => {
      const fact = c.kind === "fact" ? facts.get(c.id) : undefined;
      const remembered = fact && memory.get(factHash(fact));
      if (remembered === "useful") pinned.add(c.id);
      else if (remembered) {
        verdicts.set(c.id, { action: "downgrade", status: c.status, reason: `dismissed earlier as ${remembered}`, source: "memory" });
        return false;
      }
      return true;
    });

    // (2) Depth follows risk (spec §3.4): a quick confirm with only info facts is not worth a call.
    const strong = (brief.captain?.facts ?? []).some((f) => f.weight === "strong");
    if (brief.captain?.priority === "quick" && !strong && brief.reviewFirst.length === 0 && brief.checks.length === 0) return skip("quick-confirm PR with only info facts");
    if (toAsk.length === 0) return skip("nothing to verify");

    // (3) Per-PR token cap on the estimated prompt (spec §3.9).
    const input = { title: ctx.diff.title, candidates: toAsk, partners: collected.partners };
    const { system, user } = buildVerifyMessages(input);
    const tokens = estimateTokens(system + user);
    if (tokens > ctx.config.llm.verify.maxTokens) return skip(`prompt of ${tokens} tokens exceeds llm.verify.maxTokens (${ctx.config.llm.verify.maxTokens})`);

    // (4) One batched call; the parser already enforced the drop/downgrade/keep rules on each verdict.
    if (!provider.verify) throw new OpendrsError(`LLM provider ${provider.name} does not implement verify`, "llm");
    const { verdicts: answers, usage } = await provider.verify(input);
    const byId = new Map(answers.map((a) => [a.id, a]));
    for (const c of toAsk) {
      const a = byId.get(c.id);
      if (!a) continue;
      // A fact pinned useful can never be dropped or downgraded (spec §3.9).
      const action = pinned.has(c.id) ? "keep" : a.action;
      verdicts.set(c.id, {
        action,
        status: a.status,
        reason: a.reason,
        ...(a.citedLine ? { citedLine: a.citedLine } : {}),
        ...(action === "drop" && a.droppedClass ? { droppedClass: a.droppedClass } : {}),
        source: "verifier",
      });
    }
    return finish(`verifier: ${meta.model} · prompt ${meta.promptHash} · ${usage.inputTokens}+${usage.outputTokens} tokens`, { outcome: "verified", usage });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return finish(`verifier failed: ${reason}; everything below is unverified`, { outcome: "failed", note: reason });
  }
}
