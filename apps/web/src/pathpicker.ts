/**
 * A path picker: one input plus a sectioned suggestion list.
 *
 * It knows nothing about new sessions, quick selects or the filesystem — the
 * caller supplies sections as `(query) => entries`, so the same component
 * serves the modal, the split popover, and whatever needs a directory next.
 *
 * The keyboard is the point. Arrows move through every section as one list,
 * Tab completes to the highlighted directory and descends into it (the way a
 * shell does), Enter takes the highlight or, with nothing highlighted, the
 * literal text — someone who knows the path should never have to wait for a
 * suggestion to agree with them.
 */

import { el } from "./format.ts";

export interface PickerEntry {
  /** Primary text: usually a basename or a short path. */
  label: string;
  /** Dim annotation to the right — counts, hosts, age. */
  sublabel?: string;
  /** The value selecting this entry yields. */
  path: string;
}

export interface PickerResult {
  entries: PickerEntry[];
  /** Dim line under the section instead of entries: "no such directory", … */
  note?: string;
}

export interface PickerSection {
  label: string;
  provide: (query: string) => Promise<PickerResult> | PickerResult;
  /** Skip the section entirely for this query (e.g. quick selects once typing). */
  hidden?: (query: string) => boolean;
}

export interface PathPickerConfig {
  sections: PickerSection[];
  /** Initial input value; the picker queries with it immediately. */
  seed?: string;
  placeholder?: string;
  onSelect: (path: string) => void;
  /** Called on Esc, so the owner can close whatever contains the picker. */
  onEscape?: () => void;
  /** Reject a literal Enter: return a reason, or null when the path is fine. */
  validate?: (path: string) => string | null;
  /** Every value change, for a caller that mirrors the path elsewhere. */
  onChange?: (path: string) => void;
}

export interface PathPicker {
  root: HTMLElement;
  input: HTMLInputElement;
  focus: () => void;
  value: () => string;
  setValue: (v: string, opts?: { query?: boolean }) => void;
  destroy: () => void;
}

/** Browse queries are one readdir each; wait for a pause in the typing. */
const DEBOUNCE_MS = 150;

export function createPathPicker(cfg: PathPickerConfig): PathPicker {
  const root = el("div", "pp");
  const input = el("input", "pp-input") as HTMLInputElement;
  input.type = "text";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.placeholder = cfg.placeholder ?? "/path/to/directory";
  input.value = cfg.seed ?? "";
  const list = el("div", "pp-list");
  const err = el("div", "pp-error bad");
  err.style.display = "none";
  root.append(input, err, list);

  /** Flattened entries in display order — what the arrows walk. */
  let flat: PickerEntry[] = [];
  let highlight = -1;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  let destroyed = false;

  function setError(text: string | null): void {
    err.textContent = text ?? "";
    err.style.display = text ? "" : "none";
  }

  function paintHighlight(): void {
    const rows = list.querySelectorAll<HTMLElement>(".pp-row");
    rows.forEach((r, i) => r.classList.toggle("on", i === highlight));
    if (highlight >= 0) rows[highlight]?.scrollIntoView({ block: "nearest" });
  }

  function paint(results: { section: PickerSection; result: PickerResult }[]): void {
    list.replaceChildren();
    flat = [];
    for (const { section, result } of results) {
      if (!result.entries.length && !result.note) continue;
      list.append(el("div", "pp-sec", section.label));
      if (result.note) list.append(el("div", "pp-note dim", result.note));
      for (const entry of result.entries) {
        const row = el("button", "pp-row") as HTMLButtonElement;
        row.type = "button";
        row.append(el("span", "pp-row-label", entry.label));
        if (entry.sublabel) row.append(el("span", "pp-row-sub dim", entry.sublabel));
        row.title = entry.path;
        // mousedown, not click: the input must not lose focus mid-selection.
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          choose(entry.path);
        });
        list.append(row);
        flat.push(entry);
      }
    }
    if (highlight >= flat.length) highlight = flat.length - 1;
    paintHighlight();
  }

  async function query(): Promise<void> {
    const q = input.value;
    const mine = ++seq;
    const active = cfg.sections.filter((s) => !s.hidden?.(q));
    const results = await Promise.all(
      active.map(async (section) => {
        try {
          return { section, result: await section.provide(q) };
        } catch {
          // A section that fails is a section with nothing to say, not a break.
          return { section, result: { entries: [], note: "unavailable" } as PickerResult };
        }
      }),
    );
    if (destroyed || mine !== seq) return; // a newer keystroke already won
    paint(results);
  }

  function scheduleQuery(): void {
    clearTimeout(debounce);
    debounce = setTimeout(() => void query(), DEBOUNCE_MS);
  }

  function choose(path: string): void {
    const reason = cfg.validate?.(path) ?? null;
    setError(reason);
    if (reason) return;
    cfg.onSelect(path);
  }

  /** Tab: adopt the highlighted directory and list what is inside it. */
  function descend(): void {
    const target = flat[highlight >= 0 ? highlight : 0];
    if (!target) return;
    input.value = target.path.endsWith("/") ? target.path : `${target.path}/`;
    highlight = -1;
    setError(null);
    cfg.onChange?.(input.value);
    clearTimeout(debounce);
    void query();
  }

  input.addEventListener("input", () => {
    highlight = -1;
    setError(null);
    cfg.onChange?.(input.value);
    scheduleQuery();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flat.length) highlight = Math.min(highlight + 1, flat.length - 1);
      paintHighlight();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      // Above the first row is the input itself — back to "use what I typed".
      highlight = Math.max(highlight - 1, -1);
      paintHighlight();
      return;
    }
    if (e.key === "Tab" && !e.shiftKey) {
      if (!flat.length) return; // nothing to complete: let focus move on
      e.preventDefault();
      descend();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const entry = highlight >= 0 ? flat[highlight] : null;
      choose(entry ? entry.path : input.value.trim());
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cfg.onEscape?.();
    }
  });

  void query();

  return {
    root,
    input,
    focus: () => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
    value: () => input.value.trim(),
    setValue: (v, opts) => {
      input.value = v;
      highlight = -1;
      setError(null);
      cfg.onChange?.(v);
      if (opts?.query !== false) void query();
    },
    destroy: () => {
      destroyed = true;
      clearTimeout(debounce);
      root.remove();
    },
  };
}
