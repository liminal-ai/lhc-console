import { api, type ThreadRow } from "./api.ts";
import { el, fmtAgo, fmtStamp, fmtTokens, splitDir } from "./format.ts";

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
      return (t.cwd ?? "￿").toLowerCase();
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

export async function renderList(app: HTMLElement): Promise<void> {
  const [hosts, threads] = await Promise.all([api.hosts(), api.threads()]);

  const root = el("div", "page");
  const header = el("header");
  header.append(el("h1", undefined, "lhc console"));
  const sub = el("div", "subtitle");
  sub.textContent = hosts.map((h) => `${h.id} · ${h.threadCount}`).join("   ");
  header.append(sub);
  root.append(header);

  const controls = el("div", "controls");

  const hostSel = el("select") as HTMLSelectElement;
  hostSel.append(new Option("all hosts", ""));
  for (const h of hosts) hostSel.append(new Option(h.id, h.id));
  hostSel.value = filterHost;

  const dirSel = el("select") as HTMLSelectElement;
  dirSel.className = "dir-select";
  const search = el("input") as HTMLInputElement;
  search.type = "search";
  search.placeholder = "search title, directory, thread id, summary…";
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
  thead.append(headRow);
  table.append(thead);
  const tbody = el("tbody");
  table.append(tbody);
  root.append(table);

  const count = el("div", "list-count");
  root.append(count);

  /** Rebuild directory options from whatever the host filter admits. */
  function paintDirOptions(): void {
    const scope = filterHost ? threads.filter((t) => t.hostId === filterHost) : threads;
    const dirs = [...new Set(scope.map((t) => t.cwd).filter((c): c is string => !!c))].sort(
      (a, b) => splitDir(a).base.localeCompare(splitDir(b).base) || a.localeCompare(b),
    );
    const hasNone = scope.some((t) => !t.cwd);
    if (filterDir && filterDir !== NO_DIR && !dirs.includes(filterDir)) filterDir = "";
    if (filterDir === NO_DIR && !hasNone) filterDir = "";
    dirSel.replaceChildren();
    dirSel.append(new Option("all directories", ""));
    for (const d of dirs) {
      const opt = new Option(splitDir(d).base, d);
      opt.title = d;
      dirSel.append(opt);
    }
    if (hasNone) dirSel.append(new Option("no directory", NO_DIR));
    dirSel.value = filterDir;
  }

  function paint(): void {
    paintDirOptions();
    const needle = filterText.trim().toLowerCase();
    const rows = threads.filter((t) => {
      if (filterHost && t.hostId !== filterHost) return false;
      if (filterDir === NO_DIR && t.cwd) return false;
      if (filterDir && filterDir !== NO_DIR && t.cwd !== filterDir) return false;
      if (!needle) return true;
      return (
        t.threadId.toLowerCase().includes(needle) ||
        (t.title ?? "").toLowerCase().includes(needle) ||
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

    tbody.replaceChildren(...rows.map(threadRow));
    count.textContent =
      rows.length === threads.length
        ? `${threads.length} threads`
        : `${rows.length} of ${threads.length} threads`;
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

  paint();
  app.replaceChildren(root);
  search.focus();
}

function threadRow(t: ThreadRow): HTMLElement {
  const tr = el("tr", "thread-row");
  tr.onclick = () => {
    location.hash = `/thread/${t.hostId}/${t.threadId}`;
  };

  tr.append(el("td", `col-host host host-${t.hostId}`, t.hostId));

  const title = el("td", "col-title");
  title.append(el("div", "title-text", t.title ?? t.threadId));
  title.append(el("div", "thread-id", t.threadId));
  tr.append(title);

  const dir = el("td", "col-dir");
  const { parent, base } = splitDir(t.cwd);
  if (t.cwd) dir.title = t.cwd;
  if (parent) dir.append(el("span", "dir-parent", parent));
  dir.append(el("span", t.cwd ? "dir-base" : "dim", base));
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
  return tr;
}
