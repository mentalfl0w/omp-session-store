/**
 * session-store — search engines.
 *
 * Three search modes:
 *   keyword — FTS5 over history.db (fast, user prompts only)
 *   content — ripgrep + JSONL parse over .jsonl transcripts (full text)
 *   list    — threads table + directory scan (browsing)
 *
 * SQLite access via bun:sqlite — built into the OMP Bun runtime, zero deps.
 * No external sqlite3 CLI, no better-sqlite3, no system bun required.
 *
 * Data sources (~/.omp/agent/):
 *   history.db  → history_fts (FTS5 index of user prompts)
 *   agent.db    → threads (session registry) + stage1_outputs (summaries)
 *   sessions/   → <encoded-cwd>/*.jsonl (full transcripts)
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { readdirSync, existsSync } from "node:fs";
import type { ExtensionAPI } from "../types";
import { parseTime, formatTime } from "../time";
import { parseSessionFile, searchInSession, fileMtime, countMessages } from "../parse";
import type { SessionMatch } from "../types";

const OMP_DIR = join(homedir(), ".omp", "agent");
const SESSIONS_DIR = join(OMP_DIR, "sessions");
const HISTORY_DB = join(homedir(), ".omp", "agent", "history.db");
const AGENT_DB = join(homedir(), ".omp", "agent", "agent.db");

function projectFromCwd(cwd: string): string {
  if (!cwd) return "(unknown)";
  const parts = cwd.replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}

// ── SQLite via bun:sqlite (built into OMP's Bun runtime) ───────────

/** bun:sqlite Database — lazily required so the module resolves inside OMP. */
let DbCtor: ReturnType<typeof require> | null = null;

function getDb(path: string): { prepare: (sql: string) => { all: (params: Record<string, unknown>) => unknown[] } } {
  if (!DbCtor) {
    // bun:sqlite is built into the Bun runtime that OMP is compiled from.
    // This works without a system bun install — OMP embeds the runtime.
    const mod = require("bun:sqlite");
    DbCtor = mod.Database ?? mod.default?.Database ?? mod;
  }
  return new DbCtor(path, { readonly: true });
}

/**
 * Run a parameterized query. Params use $name binding (bun:sqlite convention).
 * Pass SQL with $name placeholders; params is a plain object { name: value }.
 */
function querySqlite(
  dbPath: string,
  sql: string,
  params: Record<string, unknown>,
): Record<string, unknown>[] {
  const db = getDb(dbPath);
  try {
    const bound: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) bound["$" + k] = v;
    return db.prepare(sql).all(bound) as Record<string, unknown>[];
  } finally {
    (db as unknown as { close: () => void }).close();
  }
}

// ── keyword: FTS5 search over user prompts + summaries ─────────────

