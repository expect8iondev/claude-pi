/**
 * Meta Creator Extension — agents building agents.
 * Registers /meta-create command that uses Pi to generate new extension files.
 */

import { writeFileSync, existsSync, symlinkSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const EXTENSIONS_DIR = join(homedir(), "claude-pi", "extensions");
const PI_EXTENSIONS_DIR = join(homedir(), ".pi", "agent", "extensions");

const EXTENSION_TEMPLATE = `/**
 * {{NAME}} Extension
 * {{DESCRIPTION}}
 */

export default function {{FUNC_NAME}}(pi: any): void {
  // Hook into Pi lifecycle events
  // Available hooks: tool_call, tool_result, agent_end, turn_end,
  //   before_agent_start, session_shutdown

  pi.on("agent_end", (event: any) => {
    // Your extension logic here
  });
}
`;

export default function metaCreator(pi: any): void {
  pi.on("command", (event: any) => {
    if (event.command !== "/meta-create") return;

    const description = event.args || "";
    if (!description) {
      pi.emit("meta_creator_error", { error: "Usage: /meta-create DESCRIPTION" });
      return;
    }

    // Generate a slug from description
    const slug = description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 30);

    const funcName = slug.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
    const fileName = `${slug}.ts`;
    const filePath = join(EXTENSIONS_DIR, fileName);

    if (existsSync(filePath)) {
      pi.emit("meta_creator_error", { error: `Extension already exists: ${fileName}` });
      return;
    }

    // Write template (Pi will be prompted to fill in the actual logic)
    const content = EXTENSION_TEMPLATE
      .replace(/\{\{NAME\}\}/g, slug)
      .replace(/\{\{DESCRIPTION\}\}/g, description)
      .replace(/\{\{FUNC_NAME\}\}/g, funcName);

    mkdirSync(EXTENSIONS_DIR, { recursive: true });
    writeFileSync(filePath, content);

    // Auto-symlink to Pi extensions
    mkdirSync(PI_EXTENSIONS_DIR, { recursive: true });
    const link = join(PI_EXTENSIONS_DIR, fileName);
    try { unlinkSync(link); } catch { /* ignore */ }
    symlinkSync(filePath, link);

    pi.emit("meta_creator_success", {
      file: filePath,
      symlink: link,
      name: slug,
      hint: "Edit the generated file to add your extension logic",
    });
  });
}
