import type { SignalProvider } from "../domain/types.js";
import { matchAny } from "../git/glob.js";
import { isCodeFamily, languageFamily } from "./language.js";
import { countedFiles, plural, topEvidence } from "./util.js";

/** Spec §4 "tests.missing": source code changed and no test file changed. */
export const testsSignals: SignalProvider = async (ctx) => {
  const files = countedFiles(ctx);
  const isTest = (path: string) => matchAny(ctx.config.paths.tests, path);
  const tests = files.filter((f) => isTest(f.path));
  const sources = files.filter((f) => !f.binary && !isTest(f.path) && isCodeFamily(languageFamily(f.path)));
  const missing = sources.length > 0 && tests.length === 0;

  let summary: string;
  if (sources.length === 0) summary = "no source code changed";
  else if (missing) summary = `${plural(sources.length, "source file")} changed with no test changes`;
  else summary = `${plural(tests.length, "test file")} changed alongside ${plural(sources.length, "source file")}`;

  return [
    {
      id: "tests.missing",
      value: missing ? 1 : 0,
      status: "derived",
      summary,
      evidence: topEvidence((missing ? sources : tests).map((f) => ({ file: f.path, detail: missing ? "source without test change" : "test file changed" }))),
    },
  ];
};
