import { api, type ThreadRow } from "./api.ts";
import { el, fmtAgo, fmtStamp, fmtTokens, splitDir } from "./format.ts";
import { closeLaunchModal, openLaunchModal } from "./launchmodal.ts";

type SortKey = "host" | "title" | "dir" | "summary" | "turns" | "context" | "created" | "activity";

interface Column {
  key: SortKey;
  label: string;
  /** Extra class applied to both header and cells. */
  cls?: string;
  /** Numeric columns sort descending on first click. */
  numeric?: boolean;
}

const COLUMNS: Column[] = [
  { key: "host", label: "host", cls: "col-host" },
  { key: "title", label: "title", cls: "col-title" },
  { key: "dir", label: "directory", cls: "col-dir" },
  { key: "summary", label: "summary", cls: "col-summary" },
  { key: "turns", label: "turns", cls: "num", numeric: true },
  { key: "context", label: "context", cls: "num", numeric: true },
  { key: "created", label: "created", cls: "col-when", numeric: true },
  { key: "activity", label: "last activity", cls: "col-when", numeric: true },
];

/**
 * The directory bucket a thread belongs to. Registry hosts bucket by cwd;
 * registry-less hosts (hermes) have no cwd, so they bucket by profile.
 */
function dirBucket(t: ThreadRow): { key: string; label: string; title: string } | null {
  if (t.cwd) return { key: t.cwd, label: splitDir(t.cwd).base, title: t.cwd };
  if (t.profile !== undefined) {
    const name = t.profile ?? "default";
    return {
      key: `${t.hostId}:profile:${name}`,
      label: `profile:${name}`,
      title: `${t.hostId} profile ${name}`,
    };
  }
  return null;
}

function lastActivity(t: ThreadRow): string {
  return t.stats?.lastEventAt ?? t.fileMtime ?? t.createdAt;
}

/** Comparable value per column: numbers sort numerically, text case-folded. */
function sortValue(t: ThreadRow, key: SortKey): string | number {
  switch (key) {
    case "host":
      return t.hostId;
    case "title":
      return (t.title ?? t.threadId).toLowerCase();
    case "dir":
      return (dirBucket(t)?.label ?? "￿").toLowerCase();
    case "summary":
      return (t.stats?.summary ?? "￿").toLowerCase();
    case "turns":
      return t.stats?.turnCount ?? -1;
    case "context":
      return t.stats?.contextTokens ?? -1;
    case "created":
      return Date.parse(t.createdAt) || 0;
    case "activity":
      return Date.parse(lastActivity(t)) || 0;
  }
}

let filterHost = "";
let filterDir = "";
let filterText = "";
let sortKey: SortKey = "activity";
let sortDesc = true;

/** Sentinel for the "no directory" bucket — distinct from "all". */
const NO_DIR = " none";

/** Threads grow while the console is open; re-poll on this cadence. */
const REFRESH_MS = 30_000;
const TICK_MS = 5_000;

let teardown: (() => void) | null = null;

/** Drop the poll loop and key bindings; the router calls this before routing. */
export function teardownList(): void {
  closeLaunchModal();
  teardown?.();
  teardown = null;
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return (
    t.isContentEditable ||
    t.tagName === "INPUT" ||
    t.tagName === "TEXTAREA" ||
    t.tagName === "SELECT"
  );
}

