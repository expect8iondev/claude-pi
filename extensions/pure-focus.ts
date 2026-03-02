/**
 * Pure Focus Extension — path protection / scope locking.
 * Blocks any tool call that accesses paths outside the focus directory.
 */

import { resolve, relative } from "node:path";

export default function pureFocus(pi: any): void {
  const focusPath = pi.getFlag?.("focus-path");
  if (!focusPath) return; // No focus path set — extension inactive

  const resolvedFocus = resolve(focusPath);

  pi.on("tool_call", (event: any) => {
    const args = event.args || event.input || {};

    // Extract path from various tool argument patterns
    const targetPath =
      args.path || args.file_path || args.filePath ||
      args.directory || args.dir || args.target;

    if (!targetPath || typeof targetPath !== "string") return;

    const resolvedTarget = resolve(targetPath);
    const rel = relative(resolvedFocus, resolvedTarget);

    // Block if path is outside focus (starts with ..)
    if (rel.startsWith("..") || resolve(rel) === resolvedTarget) {
      pi.emit("pure_focus_blocked", {
        tool: event.tool || event.name,
        target_path: targetPath,
        focus_path: resolvedFocus,
        reason: "Path outside focus scope",
      });
      return { block: true, reason: `PureFocus: ${targetPath} is outside ${focusPath}` };
    }
  });
}
