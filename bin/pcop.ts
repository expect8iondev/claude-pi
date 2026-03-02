#!/usr/bin/env tsx
/**
 * pcop — Pi Co-Processor CLI for Claude Code.
 *
 * Usage:
 *   pcop run PROMPT              General dispatch to Pi agent
 *   pcop till-done PROMPT        Loop until TASK_COMPLETE signal
 *   pcop pipeline FILE           Execute YAML agent chain
 *   pcop burst --files GLOB --op "task"  Parallel multi-file processing
 *   pcop meta DESCRIPTION        Generate new Pi extension
 *   pcop cost                    Show today's spending
 *   pcop models                  List available models
 *   pcop install                 Install Pi + deploy config + extensions
 *   pcop ext list|deploy|test    Extension management
 */
import { Command } from "commander";
import { readFileSync, existsSync, mkdirSync, symlinkSync, unlinkSync, readdirSync, chmodSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadSecrets } from "../src/secrets.js";
import { spawnPi, routeModel, listModels } from "../src/client.js";
import * as cost from "../src/cost.js";
import * as cache from "../src/cache.js";
import { deployConfig } from "../src/config.js";
import { output } from "../src/output.js";
import { getRunPrompt, getBurstPrompt, getPipelinePrompt, getTillDonePrompt, getMetaPrompt } from "../src/prompts/templates.js";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(__filename), "..");
const EXTENSIONS_DIR = join(PROJECT_ROOT, "extensions");
const PI_EXTENSIONS_DIR = join(homedir(), ".pi", "agent", "extensions");

// Auto-load secrets on startup
loadSecrets();

// Pi's native --thinking levels: off, low, medium, high, xhigh
// pcop aliases: off, low, medium, high, max -> mapped in client.ts THINKING_LEVELS

const program = new Command();

program
  .name("pcop")
  .description("Pi Co-Processor — Claude Code's agent delegation bridge")
  .version("1.0.0");

// ── pcop run ──
program
  .command("run")
  .description("General dispatch to Pi agent")
  .argument("<prompt...>", "Task prompt for Pi")
  .option("-m, --model <alias>", "Model alias (gemini-flash, gemini-pro, claude-sonnet, claude-opus)", "gemini-flash")
  .option("-d, --cwd <dir>", "Working directory for Pi", process.cwd())
  .option("-t, --timeout <ms>", "Timeout in milliseconds", "300000")
  .option("--yolo", "Skip Pi confirmations", false)
  .option("--no-cache", "Disable response caching")
  .option("--tier <level>", "Thinking depth: off, low, medium, high, max")
  .action(async (promptParts: string[], opts) => {
    const prompt = promptParts.join(" ");
    const [system, user] = getRunPrompt(prompt);

    const result = await spawnPi({
      prompt: `${system}\n\n${user}`,
      model: opts.model,
      cwd: opts.cwd,
      yolo: opts.yolo,
      timeout: parseInt(opts.timeout),
      useCache: false,
      taskLabel: "run",
      thinking: opts.tier,
    });
    output(result as unknown as Record<string, unknown>);
  });

