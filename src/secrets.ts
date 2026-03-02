/**
 * Auto-load API keys from a .env file and deploy to Pi's auth.json.
 * Reads from PCOP_SECRETS_PATH env var, or ~/.secrets/.env by default.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SECRETS_PATH = process.env.PCOP_SECRETS_PATH || join(homedir(), ".secrets", ".env");
const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

const KEYS_TO_LOAD = [
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "MISTRAL_API_KEY",
];

// Map env var names to Pi auth.json provider keys
const ENV_TO_PI_PROVIDER: Record<string, string> = {
  GEMINI_API_KEY: "google",
  ANTHROPIC_API_KEY: "anthropic",
  OPENAI_API_KEY: "openai",
  GROQ_API_KEY: "groq",
  XAI_API_KEY: "xai",
  OPENROUTER_API_KEY: "openrouter",
  MISTRAL_API_KEY: "mistral",
};

export function loadSecrets(): void {
  if (!existsSync(SECRETS_PATH)) return;

  let content: string;
  try {
    content = readFileSync(SECRETS_PATH, "utf-8");
  } catch {
    return;
  }

  const loaded: Record<string, string> = {};

  for (const rawLine of content.split("\n")) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;

    if (line.startsWith("export ")) line = line.slice(7);

    const eqIdx = line.indexOf("=");
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (KEYS_TO_LOAD.includes(key) && value) {
      if (!process.env[key]) process.env[key] = value;
      loaded[key] = value;
    }
  }

  // Deploy to Pi's auth.json so Pi can find the keys
  deployAuthJson(loaded);
}

function deployAuthJson(keys: Record<string, string>): void {
  try {
    // Read existing auth.json (may have OAuth tokens from /login)
    let existing: Record<string, any> = {};
    if (existsSync(AUTH_PATH)) {
      try {
        existing = JSON.parse(readFileSync(AUTH_PATH, "utf-8"));
      } catch {
        existing = {};
      }
    }

    let changed = false;
    for (const [envKey, value] of Object.entries(keys)) {
      const provider = ENV_TO_PI_PROVIDER[envKey];
      if (!provider) continue;

      // Don't overwrite OAuth tokens (they have type: "oauth")
      if (existing[provider]?.type === "oauth") continue;

      // Only update if missing or different
      if (!existing[provider] || existing[provider].key !== value) {
        existing[provider] = { type: "api_key", key: value };
        changed = true;
      }
    }

    if (changed) {
      mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
      writeFileSync(AUTH_PATH, JSON.stringify(existing, null, 2));
      chmodSync(AUTH_PATH, 0o600);
    }
  } catch {
    // Non-fatal — Pi can still use env vars
  }
}
