import { el } from "./format.ts";

/**
 * Click-to-edit for the console's own thread names, used by the list rows and
 * the detail header.
 *
 * Two rules that are easy to get wrong and expensive to get wrong:
 *
 * - The editor starts from what is STORED, never from the displayed fallback.
 *   A row showing the registry's title opens an EMPTY box, so pressing Enter
 *   on an untouched field cannot quietly copy a cwd basename into the console's
 *   prefs and freeze it there.
 * - Blur cancels. The field sits inside a clickable table row, so a stray click
 *   elsewhere must throw the edit away rather than save something half-typed.
 *   Enter is the only thing that writes.
 */

/** Mirrors NAME_TITLE_MAX / NAME_DESCRIPTION_MAX in packages/core/src/names.ts. */
const MAX = { title: 80, description: 300 } as const;

const PLACEHOLDER = {
  title: "name this thread",
  description: "one line about this thread",
} as const;

/** An editor is open somewhere: page-level single-key shortcuts stand down. */
let openCount = 0;

export function nameEditorOpen(): boolean {
  return openCount > 0;
}

export interface NameEditOptions {
  field: "title" | "description";
  /** What is stored today — null when the console has never named this. */
  stored: string | null;
  /** Persist the new value; null clears the field. Rejects on failure. */
  save: (value: string | null) => Promise<unknown>;
  /** Repaint the surrounding UI after a save lands. */
  after?: () => void;
}

/**
 * Swap `cell`'s content for an input until the edit settles. The cell's height
 * is pinned for the duration so a row never jumps as it changes shape.
 */
export function editName(cell: HTMLElement, opts: NameEditOptions): void {
  if (cell.classList.contains("editing")) {
    cell.querySelector("input")?.focus();
    return;
  }
  const prev = [...cell.childNodes];
  const height = cell.getBoundingClientRect().height;

  const input = el("input", "name-input") as HTMLInputElement;
  input.type = "text";
  input.value = opts.stored ?? "";
  input.maxLength = MAX[opts.field];
  input.placeholder = PLACEHOLDER[opts.field];
  input.spellcheck = false;
  input.autocomplete = "off";
  input.title = `${opts.field} · enter saves · esc cancels · max ${MAX[opts.field]} chars`;

  cell.classList.add("editing");
  cell.classList.remove("name-failed");
  if (height > 0) cell.style.height = `${height}px`;
  cell.replaceChildren(input);
  openCount++;

  let settled = false;
  /** Put the old content back exactly as it was. */
  const restore = (): void => {
    if (settled) return;
    settled = true;
    openCount--;
    cell.classList.remove("editing");
    cell.style.height = "";
    cell.replaceChildren(...prev);
  };

  const fail = (e: unknown): void => {
    cell.classList.add("name-failed");
    cell.title = e instanceof Error ? e.message : String(e);
    // The styling is a signal, not a state: it clears itself, and any repaint
    // of the surrounding list drops it sooner.
    setTimeout(() => cell.classList.remove("name-failed"), 4000);
  };

  const commit = (): void => {
    if (settled) return;
    const typed = input.value.trim();
    const next = typed === "" ? null : typed;
    if (next === opts.stored) {
      restore();
      return;
    }
    settled = true;
    openCount--;
    input.disabled = true;
    cell.classList.add("saving");
    void opts.save(next).then(
      () => {
        cell.classList.remove("editing", "saving");
        cell.style.height = "";
        opts.after?.();
      },
      (e: unknown) => {
        // Nothing was stored: show what was there before, and say why.
        cell.classList.remove("editing", "saving");
        cell.style.height = "";
        cell.replaceChildren(...prev);
        fail(e);
      },
    );
  };

  input.onkeydown = (e) => {
    // The page binds single-key shortcuts on window; none of them belong to a
    // field that is being typed in, and Esc here must not also navigate away.
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      restore();
    }
  };
  // A click inside the editor must not reach the row underneath it.
  input.onclick = (e) => e.stopPropagation();
  input.onmousedown = (e) => e.stopPropagation();
  input.onblur = restore;

  input.focus();
  input.select();
}

/**
 * The ✎ that opens the editor: dim, hover-only (CSS), and never the row's
 * click — a rename must not also navigate to the thread.
 */
export function editAffordance(label: string, open: () => void): HTMLButtonElement {
  const btn = el("button", "name-edit", "✎") as HTMLButtonElement;
  btn.type = "button";
  btn.tabIndex = -1;
  btn.title = label;
  btn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    open();
  };
  // The row's click handler fires on click, but mousedown would move focus
  // before the swap; keep both away from it.
  btn.onmousedown = (e) => e.stopPropagation();
  return btn;
}
