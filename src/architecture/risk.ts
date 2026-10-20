import type { ArchitectureFact, ChangedFile, ScoringContext } from "../domain/types.js";
import { changedLines } from "../git/diff.js";
import { code } from "../report/escape.js";
import { isCodeFamily, languageFamily } from "../signals/language.js";
import { isTestPath } from "../signals/tests.js";
import { plural } from "../signals/util.js";
import type { Detector } from "./index.js";

/**
 * Error handling, null checks, assertions and precondition helpers: code that rejects bad states.
 * Copied verbatim from the archived review-heuristics patch
 * (bench/apachejit/archive/2026-10-18-review-signals.patch), which the 2026-10-19 captain-fact-lift
 * experiment (docs/experiments.md, "Captain-fact lift on ApacheJIT") measured at 1.788x lift on
 * 5,127 of 24,690 ApacheJIT test commits.
 */
const SAFETY =
  /\b(catch|except|rescue|finally)\b|\bthrow\b(?!s)|\braise\b|\bassert\b|[!=]==?\s*(null|nil|None|undefined)\b|\b(null|nil|None|undefined)\s*[!=]==?|\bis (not )?None\b|\bcheck(Argument|State|NotNull|Index|ElementIndex|PositionIndex)\s*\(|\brequireNonNull\s*\(|\bValidate\.\w+\s*\(/;

/**
 * Locks, atomics, executors and thread or goroutine primitives (not async/await, which is
 * everywhere in JS). The Java/Go/Rust/Python-oriented base is copied verbatim from the archived
 * review-heuristics patch (bench/apachejit/archive/2026-10-18-review-signals.patch), which the
 * 2026-10-19 captain-fact-lift experiment measured at 2.036x lift on 3,196 of 24,690 ApacheJIT test
 * commits. The trailing alternatives (`new Worker(`, `Atomics.`, `SharedArrayBuffer`,
 * `DispatchQueue`, `actor <Name>`, `async let`, `Task {`) are this change's own addition: the
 * obvious TS/JS and Swift equivalents, not part of the measured regex.
 */
const CONCURRENCY =
  /\b(synchronized|volatile|ReentrantLock|ReadWriteLock|ReentrantReadWriteLock|StampedLock|Semaphore|CountDownLatch|CyclicBarrier|Phaser|ExecutorService|Executors|ThreadPoolExecutor|ForkJoinPool|CompletableFuture|ConcurrentHashMap|ConcurrentLinkedQueue|BlockingQueue|ThreadLocal|Atomic(Integer|Long|Boolean|Reference)\w*|Mutex|RwLock|RWMutex|WaitGroup|threading|multiprocessing)\b|\bnew Thread\b|\bThread\.(sleep|start|interrupt|yield)\b|\.(wait|notify|notifyAll|lock|unlock|tryLock)\s*\(|\bgo func\b|\bnew Worker\s*\(|\bAtomics\.|\bSharedArrayBuffer\b|\bDispatchQueue\b|\bactor\s+[A-Za-z_]|\basync let\b|\bTask\s*\{/;

/** A whole-line comment in any of the supported syntaxes; such lines are never counted. Copied verbatim from the archived patch. */
const isComment = (text: string): boolean => /^\s*(\/\/|#|\/\*|\*)/.test(text);

function locate(file: string, line: number | undefined): string {
  return line === undefined ? file : `${file}:${line}`;
}

/** Non-test code files: these facts read program code only (same scope as the archived signals). */
function codeFiles(ctx: ScoringContext): ChangedFile[] {
  return ctx.diff.files.filter((f) => !f.ignored && !f.binary && isCodeFamily(languageFamily(f.path)) && !isTestPath(ctx.config, f.path));
}

/** The first changed, non-comment line in `f` that matches CONCURRENCY, if any. */
function firstConcurrencyMatch(f: ChangedFile): { line: number; primitive: string } | undefined {
  for (const h of f.hunks) {
    for (const { line, text } of changedLines(h)) {
      if (isComment(text)) continue;
      const m = CONCURRENCY.exec(text);
      if (m) return { line, primitive: m[0] };
    }
  }
  return undefined;
}

/**
 * Spec: deterministic captain facts from AI code reviewers' checklists (research R4-R6), measured
 * on ApacheJIT (docs/experiments.md, "Captain-fact lift on ApacheJIT") rather than assumed:
 *
 * - "change.concurrency" (strong, 2.036x lift, fires on 13% of test commits): a changed,
 *   non-comment line of non-test code uses a concurrency primitive. One fact per file, at the
 *   file's first matching line.
 * - "change.safety_removed" (info, 1.79x lift, fires on 21% of test commits — too common for
 *   "strong" without pushing most PRs to careful review): net deleted error-handling/guard lines,
 *   per hunk, across every non-test code file. One fact for the whole PR, located at the first
 *   deleted line.
 */
export const detectRisk: Detector = async (ctx) => {
  const files = codeFiles(ctx);
  const facts: ArchitectureFact[] = [];

  for (const f of files) {
    const match = firstConcurrencyMatch(f);
    if (!match) continue;
    facts.push({
      id: "change.concurrency",
      weight: "strong",
      file: f.path,
      line: match.line,
      text: `Changes concurrency code: ${code(match.primitive)} (${code(locate(f.path, match.line))}).`,
    });
  }

  const removed: Array<{ file: string; line: number }> = [];
  for (const f of files) {
    for (const h of f.hunks) {
      const deleted: Array<{ file: string; line: number }> = [];
      let added = 0;
      for (const { kind, line, text } of changedLines(h)) {
        if (isComment(text) || !SAFETY.test(text)) continue;
        if (kind === "-") deleted.push({ file: f.path, line });
        else added++;
      }
      removed.push(...deleted.slice(0, Math.max(0, deleted.length - added)));
    }
  }
  if (removed.length > 0) {
    const first = removed[0]!;
    facts.push({
      id: "change.safety_removed",
      weight: "info",
      file: first.file,
      line: first.line,
      text: `Removes ${plural(removed.length, "error-handling or guard line")} (${code(locate(first.file, first.line))}).`,
    });
  }

  return { facts, notes: [] };
};
