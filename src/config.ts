/**
 * Pi configuration generator.
 * Creates ~/.pi/agent/settings.json and models.json for Pi agent.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PI_DIR = join(homedir(), ".pi", "agent");

export function generateSettings(): Record<string, unknown> {
  return {
    defaultProvider: "google",
    defaultModel: "gemini-2.5-flash",
    yolo: false,
    maxTurns: 50,
    mcpServers: {},
  };
}

export function generateModels(): Record<string, unknown> {
  return {
    providers: {
      google: {
        name: "Google AI",
        apiKeyEnvVar: "GEMINI_API_KEY",
        models: {
          "gemini-2.5-flash": {
            name: "Gemini 2.5 Flash",
            maxContextLength: 1048576,
            supportsImages: true,
            supportsToolUse: true,
            inputPrice: 0.15,
            outputPrice: 0.60,
          },
          "gemini-2.5-pro": {
            name: "Gemini 2.5 Pro",
            maxContextLength: 1048576,
            supportsImages: true,
            supportsToolUse: true,
            inputPrice: 1.25,
            outputPrice: 10.0,
          },
        },
      },
      anthropic: {
        name: "Anthropic",
        apiKeyEnvVar: "ANTHROPIC_API_KEY",
        models: {
          "claude-sonnet-4-5": {
            name: "Claude Sonnet 4.5",
            maxContextLength: 200000,
            supportsImages: true,
            supportsToolUse: true,
            inputPrice: 3.0,
            outputPrice: 15.0,
          },
          "claude-opus-4-6": {
            name: "Claude Opus 4.6",
            maxContextLength: 200000,
            supportsImages: true,
            supportsToolUse: true,
            inputPrice: 15.0,
            outputPrice: 75.0,
          },
        },
      },
    },
  };
}

export function deployConfig(): { settingsPath: string; modelsPath: string } {
  mkdirSync(PI_DIR, { recursive: true });

  const settingsPath = join(PI_DIR, "settings.json");
  const modelsPath = join(PI_DIR, "models.json");

  writeFileSync(settingsPath, JSON.stringify(generateSettings(), null, 2));
  writeFileSync(modelsPath, JSON.stringify(generateModels(), null, 2));

  return { settingsPath, modelsPath };
}

export function configExists(): boolean {
  return (
    existsSync(join(PI_DIR, "settings.json")) &&
    existsSync(join(PI_DIR, "models.json"))
  );
}
