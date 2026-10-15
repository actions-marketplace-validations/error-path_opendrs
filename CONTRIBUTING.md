# Contributing

## Setup

Node 22 or newer.

```sh
npm ci
npm run check        # typecheck + tests
```

## Layout

Dependencies point inward: `domain` ← `git`, `graph`, `llm` ← `signals` ← `model`, `policy` ←
`engine` ← `cli`, `mcp`, `action`. Shared types live in `src/domain/types.ts`; changing one is an
interface change, so update `docs/specs/` in the same PR. Adapters (CLI, MCP, Action) hold no
scoring logic.

## Rules

- No new runtime dependencies without discussion. GitHub and LLM calls use plain `fetch`.
- TypeScript strict, ESM, imports with `.js` suffixes. Small files with one job.
- Tests first. Most tests build real temporary git repositories with `tests/helpers/repo.ts`.
- Every signal reports its provenance and evidence. A value that cannot be computed is `unknown`,
  never zero.
- If you change anything under `src/` that the Action uses, run `npm run build:action` and commit
  `action/dist`. CI fails when the bundle is out of date.
- Conventional Commit messages (`feat(cli): ...`, `fix(action): ...`).
- Docs: plain, specific sentences. Say what a thing does and what it does not.

## Reporting a security problem

Do not open a public issue for a way around the Action's approval rails. Use GitHub's private
vulnerability reporting on this repository.
