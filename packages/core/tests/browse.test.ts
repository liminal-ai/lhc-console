import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { browseDirs, isExistingDir, splitBrowsePath } from "../src/browse.ts";

const HOME = "/home/tester";

describe("splitBrowsePath", () => {
  it("splits a partial last segment into parent + prefix", () => {
    expect(splitBrowsePath("/srv/work", HOME)).toEqual({ parentDir: "/srv", prefix: "work" });
  });

  it("treats a trailing slash as 'list this directory'", () => {
    expect(splitBrowsePath("/srv/work/", HOME)).toEqual({ parentDir: "/srv/work", prefix: "" });
  });

  it("lists the filesystem root for '/'", () => {
    expect(splitBrowsePath("/", HOME)).toEqual({ parentDir: "/", prefix: "" });
  });

  it("keeps a single-segment path under the root", () => {
    expect(splitBrowsePath("/sr", HOME)).toEqual({ parentDir: "/", prefix: "sr" });
  });

  it("carries a dot prefix through, so hidden dirs can be asked for", () => {
    expect(splitBrowsePath("/home/tester/.cl", HOME)).toEqual({
      parentDir: "/home/tester",
      prefix: ".cl",
    });
  });

  it("expands a leading tilde", () => {
    expect(splitBrowsePath("~/pro", HOME)).toEqual({ parentDir: HOME, prefix: "pro" });
    expect(splitBrowsePath("~", HOME)).toEqual({ parentDir: "/home", prefix: "tester" });
  });

  it("trims surrounding whitespace", () => {
    expect(splitBrowsePath("  /srv/wo  ", HOME)).toEqual({ parentDir: "/srv", prefix: "wo" });
  });

  it("reports no parent for a non-absolute partial", () => {
    expect(splitBrowsePath("work", HOME)).toEqual({ parentDir: "", prefix: "work" });
    expect(splitBrowsePath("", HOME)).toEqual({ parentDir: "", prefix: "" });
  });
});

describe("browseDirs", () => {
  const root = mkdtempSync(join(tmpdir(), "lhc-browse-"));
  mkdirSync(join(root, "alpha"));
  mkdirSync(join(root, "Beta"));
  mkdirSync(join(root, "beta-two"));
  mkdirSync(join(root, ".hidden"));
  mkdirSync(join(root, "target"));
  writeFileSync(join(root, "afile.txt"), "x");
  symlinkSync(join(root, "target"), join(root, "linked"));
  symlinkSync(join(root, "nowhere"), join(root, "dangling"));

  it("returns only directories, sorted, with full paths", () => {
    const res = browseDirs(`${root}/`);
    expect(res.parentDir).toBe(root);
    expect(res.entries.map((e) => e.name).sort()).toEqual([
      "Beta",
      "alpha",
      "beta-two",
      "linked",
      "target",
    ]);
    expect(res.entries.map((e) => e.name)).toEqual(
      res.entries.map((e) => e.name).sort((a, b) => a.localeCompare(b)),
    );
    expect(res.entries.find((e) => e.name === "Beta")!.path).toBe(join(root, "Beta"));
    expect(res.error).toBeUndefined();
    expect(res.truncated).toBe(false);
  });

  it("matches the prefix case-insensitively", () => {
    expect(
      browseDirs(`${root}/be`)
        .entries.map((e) => e.name)
        .sort(),
    ).toEqual(["Beta", "beta-two"]);
  });

  it("hides dot directories unless the prefix asks for them", () => {
    expect(browseDirs(`${root}/`).entries.map((e) => e.name)).not.toContain(".hidden");
    expect(browseDirs(`${root}/.`).entries.map((e) => e.name)).toEqual([".hidden"]);
  });

  it("caps the listing and flags truncation", () => {
    const res = browseDirs(`${root}/`, 2);
    expect(res.entries).toHaveLength(2);
    expect(res.truncated).toBe(true);
  });

  it("answers a nonexistent parent with a reason, not a throw", () => {
    const res = browseDirs(`${root}/nope/thing`);
    expect(res.entries).toEqual([]);
    expect(res.error).toBe("no such directory");
  });

  it("answers a file used as a parent with a reason", () => {
    const res = browseDirs(`${root}/afile.txt/x`);
    expect(res.entries).toEqual([]);
    expect(res.error).toBe("not a directory");
  });

  it("rejects a relative partial", () => {
    expect(browseDirs("work").error).toBe("type an absolute path");
  });
});

describe("isExistingDir", () => {
  const root = mkdtempSync(join(tmpdir(), "lhc-isdir-"));
  writeFileSync(join(root, "f"), "x");

  it("is true for a directory and false for anything else", () => {
    expect(isExistingDir(root)).toBe(true);
    expect(isExistingDir(join(root, "f"))).toBe(false);
    expect(isExistingDir(join(root, "missing"))).toBe(false);
  });
});
