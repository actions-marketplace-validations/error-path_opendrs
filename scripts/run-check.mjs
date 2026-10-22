#!/usr/bin/env node
// `npm run check`'s full gate: typecheck, then the fast test tier, then the slow test tier.
// Kept as separate sequential steps (not shell `&&`) so each still reports its own
// .dev-metrics/runs.jsonl entry via its own npm script. CI runs the same three steps
// (see .github/workflows/ci.yml) so `check` and CI always cover the same tests.
import { spawnSync } from "node:child_process";

const steps = [
  ["npm", ["run", "typecheck"]],
  ["npm", ["run", "test"]],
  ["npm", ["run", "test:slow"]],
];

for (const [cmd, args] of steps) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
