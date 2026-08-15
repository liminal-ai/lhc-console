import { describe, expect, it } from "vite-plus/test";
import type { OverviewResponse, ViewArrangement } from "../src/api.ts";
import {
  normalizeOverviewResponse,
  normalizeThreadRows,
  normalizeViewArrangement,
} from "../src/api.ts";

describe("overview API compatibility", () => {
  it("supplies unavailable host measurements for an older live server response", () => {
    const response = {
      overview: {
        stats: {
          totalTokenEstimate: 1000,
          contextTokens: 250,
          pendingWork: 2,
          failedDerivations: 3,
        },
      },
    } as unknown as OverviewResponse;

    const normalized = normalizeOverviewResponse(response);
    expect(normalized.overview.hostMeasurements).toEqual({
      activeContextTokens: null,
      modelContextWindow: null,
      latestProviderUsageAt: null,
      latestNativeCompactAt: null,
      alarms: [],
    });
    expect(normalized.overview.stats).toMatchObject({
      retainedArchiveTokenEstimate: 1000,
      projectedViewTokenEstimate: 250,
      projectedViewIsUpperBound: false,
      latestProviderInputTokens: null,
      activeWorkItems: 2,
      historicalFailedDerivations: 3,
    });
  });

  it("normalizes legacy quick stats in thread-list responses", () => {
    const rows = [{ stats: { contextTokens: 42, totalTokenEstimate: 84 } }] as never;
    expect(normalizeThreadRows(rows)[0]?.stats).toMatchObject({
      projectedViewTokenEstimate: 42,
      retainedArchiveTokenEstimate: 84,
    });
  });

  it("splits a legacy thread-view tail into live and archived measurements", () => {
    const legacy = {
      view: { bands: [{ band: "brief", tokenCount: 25 }] },
      entries: [],
      tail: [
        { turnId: "old", tokenEstimate: 100, afterCompact: false },
        { turnId: "new", tokenEstimate: 50, afterCompact: true },
      ],
      tailTokens: 150,
      turnsSinceView: 1,
      turnCount: 2,
    } as unknown as ViewArrangement;

    expect(normalizeViewArrangement(legacy)).toMatchObject({
      liveTail: [{ turnId: "new" }],
      liveTailTokens: 50,
      archivedHistory: [{ turnId: "old" }],
      archivedHistoryTokens: 100,
      retainedArchiveTokens: 150,
      projectedViewTokens: 75,
      projectedViewIsUpperBound: false,
    });
  });
});
