/**
 * Damage Control Extension — hard security firewall for Pi agent.
 *
 * Blocks catastrophic commands even when --yolo is active.
 * YOLO bypasses human confirmation prompts, NOT security hardcodes.
 *
 * This is the last line of defense before irreversible damage.
 */

// Exact-match blocked commands (normalized, no args)
const BLOCKED_EXACT = new Set([
  "rm -rf /",
  "rm -rf /*",
  "rm -rf ~",
  "rm -rf ~/",
  "rm -rf .",
  "mkfs",
  "dd if=/dev/zero",
  "dd if=/dev/random",
  ":(){:|:&};:",            // fork bomb
]);

// Pattern-match blocked commands (regex on full command string)
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Filesystem destruction
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?(\/|~\/?\s*$)/,
    reason: "Recursive delete of root/home directory" },
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\//,
    reason: "Recursive force-delete from root" },
  { pattern: /\bchmod\s+(-R\s+)?[0-7]*777\s+\//,
    reason: "Recursive chmod 777 on system paths" },
  { pattern: /\bchown\s+-R\s+.*\s+\//,
    reason: "Recursive chown on system paths" },

  // Git destruction
  { pattern: /\bgit\s+push\s+.*--force\s+(origin\s+)?(main|master)\b/,
    reason: "Force push to main/master" },
  { pattern: /\bgit\s+push\s+-f\s+(origin\s+)?(main|master)\b/,
    reason: "Force push to main/master" },
  { pattern: /\bgit\s+reset\s+--hard\s+origin\//,
    reason: "Hard reset to remote (destroys local work)" },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*f[a-zA-Z]*d/,
    reason: "Force clean all untracked files and directories" },

  // Database destruction
  { pattern: /\bDROP\s+(DATABASE|TABLE|SCHEMA)\b/i,
    reason: "Database/table/schema drop" },
  { pattern: /\bTRUNCATE\s+TABLE\b/i,
    reason: "Table truncation" },
  { pattern: /\bDELETE\s+FROM\s+\w+\s*;?\s*$/i,
    reason: "DELETE without WHERE clause" },

  // System destruction
  { pattern: /\bmkfs\b/,
    reason: "Filesystem format" },
  { pattern: /\bdd\s+if=\/dev\/(zero|random|urandom)/,
    reason: "Disk overwrite" },
  { pattern: /\bshutdown\b/,
    reason: "System shutdown" },
  { pattern: /\breboot\b/,
    reason: "System reboot" },
  { pattern: /\bsystemctl\s+(stop|disable)\s+(docker|nginx|sshd|postgresql)/,
    reason: "Stopping critical system service" },

  // Container destruction
  { pattern: /\bdocker\s+(rm|rmi)\s+-f\s+\$\(docker\s+(ps|images)/,
    reason: "Mass docker container/image removal" },
  { pattern: /\bdocker\s+system\s+prune\s+-a/,
    reason: "Docker full system prune" },

  // Secrets exposure
  { pattern: /\bcat\s+.*\.(env|pem|key|secret)\s*\|.*curl/,
    reason: "Piping secrets to external endpoint" },
  { pattern: /\bcurl\s+.*-d\s+.*(\$\{?(GEMINI|ANTHROPIC|OPENAI|API)_?(KEY|SECRET|TOKEN))/i,
    reason: "Sending API keys to external endpoint" },

  // Network danger
  { pattern: /\biptables\s+-F\b/,
    reason: "Flushing all firewall rules" },
  { pattern: /\bufw\s+disable\b/,
    reason: "Disabling firewall" },
];

// Paths that should never be written to or deleted
const PROTECTED_PATHS = [
  "/etc/passwd",
  "/etc/shadow",
  "/etc/sudoers",
  "/boot/",
  "/usr/bin/",
  "/usr/sbin/",
  `${process.env.HOME}/.secrets/`,
  `${process.env.HOME}/.ssh/`,
];

function checkCommand(command: string): { blocked: boolean; reason?: string } {
  const normalized = command.trim().replace(/\s+/g, " ");

  // Exact match
  for (const blocked of BLOCKED_EXACT) {
    if (normalized === blocked || normalized.startsWith(blocked + " ")) {
      return { blocked: true, reason: `Exact-match blocked: "${blocked}"` };
    }
  }

  // Pattern match
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(normalized)) {
      return { blocked: true, reason: `Pattern blocked: ${reason}` };
    }
  }

  return { blocked: false };
}

function checkPath(path: string): { blocked: boolean; reason?: string } {
  for (const protected_ of PROTECTED_PATHS) {
    if (path.startsWith(protected_) || path === protected_.replace(/\/$/, "")) {
      return { blocked: true, reason: `Protected path: ${protected_}` };
    }
  }
  return { blocked: false };
}

export default function damageControl(pi: any): void {
  let blockedCount = 0;
  const blockedLog: Array<{ tool: string; command?: string; path?: string; reason: string; timestamp: number }> = [];

  pi.on("tool_call", (event: any) => {
    const toolName = (event.tool || event.name || "").toLowerCase();
    const args = event.args || event.input || event.arguments || {};

    // Check bash/shell commands
    if (toolName === "bash" || toolName === "shell" || toolName === "execute" || toolName === "run_command") {
      const command = String(args.command || args.cmd || args.script || "");
      if (!command) return;

      const result = checkCommand(command);
      if (result.blocked) {
        blockedCount++;
        blockedLog.push({
          tool: toolName,
          command: command.slice(0, 200),
          reason: result.reason!,
          timestamp: Date.now(),
        });
        pi.emit("damage_control_blocked", {
          tool: toolName,
          command: command.slice(0, 200),
          reason: result.reason,
        });
        return { block: true, reason: `DamageControl: ${result.reason}` };
      }
    }

    // Check file operations against protected paths
    if (["write", "edit", "write_file", "edit_file", "create_file", "delete", "remove"].includes(toolName)) {
      const targetPath = String(args.path || args.file_path || args.filePath || args.target || "");
      if (targetPath) {
        const result = checkPath(targetPath);
        if (result.blocked) {
          blockedCount++;
          blockedLog.push({
            tool: toolName,
            path: targetPath,
            reason: result.reason!,
            timestamp: Date.now(),
          });
          pi.emit("damage_control_blocked", {
            tool: toolName,
            path: targetPath,
            reason: result.reason,
          });
          return { block: true, reason: `DamageControl: ${result.reason}` };
        }
      }
    }
  });

  pi.on("session_shutdown", () => {
    if (blockedCount > 0) {
      pi.emit("damage_control_summary", {
        total_blocked: blockedCount,
        events: blockedLog.slice(0, 20),
      });
    }
  });
}