export async function renderList(app: HTMLElement): Promise<void> {
  const [hosts, initial] = await Promise.all([api.hosts(), api.threads()]);
  let threads = initial;
  let fetchedAt = Date.now();
  let inFlight = false;

  const root = el("div", "page");
  const header = el("header");
  header.append(el("h1", undefined, "lhc console"));
  const sub = el("div", "subtitle");
  header.append(sub);
  root.append(header);

  const controls = el("div", "controls");

  const hostSel = el("select") as HTMLSelectElement;
  hostSel.title = "filter by host";
  hostSel.append(new Option("all hosts", ""));
  for (const h of hosts) hostSel.append(new Option(h.id, h.id));
  hostSel.value = filterHost;

  const dirSel = el("select") as HTMLSelectElement;
  dirSel.className = "dir-select";
  dirSel.title = "filter by directory";
  const search = el("input") as HTMLInputElement;
  search.type = "search";
  search.placeholder = "search title, directory, thread id, summary…   ( / )";
  search.value = filterText;

  controls.append(hostSel, dirSel, search);
  root.append(controls);

  const table = el("table", "threads");
  const thead = el("thead");
  const headRow = el("tr");
  const headCells = new Map<SortKey, HTMLElement>();
  for (const col of COLUMNS) {
    const th = el("th", ["sortable", col.cls].filter(Boolean).join(" "));
    th.append(el("span", "th-label", col.label));
    th.append(el("span", "sort-mark"));
    th.onclick = () => {
      if (sortKey === col.key) {
        sortDesc = !sortDesc;
      } else {
        sortKey = col.key;
        sortDesc = col.numeric ?? false;
      }
      paint();
    };
    headCells.set(col.key, th);
    headRow.append(th);
  }
  headRow.append(el("th", "col-launch"));
  thead.append(headRow);
  table.append(thead);
  const tbody = el("tbody");
  table.append(tbody);
  root.append(table);

  const count = el("div", "list-count");
  const countText = el("span", "count-text");
  const freshness = el("span", "freshness dim");
  count.append(countText, freshness);
  root.append(count);

  /** Rebuild directory options from whatever the host filter admits. */
  function paintDirOptions(): void {
    const scope = filterHost ? threads.filter((t) => t.hostId === filterHost) : threads;
    const buckets = new Map<string, { label: string; title: string }>();
    let hasNone = false;
    for (const t of scope) {
      const b = dirBucket(t);
      if (b) buckets.set(b.key, { label: b.label, title: b.title });
      else hasNone = true;
    }
    const keys = [...buckets.keys()].sort(
      (a, b) => buckets.get(a)!.label.localeCompare(buckets.get(b)!.label) || a.localeCompare(b),
    );
    if (filterDir && filterDir !== NO_DIR && !buckets.has(filterDir)) filterDir = "";
    if (filterDir === NO_DIR && !hasNone) filterDir = "";
    dirSel.replaceChildren();
    dirSel.append(new Option("all directories", ""));
    for (const k of keys) {
      const opt = new Option(buckets.get(k)!.label, k);
      opt.title = buckets.get(k)!.title;
      dirSel.append(opt);
    }
    if (hasNone) dirSel.append(new Option("no directory", NO_DIR));
    dirSel.value = filterDir;
  }

  function paintFreshness(): void {
    const secs = Math.round((Date.now() - fetchedAt) / 1000);
    freshness.textContent = inFlight
      ? " · refreshing…"
      : secs < TICK_MS / 1000
        ? " · just updated"
        : ` · updated ${secs}s ago`;
  }

  function paint(): void {
    paintDirOptions();
    const counts = new Map<string, number>();
    for (const t of threads) counts.set(t.hostId, (counts.get(t.hostId) ?? 0) + 1);
    sub.textContent = hosts.map((h) => `${h.id} · ${counts.get(h.id) ?? 0}`).join("   ");

    const needle = filterText.trim().toLowerCase();
    const rows = threads.filter((t) => {
      if (filterHost && t.hostId !== filterHost) return false;
      const bucket = dirBucket(t);
      if (filterDir === NO_DIR && bucket) return false;
      if (filterDir && filterDir !== NO_DIR && bucket?.key !== filterDir) return false;
      if (!needle) return true;
      return (
        t.threadId.toLowerCase().includes(needle) ||
        (t.title ?? "").toLowerCase().includes(needle) ||
        (dirBucket(t)?.label ?? "").toLowerCase().includes(needle) ||
        (t.cwd ?? "").toLowerCase().includes(needle) ||
        (t.stats?.summary ?? "").toLowerCase().includes(needle)
      );
    });

    rows.sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      let cmp: number;
      if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv));
      if (cmp !== 0) return sortDesc ? -cmp : cmp;
      // Ties always fall back to most-recent-first, whichever way the column runs.
      return Date.parse(lastActivity(b)) - Date.parse(lastActivity(a));
    });

    for (const [key, th] of headCells) {
      const active = key === sortKey;
      th.classList.toggle("sorted", active);
      th.querySelector(".sort-mark")!.textContent = active ? (sortDesc ? "▾" : "▲") : "";
    }

    // A poll can change row count; keep the reader where they were.
    const scrollY = window.scrollY;
    tbody.replaceChildren(...rows.map(threadRow));
    if (scrollY > 0 && window.scrollY !== scrollY) window.scrollTo({ top: scrollY });

    const ctx = rows.reduce((s, t) => s + (t.stats?.contextTokens ?? 0), 0);
    const shown =
      rows.length === threads.length
        ? `${threads.length} threads`
        : `${rows.length} of ${threads.length} threads`;
    countText.textContent = `${shown} · ${fmtTokens(ctx)} context tokens`;
    paintFreshness();
  }

  /**
   * Re-poll the aggregate list. Filters, sort and the search caret all live
   * outside the rows, so re-rendering rows keeps every bit of interaction state.
   */
  async function refresh(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    paintFreshness();
    try {
      threads = await api.threads();
      fetchedAt = Date.now();
    } catch {
      // A transient poll failure keeps the last good rows on screen.
    } finally {
      inFlight = false;
      if (root.isConnected) paint();
    }
  }

  hostSel.onchange = () => {
    filterHost = hostSel.value;
    paint();
  };
  dirSel.onchange = () => {
    filterDir = dirSel.value;
    paint();
  };
  let debounce: ReturnType<typeof setTimeout> | undefined;
  search.oninput = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      filterText = search.value;
      paint();
    }, 120);
  };

  // --- freshness + shortcuts -----------------------------------------------

  const tick = setInterval(() => {
    if (document.hidden) return;
    if (Date.now() - fetchedAt >= REFRESH_MS) void refresh();
    else paintFreshness();
  }, TICK_MS);

  const onFocus = (): void => {
    if (!document.hidden && Date.now() - fetchedAt >= TICK_MS) void refresh();
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onFocus);

  const onKey = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/" && !isTypingTarget(e.target)) {
      e.preventDefault();
      search.focus();
      search.select();
      return;
    }
    if (e.key === "Escape" && (search.value || document.activeElement === search)) {
      e.preventDefault();
      clearTimeout(debounce);
      search.value = "";
      filterText = "";
      search.blur();
      paint();
    }
  };
  window.addEventListener("keydown", onKey);

  teardownList();
  teardown = () => {
    clearInterval(tick);
    clearTimeout(debounce);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onFocus);
    window.removeEventListener("keydown", onKey);
  };

  paint();
  app.replaceChildren(root);
  search.focus();
}

