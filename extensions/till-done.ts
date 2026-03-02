/**
 * Till Done Extension — deterministic loop enforcement.
 * Keeps Pi running until a done-signal is detected in the agent's output.
 */

const DEFAULT_DONE_SIGNAL = "TASK_COMPLETE";
const DEFAULT_MAX_TURNS = 20;

export default function tillDone(pi: any): void {
  const doneSignal = pi.getFlag?.("done-signal") || DEFAULT_DONE_SIGNAL;
  const maxTurns = parseInt(pi.getFlag?.("max-turns") || String(DEFAULT_MAX_TURNS));
  let currentTurn = 0;
  let completed = false;

  // Inject done-signal instruction at session start
  pi.on("before_agent_start", (event: any) => {
    const instruction = [
      `\n\n[DETERMINISTIC LOOP MODE]`,
      `When you have fully completed the assigned task, output exactly: ${doneSignal}`,
      `Do NOT output ${doneSignal} until ALL work is genuinely done.`,
      `If you encounter errors, fix them and continue. You have up to ${maxTurns} turns.`,
    ].join("\n");

    if (event.prompt && typeof event.prompt === "string") {
      event.prompt += instruction;
    }
  });

  // Check for done signal after each agent turn
  pi.on("agent_end", (event: any) => {
    currentTurn++;
    const content = String(event.content || event.message || event.text || "");

    if (content.includes(doneSignal)) {
      completed = true;
      pi.emit("till_done_complete", {
        turns: currentTurn,
        signal: doneSignal,
      });
      return; // Let Pi stop normally
    }

    if (currentTurn >= maxTurns) {
      pi.emit("till_done_max_reached", {
        turns: currentTurn,
        max_turns: maxTurns,
        signal: doneSignal,
      });
      if (pi.abort) {
        pi.abort(`TillDone: Max turns (${maxTurns}) reached without ${doneSignal}`);
      }
      return;
    }

    // Re-prompt Pi to continue
    if (pi.continueAgent) {
      pi.continueAgent(`Continue working. Output ${doneSignal} when done. Turn ${currentTurn}/${maxTurns}.`);
    }
  });

  pi.on("session_shutdown", () => {
    pi.emit("till_done_summary", {
      completed,
      turns: currentTurn,
      max_turns: maxTurns,
      signal: doneSignal,
    });
  });
}