export async function searchKeyword(
  _pi: ExtensionAPI,
  query: string,
  since?: string,
  until?: string,
  limit = 10,
): Promise<SessionMatch[]> {
  const sinceTs = parseTime(since);
  const untilTs = parseTime(until);
  const results: SessionMatch[] = [];

  // 1. FTS5 search in history.db (user prompts)
  const ftsConditions = ["fts.prompt MATCH $query"];
  const ftsParams: Record<string, unknown> = { query, limit };
  if (sinceTs) { ftsConditions.push("h.created_at >= $sinceTs"); ftsParams.sinceTs = sinceTs; }
  if (untilTs) { ftsConditions.push("h.created_at <= $untilTs"); ftsParams.untilTs = untilTs; }

  let ftsRows: Record<string, unknown>[] = [];
  try {
    ftsRows = querySqlite(
      HISTORY_DB,
      `SELECT h.session_id, h.cwd, h.created_at, h.prompt
       FROM history_fts fts
       JOIN history h ON h.id = fts.rowid
       WHERE ${ftsConditions.join(" AND ")}
       ORDER BY h.created_at DESC
       LIMIT $limit`,
      ftsParams,
    );
  } catch { /* history.db may not exist on fresh installs */ }

  // 2. Summary search in agent.db stage1_outputs
  const sumConditions = ["s.rollout_summary LIKE '%' || $query || '%'"];
  const sumParams: Record<string, unknown> = { query, limit };
  if (sinceTs) { sumConditions.push("t.updated_at >= $sinceTs"); sumParams.sinceTs = sinceTs; }
  if (untilTs) { sumConditions.push("t.updated_at <= $untilTs"); sumParams.untilTs = untilTs; }

  let summaryRows: Record<string, unknown>[] = [];
  try {
    summaryRows = querySqlite(
      AGENT_DB,
      `SELECT t.id, t.cwd, t.rollout_path, t.updated_at, s.rollout_summary, s.rollout_slug
       FROM threads t
       LEFT JOIN stage1_outputs s ON s.thread_id = t.id
       WHERE ${sumConditions.join(" AND ")}
       ORDER BY t.updated_at DESC
       LIMIT $limit`,
      sumParams,
    );
  } catch { /* stage1_outputs may not exist */ }

  // Merge & deduplicate by session_id
  const seen = new Set<string>();

  for (const row of ftsRows) {
    const sid = row.session_id as string;
    if (seen.has(sid)) continue;
    seen.add(sid);
    const cwd = (row.cwd as string) || "";
    results.push({
      session_id: sid,
      project: projectFromCwd(cwd),
      cwd,
      time: formatTime(row.created_at as number),
      title: ((row.prompt as string) || "").slice(0, 100),
      summary: "",
      snippet: ((row.prompt as string) || "").slice(0, 200),
      path: "",
      message_count: 0,
    });
  }

  for (const row of summaryRows) {
    const sid = row.id as string;
    if (seen.has(sid)) {
      const existing = results.find((r) => r.session_id === sid);
      if (existing && !existing.summary) {
        existing.summary = (row.rollout_summary as string) || "";
        existing.path = (row.rollout_path as string) || "";
      }
      continue;
    }
    seen.add(sid);
    const cwd = (row.cwd as string) || "";
    const summary = (row.rollout_summary as string) || "";
    results.push({
      session_id: sid,
      project: projectFromCwd(cwd),
      cwd,
      time: formatTime(row.updated_at as number),
      title: (row.rollout_slug as string) || summary.slice(0, 80),
      summary,
      snippet: summary.slice(0, 200),
      path: (row.rollout_path as string) || "",
      message_count: 0,
    });
  }

  return results.slice(0, limit);
}

// ── content: full-text search over .jsonl transcripts ──────────────

export async function searchContent(
  pi: ExtensionAPI,
  query: string,
  project?: string,
  since?: string,
  until?: string,
  limit = 10,
): Promise<SessionMatch[]> {
  const sinceTs = parseTime(since);
  const untilTs = parseTime(until);

  // Find matching .jsonl files via ripgrep (fast pre-filter).
  // If rg throws, fall back to direct scan.
  let matchingFiles: string[] = [];
  try {
    const searchRoot = project ? findProjectSessionDir(project) : SESSIONS_DIR;
    const rgResult = await pi.exec("rg", ["-l", "--ignore-case", query, searchRoot]);
    matchingFiles = (rgResult.stdout || "").trim().split("\n").filter(Boolean);
  } catch {
    // rg not found — fall through to direct scan
  }

  if (matchingFiles.length === 0) {
    return scanFilesDirectly(query, project, sinceTs, untilTs, limit);
  }

  const results: SessionMatch[] = [];
  for (const filePath of matchingFiles) {
    if (results.length >= limit) break;
    const parsed = parseSessionFile(filePath);
    if (!parsed) continue;

    if (sinceTs || untilTs) {
      const sessionTs = parsed.timestamp ? Date.parse(parsed.timestamp) / 1000 : 0;
      if (sinceTs && sessionTs < sinceTs) continue;
      if (untilTs && sessionTs > untilTs) continue;
    }

    const hits = searchInSession(parsed, query, 3);
    if (hits.length === 0) continue;

    results.push({
      session_id: parsed.sessionId,
      project: projectFromCwd(parsed.cwd),
      cwd: parsed.cwd,
      time: hits[0].message.timestamp || parsed.timestamp || fileMtime(filePath),
      title: parsed.title || hits[0].message.text.slice(0, 80),
      summary: "",
      snippet: hits[0].snippet,
      path: filePath,
      message_count: parsed.messageCount,
    });
  }

  return results;
}