// ── pcop till-done ──
program
  .command("till-done")
  .description("Loop until done signal detected")
  .argument("<prompt...>", "Task prompt")
  .option("-m, --model <alias>", "Model alias", "gemini-flash")
  .option("-d, --cwd <dir>", "Working directory", process.cwd())
  .option("-t, --timeout <ms>", "Timeout per iteration", "300000")
  .option("--done-signal <signal>", "Completion signal string", "TASK_COMPLETE")
  .option("--max-turns <n>", "Maximum iterations", "20")
  .option("--yolo", "Skip confirmations", false)
  .option("--tier <level>", "Thinking depth: low, medium, high, max")
  .action(async (promptParts: string[], opts) => {
    const prompt = promptParts.join(" ");
    const [system, user] = getTillDonePrompt(prompt, opts.doneSignal);
    const maxTurns = parseInt(opts.maxTurns);
    const allToolCalls: unknown[] = [];
    const allFilesModified = new Set<string>();
    let totalCost = 0;
    let lastResponse = "";

    // Stall detection: track recent responses to detect infinite loops
    const recentResponses: string[] = [];
    const STALL_WINDOW = 3; // number of identical responses to trigger stall

    for (let turn = 0; turn < maxTurns; turn++) {
      const iterPrompt = turn === 0
        ? `${system}\n\n${user}`
        : `${system}\n\nPrevious result:\n${lastResponse}\n\nContinue working. Remember to output ${opts.doneSignal} when done.`;

      const result = await spawnPi({
        prompt: iterPrompt,
        model: opts.model,
        cwd: opts.cwd,
        yolo: opts.yolo,
        timeout: parseInt(opts.timeout),
        taskLabel: `till-done-${turn}`,
        thinking: opts.tier,
      });

      allToolCalls.push(...result.tool_calls);
      result.files_modified.forEach((f) => allFilesModified.add(f));
      totalCost += result.cost_usd;
      lastResponse = result.response;

      if (result.response.includes(opts.doneSignal)) {
        output({
          status: "ok",
          response: result.response,
          model: result.model,
          turns: turn + 1,
          cost_usd: Math.round(totalCost * 1_000_000) / 1_000_000,
          tool_calls: allToolCalls,
          files_modified: [...allFilesModified],
          done_signal_found: true,
        });
        return;
      }

      if (result.status === "error") {
        output({
          status: "error",
          error: `Pi errored on turn ${turn + 1}: ${result.error}`,
          turns: turn + 1,
          cost_usd: totalCost,
          last_response: lastResponse,
        });
        return;
      }

      // Stall detection: check if response is identical to recent ones
      const responseFingerprint = result.response.trim().slice(0, 500);
      recentResponses.push(responseFingerprint);
      if (recentResponses.length >= STALL_WINDOW) {
        const window = recentResponses.slice(-STALL_WINDOW);
        const allSame = window.every((r) => r === window[0]);
        if (allSame) {
          // Dump state to error file
          const { writeFileSync: wfs, mkdirSync: mds } = await import("node:fs");
          const errorDir = join(opts.cwd, ".pi_workspace", "errors");
          mds(errorDir, { recursive: true });
          const errorFile = join(errorDir, `stall-${Date.now()}.md`);
          wfs(errorFile, [
            `# Till-Done Stall Detected`,
            ``,
            `**Turn**: ${turn + 1}/${maxTurns}`,
            `**Cost so far**: $${totalCost.toFixed(4)}`,
            `**Stall pattern**: Agent produced identical response ${STALL_WINDOW} times`,
            ``,
            `## Last Response`,
            `\`\`\``,
            lastResponse.slice(0, 2000),
            `\`\`\``,
            ``,
            `## Files Modified`,
            [...allFilesModified].map((f) => `- ${f}`).join("\n") || "None",
          ].join("\n"));

          output({
            status: "error",
            error: `Stall detected: identical response ${STALL_WINDOW} consecutive turns. State dumped to ${errorFile}`,
            turns: turn + 1,
            cost_usd: totalCost,
            stall_file: errorFile,
            last_response: lastResponse.slice(0, 500),
            files_modified: [...allFilesModified],
          });
          return;
        }
      }
    }

    output({
      status: "error",
      error: `Max turns (${maxTurns}) reached without ${opts.doneSignal}`,
      turns: maxTurns,
      cost_usd: totalCost,
      last_response: lastResponse,
      files_modified: [...allFilesModified],
    });
  });

// ── pcop pipeline ──
program
  .command("pipeline")
  .description("Execute YAML agent chain")
  .argument("<file>", "Pipeline YAML file")
  .option("-d, --cwd <dir>", "Working directory", process.cwd())
  .option("--yolo", "Skip confirmations", false)
  .action(async (file: string, opts) => {
    let yaml: typeof import("js-yaml");
    try {
      yaml = await import("js-yaml");
    } catch {
      output({ status: "error", error: "js-yaml not installed. Run: npm install js-yaml" });
      return;
    }

    const filePath = resolve(file);
    if (!existsSync(filePath)) {
      output({ status: "error", error: `Pipeline file not found: ${filePath}` });
      return;
    }

    const content = readFileSync(filePath, "utf-8");
    const pipeline = yaml.load(content) as { name: string; stages: Array<{ name: string; prompt: string; model?: string }> };

    if (!pipeline?.stages?.length) {
      output({ status: "error", error: "Invalid pipeline: no stages defined" });
      return;
    }

    const results: Record<string, string> = {};
    const stageResults: unknown[] = [];
    let totalCost = 0;

    for (const stage of pipeline.stages) {
      const [system, user] = getPipelinePrompt(stage.name, stage.prompt, results);
      const fullPrompt = `${system}\n\n${user}`;

      const result = await spawnPi({
        prompt: fullPrompt,
        model: stage.model || "gemini-flash",
        cwd: opts.cwd,
        yolo: opts.yolo,
        taskLabel: `pipeline-${stage.name}`,
      });

      results[stage.name] = result.response;
      totalCost += result.cost_usd;
      stageResults.push({
        name: stage.name,
        status: result.status,
        model: result.model,
        cost_usd: result.cost_usd,
        files_modified: result.files_modified,
        response_preview: result.response.slice(0, 200),
      });

      if (result.status === "error") {
        output({
          status: "error",
          error: `Pipeline failed at stage "${stage.name}": ${result.error}`,
          completed_stages: stageResults,
          total_cost: totalCost,
        });
        return;
      }
    }

    output({
      status: "ok",
      pipeline: pipeline.name,
      stages: stageResults,
      total_cost: Math.round(totalCost * 1_000_000) / 1_000_000,
    });
  });

