import type { ScoringContext, Signal, SignalProvider } from "../domain/types.js";
import { countedFiles, historyAvailable, historyPath, plural, topEvidence, unknown } from "./util.js";

/** Spec §4 "expertise.*" signals. */
export const expertiseSignals: SignalProvider = async (ctx) => {
  const email = ctx.diff.author?.email.toLowerCase();
  if (!email) {
    const why = "author email unknown for the head commit";
    return [unknown("expertise.author_commits", why), unknown("expertise.owner_ratio", why)];
  }
  if (!historyAvailable(ctx)) {
    const why = "no commit history before this change";
    return [unknown("expertise.author_commits", why), unknown("expertise.owner_ratio", why)];
  }

  const prior = ctx.history.authorCommitCount(email, ctx.asOf);
  const authorCommits: Signal = {
    id: "expertise.author_commits",
    value: Math.log1p(prior),
    status: "derived",
    summary: `${email} has ${plural(prior, "prior commit")} in this repo`,
    evidence: [],
  };
  return [authorCommits, ownerRatio(ctx, email)];
};

function ownerRatio(ctx: ScoringContext, email: string): Signal {
  const id = "expertise.owner_ratio";
  const existing = countedFiles(ctx).filter((f) => f.status !== "added");
  if (existing.length === 0) return { id, value: 0, status: "derived", summary: "no pre-existing files changed", evidence: [] };

  const owned = existing.flatMap((f) => {
    const path = historyPath(f);
    if (ctx.history.fileCreator(path, ctx.asOf) === email) return [{ file: f.path, detail: "author created this file" }];
    const commits = ctx.history.fileCommits(path, ctx.asOf);
    const mine = commits.filter((c) => c.authorEmail.toLowerCase() === email).length;
    return mine * 2 > commits.length ? [{ file: f.path, detail: `author made ${mine} of ${commits.length} commits` }] : [];
  });
  return {
    id,
    value: owned.length / existing.length,
    status: "derived",
    summary: `author created or mostly wrote ${owned.length} of ${plural(existing.length, "pre-existing changed file")}`,
    evidence: topEvidence(owned),
  };
}
