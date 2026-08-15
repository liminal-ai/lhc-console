import { closeSync, openSync, readSync, statSync } from "node:fs";

const ROLLOUT_TAIL_BYTES = 2 * 1024 * 1024;

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
      latestNativeCompactAt = timestamp;
      latestNativeCompactViewId = null;
      if (typeof event.payload === "object" && event.payload) {
        const message = (event.payload as Record<string, unknown>).message;
        if (typeof message === "string") {
          const match = message.match(/lhc_compact_durable\s+(\{.*\})/s);
          if (match) {
            try {
              const receipt = JSON.parse(match[1]) as Record<string, unknown>;
              if (typeof receipt.viewId === "string") latestNativeCompactViewId = receipt.viewId;
            } catch {
              // A native compact without a valid LHC receipt remains a native compact.
            }
          }
        }
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
  modelContextWindow: number | null;
  currentViewId: string | null;
  currentViewCreatedAt: string | null;
  latestNativeCompactAt: string | null;
  latestNativeCompactViewId: string | null;
}

export function measurementAlarms(input: MeasurementAlarmInput): string[] {
  const alarms: string[] = [];
  if (input.modelContextWindow != null && input.projectedViewTokens > input.modelContextWindow) {
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

export function readCodexRolloutMeasurements(path: string): CodexRolloutMeasurements | null {
  let fd: number;
  let size: number;
  try {
    size = statSync(path).size;
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const start = Math.max(0, size - ROLLOUT_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return parseCodexRolloutMeasurements(text);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
