/**
 * Error Scraper Extension — captures structured errors from Pi tool results.
 * Hooks into tool_result events, scans for error patterns, emits summary at shutdown.
 */

interface ErrorRecord {
  tool: string;
  pattern: string;
  line: string;
  timestamp: number;
}

const ERROR_PATTERNS = [
  /error/i,
  /exception/i,
  /traceback/i,
  /FATAL/,
  /failed/i,
  /panic/i,
  /segfault/i,
  /ENOENT/,
  /EACCES/,
  /EPERM/,
  /TypeError/,
  /ReferenceError/,
  /SyntaxError/,
];

export default function errorScraper(pi: any): void {
  const errors: ErrorRecord[] = [];

  pi.on("tool_result", (event: any) => {
    const result = String(event.result || event.output || "");
    const toolName = event.tool || event.name || "unknown";

    for (const line of result.split("\n")) {
      for (const pattern of ERROR_PATTERNS) {
        if (pattern.test(line)) {
          errors.push({
            tool: toolName,
            pattern: pattern.source,
            line: line.trim().slice(0, 200),
            timestamp: Date.now(),
          });
          break; // one match per line
        }
      }
    }
  });

  pi.on("session_shutdown", () => {
    if (errors.length > 0) {
      pi.emit("error_scraper_summary", {
        total_errors: errors.length,
        errors: errors.slice(0, 50), // cap at 50
        tools_with_errors: [...new Set(errors.map((e) => e.tool))],
      });
    }
  });
}
