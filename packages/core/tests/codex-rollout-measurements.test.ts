import { describe, expect, it } from "vite-plus/test";
import {
  measurementAlarms,
  parseCodexRolloutMeasurements,
} from "../src/codex-rollout-measurements.ts";

describe("Codex rollout measurements", () => {
  it("separates provider input/window receipts from native compact freshness", () => {
    const text = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00Z",
        type: "compacted",
        payload: { message: 'lhc_compact_durable {"viewId":"v1"}' },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:01:00Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 175_514 },
            model_context_window: 258_400,
          },
        },
      }),
    ].join("\n");

    expect(parseCodexRolloutMeasurements(text)).toEqual({
      latestProviderInputTokens: 175_514,
      modelContextWindow: 258_400,
      latestProviderUsageAt: "2026-01-01T00:01:00Z",
      latestNativeCompactAt: "2026-01-01T00:00:00Z",
      latestNativeCompactViewId: "v1",
    });
  });

  it("keeps unavailable host facts null instead of inventing estimates", () => {
    expect(parseCodexRolloutMeasurements("not json\n{}\n")).toEqual({
      latestProviderInputTokens: null,
      modelContextWindow: null,
      latestProviderUsageAt: null,
      latestNativeCompactAt: null,
      latestNativeCompactViewId: null,
    });
  });

  it("alarms on impossible projections and newer unmatched native compacts", () => {
    expect(
      measurementAlarms({
        projectedViewTokens: 300_000,
        modelContextWindow: 258_400,
        currentViewId: "v1",
        currentViewCreatedAt: "2026-01-01T00:00:00Z",
        latestNativeCompactAt: "2026-01-01T00:01:00Z",
        latestNativeCompactViewId: null,
      }),
    ).toEqual([
      "projected LHC view exceeds the provider-reported model window",
      "native host compact is newer than the current LHC view",
    ]);
  });

  it("does not carry an older LHC view id onto a newer receipt-less native compact", () => {
    const text = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00Z",
        type: "compacted",
        payload: { message: 'lhc_compact_durable {"viewId":"v1"}' },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:02:00Z",
        type: "compacted",
        payload: { message: "native compact without an LHC receipt" },
      }),
    ].join("\n");

    const measurements = parseCodexRolloutMeasurements(text);
    expect(measurements.latestNativeCompactViewId).toBeNull();
    expect(
      measurementAlarms({
        projectedViewTokens: 10,
        modelContextWindow: 100,
        currentViewId: "v1",
        currentViewCreatedAt: "2026-01-01T00:00:00Z",
        latestNativeCompactAt: measurements.latestNativeCompactAt,
        latestNativeCompactViewId: measurements.latestNativeCompactViewId,
      }),
    ).toContain("native host compact is newer than the current LHC view");
  });
});
