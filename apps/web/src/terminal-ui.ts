interface PressTarget {
  addEventListener(type: string, listener: () => void): void;
}

/**
 * Tabs can be repainted by terminal activity between mouse-down and click.
 * Activate on the initial press so replacement cannot swallow navigation.
 */
export function activateOnPress(target: PressTarget, activate: () => void): void {
  target.addEventListener("pointerdown", activate);
}

/** Resolve at click time so split-pane focus changes cannot leave stale controls. */
export function focusedPaneForCopy(focused: string | null, paneIds: string[]): string | null {
  return focused && paneIds.includes(focused) ? focused : null;
}

interface BufferLine {
  translateToString(trimRight?: boolean): string;
}

interface TerminalBuffer {
  type: "normal" | "alternate";
  length: number;
  getLine(index: number): BufferLine | undefined;
}

interface TerminalBuffers {
  active: TerminalBuffer;
  normal: TerminalBuffer;
}

function bufferText(buffer: TerminalBuffer): string {
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

/** A plain-text snapshot that remains selectable even when a TUI owns mouse input. */
export function terminalBufferText(buffers: TerminalBuffers): string {
  const active = bufferText(buffers.active);
  if (buffers.active.type === "normal") return active;
  const normal = bufferText(buffers.normal);
  if (!normal) return active;
  if (!active) return normal;
  return `${normal}\n\n--- current screen ---\n\n${active}`;
}
