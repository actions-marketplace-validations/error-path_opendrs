import type { Signal, SignalProvider } from "../domain/types.js";
import { countedFiles, historyAvailable, historyPath, plural, shallowAware, topEvidence, unknown } from "./util.js";

/** Spec §4 "diffusion.*" signals. */
export const diffusionSignals: SignalProvider = async (ctx) => {
  const files = countedFiles(ctx);

  const dirs = [...new Set(files.map((f) => topDir(f.path)))];
  const dirSignal: Signal = {
    id: "diffusion.dirs",
    value: Math.log1p(dirs.length),
    status: "observed",
    summary: `${plural(dirs.length, "directory", "directories")} touched` + (dirs.length ? `: ${dirs.slice(0, 5).join(", ")}` : ""),
    evidence: [],
  };

  let authorSignal: Signal;
  if (!historyAvailable(ctx)) {
    authorSignal = unknown("diffusion.authors", "no commit history before this change");
  } else {
    const all = new Set<string>();
    const perFile = files.map((f) => {
      const emails = new Set(ctx.history.fileCommits(historyPath(f), ctx.asOf).map((c) => c.authorEmail.toLowerCase()));
      for (const e of emails) all.add(e);
      return { file: f.path, detail: `${plural(emails.size, "author")} in history`, n: emails.size };
    });
    authorSignal = shallowAware(ctx, {
      id: "diffusion.authors",
      value: Math.log1p(all.size),
      status: "derived",
      summary: `${plural(all.size, "distinct author")} have touched these files`,
      evidence: topEvidence(perFile.filter((e) => e.n > 0).sort((a, b) => b.n - a.n).map(({ file, detail }) => ({ file, detail }))),
    });
  }

  return [
    {
      id: "diffusion.files",
      value: Math.log1p(files.length),
      status: "observed",
      summary: `${plural(files.length, "file")} changed`,
      evidence: [],
    },
    dirSignal,
    authorSignal,
  ];
};

/** First two directory levels of a path; "." for files at the repo root. */
function topDir(path: string): string {
  const parts = path.split("/").slice(0, -1);
  return parts.length ? parts.slice(0, 2).join("/") : ".";
}
