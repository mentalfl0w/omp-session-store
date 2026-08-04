/**
 * session-store — OMP extension entry point.
 *
 * Registers a custom "session_search" tool that lets the agent search
 * offline / completed / archived sessions — the ones that history://
 * cannot reach.
 *
 * Returns structured JSON in the tool result text. The agent can parse
 * it directly; no need to read .jsonl files separately.
 *
 * Three search modes:
 *   keyword — FTS5 over history.db (fast, user prompts + summaries)
 *   content — ripgrep + JSONL parse (full conversation text)
 *   list    — threads table (browse by project/time)
 *
 * All external commands (sqlite3, rg) run via pi.exec — zero native deps.
 * Works in RPC mode (hasUI=false) and TUI mode alike.
 */

import type { ExtensionAPI, ExtensionCtx, AgentToolResult, SearchParams, SessionMatch } from "./types";
import { searchKeyword, searchContent, listSessions } from "./search";

export default function sessionStore(pi: ExtensionAPI): void {
  const z = pi.zod;

  pi.registerTool({
    name: "session_search",
    label: "Session Store",
    description:
      "Search past/offline/completed OMP sessions by keyword, content, or list them. " +
      "Returns structured JSON: session_id, project, time, title, summary, snippet, path, message_count. " +
      "Works with sessions that history:// cannot reach (offline/completed/archived). " +
      "No TUI needed — fully functional in RPC mode.\n\n" +
      "Modes:\n" +
      "  keyword — fast FTS5 search over session prompts + summaries\n" +
      "  content — full-text search over session .jsonl transcripts (slower but exhaustive)\n" +
      "  list    — list sessions by project and/or time range\n\n" +
      "Time format: '2026-07-30' (date), '2026-07-30T17:30:00+08:00' (ISO), '3d'/'6h'/'2w' (relative).",

    parameters: z.object({
      action: z.enum(["keyword", "content", "list"]).describe(
        "keyword: fast FTS5 search over session prompts + summaries; " +
        "content: full-text search over session .jsonl transcripts; " +
        "list: list sessions by project/date"
      ),
      query: z.string().optional().describe(
        "Search query (required for keyword/content). Supports plain text matching."
      ),
      project: z.string().optional().describe(
        "Filter by project name or path substring (e.g. 'ChordAuditMatrix')"
      ),
      since: z.string().optional().describe(
        "Lower time bound: '2026-07-30' or '2026-07-30T17:00:00+08:00' or '3d' (3 days ago)"
      ),
      until: z.string().optional().describe(
        "Upper time bound: same format as since"
      ),
      limit: z.number().optional().describe(
        "Max results (default 10)"
      ),
    }),

    approval: "auto",

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionCtx): Promise<AgentToolResult> {
      const p = params as SearchParams;
      const limit = p.limit ?? 10;

      if ((p.action === "keyword" || p.action === "content") && !p.query?.trim()) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "query is required for keyword/content action" }) }],
          isError: true,
        };
      }

      let results: SessionMatch[];
      try {
        if (p.action === "keyword") {
          results = await searchKeyword(pi, p.query!, p.since, p.until, limit);
        } else if (p.action === "content") {
          results = await searchContent(pi, p.query!, p.project, p.since, p.until, limit);
        } else {
          results = await listSessions(pi, p.project, p.since, p.until, limit);
        }
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: `Search failed: ${(err as Error).message}`,
              action: p.action,
              query: p.query,
              project: p.project,
              since: p.since,
              until: p.until,
            }, null, 2),
          }],
          isError: true,
        };
      }

      if (results.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message: "No sessions found matching the criteria",
              action: p.action,
              query: p.query,
              project: p.project,
              since: p.since,
              until: p.until,
              results: [],
            }, null, 2),
          }],
        };
      }

      const output = {
        action: p.action,
        query: p.query,
        project: p.project,
        since: p.since,
        until: p.until,
        total: results.length,
        results: results.map((r) => ({
          session_id: r.session_id,
          project: r.project,
          cwd: r.cwd,
          time: r.time,
          title: r.title,
          summary: r.summary.slice(0, 300),
          snippet: r.snippet.slice(0, 500),
          path: r.path,
          message_count: r.message_count,
          resume_hint: `omp --resume ${r.session_id}`,
        })),
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify(output, null, 2),
        }],
      };
    },
  });
}
