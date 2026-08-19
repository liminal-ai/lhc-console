import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { V2Store } from "../src/v2/store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("V2 event log retention", () => {
  it("returns 410-class evidence when a cursor is older than the retained minimum", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-store-"));
    dirs.push(dir);
    const store = new V2Store({
      dbPath: join(dir, "v2.sqlite"),
      eventRetentionCount: 2,
      eventRetentionDays: 14,
    });
    store.appendEvent({ target: "fable", kind: "runtime.state", data: { n: 1 } });
    store.appendEvent({ target: "fable", kind: "runtime.state", data: { n: 2 } });
    store.appendEvent({ target: "fable", kind: "runtime.state", data: { n: 3 } });
    const min = store.minEventSeq("fable");
    expect(min).toBeGreaterThan(1);
    expect(store.listEventsAfter("fable", 0).map((event) => event.data.n)).toEqual([2, 3]);
    store.close();
  });
});