// ── pcop burst ──
program
  .command("burst")
  .description("Parallel multi-file processing")
  .requiredOption("--files <glob>", "File glob pattern")
  .requiredOption("--op <operation>", "Operation to perform on each file")
  .option("-m, --model <alias>", "Model alias", "gemini-flash")
  .option("-d, --cwd <dir>", "Working directory", process.cwd())
  .option("-t, --timeout <ms>", "Timeout per file", "300000")
  .option("--yolo", "Skip confirmations", false)
  .option("-c, --concurrency <n>", "Max concurrent Pi instances", "4")
  .option("--tier <level>", "Thinking depth: low, medium, high, max")
  .option("--summary <path>", "Write summary to markdown file instead of full JSON stdout")
  .action(async (opts) => {
    // Expand glob using bash
    const globResult = spawnSync("bash", ["-c", `ls ${opts.files} 2>/dev/null`], { cwd: opts.cwd });
    const files = globResult.stdout.toString().trim().split("\n").filter(Boolean);

    if (!files.length) {
      output({ status: "error", error: `No files matched: ${opts.files}` });
      return;
    }

    const concurrency = parseInt(opts.concurrency);
    const results: unknown[] = [];
    let totalCost = 0;

    // Process in batches
    for (let i = 0; i < files.length; i += concurrency) {
      const batch = files.slice(i, i + concurrency);
      const promises = batch.map(async (file) => {
        const [system, user] = getBurstPrompt(file, opts.op);
        const prompt = `${system}\n\n${user}`;

        // Per-item retry with backoff for rate limits
        let lastErr: string | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          const result = await spawnPi({
            prompt,
            model: opts.model,
            cwd: opts.cwd,
            yolo: opts.yolo,
            timeout: parseInt(opts.timeout),
            taskLabel: `burst-${basename(file)}`,
            thinking: opts.tier,
          });
          // Retry on rate limit
          if (result.status === "error" && /429|rate.limit|too many/i.test(result.error || "")) {
            lastErr = result.error;
            await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
            continue;
          }
          return { file, ...result };
        }
        return { file, status: "error" as const, response: "", model: "", cost_usd: 0, latency_ms: 0, cached: false, tool_calls: [], files_modified: [], exit_code: 1, error: `Rate limited after 3 retries: ${lastErr}` };
      });

      const batchResults = await Promise.all(promises);
      for (const r of batchResults) {
        totalCost += r.cost_usd;
        results.push({
          file: r.file,
          status: r.status,
          response_preview: r.response.slice(0, 200),
          response_full: r.response,
          files_modified: r.files_modified,
          cost_usd: r.cost_usd,
        });
      }
    }

    const totalCostRounded = Math.round(totalCost * 1_000_000) / 1_000_000;

    // Write summary to file if --summary flag provided (context rot prevention)
    if (opts.summary) {
      const { writeFileSync: wfs, mkdirSync: mds } = await import("node:fs");
      const { dirname: dn } = await import("node:path");
      const summaryPath = resolve(opts.summary);
      mds(dn(summaryPath), { recursive: true });
      const lines = [
        `# Burst Summary`,
        ``,
        `**Operation**: ${opts.op}`,
        `**Files processed**: ${files.length}`,
        `**Total cost**: $${totalCostRounded}`,
        `**Model**: ${opts.model}`,
        ``,
        `| File | Status | Preview |`,
        `|------|--------|---------|`,
      ];
      for (const r of results as Array<{ file: string; status: string; response_preview: string }>) {
        lines.push(`| \`${r.file}\` | ${r.status} | ${r.response_preview.replace(/\n/g, " ").slice(0, 80)} |`);
      }
      wfs(summaryPath, lines.join("\n") + "\n");
      output({
        status: "ok",
        files_processed: files.length,
        total_cost: totalCostRounded,
        summary_file: summaryPath,
        hint: "Full results written to summary file. Read it to review.",
      });
    } else {
      output({
        status: "ok",
        files_processed: files.length,
        results,
        total_cost: totalCostRounded,
      });
    }
  });

