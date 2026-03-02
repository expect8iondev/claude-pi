/**
 * Core Pi agent spawner.
 * Spawns `pi` as a subprocess, parses JSON event stream, extracts results.
 */
import { spawn } from "node:child_process";
import { loadSecrets } from "./secrets.js";
import * as cache from "./cache.js";
import * as cost from "./cost.js";

// Model alias -> Pi model string (using provider/id syntax)
// Pi resolves provider from the model string or from auth.json/env vars
const MODEL_MAP: Record<string, string> = {
  // Google Gemini
  "gemini-flash":    "google/gemini-2.5-flash",
  "gemini-pro":      "google/gemini-2.5-pro",
  "gemini-3.1":      "google/gemini-3.1-pro-preview",
  "gemini-flash-lite": "google/gemini-2.5-flash-lite",

  // Anthropic Claude
  "claude-sonnet":   "anthropic/claude-sonnet-4-5",
  "claude-opus":     "anthropic/claude-opus-4-6",
  "claude-haiku":    "anthropic/claude-haiku-4-5",

  // OpenAI
  "gpt-4o":          "openai/gpt-4o",
  "gpt-4o-mini":     "openai/gpt-4o-mini",
  "o3":              "openai/o3",
  "o4-mini":         "openai/o4-mini",

  // OpenRouter (access to many models via single key)
  "openrouter":      "openrouter/anthropic/claude-sonnet-4-5",
};

// Pi's native thinking levels (maps to --thinking flag)
const THINKING_LEVELS: Record<string, string> = {
  off: "off",
  low: "low",
  medium: "medium",
  high: "high",
  max: "xhigh",
};

const DEFAULT_MODEL = "gemini-flash";
const DEFAULT_TIMEOUT = 300_000; // 5 minutes
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // exponential backoff

export interface PiRunOptions {
  prompt: string;
  model?: string;
  cwd?: string;
  yolo?: boolean;
  timeout?: number;
  useCache?: boolean;
  taskLabel?: string;
  extensions?: string[];
  thinking?: string;       // off, low, medium, high, max
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  result?: string;
  error?: boolean;
}

export interface PiRunResult {
  status: "ok" | "error";
  response: string;
  model: string;
  cost_usd: number;
  latency_ms: number;
  cached: boolean;
  tool_calls: ToolCallRecord[];
  files_modified: string[];
  exit_code: number;
  error?: string;
}

export function routeModel(alias: string): string {
  // If it contains a slash, treat as direct provider/model reference
  if (alias.includes("/")) return alias;
  return MODEL_MAP[alias] || MODEL_MAP[DEFAULT_MODEL]!;
}

export function listModels(): Record<string, string> {
  return { ...MODEL_MAP };
}

interface PiEvent {
  type: string;
  [key: string]: unknown;
}

export function parsePiEvents(rawOutput: string): PiEvent[] {
  const events: PiEvent[] = [];
  for (const line of rawOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        // Pi --mode json can output conversation-style events with role/content
        if (parsed.role) {
          events.push({ type: parsed.role, ...parsed } as PiEvent);
        } else if (parsed.type) {
          events.push(parsed as PiEvent);
        }
        // Also extract nested events from content arrays
        if (Array.isArray(parsed.content)) {
          for (const item of parsed.content) {
            if (item && typeof item === "object" && (item.type || item.name)) {
              events.push({ ...item, _parentRole: parsed.role } as PiEvent);
            }
          }
        }
      }
    } catch {
      // Not a JSON event line — skip
    }
  }
  return events;
}

function extractToolCalls(events: PiEvent[]): ToolCallRecord[] {
  const calls: ToolCallRecord[] = [];
  for (const event of events) {
    if (event.type === "tool_execution_end" || event.type === "tool_call" || event.type === "toolCall") {
      calls.push({
        tool: (event.tool as string) || (event.name as string) || "unknown",
        args: (event.args as Record<string, unknown>) || (event.input as Record<string, unknown>) || (event.arguments as Record<string, unknown>) || {},
        result: event.result as string | undefined,
        error: (event.error as boolean) || (event.isError as boolean) || undefined,
      });
    }
    // Handle toolResult events for result mapping
    if (event.type === "toolResult") {
      const content = event.content as Array<{ type: string; text: string }> | undefined;
      const text = content?.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      if (text && calls.length > 0) {
        calls[calls.length - 1]!.result = text;
      }
    }
  }
  return calls;
}

function extractFilesModified(toolCalls: ToolCallRecord[]): string[] {
  const files = new Set<string>();
  for (const call of toolCalls) {
    if (["write", "edit", "write_file", "edit_file", "create_file"].includes(call.tool)) {
      const path = (call.args.path || call.args.file_path || call.args.filePath) as string | undefined;
      if (path) files.add(path);
    }
  }
  return [...files];
}

function extractTextFromMessages(messages: any[]): string {
  // Find the last assistant message with stopReason "stop" and extract text
  let lastText = "";
  for (const msg of messages) {
    if (msg?.role === "assistant" && Array.isArray(msg.content)) {
      const textParts = msg.content
        .filter((c: any) => c.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text as string);
      if (textParts.length > 0) {
        // Prefer messages with stopReason "stop" (final response, not mid-tool-call)
        if (msg.stopReason === "stop") {
          lastText = textParts.join("\n");
        } else if (!lastText) {
          lastText = textParts.join("\n");
        }
      }
    }
  }
  return lastText;
}

