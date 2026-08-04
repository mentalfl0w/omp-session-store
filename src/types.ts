/**
 * session-store — type definitions.
 *
 * Minimal ExtensionAPI surface (no host import), mirroring the pattern
 * from smart-approve. OMP injects `zod` at runtime.
 */

/** The pi/omp extension API surface used by this extension. */
export interface ExtensionAPI {
  /** Register a custom tool callable by the LLM. */
  registerTool<TParams = unknown, TDetails = unknown>(
    tool: ToolDefinition<TParams, TDetails>,
  ): void;
  /** Execute a shell command. */
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  /** Injected zod module for tool parameter schemas. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  zod: any;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  killed?: boolean;
}

/** Tool definition for registerTool. */
export interface ToolDefinition<TParams = unknown, TDetails = unknown> {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  approval?: string;
  deferrable?: boolean;
  hidden?: boolean;
  execute(
    toolCallId: string,
    params: TParams,
    signal: AbortSignal | undefined,
    onUpdate: ((update: { content: unknown[]; details?: unknown }) => void) | undefined,
    ctx: ExtensionCtx,
  ): Promise<AgentToolResult<TDetails>>;
  onSession?: (event: { reason: string }, ctx: ExtensionCtx) => void | Promise<void>;
}

/** Tool result returned by custom tool execute(). */
export interface AgentToolResult<TDetails = unknown> {
  content: Array<{ type: "text"; text: string }>;
  details?: TDetails;
  isError?: boolean;
}

export interface ExtensionCtx {
  hasUI: boolean;
  cwd?: string;
  lang?: string;
  ui?: {
    setStatus: (id: string, text: string | undefined) => void;
    notify?: (msg: string, level: "info" | "warning") => void;
  };
}

// ── Domain types ─────────────────────────────────────────────────────

export type SearchAction = "keyword" | "content" | "list";

export interface SearchParams {
  action: SearchAction;
  query?: string;
  project?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface SessionMatch {
  session_id: string;
  project: string;
  cwd: string;
  time: string;
  title: string;
  summary: string;
  snippet: string;
  path: string;
  message_count: number;
}
