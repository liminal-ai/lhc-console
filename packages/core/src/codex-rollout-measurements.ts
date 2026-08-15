import { readFileSync, statSync } from "node:fs";

export interface CodexRolloutMeasurements {
  latestProviderInputTokens: number | null;
  modelContextWindow: number | null;
  latestProviderUsageAt: string | null;
  latestNativeCompactAt: string | null;
  latestNativeCompactViewId: string | null;
}

interface CodexEvent {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Parse only facts the native Codex rollout explicitly reports. */
export function parseCodexRolloutMeasurements(text: string): CodexRolloutMeasurements {
  let latestProviderInputTokens: number | null = null;
  let modelContextWindow: number | null = null;
  let latestProviderUsageAt: string | null = null;
  let latestNativeCompactAt: string | null = null;
  let latestNativeCompactViewId: string | null = null;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event: CodexEvent;
    try {
      event = JSON.parse(line) as CodexEvent;
    } catch {
      continue;
    }
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : null;
    if (event.type === "compacted" && timestamp) {
      let validLhcReceipt = false;
      if (typeof event.payload === "object" && event.payload) {
        const message = (event.payload as Record<string, unknown>).message;
        if (typeof message === "string") {
          const match = message.match(/lhc_compact_durable\s+(\{.*\})/s);
          if (match) {
            try {
              const receipt = JSON.parse(match[1]) as Record<string, unknown>;
              validLhcReceipt = typeof receipt.viewId === "string";
            } catch {
              // A compact with a malformed receipt is not attributable to LHC.
            }
          }
        }
      }
      if (!validLhcReceipt) {
        latestNativeCompactAt = timestamp;
        latestNativeCompactViewId = null;
      }
    }
    if (event.type !== "event_msg" || typeof event.payload !== "object" || !event.payload) continue;
    const payload = event.payload as Record<string, unknown>;
    if (payload.type !== "token_count" || typeof payload.info !== "object" || !payload.info)
      continue;
    const info = payload.info as Record<string, unknown>;
    const last =
      typeof info.last_token_usage === "object" && info.last_token_usage
        ? (info.last_token_usage as Record<string, unknown>)
        : null;
    const input = finiteNumber(last?.input_tokens);
    if (input != null) latestProviderInputTokens = input;
    modelContextWindow = finiteNumber(info.model_context_window) ?? modelContextWindow;
    if (timestamp) latestProviderUsageAt = timestamp;
  }

  return {
    latestProviderInputTokens,
    modelContextWindow,
    latestProviderUsageAt,
    latestNativeCompactAt,
    latestNativeCompactViewId,
  };
}

export interface MeasurementAlarmInput {
  projectedViewTokens: number;
  projectedViewIsUpperBound: boolean;
  modelContextWindow: number | null;
  currentViewId: string | null;
  currentViewCreatedAt: string | null;
  latestNativeCompactAt: string | null;
  latestNativeCompactViewId: string | null;
}

export function measurementAlarms(input: MeasurementAlarmInput): string[] {
  const alarms: string[] = [];
  if (
    !input.projectedViewIsUpperBound &&
    input.modelContextWindow != null &&
    input.projectedViewTokens > input.modelContextWindow
  ) {
    alarms.push("projected LHC view exceeds the provider-reported model window");
  }
  if (
    input.latestNativeCompactAt &&
    input.currentViewCreatedAt &&
    Date.parse(input.latestNativeCompactAt) > Date.parse(input.currentViewCreatedAt) &&
    input.latestNativeCompactViewId !== input.currentViewId
  ) {
    alarms.push("native host compact is newer than the current LHC view");
  }
  return alarms;
}

function hasRecognizedMeasurementEvent(text: string): boolean {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as CodexEvent;
      if (event.type === "compacted") return true;
      if (event.type !== "event_msg" || typeof event.payload !== "object" || !event.payload)
        continue;
      if ((event.payload as Record<string, unknown>).type === "token_count") return true;
    } catch {
      // Ignore malformed lines while looking for a usable rollout artifact.
    }
  }
  return false;
}

export function readCodexRolloutMeasurements(path: string): CodexRolloutMeasurements | null {
  try {
    const text = readFileSync(path, "utf8");
    return hasRecognizedMeasurementEvent(text) ? parseCodexRolloutMeasurements(text) : null;
  } catch {
    return null;
  }
}

/** Read the newest valid artifact, independent of filesystem/glob ordering. */
export function readNewestCodexRolloutMeasurements(
  paths: string[],
): CodexRolloutMeasurements | null {
  const newestFirst = paths
    .flatMap((path) => {
      try {
        return [{ path, mtimeMs: statSync(path).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  for (const { path } of newestFirst) {
    const measurements = readCodexRolloutMeasurements(path);
    if (measurements) return measurements;
  }
  return null;
}
