import type { ChangedFile, SignalProvider } from "../domain/types.js";
import { matchAny } from "../git/glob.js";
import { isCodeFamily, languageFamily } from "./language.js";
import { countedFiles, plural, topEvidence } from "./util.js";

/** Test lines a change needs, as a share of its source lines, before the penalty is gone. */
const EXPECTED_TEST_SHARE = 0.3;

/**
 * Spec §4 "tests.missing": 1 when source changed and no test lines did; otherwise
 * max(0, 1 − testLines / (0.3 · sourceLines)), so a token test edit barely helps.
 */
export const testsSignals: SignalProvider = async (ctx) => {
  const files = countedFiles(ctx);
  const isTest = (path: string) => matchAny(ctx.config.paths.tests, path);
  const lines = (fs: ChangedFile[]) => fs.reduce((n, f) => n + f.added + f.deleted, 0);
  const tests = files.filter((f) => isTest(f.path));
  const sources = files.filter((f) => !f.binary && !isTest(f.path) && isCodeFamily(languageFamily(f.path)));
  const testLines = lines(tests);
  const sourceLines = lines(sources);

  let value: number;
  let summary: string;
  if (sources.length === 0) {
    value = 0;
    summary = "no source code changed";
  } else if (testLines === 0) {
    value = 1;
    summary = `${plural(sources.length, "source file")} changed with no test changes`;
  } else {
    value = Math.min(1, Math.max(0, 1 - testLines / (EXPECTED_TEST_SHARE * sourceLines)));
    summary = `${plural(testLines, "test line")} changed for ${plural(sourceLines, "source line")} (${EXPECTED_TEST_SHARE * 100}% expected)`;
  }

  const untested = sources.length > 0 && testLines === 0;
  return [
    {
      id: "tests.missing",
      value,
      status: "derived",
      summary,
      evidence: topEvidence(
        untested
          ? sources.map((f) => ({ file: f.path, detail: "source without test change" }))
          : tests.map((f) => ({ file: f.path, detail: `test file changed (+${f.added} -${f.deleted})` })),
      ),
    },
  ];
};
