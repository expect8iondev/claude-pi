/**
 * Heuristic cost tracking with daily JSONL logs.
 * Port of gcop's cost.py pattern, adapted for Pi's heuristic model.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const COST_DIR = process.env.PI_COST_DIR || join(homedir(), ".cache", "claude-pi");
const DAILY_BUDGET = parseFloat(process.env.PI_DAILY_BUDGET || "5.00");

// Pricing per 1M tokens (USD) — Feb 2026
const PRICING: Record<string, { input: number; output: number }> = {
  // Google Gemini
  "gemini-2.5-flash":       { input: 0.15, output: 0.60 },
  "gemini-2.5-flash-lite":  { input: 0.075, output: 0.30 },
  "gemini-2.5-pro":         { input: 1.25, output: 10.0 },
  "gemini-3.1-pro-preview": { input: 1.25, output: 10.0 },
  // Anthropic Claude
  "claude-sonnet-4-5":      { input: 3.0, output: 15.0 },
  "claude-opus-4-6":        { input: 15.0, output: 75.0 },
  "claude-haiku-4-5":       { input: 0.80, output: 4.0 },
  // OpenAI
  "gpt-4o":                 { input: 2.50, output: 10.0 },
  "gpt-4o-mini":            { input: 0.15, output: 0.60 },
  "o3":                     { input: 10.0, output: 40.0 },
  "o4-mini":                { input: 1.10, output: 4.40 },
};

// Heuristic: chars/4 for tokens, + 700 per tool call
const CHARS_PER_TOKEN = 4;
const TOOL_CALL_OVERHEAD = 700;

interface CostEntry {
  timestamp: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  task: string;
}

function todayLog(): string {
  const date = new Date().toISOString().split("T")[0];
  return join(COST_DIR, `costs-${date}.jsonl`);
}

function readToday(): CostEntry[] {
  const path = todayLog();
  if (!existsSync(path)) return [];
  const entries: CostEntry[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return entries;
}

export function estimateTokens(text: string, toolCalls: number = 0): { input: number; output: number } {
  const inputTokens = Math.ceil(text.length / CHARS_PER_TOKEN) + toolCalls * TOOL_CALL_OVERHEAD;
  // Assume output is roughly 60% of input for agent tasks
  const outputTokens = Math.ceil(inputTokens * 0.6);
  return { input: inputTokens, output: outputTokens };
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const prices = PRICING[model] || PRICING["gemini-2.5-flash"]!;
  return (inputTokens * prices.input + outputTokens * prices.output) / 1_000_000;
}

export function logUsage(
  model: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  task: string = "",
): void {
  mkdirSync(COST_DIR, { recursive: true });
  const entry: CostEntry = {
    timestamp: new Date().toISOString(),
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
    task,
  };
  appendFileSync(todayLog(), JSON.stringify(entry) + "\n");
}

export function dailySpend(): number {
  return readToday().reduce((sum, e) => sum + (e.cost_usd || 0), 0);
}

export function checkBudget(): { withinBudget: boolean; spent: number; limit: number } {
  const spent = dailySpend();
  return { withinBudget: spent < DAILY_BUDGET, spent, limit: DAILY_BUDGET };
}

export function summary(date?: string): Record<string, unknown> {
  let entries: CostEntry[];
  if (date) {
    const path = join(COST_DIR, `costs-${date}.jsonl`);
    entries = [];
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch { continue; }
      }
    }
  } else {
    entries = readToday();
  }

  let totalCost = 0;
  const models: Record<string, { calls: number; cost: number; tokens: number }> = {};
  for (const entry of entries) {
    totalCost += entry.cost_usd || 0;
    const m = entry.model || "unknown";
    if (!models[m]) models[m] = { calls: 0, cost: 0, tokens: 0 };
    models[m]!.calls++;
    models[m]!.cost += entry.cost_usd || 0;
    models[m]!.tokens += (entry.input_tokens || 0) + (entry.output_tokens || 0);
  }

  return {
    status: "ok",
    date: date || new Date().toISOString().split("T")[0],
    total_cost: Math.round(totalCost * 10000) / 10000,
    total_calls: entries.length,
    daily_budget: DAILY_BUDGET,
    budget_remaining: Math.round((DAILY_BUDGET - totalCost) * 10000) / 10000,
    models,
  };
}