function extractResponse(_events: PiEvent[], rawOutput: string): string {
  // Pi --mode json outputs the full conversation. It can be:
  // 1. A single JSON array of messages: [{role:"assistant",...}, {role:"toolResult",...}, ...]
  // 2. JSONL with one message per line
  // 3. A wrapper object containing messages

  // Strategy 1: Try parsing each line (handles both single-line array and JSONL)
  for (const line of rawOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);

      // Case A: It's an array of messages
      if (Array.isArray(parsed)) {
        const text = extractTextFromMessages(parsed);
        if (text) return text;
      }

      // Case B: It's a wrapper object with a messages/conversation array
      if (parsed && typeof parsed === "object") {
        const msgs = parsed.messages || parsed.conversation || parsed.history;
        if (Array.isArray(msgs)) {
          const text = extractTextFromMessages(msgs);
          if (text) return text;
        }

        // Case C: It's a single message object with role:"assistant"
        if (parsed.role === "assistant" && parsed.stopReason === "stop" && Array.isArray(parsed.content)) {
          const textParts = parsed.content
            .filter((c: any) => c.type === "text" && typeof c.text === "string")
            .map((c: any) => c.text as string);
          if (textParts.length > 0) return textParts.join("\n");
        }
      }
    } catch {
      // Not valid JSON — skip
    }
  }

  // Strategy 2: Find text events from parsed events
  const textEvents = _events.filter(
    (e) => e.type === "text" && (e._parentRole as string) === "assistant" && e.text,
  );
  if (textEvents.length > 0) {
    return (textEvents[textEvents.length - 1]!.text as string);
  }

  // Strategy 3: Find assistant events with content arrays
  for (const event of [..._events].reverse()) {
    if (event.type === "assistant" && Array.isArray(event.content)) {
      const textParts = (event.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!);
      if (textParts.length > 0) return textParts.join("\n");
    }
  }

  // Fallback
  return rawOutput.slice(-2000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function spawnPi(opts: PiRunOptions): Promise<PiRunResult> {
  loadSecrets();

  const modelAlias = opts.model || DEFAULT_MODEL;
  const modelStr = routeModel(modelAlias);
  // Extract short model name for display/cost tracking
  const model = modelStr.includes("/") ? modelStr.split("/").pop()! : modelStr;
  const cwd = opts.cwd || process.cwd();
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  const extensions = opts.extensions || [];
  const useCache = opts.useCache ?? false;

  // Check budget
  const budget = cost.checkBudget();
  if (!budget.withinBudget) {
    return {
      status: "error",
      response: "",
      model,
      cost_usd: 0,
      latency_ms: 0,
      cached: false,
      tool_calls: [],
      files_modified: [],
      exit_code: 1,
      error: `Daily budget exceeded: $${budget.spent.toFixed(2)} / $${budget.limit.toFixed(2)}`,
    };
  }

  // Check cache
  if (useCache) {
    const cached = cache.get(model, cwd, extensions, opts.prompt);
    if (cached) {
      return {
        ...(cached as unknown as PiRunResult),
        cached: true,
        status: "ok",
      };
    }
  }

  // Build pi command args — use provider/model syntax
  const args = ["--mode", "json", "--model", modelStr, "--no-session"];
  if (opts.yolo) args.push("--yolo");
  // Apply Pi's native --thinking flag
  if (opts.thinking && THINKING_LEVELS[opts.thinking]) {
    args.push("--thinking", THINKING_LEVELS[opts.thinking]!);
  }
  args.push(opts.prompt);

  let lastError: string | undefined;
  let lastExitCode = 1;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const start = Date.now();

    try {
      const result = await runPiProcess(args, cwd, timeout);
      const latencyMs = Date.now() - start;

      const events = parsePiEvents(result.stdout);
      const toolCalls = extractToolCalls(events);
      const filesModified = extractFilesModified(toolCalls);
      const response = extractResponse(events, result.stdout);

      // Try to extract actual usage from Pi events, fall back to heuristic
      let inputTokens = 0;
      let outputTokens = 0;
      let actualCost = 0;
      for (const event of events) {
        const usage = event.usage as { input?: number; output?: number; cost?: { total?: number } } | undefined;
        if (usage) {
          inputTokens += usage.input || 0;
          outputTokens += usage.output || 0;
          actualCost += usage.cost?.total || 0;
        }
      }
      // Fall back to heuristic if no usage data found
      if (inputTokens === 0 && outputTokens === 0) {
        const tokens = cost.estimateTokens(opts.prompt + result.stdout, toolCalls.length);
        inputTokens = tokens.input;
        outputTokens = tokens.output;
      }
      const costUsd = actualCost > 0 ? actualCost : cost.estimateCost(model, inputTokens, outputTokens);
      cost.logUsage(model, inputTokens, outputTokens, costUsd, opts.taskLabel || "");

      const piResult: PiRunResult = {
        status: result.exitCode === 0 ? "ok" : "error",
        response,
        model,
        cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
        latency_ms: latencyMs,
        cached: false,
        tool_calls: toolCalls,
        files_modified: filesModified,
        exit_code: result.exitCode,
        error: result.exitCode !== 0 ? result.stderr || "Pi exited with non-zero status" : undefined,
      };

      // Cache successful results if caching enabled
      if (useCache && piResult.status === "ok") {
        cache.put(model, cwd, extensions, opts.prompt, piResult as unknown as Record<string, unknown>);
      }

      return piResult;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      lastExitCode = 1;

      // Retry on transient errors
      const isTransient = /timeout|ETIMEDOUT|ECONNRESET|rate.limit/i.test(lastError);
      if (isTransient && attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_DELAYS[attempt]!);
        continue;
      }
      break;
    }
  }

  return {
    status: "error",
    response: "",
    model,
    cost_usd: 0,
    latency_ms: 0,
    cached: false,
    tool_calls: [],
    files_modified: [],
    exit_code: lastExitCode,
    error: lastError || "Unknown error",
  };
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runPiProcess(args: string[], cwd: string, timeout: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn("pi", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      timeout,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Pi process timed out after ${timeout}ms`));
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
