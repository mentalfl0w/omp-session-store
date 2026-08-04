/**
 * session-store — JSONL transcript parser.
 *
 * Reads session .jsonl files line by line, extracting:
 *   - session metadata (id, cwd, timestamp)
 *   - message content (role + text)
 *   - title
 *
 * Each line is a separate JSON object with a "type" field.
 * Relevant types: "title", "session", "message".
 */

import { readFileSync, statSync } from "node:fs";

export interface JsonlMessage {
  role: string;
  text: string;
  timestamp: string;
  line: number;
}

export interface ParsedSession {
  sessionId: string;
  cwd: string;
  timestamp: string;
  title: string;
  messages: JsonlMessage[];
  messageCount: number;
}

export interface ContentHit {
  message: JsonlMessage;
  snippet: string;
  line: number;
}

/**
 * Parse a session .jsonl file, extracting messages with text content.
 * Returns null if file is empty or unreadable.
 */
export function parseSessionFile(filePath: string): ParsedSession | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const result: ParsedSession = {
    sessionId: "",
    cwd: "",
    timestamp: "",
    title: "",
    messages: [],
    messageCount: 0,
  };

  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const type = obj.type as string | undefined;
    if (!type) continue;

    if (type === "title") {
      result.title = (obj.title as string) || "";
    } else if (type === "session") {
      result.sessionId = (obj.id as string) || "";
      result.cwd = (obj.cwd as string) || "";
      result.timestamp = (obj.timestamp as string) || "";
    } else if (type === "message") {
      result.messageCount++;
      const msg = obj.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      const role = (msg.role as string) || "";
      const ts = (msg.timestamp as number | string | undefined);
      const timestamp = typeof ts === "number"
        ? new Date(ts).toISOString()
        : (ts as string) || "";

      const content = msg.content;
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = (content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text!)
          .join(" ");
      }

      if (text) {
        result.messages.push({ role, text, timestamp, line: i + 1 });
      }
    }
  }

  return result;
}

/**
 * Search for a query string within parsed messages.
 * Returns matches with surrounding context snippets.
 */
export function searchInSession(
  parsed: ParsedSession,
  query: string,
  maxResults = 5,
): ContentHit[] {
  const lowerQuery = query.toLowerCase();
  const hits: ContentHit[] = [];

  for (const msg of parsed.messages) {
    const lowerText = msg.text.toLowerCase();
    const idx = lowerText.indexOf(lowerQuery);
    if (idx === -1) continue;

    const start = Math.max(0, idx - 120);
    const end = Math.min(msg.text.length, idx + query.length + 120);
    const snippet = (start > 0 ? "…" : "") + msg.text.slice(start, end) + (end < msg.text.length ? "…" : "");

    hits.push({ message: msg, snippet, line: msg.line });
    if (hits.length >= maxResults) break;
  }

  return hits;
}

/**
 * Get message count quickly without full parse (just count "message" lines).
 */
export function countMessages(filePath: string): number {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "message") count++;
    } catch { /* skip */ }
  }
  return count;
}

/** Get file mtime as ISO string. */
export function fileMtime(filePath: string): string {
  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return "";
  }
}
