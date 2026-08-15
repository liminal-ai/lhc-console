import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  measurementAlarms,
  parseCodexRolloutMeasurements,
  readCodexRolloutMeasurements,
  readNewestCodexRolloutMeasurements,
} from "../src/codex-rollout-measurements.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rollout(name: string, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lhc-console-codex-rollout-"));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

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
      latestNativeCompactAt: null,
      latestNativeCompactViewId: null,
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
        projectedViewIsUpperBound: false,
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

  it("does not compare a pre-pruning upper estimate to the provider window", () => {
    expect(
      measurementAlarms({
        projectedViewTokens: 300_000,
        projectedViewIsUpperBound: true,
        modelContextWindow: 258_400,
        currentViewId: "v1",
        currentViewCreatedAt: "2026-01-01T00:00:00Z",
        latestNativeCompactAt: null,
        latestNativeCompactViewId: null,
      }),
    ).not.toContain("projected LHC view exceeds the provider-reported model window");
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
        projectedViewIsUpperBound: false,
        modelContextWindow: 100,
        currentViewId: "v1",
        currentViewCreatedAt: "2026-01-01T00:00:00Z",
        latestNativeCompactAt: measurements.latestNativeCompactAt,
        latestNativeCompactViewId: measurements.latestNativeCompactViewId,
      }),
    ).toContain("native host compact is newer than the current LHC view");
  });

  it("does not classify a valid LHC compact receipt as native or alarm on it", () => {
    const measurements = parseCodexRolloutMeasurements(
      JSON.stringify({
        timestamp: "2026-01-01T00:02:00Z",
        type: "compacted",
        payload: { message: 'lhc_compact_durable {"viewId":"v2"}' },
      }),
    );

    expect(measurements.latestNativeCompactAt).toBeNull();
    expect(
      measurementAlarms({
        projectedViewTokens: 10,
        projectedViewIsUpperBound: false,
        modelContextWindow: 100,
        currentViewId: "v1",
        currentViewCreatedAt: "2026-01-01T00:00:00Z",
        latestNativeCompactAt: measurements.latestNativeCompactAt,
        latestNativeCompactViewId: measurements.latestNativeCompactViewId,
      }),
    ).not.toContain("native host compact is newer than the current LHC view");
  });

  it("finds a compact more than 2 MiB before EOF", () => {
    const compact = JSON.stringify({
      timestamp: "2026-01-01T00:02:00Z",
      type: "compacted",
      payload: { message: "native compact without an LHC receipt" },
    });
    const path = rollout("rollout.jsonl", `${compact}\n${"x".repeat(2 * 1024 * 1024 + 100)}\n`);

    expect(readCodexRolloutMeasurements(path)?.latestNativeCompactAt).toBe("2026-01-01T00:02:00Z");
  });

  it("selects the newest readable rollout regardless of glob order", () => {
    const event = (tokens: number, timestamp: string) =>
      `${JSON.stringify({ timestamp, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: tokens } } } })}\n`;
    const older = rollout("older.jsonl", event(10, "2026-01-01T00:00:00Z"));
    const newer = rollout("newer.jsonl", event(20, "2026-01-01T00:01:00Z"));
    const oldTime = new Date("2026-01-01T00:00:00Z");
    const newTime = new Date("2026-01-01T00:01:00Z");
    utimesSync(older, oldTime, oldTime);
    utimesSync(newer, newTime, newTime);

    expect(readNewestCodexRolloutMeasurements([older, newer])?.latestProviderInputTokens).toBe(20);
    expect(readNewestCodexRolloutMeasurements([newer, older])?.latestProviderInputTokens).toBe(20);
  });

  it("skips a newer artifact with no recognized measurement events", () => {
    const valid = rollout(
      "valid.jsonl",
      `${JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10 } } } })}\n`,
    );
    const invalid = rollout("invalid.jsonl", "not json\n{}\n");
    const oldTime = new Date("2026-01-01T00:00:00Z");
    const newTime = new Date("2026-01-01T00:01:00Z");
    utimesSync(valid, oldTime, oldTime);
    utimesSync(invalid, newTime, newTime);

    expect(readNewestCodexRolloutMeasurements([valid, invalid])?.latestProviderInputTokens).toBe(
      10,
    );
  });
});