// ── pcop meta ──
program
  .command("meta")
  .description("Generate a new Pi extension using Pi itself")
  .argument("<description...>", "Description of the extension to create")
  .option("-m, --model <alias>", "Model alias", "gemini-pro")
  .option("--yolo", "Skip confirmations", false)
  .action(async (descParts: string[], opts) => {
    const description = descParts.join(" ");
    const [system, user] = getMetaPrompt(description);

    const result = await spawnPi({
      prompt: `${system}\n\n${user}`,
      model: opts.model,
      cwd: EXTENSIONS_DIR,
      yolo: opts.yolo,
      taskLabel: "meta-create",
    });

    output({
      status: result.status,
      response: result.response,
      files_modified: result.files_modified,
      cost_usd: result.cost_usd,
      hint: "Run 'pcop ext deploy' to symlink new extensions to Pi",
    });
  });

// ── pcop cost ──
program
  .command("cost")
  .description("Show today's spending report")
  .option("--date <YYYY-MM-DD>", "Show costs for a specific date")
  .action((opts) => {
    output(cost.summary(opts.date));
  });

// ── pcop models ──
program
  .command("models")
  .description("List available model aliases")
  .action(() => {
    const models = listModels();
    output({
      status: "ok",
      aliases: models,
      default: "gemini-flash",
      thinking_levels: ["off", "low", "medium", "high", "max"],
      routing: "Use --model ALIAS or --model provider/model-id. --tier sets Pi's native thinking level.",
      tip: "Any provider/model-id combo works if the API key is configured (e.g., --model openai/gpt-4o)",
    });
  });

// ── pcop install ──
program
  .command("install")
  .description("Install Pi globally + deploy config + extensions + symlinks")
  .option("--skip-pi", "Skip Pi global install (if already installed)")
  .action(async (opts) => {
    const steps: Array<{ step: string; status: string; detail?: string }> = [];

    // 1. Check/install tsx globally
    try {
      execSync("tsx --version", { stdio: "pipe" });
      steps.push({ step: "tsx", status: "already_installed" });
    } catch {
      try {
        execSync("npm install -g tsx", { stdio: "pipe" });
        steps.push({ step: "tsx", status: "installed" });
      } catch (e) {
        steps.push({ step: "tsx", status: "failed", detail: String(e) });
      }
    }

    // 2. Install Pi globally
    if (!opts.skipPi) {
      try {
        execSync("pi --version", { stdio: "pipe" });
        steps.push({ step: "pi", status: "already_installed" });
      } catch {
        try {
          execSync("npm install -g @mariozechner/pi-coding-agent", { stdio: "pipe", timeout: 120000 });
          steps.push({ step: "pi", status: "installed" });
        } catch (e) {
          steps.push({ step: "pi", status: "failed", detail: String(e) });
        }
      }
    }

    // 3. npm install in claude-pi/
    try {
      execSync("npm install", { cwd: PROJECT_ROOT, stdio: "pipe" });
      steps.push({ step: "npm_install", status: "ok" });
    } catch (e) {
      steps.push({ step: "npm_install", status: "failed", detail: String(e) });
    }

    // 4. Deploy Pi config
    try {
      const { settingsPath, modelsPath } = deployConfig();
      steps.push({ step: "config", status: "ok", detail: `${settingsPath}, ${modelsPath}` });
    } catch (e) {
      steps.push({ step: "config", status: "failed", detail: String(e) });
    }

    // 5. Symlink extensions
    try {
      mkdirSync(PI_EXTENSIONS_DIR, { recursive: true });
      const extFiles = readdirSync(EXTENSIONS_DIR).filter((f) => f.endsWith(".ts"));
      for (const ext of extFiles) {
        const target = join(EXTENSIONS_DIR, ext);
        const link = join(PI_EXTENSIONS_DIR, ext);
        try { unlinkSync(link); } catch { /* doesn't exist */ }
        symlinkSync(target, link);
      }
      steps.push({ step: "extensions", status: "ok", detail: `${extFiles.length} extensions linked` });
    } catch (e) {
      steps.push({ step: "extensions", status: "failed", detail: String(e) });
    }

    // 6. Symlink CLI
    const cliTarget = join(PROJECT_ROOT, "bin", "pcop");
    const cliLink = "/usr/local/bin/pcop";
    try {
      chmodSync(cliTarget, 0o755);
      try { unlinkSync(cliLink); } catch { /* doesn't exist */ }
      symlinkSync(cliTarget, cliLink);
      steps.push({ step: "cli_symlink", status: "ok", detail: cliLink });
    } catch (e) {
      steps.push({ step: "cli_symlink", status: "failed", detail: String(e) });
    }

    // 7. Verify Pi
    let piVersion = "unknown";
    try {
      piVersion = execSync("pi --version", { stdio: "pipe" }).toString().trim();
    } catch { /* not installed */ }

    const failed = steps.filter((s) => s.status === "failed");
    output({
      status: failed.length > 0 ? "partial" : "ok",
      pi_version: piVersion,
      steps,
      failed_count: failed.length,
    });
  });

