# Claude-Pi

Co-processor CLI that delegates deterministic coding tasks from Claude Code to [Pi](https://github.com/mariozechner/pi-agent), a lightweight AI agent. Claude handles ambiguity and coordination (80%); Pi handles loops, parallel file ops, pipelines, and meta-agent creation (20%).

## Architecture

```
Claude Code (orchestrator)
    |
    +-- pcop run "task"          --- spawns --> pi --mode json
    +-- pcop till-done "task"    --- loops  --> pi --mode json (x N, stall-protected)
    +-- pcop pipeline spec.yaml  --- chains --> pi --mode json (x stages)
    +-- pcop burst --files *.ts  --- fans   --> pi --mode json (x files, rate-limited)
                                       |
                                       +-- damage-control.ts (YOLO firewall, always active)
```

## Commands

| Command | Purpose | Default Model |
|---------|---------|---------------|
| `pcop run PROMPT` | General Pi dispatch | gemini-flash |
| `pcop till-done PROMPT` | Loop until TASK_COMPLETE | gemini-flash |
| `pcop pipeline FILE` | YAML agent chain | per-stage |
| `pcop burst --files GLOB --op "task"` | Parallel multi-file | gemini-flash |
| `pcop meta DESCRIPTION` | Generate new extension | gemini-pro |
| `pcop cost` | Today's spending report | - |
| `pcop models` | List available models | - |
| `pcop install` | Install Pi + deploy config | - |

## Safety Architecture

### Damage Control (YOLO Firewall)

`--yolo` bypasses human confirmation prompts. It does **not** bypass security hardcodes. `damage-control.ts` hard-blocks even in YOLO mode:

- **Filesystem destruction**: `rm -rf /`, `chmod -R 777 /`, `mkfs`
- **Git destruction**: `git push --force origin main`, `git reset --hard origin/`
- **Database destruction**: `DROP TABLE`, `TRUNCATE`, `DELETE FROM` without WHERE
- **System destruction**: `shutdown`, `reboot`, stopping critical services
- **Secrets exposure**: piping `.env`/`.key` files to `curl`
- **Protected paths**: `~/.secrets/`, `~/.ssh/`, `/etc/passwd`, `/boot/`

### Stall Detection

If Pi produces identical responses 3 consecutive turns, execution is suspended and state is dumped to `.pi_workspace/errors/stall-{timestamp}.md` for manual review.

### Rate Limit Protection

Each burst item retries up to 3x with exponential backoff (2s, 4s, 6s) on HTTP 429. Concurrency defaults to 4 parallel instances.

## Extensions

| Extension | Purpose | Hook |
|-----------|---------|------|
| `damage-control` | Block catastrophic commands | `tool_call` |
| `error-scraper` | Capture structured errors | `tool_result` |
| `cost-guard` | Session budget enforcement | `turn_end` |
| `pure-focus` | Path scope locking | `tool_call` |
| `till-done` | Deterministic loop control | `agent_end` |
| `meta-creator` | Agents building agents | `command` |

## Model Routing

| Alias | Model | Use Case |
|-------|-------|----------|
| `gemini-flash` | Gemini 2.5 Flash | Default, speed, bulk |
| `gemini-pro` | Gemini 2.5 Pro | Complex refactoring |
| `claude-sonnet` | Claude Sonnet 4.5 | Code generation |
| `claude-opus` | Claude Opus 4.6 | Complex agentic tasks |

Any `provider/model-id` string works if the API key is configured.

## Setup

```bash
git clone https://github.com/herakles-dev/claude-pi.git
cd claude-pi
npm install

# Set API keys (at minimum, one of these)
export GEMINI_API_KEY="your-key"
export ANTHROPIC_API_KEY="your-key"

# Or point to an .env file
export PCOP_SECRETS_PATH="~/.secrets/.env"

# Install Pi + deploy config + extensions
npx tsx bin/pcop.ts install
```

Requires: Node.js 20+, [Pi agent](https://github.com/mariozechner/pi-agent)

## Project Structure

```
bin/
  pcop              # Bash wrapper
  pcop.ts           # CLI implementation (commander)
src/
  client.ts         # Core Pi spawner (spawnPi, parsePiEvents, routeModel)
  cache.ts          # SHA256 response cache
  cost.ts           # Usage tracking + budget enforcement
  config.ts         # Pi settings/models generation
  secrets.ts        # Auto-load API keys from .env
  output.ts         # JSON output helper
  prompts/
    templates.ts    # Task-specific prompt templates
extensions/
  damage-control.ts # YOLO firewall (25 blocked patterns)
  cost-guard.ts     # Per-session budget
  error-scraper.ts  # Error pattern capture
  pure-focus.ts     # Path scope locking
  till-done.ts      # Deterministic loop control
  meta-creator.ts   # Extension generator
pipelines/
  scout-plan-build.yaml  # Three-stage reconnaissance pipeline
  self-audit.yaml        # Meta-engineering: Pi audits its own codebase
config/
  models.yml        # Model specs, pricing, routing rules
```

## Tech Stack

TypeScript, Node.js, Commander.js

---

Built by [D. Michael Piscitelli](https://github.com/herakles-dev) | [herakles.dev](https://herakles.dev)