/** Health dot: failed derivations are bad, queued work is a warning. */
function healthDot(t: ThreadRow): HTMLElement | null {
  const s = t.stats;
  if (!s) return null;
  if (s.failedDerivations > 0) {
    const dot = el("span", "health-dot bad");
    dot.title = `${s.failedDerivations} failed derivation${s.failedDerivations === 1 ? "" : "s"}`;
    return dot;
  }
  if (s.pendingWork > 0) {
    const dot = el("span", "health-dot warn");
    dot.title = `${s.pendingWork} queued work item${s.pendingWork === 1 ? "" : "s"}`;
    return dot;
  }
  return null;
}

function threadRow(t: ThreadRow): HTMLElement {
  const href = `#/thread/${t.hostId}/${t.threadId}`;
  const tr = el("tr", "thread-row");
  tr.onclick = (e) => {
    // The title is a real link, so the browser owns modified and middle clicks.
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if ((e.target as HTMLElement).closest("a")) return;
    location.hash = href.slice(1);
  };

  tr.append(el("td", `col-host host host-${t.hostId}`, t.hostId));

  const title = el("td", "col-title");
  const link = el("a", "title-link") as HTMLAnchorElement;
  link.href = href;
  const line = el("div", "title-text");
  const dot = healthDot(t);
  if (dot) line.append(dot);
  line.append(el("span", "title-label", t.title ?? t.threadId));
  link.append(line);
  link.append(el("div", "thread-id", t.threadId));
  title.append(link);
  tr.append(title);

  const dir = el("td", "col-dir");
  const bucket = dirBucket(t);
  if (t.cwd) {
    dir.title = t.cwd;
    const { parent, base } = splitDir(t.cwd);
    if (parent) dir.append(el("span", "dir-parent", parent));
    dir.append(el("span", "dir-base", base));
  } else if (bucket) {
    dir.title = bucket.title;
    dir.append(el("span", "dir-profile", bucket.label));
  } else {
    dir.append(el("span", "dim", "—"));
  }
  tr.append(dir);

  const summary = el("td", "col-summary");
  const text = t.stats?.summary ?? (t.stats ? "" : "missing thread file");
  summary.append(el("span", t.stats ? "summary-text" : "summary-text bad", text));
  if (t.stats?.summary) summary.title = t.stats.summary;
  tr.append(summary);

  tr.append(el("td", "num", t.stats ? String(t.stats.turnCount) : "—"));
  tr.append(el("td", "num", fmtTokens(t.stats?.contextTokens)));
  tr.append(el("td", "col-when dim", fmtStamp(t.createdAt)));
  const activity = el("td", "col-when", fmtAgo(lastActivity(t)));
  activity.title = new Date(lastActivity(t)).toLocaleString();
  tr.append(activity);

  const launchCell = el("td", "col-launch");
  const cmd = t.launch?.command;
  if (cmd) {
    const btn = el("button", "launch-link", "launch") as HTMLButtonElement;
    btn.type = "button";
    btn.title = cmd;
    // The row is clickable; the launch affordance must not navigate.
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openLaunchModal(cmd);
    };
    launchCell.append(btn);
  }
  tr.append(launchCell);
  return tr;
}
