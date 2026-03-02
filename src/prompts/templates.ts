/**
 * Prompt templates for common Pi agent tasks.
 * Each returns [system, user] tuple matching gcop pattern.
 */

export function getRunPrompt(prompt: string): [string, string] {
  const system = [
    "You are a precise coding agent. Execute the task described below.",
    "Be thorough but concise. Report what you did and any issues found.",
    "If the task involves file modifications, list all files changed.",
  ].join(" ");
  return [system, prompt];
}

export function getBurstPrompt(file: string, operation: string): [string, string] {
  const system = [
    "You are a focused coding agent working on a single file.",
    "Apply the requested operation precisely. Do not modify other files.",
    "Report what you changed and any issues found.",
  ].join(" ");
  const user = `File: ${file}\n\nOperation: ${operation}`;
  return [system, user];
}

export function getPipelinePrompt(
  stageName: string,
  stagePrompt: string,
  previousResults?: Record<string, string>,
): [string, string] {
  const system = [
    `You are executing stage "${stageName}" of a multi-stage pipeline.`,
    "Complete your stage thoroughly. Your output will feed into subsequent stages.",
  ].join(" ");

  let user = stagePrompt;
  if (previousResults) {
    // Substitute {{stage.response}} placeholders
    for (const [key, value] of Object.entries(previousResults)) {
      user = user.replace(new RegExp(`\\{\\{${key}\\.response\\}\\}`, "g"), value);
    }
  }
  return [system, user];
}

export function getTillDonePrompt(prompt: string, doneSignal: string): [string, string] {
  const system = [
    "You are a deterministic coding agent that works in a loop.",
    `When you have fully completed the task, output the exact string: ${doneSignal}`,
    `Do NOT output ${doneSignal} until the task is genuinely complete.`,
    "If you encounter errors, fix them and continue working.",
  ].join(" ");
  return [system, prompt];
}

export function getMetaPrompt(description: string): [string, string] {
  const system = [
    "You are a meta-agent that creates Pi agent extensions.",
    "Generate a TypeScript file that exports a default function accepting a Pi ExtensionAPI.",
    "The extension should hook into Pi's lifecycle events.",
    "Follow the pattern of existing extensions in the claude-pi/extensions/ directory.",
  ].join(" ");
  const user = `Create a new Pi extension:\n\n${description}`;
  return [system, user];
}
