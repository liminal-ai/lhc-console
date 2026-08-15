import { describe, expect, it } from "vite-plus/test";
import type { OverviewResponse } from "../src/api.ts";
import { normalizeOverviewResponse } from "../src/api.ts";

describe("overview API compatibility", () => {
  it("supplies unavailable host measurements for an older live server response", () => {
    const response = {
      overview: {},
    } as OverviewResponse;

    expect(normalizeOverviewResponse(response).overview.hostMeasurements).toEqual({
      activeContextTokens: null,
      modelContextWindow: null,
      latestProviderUsageAt: null,
      latestNativeCompactAt: null,
      alarms: [],
    });
  });
});
