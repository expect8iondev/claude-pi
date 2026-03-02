/**
 * Cost Guard Extension — per-session budget enforcement.
 * Hooks into turn_end events, tracks cumulative cost, aborts if budget exceeded.
 */

const DEFAULT_SESSION_BUDGET = 1.0; // USD

export default function costGuard(pi: any): void {
  const budget = parseFloat(pi.getFlag?.("session-budget") || String(DEFAULT_SESSION_BUDGET));
  let totalCost = 0;
  let totalTokens = 0;
  let turns = 0;

  pi.on("turn_end", (event: any) => {
    turns++;

    // Try to get actual usage from Pi context
    const usage = pi.getContextUsage?.() || event.usage || {};
    const inputTokens = usage.input_tokens || usage.promptTokens || 0;
    const outputTokens = usage.output_tokens || usage.completionTokens || 0;

    totalTokens += inputTokens + outputTokens;

    // Heuristic cost: assume Gemini Flash pricing if not available
    const inputCost = (inputTokens * 0.15) / 1_000_000;
    const outputCost = (outputTokens * 0.60) / 1_000_000;
    totalCost += inputCost + outputCost;

    if (totalCost >= budget) {
      pi.emit("cost_guard_alert", {
        message: `Session budget exceeded: $${totalCost.toFixed(4)} >= $${budget.toFixed(2)}`,
        total_cost: totalCost,
        budget,
        turns,
      });
      // Request abort
      if (pi.abort) {
        pi.abort(`CostGuard: Session budget of $${budget.toFixed(2)} exceeded`);
      }
    }
  });

  pi.on("session_shutdown", () => {
    pi.emit("cost_guard_summary", {
      total_cost: Math.round(totalCost * 1_000_000) / 1_000_000,
      total_tokens: totalTokens,
      turns,
      budget,
      within_budget: totalCost < budget,
    });
  });
}
