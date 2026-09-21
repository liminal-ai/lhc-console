import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { appendLine, draftWakes } from "../src/groups.ts";

/** Enough of the DOM for `el()` and appendLine: no dependency added for it. */
class FakeElement {
  className = "";
  textContent = "";
  title = "";
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  constructor(public tag: string) {}
  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }
  getAttribute(name: string): string | null {
    return name.startsWith("data-") ? (this.dataset[name.slice(5)] ?? null) : null;
  }
  querySelector(sel: string): FakeElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    const cls = sel.slice(1);
    const out: FakeElement[] = [];
    for (const c of this.children) {
      if (c.className.split(" ").includes(cls)) out.push(c);
      out.push(...c.querySelectorAll(sel));
    }
    return out;
  }
}
beforeEach(() => {
  vi.stubGlobal("document", { createElement: (tag: string) => new FakeElement(tag) });
});
afterEach(() => vi.unstubAllGlobals());

const members = [
  { id: "sable", label: "Sable" },
  { id: "flint", label: "Flint" },
];

describe("group web view", () => {
  it("previews wakes by the line's tag rule", () => {
    expect(draftWakes("@flint status?", members)).toEqual(["Flint"]);
    expect(draftWakes("@flint @sable both", members)).toEqual(["Sable", "Flint"]);
    expect(draftWakes("@all hi", members)).toEqual(["Sable", "Flint"]);
    expect(draftWakes("plain note", members)).toEqual([]);
    expect(draftWakes("email me@flint.dev", members)).toEqual([]);
  });

  it("renders owner and member lines with label, time, and text", () => {
    const log = new FakeElement("div") as unknown as HTMLElement;
    appendLine(log, {
      seq: 1,
      senderId: "lee",
      senderLabel: "Lee",
      text: "@flint go",
      at: new Date().toISOString(),
    });
    appendLine(log, {
      seq: 2,
      senderId: "flint",
      senderLabel: "Flint",
      text: "on it\nline two",
      at: new Date().toISOString(),
    });
    const lines = [...log.querySelectorAll(".group-line")];
    expect(lines.map((l) => l.className)).toEqual(["group-line owner", "group-line member"]);
    expect(lines[1]?.querySelector(".group-text")?.textContent).toBe("on it\nline two");
    expect(lines[0]?.getAttribute("data-seq")).toBe("1");
  });
});
