import { describe, expect, it } from "vite-plus/test";
import type { ViewArrangement } from "../src/api.ts";
import { viewMeasurementLabels } from "../src/viewtab.ts";

function arrangement(): ViewArrangement {
  return {
    view: {
      viewId: "v1",
      createdAt: "2026-01-01T00:00:00Z",
      profileName: "default",
      compactPoint: 100,
      coveredFrom: 1,
      bands: [{ band: "brief", tokenCount: 25 }],
      gaps: [],
    },
    entries: [],
    liveTail: [
      {
        turnId: "new",
        turnOrder: 3,
        status: "closed",
        messageCount: 1,
        tokenEstimate: 50,
        firstEventOrder: 110,
        promptExcerpt: "new",
      },
    ],
    liveTailTokens: 50,
    archivedHistory: [
      {
        turnId: "old",
        turnOrder: 2,
        status: "closed",
        messageCount: 1,
        tokenEstimate: 1000,
        firstEventOrder: 20,
        promptExcerpt: "old",
      },
    ],
    archivedHistoryTokens: 1000,
    retainedArchiveTokens: 1100,
    projectedViewTokens: 75,
    turnsSinceView: 1,
    turnCount: 3,
  };
}

describe("thread view measurements", () => {
  it("labels true post-compact turns as live and omitted older turns as archived history", () => {
    const labels = viewMeasurementLabels(arrangement());

    expect(labels.liveTail).toBe("live tail · 1 turn · 50 estimated tokens after compact");
    expect(labels.archivedHistory).toBe(
      "archived history omitted from current view · 1 turn · 1.0k estimated tokens",
    );
  });
});
