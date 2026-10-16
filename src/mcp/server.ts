import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { VERSION } from "../version.js";
import { explainFileRiskTool, listHotspotsTool, scoreDiffTool, suggestReviewersTool } from "./tools.js";

const repoDir = z.string().min(1).describe("Absolute path to the git repository (any directory inside the work tree).");

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "opendrs", version: VERSION });

  server.registerTool(
    "score_diff",
    {
      title: "Score diff risk",
      description:
        "Compute the opendrs Diff Risk Score (0-1, calibrated probability that the change causes an incident) for the changes between two git refs. " +
        "Returns the score, tier (green/yellow/red), the gate decision and its reasons, the top contributing signals with evidence, " +
        "signals that could not be computed (unknowns), suggested reviewers, and the LLM judge's rationale when enabled. " +
        "Use it before opening a pull request, or to decide whether a change should be split.",
      inputSchema: {
        repoDir,
        base: z.string().min(1).optional().describe('Base ref to diff against. Defaults to "origin/HEAD", or "main" when that is not set.'),
        head: z.string().min(1).optional().describe('Head ref to score. Defaults to "HEAD".'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => scoreDiffTool(args),
  );

  server.registerTool(
    "explain_file_risk",
    {
      title: "Explain file risk",
      description:
        "Show the standing risk profile of one file at HEAD: commit and bug-fix history, number of authors, direct and transitive dependents " +
        "(blast radius; null when the language is not supported), whether it is on a critical or blocked path, and its top authors. " +
        "Use it before editing a file you do not know, or to explain a high blast.dependents contribution.",
      inputSchema: {
        repoDir,
        path: z.string().min(1).describe("Repo-relative file path with forward slashes, e.g. src/auth/session.ts."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => explainFileRiskTool(args),
  );

  server.registerTool(
    "list_hotspots",
    {
      title: "List hotspots",
      description:
        "Rank the files tracked at HEAD by code-at-rest risk: bug-fix commits, commits and authors in the history lookback window, " +
        "transitive dependents in the import graph (null when the language is not supported), and critical or blocked path flags. " +
        "Use it to find where a codebase is most likely to break, or to pick files for reengineering or extra test coverage.",
      inputSchema: {
        repoDir,
        top: z.number().int().positive().optional().describe("How many files to return. Defaults to 20."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => listHotspotsTool(args),
  );

  server.registerTool(
    "suggest_reviewers",
    {
      title: "Suggest reviewers",
      description:
        "Suggest up to three reviewers (author emails) for a set of files, ranked by how often they recently changed them in git history. " +
        "Use it to pick human reviewers for a risky change.",
      inputSchema: {
        repoDir,
        paths: z.array(z.string().min(1)).min(1).describe("Repo-relative file paths the change touches."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => suggestReviewersTool(args),
  );

  return server;
}

/** `opendrs mcp`: serve the tools over stdio until the client disconnects. */
export async function runMcpServer(): Promise<void> {
  await createMcpServer().connect(new StdioServerTransport());
}
