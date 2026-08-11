import { describe, expect, it, vi } from "vite-plus/test";
import { activateOnPress, focusedPaneForCopy, terminalBufferText } from "../src/terminal-ui.ts";

class FakeTarget {
  readonly listeners = new Map<string, Array<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

function buffer(type: "normal" | "alternate", lines: string[]) {
  return {
    type,
    length: lines.length,
    getLine(index: number) {
      const line = lines[index];
      return line === undefined
        ? undefined
        : { translateToString: (trimRight?: boolean) => (trimRight ? line.trimEnd() : line) };
    },
  };
}

describe("terminal UI helpers", () => {
  it("activates a tab on pointer-down instead of waiting for a replaceable click target", () => {
    const target = new FakeTarget();
    const activate = vi.fn();

    activateOnPress(target, activate);
    target.dispatch("pointerdown");

    expect(activate).toHaveBeenCalledOnce();
  });

  it("resolves copy against the currently focused pane instead of a stale control closure", () => {
    expect(focusedPaneForCopy("pane-b", ["pane-a", "pane-b"])).toBe("pane-b");
    expect(focusedPaneForCopy("other-screen", ["pane-a", "pane-b"])).toBeNull();
  });

  it("renders normal scrollback and the current alternate screen as selectable text", () => {
    expect(
      terminalBufferText({
        active: buffer("alternate", ["current screen   ", "", ""]),
        normal: buffer("normal", ["older output", "shell prompt   ", ""]),
      }),
    ).toBe("older output\nshell prompt\n\n--- current screen ---\n\ncurrent screen");
  });

  it("does not duplicate the normal buffer when it is active", () => {
    const normal = buffer("normal", ["line one", "line two", ""]);
    expect(terminalBufferText({ active: normal, normal })).toBe("line one\nline two");
  });
});
