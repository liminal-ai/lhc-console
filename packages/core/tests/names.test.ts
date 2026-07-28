import { describe, expect, it } from "vite-plus/test";
import {
  capField,
  mergeName,
  nameKey,
  normalizeNames,
  parseNamePatch,
  NAME_DESCRIPTION_MAX,
  NAME_TITLE_MAX,
  type ThreadName,
} from "../src/names.ts";

const NOW = "2026-07-27T12:00:00.000Z";
const EPOCH = new Date(0).toISOString();

const stored = (over: Partial<ThreadName> = {}): ThreadName => ({
  title: "console title",
  description: "what this thread is for",
  updatedAt: NOW,
  ...over,
});

describe("nameKey", () => {
  it("is host + resolved thread id", () => {
    expect(nameKey("cc-lhc", "abc-123")).toBe("cc-lhc/abc-123");
  });
});

describe("capField", () => {
  it("trims and keeps the text", () => {
    expect(capField("  a name  ", NAME_TITLE_MAX)).toBe("a name");
  });

  it("reads empty-after-trim as absent", () => {
    expect(capField("   ", NAME_TITLE_MAX)).toBeNull();
    expect(capField("", NAME_TITLE_MAX)).toBeNull();
  });

  it("caps at the limit and leaves no trailing space", () => {
    expect(capField("x".repeat(90), NAME_TITLE_MAX)).toBe("x".repeat(NAME_TITLE_MAX));
    expect(capField(`${"x".repeat(79)} tail`, NAME_TITLE_MAX)).toBe("x".repeat(79));
    expect(capField("y".repeat(1400), NAME_DESCRIPTION_MAX)?.length).toBe(NAME_DESCRIPTION_MAX);
  });

  it("reads anything that is not a string as absent", () => {
    expect(capField(null, NAME_TITLE_MAX)).toBeNull();
    expect(capField(42, NAME_TITLE_MAX)).toBeNull();
    expect(capField({ title: "nested" }, NAME_TITLE_MAX)).toBeNull();
  });
});

describe("normalizeNames", () => {
  it("keeps well-formed entries", () => {
    expect(
      normalizeNames({
        "cc-lhc/a": { title: " one ", description: " two ", updatedAt: NOW },
      }),
    ).toEqual({ "cc-lhc/a": { title: "one", description: "two", updatedAt: NOW } });
  });

  it("tolerates unknown shapes instead of throwing", () => {
    expect(normalizeNames(undefined)).toEqual({});
    expect(normalizeNames(null)).toEqual({});
    expect(normalizeNames("nope")).toEqual({});
    expect(normalizeNames({ "cc-lhc/a": null })).toEqual({});
    expect(normalizeNames({ "cc-lhc/a": "just a string" })).toEqual({});
    expect(normalizeNames({ "cc-lhc/a": { title: 7, description: [] } })).toEqual({});
  });

  it("drops an entry whose fields are both empty", () => {
    expect(normalizeNames({ "cc-lhc/a": { title: "  ", description: null } })).toEqual({});
  });

  it("keeps a half-filled entry and caps what it keeps", () => {
    const out = normalizeNames({ "cc-lhc/a": { description: "d".repeat(1500) } });
    expect(out["cc-lhc/a"].title).toBeNull();
    expect(out["cc-lhc/a"].description?.length).toBe(NAME_DESCRIPTION_MAX);
  });

  it("substitutes the epoch for a missing or odd updatedAt", () => {
    expect(normalizeNames({ "cc-lhc/a": { title: "t" } })["cc-lhc/a"].updatedAt).toBe(EPOCH);
    expect(normalizeNames({ "cc-lhc/a": { title: "t", updatedAt: 5 } })["cc-lhc/a"].updatedAt).toBe(
      EPOCH,
    );
  });

  it("ignores an empty key", () => {
    expect(normalizeNames({ "": { title: "t" } })).toEqual({});
  });
});

describe("mergeName", () => {
  it("creates an entry from nothing", () => {
    expect(mergeName(undefined, { title: "  fresh  " }, NOW)).toEqual({
      title: "fresh",
      description: null,
      updatedAt: NOW,
    });
  });

  it("leaves an absent field untouched", () => {
    expect(mergeName(stored(), { description: "new text" }, NOW)).toEqual({
      title: "console title",
      description: "new text",
      updatedAt: NOW,
    });
    expect(mergeName(stored(), {}, NOW)).toEqual(stored());
  });

  it("clears a field with null and keeps the other", () => {
    expect(mergeName(stored(), { title: null }, NOW)).toEqual({
      title: null,
      description: "what this thread is for",
      updatedAt: NOW,
    });
  });

  it("treats empty-after-trim as a clear", () => {
    expect(mergeName(stored(), { title: "   " }, NOW)?.title).toBeNull();
  });

  it("caps both fields on write", () => {
    const merged = mergeName(
      undefined,
      { title: "t".repeat(200), description: "d".repeat(1400) },
      NOW,
    );
    expect(merged?.title?.length).toBe(NAME_TITLE_MAX);
    expect(merged?.description?.length).toBe(NAME_DESCRIPTION_MAX);
  });

  it("returns null when both fields end up empty — the entry is deleted", () => {
    expect(mergeName(stored(), { title: null, description: null }, NOW)).toBeNull();
    expect(mergeName(stored({ description: null }), { title: "" }, NOW)).toBeNull();
    expect(mergeName(undefined, {}, NOW)).toBeNull();
    expect(mergeName(null, { title: null }, NOW)).toBeNull();
  });

  it("stamps the time it was given", () => {
    expect(mergeName(stored(), { title: "x" }, "2030-01-01T00:00:00.000Z")?.updatedAt).toBe(
      "2030-01-01T00:00:00.000Z",
    );
  });
});

describe("parseNamePatch", () => {
  it("accepts strings, nulls, and an absent field", () => {
    expect(parseNamePatch({ title: "a", description: null })).toEqual({
      ok: true,
      patch: { title: "a", description: null },
    });
    expect(parseNamePatch({ description: "only" })).toEqual({
      ok: true,
      patch: { description: "only" },
    });
    expect(parseNamePatch({})).toEqual({ ok: true, patch: {} });
    expect(parseNamePatch(undefined)).toEqual({ ok: true, patch: {} });
  });

  it("ignores fields it does not own", () => {
    expect(parseNamePatch({ title: "a", hidden: true })).toEqual({
      ok: true,
      patch: { title: "a" },
    });
  });

  it("rejects a wrong type rather than reading it as a clear", () => {
    expect(parseNamePatch({ title: 42 })).toEqual({
      ok: false,
      error: "title must be a string or null",
    });
    expect(parseNamePatch({ description: { text: "x" } })).toEqual({
      ok: false,
      error: "description must be a string or null",
    });
    expect(parseNamePatch("title=x").ok).toBe(false);
    expect(parseNamePatch([{ title: "x" }]).ok).toBe(false);
  });
});
