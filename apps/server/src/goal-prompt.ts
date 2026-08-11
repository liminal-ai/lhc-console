export function renderGoalReminderPrompt(goalId: string, objective: string): string {
  return `[LHC system goal reminder]
Goal: ${goalId}
Objective: ${objective}

This is a scheduled reminder to continue work on the goal above — not a new owner request.

Continue the objective. When your judgment reaches a stopping point, mark this goal:
  lhc-agent goal done ${goalId}
  lhc-agent goal blocked ${goalId} "reason"`;
}
