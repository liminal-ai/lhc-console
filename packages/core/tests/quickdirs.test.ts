import { describe, expect, it } from "vite-plus/test";
import { quickDirs, type QuickDirInput } from "../src/quickdirs.ts";

const rows: QuickDirInput[] = [
  { hostId: "cc-lhc", cwd: "/srv/work/lhc-console", lastActiveAt: "2026-07-27T10:00:00.000Z" },
  { hostId: "cc-lhc", cwd: "/srv/work/lhc-console", lastActiveAt: "2026-07-26T09:00:00.000Z" },
  { hostId: "pi-lhc", cwd: "/srv/work/lhc-console/", lastActiveAt: "2026-07-25T09:00:00.000Z" },
  { hostId: "pi-lhc", cwd: "/srv/work/hermes-agent", lastActiveAt: "2026-07-27T11:00:00.000Z" },
  { hostId: "hermes", cwd: null, lastActiveAt: "2026-07-27T12:00:00.000Z" },
  { hostId: "cc-lhc", cwd: "/srv/work/old", lastActiveAt: null },
];

describe("quickDirs", () => {
  it("dedupes by path, counting threads and collecting hosts", () => {
    const console_ = quickDirs(rows).find((d) => d.path === "/srv/work/lhc-console")!;
    expect(console_.threadCount).toBe(3);
    expect(console_.hosts).toEqual(["cc-lhc", "pi-lhc"]);
    expect(console_.basename).toBe("lhc-console");
    expect(console_.lastActiveAt).toBe("2026-07-27T10:00:00.000Z");
  });

  it("normalises a trailing slash to the same directory", () => {
    expect(quickDirs(rows).map((d) => d.path)).not.toContain("/srv/work/lhc-console/");
  });

  it("ranks by last activity, most recent first", () => {
    expect(quickDirs(rows).map((d) => d.path)).toEqual([
      "/srv/work/hermes-agent",
      "/srv/work/lhc-console",
    ]);
  });

  it("skips rows with no cwd (hermes) and rows with no activity stamp", () => {
    const paths = quickDirs(rows).map((d) => d.path);
    expect(paths).not.toContain(null);
    expect(paths).not.toContain("/srv/work/old");
  });

  it("caps the list", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      hostId: "cc-lhc",
      cwd: `/srv/work/p${i}`,
      lastActiveAt: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString(),
    }));
    expect(quickDirs(many, 15)).toHaveLength(15);
    expect(quickDirs(many, 15)[0].path).toBe("/srv/work/p39");
  });

  it("names the root directory sensibly", () => {
    expect(
      quickDirs([{ hostId: "cc-lhc", cwd: "/", lastActiveAt: "2026-01-01T00:00:00.000Z" }])[0]
        .basename,
    ).toBe("/");
  });
});