/** Fallback when ripgrep is unavailable: scan files directly. */
function scanFilesDirectly(
  query: string,
  project: string | undefined,
  sinceTs: number | undefined,
  untilTs: number | undefined,
  limit: number,
): SessionMatch[] {
  const results: SessionMatch[] = [];
  const dirs = project
    ? [findProjectSessionDir(project)]
    : readdirSync(SESSIONS_DIR).map((d) => join(SESSIONS_DIR, d));

  for (const dir of dirs) {
    if (results.length >= limit) break;
    if (!existsSync(dir)) continue;

    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
    } catch { continue; }

    for (const filePath of files) {
      if (results.length >= limit) break;
      const parsed = parseSessionFile(filePath);
      if (!parsed) continue;

      if (sinceTs || untilTs) {
        const sessionTs = parsed.timestamp ? Date.parse(parsed.timestamp) / 1000 : 0;
        if (sinceTs && sessionTs < sinceTs) continue;
        if (untilTs && sessionTs > untilTs) continue;
      }

      const hits = searchInSession(parsed, query, 3);
      if (hits.length === 0) continue;

      results.push({
        session_id: parsed.sessionId,
        project: projectFromCwd(parsed.cwd),
        cwd: parsed.cwd,
        time: hits[0].message.timestamp || parsed.timestamp || fileMtime(filePath),
        title: parsed.title || hits[0].message.text.slice(0, 80),
        summary: "",
        snippet: hits[0].snippet,
        path: filePath,
        message_count: parsed.messageCount,
      });
    }
  }

  return results;
}

/** Find the session directory for a project name. */
function findProjectSessionDir(project: string): string {
  try {
    for (const dir of readdirSync(SESSIONS_DIR)) {
      if (dir.includes(project)) return join(SESSIONS_DIR, dir);
    }
  } catch { /* */ }
  return SESSIONS_DIR;
}

// ── list: browse sessions by project/time ───────────────────────────

export async function listSessions(
  _pi: ExtensionAPI,
  project?: string,
  since?: string,
  until?: string,
  limit = 20,
): Promise<SessionMatch[]> {
  const sinceTs = parseTime(since);
  const untilTs = parseTime(until);

  const conditions: string[] = [];
  const params: Record<string, unknown> = { limit };
  if (project) { conditions.push("t.cwd LIKE '%' || $project || '%'"); params.project = project; }
  if (sinceTs) { conditions.push("t.updated_at >= $sinceTs"); params.sinceTs = sinceTs; }
  if (untilTs) { conditions.push("t.updated_at <= $untilTs"); params.untilTs = untilTs; }
  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

  let rows: Record<string, unknown>[] = [];
  try {
    rows = querySqlite(
      AGENT_DB,
      `SELECT t.id, t.cwd, t.rollout_path, t.updated_at,
              s.rollout_summary, s.rollout_slug
       FROM threads t
       LEFT JOIN stage1_outputs s ON s.thread_id = t.id
       ${where}
       ORDER BY t.updated_at DESC
       LIMIT $limit`,
      params,
    );
  } catch { /* agent.db may not exist */ }

  const results: SessionMatch[] = [];
  for (const row of rows) {
    const sid = row.id as string;
    const cwd = (row.cwd as string) || "";
    const rolloutPath = (row.rollout_path as string) || "";
    const summary = (row.rollout_summary as string) || "";
    const slug = (row.rollout_slug as string) || "";

    let msgCount = 0;
    if (rolloutPath && existsSync(rolloutPath)) {
      msgCount = countMessages(rolloutPath);
    }

    results.push({
      session_id: sid,
      project: projectFromCwd(cwd),
      cwd,
      time: formatTime(row.updated_at as number),
      title: slug || summary.slice(0, 80),
      summary,
      snippet: summary.slice(0, 200),
      path: rolloutPath,
      message_count: msgCount,
    });
  }

  return results;
}