// ── pcop ext ──
const ext = program
  .command("ext")
  .description("Extension management");

ext
  .command("list")
  .description("List installed extensions")
  .action(() => {
    const extensions: Array<{ name: string; source: string; deployed: boolean }> = [];

    if (existsSync(EXTENSIONS_DIR)) {
      for (const f of readdirSync(EXTENSIONS_DIR).filter((f) => f.endsWith(".ts"))) {
        const deployed = existsSync(join(PI_EXTENSIONS_DIR, f));
        extensions.push({
          name: f.replace(".ts", ""),
          source: join(EXTENSIONS_DIR, f),
          deployed,
        });
      }
    }

    output({
      status: "ok",
      extensions,
      extensions_dir: EXTENSIONS_DIR,
      pi_extensions_dir: PI_EXTENSIONS_DIR,
    });
  });

ext
  .command("deploy")
  .description("Deploy extensions to Pi")
  .action(() => {
    mkdirSync(PI_EXTENSIONS_DIR, { recursive: true });
    const deployed: string[] = [];

    if (existsSync(EXTENSIONS_DIR)) {
      for (const f of readdirSync(EXTENSIONS_DIR).filter((f) => f.endsWith(".ts"))) {
        const target = join(EXTENSIONS_DIR, f);
        const link = join(PI_EXTENSIONS_DIR, f);
        try { unlinkSync(link); } catch { /* ignore */ }
        symlinkSync(target, link);
        deployed.push(f);
      }
    }

    output({ status: "ok", deployed, count: deployed.length });
  });

ext
  .command("test")
  .description("Test extension syntax")
  .argument("[name]", "Extension name to test (or all)")
  .action((name?: string) => {
    const files = name
      ? [join(EXTENSIONS_DIR, `${name}.ts`)]
      : (existsSync(EXTENSIONS_DIR)
        ? readdirSync(EXTENSIONS_DIR).filter((f) => f.endsWith(".ts")).map((f) => join(EXTENSIONS_DIR, f))
        : []);

    const results: Array<{ name: string; valid: boolean; error?: string }> = [];
    for (const file of files) {
      if (!existsSync(file)) {
        results.push({ name: basename(file), valid: false, error: "File not found" });
        continue;
      }
      // Typecheck with tsx
      const check = spawnSync("npx", ["tsx", "--eval", `import("${file}")`], {
        cwd: PROJECT_ROOT,
        stdio: "pipe",
        timeout: 10000,
      });
      results.push({
        name: basename(file, ".ts"),
        valid: check.status === 0,
        error: check.status !== 0 ? check.stderr.toString().slice(0, 200) : undefined,
      });
    }

    output({ status: "ok", results });
  });

// ── pcop cache-clear ──
program
  .command("cache-clear")
  .description("Clear response cache")
  .action(() => {
    const count = cache.clear();
    output({ status: "ok", cleared: count });
  });

program.parse();
