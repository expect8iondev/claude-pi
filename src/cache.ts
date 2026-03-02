/**
 * SHA256-based response cache for Pi agent calls.
 * Port of gcop's cache.py pattern.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CACHE_DIR = process.env.PI_CACHE_DIR || join(homedir(), ".cache", "claude-pi");
const DEFAULT_TTL = 3600; // 1 hour
const MAX_ENTRIES = 200;

function cacheKey(model: string, cwd: string, extensions: string[], prompt: string): string {
  const content = `${model}:${cwd}:${extensions.sort().join(",")}:${prompt}`;
  return createHash("sha256").update(content).digest("hex");
}

export function get(
  model: string,
  cwd: string,
  extensions: string[],
  prompt: string,
  ttl: number = DEFAULT_TTL,
): Record<string, unknown> | null {
  const key = cacheKey(model, cwd, extensions, prompt);
  const path = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(path)) return null;

  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (Date.now() / 1000 - (data.timestamp || 0) > ttl) {
      try { unlinkSync(path); } catch { /* ignore */ }
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export function put(
  model: string,
  cwd: string,
  extensions: string[],
  prompt: string,
  response: Record<string, unknown>,
): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const key = cacheKey(model, cwd, extensions, prompt);
    const path = join(CACHE_DIR, `${key}.json`);
    const data = { ...response, timestamp: Date.now() / 1000, cache_key: key };
    writeFileSync(path, JSON.stringify(data));
    evictIfNeeded();
  } catch (error) {
    console.error(`Error writing to cache: ${error}`);
  }
}

function evictIfNeeded(): void {
  if (!existsSync(CACHE_DIR)) return;

  const entries = readdirSync(CACHE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const full = join(CACHE_DIR, f);
      try {
        return { path: full, mtime: statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((e): e is { path: string; mtime: number } => e !== null)
    .sort((a, b) => a.mtime - b.mtime);

  if (entries.length <= MAX_ENTRIES) return;

  // Remove expired first
  const now = Date.now() / 1000;
  let removed = 0;
  for (const entry of entries) {
    try {
      const data = JSON.parse(readFileSync(entry.path, "utf-8"));
      if (now - (data.timestamp || 0) > DEFAULT_TTL) {
        unlinkSync(entry.path);
        removed++;
      }
    } catch {
      try { unlinkSync(entry.path); removed++; } catch { /* ignore */ }
    }
  }

  // If still over limit, remove oldest
  if (entries.length - removed > MAX_ENTRIES) {
    const remaining = entries.filter((e) => existsSync(e.path));
    for (const entry of remaining.slice(0, remaining.length - MAX_ENTRIES)) {
      try { unlinkSync(entry.path); } catch { /* ignore */ }
    }
  }
}

export function clear(): number {
  if (!existsSync(CACHE_DIR)) return 0;
  let count = 0;
  for (const f of readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json"))) {
    try {
      unlinkSync(join(CACHE_DIR, f));
      count++;
    } catch { /* ignore */ }
  }
  return count;
}
