import {
  api,
  type MessageRow,
  type OverviewResponse,
  type TurnKindRow,
  type TurnRow,
  type ViewArrangement,
} from "./api.ts";
import { displayTitle, el, fmtAgo, fmtBytes, fmtCount, fmtStamp, fmtTokens } from "./format.ts";
import { histogramPanel } from "./histogram.ts";
import { closeLaunchModal, openLaunchModal } from "./launchmodal.ts";
import { editAffordance, editName, nameEditorOpen } from "./nameedit.ts";
import { viewTabPanel } from "./viewtab.ts";
import {
  openThreadTerminal,
  subscribeTerminals,
  terminalFor,
  workspaceActive,
  workspaceContains,
} from "./workspace.ts";

export type Tab = "overview" | "histogram" | "turns" | "view";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "overview" },
  { id: "histogram", label: "histogram" },
  { id: "turns", label: "turns" },
  { id: "view", label: "thread view" },
];

export function isTab(s: string | undefined): s is Tab {
  return TABS.some((t) => t.id === s);
}

/** Everything fetched for one thread, kept across tab switches. */
interface ThreadState {
  hostId: string;
  threadId: string;
  ov: OverviewResponse;
  turns: TurnRow[];
  /** Message payloads by turn id, loaded lazily and never refetched. */
  messages: Map<string, MessageRow[]>;
  /** Histogram data, loaded on first visit to that tab and kept after. */
  kinds: TurnKindRow[] | null;
  /** Thread-view projection, loaded on first visit to that tab and kept after. */
  arrangement: ViewArrangement | null;
  selectedTurnOrder: number | null;
  /** When this state's payloads were fetched — drives the freshness readout. */
  loadedAt: number;
}

/** Small LRU so revisiting a thread is instant without unbounded retention. */
const CACHE_MAX = 4;
const cache = new Map<string, ThreadState>();

function cacheKey(hostId: string, threadId: string): string {
  return `${hostId}/${threadId}`;
}

async function loadThread(hostId: string, threadId: string): Promise<ThreadState> {
  const key = cacheKey(hostId, threadId);
  const hit = cache.get(key);
  if (hit) return hit;
  const [ov, turns] = await Promise.all([
    api.overview(hostId, threadId),
    api.turns(hostId, threadId),
  ]);
  const st: ThreadState = {
    hostId,
    threadId,
    ov,
    turns,
    messages: new Map(),
    kinds: null,
    arrangement: null,
    selectedTurnOrder: null,
    loadedAt: Date.now(),
  };
  cache.set(key, st);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return st;
}

function threadPath(st: ThreadState, tab: Tab, turnOrder?: number | null): string {
  const base = `/thread/${st.hostId}/${st.threadId}/${tab}`;
  return tab === "turns" && turnOrder != null ? `${base}/${turnOrder}` : base;
}

// --- keyboard ---------------------------------------------------------------

let detachKeys: (() => void) | null = null;
let detachChart: (() => void) | null = null;
let detachPage: (() => void) | null = null;
let detachLaunch: (() => void) | null = null;

/** Drop any tab-scoped bindings; the router calls this before each render. */
export function teardownDetail(): void {
  closeLaunchModal();
  detachKeys?.();
  detachKeys = null;
  detachChart?.();
  detachChart = null;
  detachPage?.();
  detachPage = null;
  detachLaunch?.();
  detachLaunch = null;
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

// --- render -----------------------------------------------------------------

let renderSeq = 0;

/** Threads are appended to live; re-check the file mtime on this cadence. */
const FRESH_MS = 30_000;
const TICK_MS = 5_000;

/**
 * Drop this thread's cached payloads and re-run the router, which rebuilds the
 * active tab from the hash (tab and selected turn both live there).
 */
function reloadThread(hostId: string, threadId: string): void {
  cache.delete(cacheKey(hostId, threadId));
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export async function renderThread(
  app: HTMLElement,
  hostId: string,
  threadId: string,
  tab: Tab,
  turnOrder: number | null,
): Promise<void> {
  const seq = ++renderSeq;
  const st = await loadThread(hostId, threadId);
  if (seq !== renderSeq) return;
  if (turnOrder != null && st.turns.some((t) => t.turnOrder === turnOrder)) {
    st.selectedTurnOrder = turnOrder;
  }

  /** Re-run whenever the console's own title changes under a rename. */
  const retitle = (): void => {
    document.title = `${displayTitle({ ...st.ov.thread, custom: st.ov.custom })} · ${
      TABS.find((t) => t.id === tab)?.label ?? tab
    } · lhc console`;
  };
  retitle();

  const reload = (): void => reloadThread(hostId, threadId);

  const root = el("div", "page");
  const back = el("a", "back", "← all threads") as HTMLAnchorElement;
  back.href = "#/";
  root.append(back);
  const head = threadHeader(st, reload, retitle);
  root.append(head.node);

  const bar = el("div", "tabbar");
  for (const t of TABS) {
    const btn = el("button", `tab${t.id === tab ? " active" : ""}`, t.label) as HTMLButtonElement;
    btn.type = "button";
    btn.onclick = () => {
      if (t.id === tab) return;
      location.hash = threadPath(st, t.id, st.selectedTurnOrder);
    };
    bar.append(btn);
  }
  root.append(bar);

  switch (tab) {
    case "overview":
      root.append(overviewPanel(st));
      break;
    case "turns":
      root.append(turnsPanel(st));
      break;
    case "histogram":
      root.append(histogramTab(st));
      break;
    case "view":
      root.append(viewTab(st));
      break;
  }

  app.replaceChildren(root);

  // --- freshness poll + page keys ------------------------------------------

  let checking = false;
  /** Cheap overview call, used purely to compare the thread file's mtime. */
  async function checkFresh(): Promise<void> {
    // A changed mtime rebuilds the page, which would throw away a rename in
    // progress; the next tick re-checks once the editor is closed.
    if (checking || !root.isConnected || nameEditorOpen()) return;
    checking = true;
    try {
      const fresh = await api.overview(hostId, threadId);
      if (!root.isConnected) return;
      if (fresh.thread.fileMtime !== st.ov.thread.fileMtime) {
        reload();
        return;
      }
      // Nothing changed on disk — the payloads we hold are current again.
      st.loadedAt = Date.now();
      head.paintFresh();
    } catch {
      // A failed poll changes nothing; the next tick tries again.
    } finally {
      checking = false;
    }
  }

  const tick = setInterval(() => {
    if (document.hidden || !root.isConnected) return;
    if (Date.now() - st.loadedAt >= FRESH_MS) void checkFresh();
    else head.paintFresh();
  }, TICK_MS);

  const onFocus = (): void => {
    if (!document.hidden && Date.now() - st.loadedAt >= TICK_MS) void checkFresh();
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onFocus);

  const onPageKey = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
    if (workspaceActive() || workspaceContains(e.target)) return;
    if (nameEditorOpen()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      location.hash = "/";
    }
  };
  window.addEventListener("keydown", onPageKey);

  detachPage?.();
  detachPage = () => {
    clearInterval(tick);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onFocus);
    window.removeEventListener("keydown", onPageKey);
  };
}

/** The header, plus a hook to repaint just its freshness readout. */
function threadHeader(
  st: ThreadState,
  reload: () => void,
  retitle: () => void,
): { node: HTMLElement; paintFresh: () => void } {
  const { thread, launch, overview } = st.ov;
  const s = overview.stats;
  const head = el("div", "detail-head");

  const top = el("div", "head-top");

  /*
   * The console's own name for this thread, editable in place. The registry
   * title is not replaced by this — it keeps its own labelled field in the
   * Overview tab, and moves to the tooltip here.
   */
  const save = (patch: { title?: string | null; description?: string | null }): Promise<void> =>
    api.setThreadName(thread.hostId, thread.threadId, patch).then((res) => {
      st.ov.custom = res.custom;
    });

  const titleBox = el("div", "head-title");
  const paintTitle = (): void => {
    const custom = st.ov.custom?.title ?? null;
    const h1 = el("h1", undefined, displayTitle({ ...thread, custom: st.ov.custom }));
    h1.title =
      custom && thread.title ? `registry title: ${thread.title}` : "click to name this thread";
    h1.onclick = editTitle;
    titleBox.replaceChildren(h1, editAffordance("rename (console only)", editTitle));
    retitle();
  };
  function editTitle(): void {
    editName(titleBox, {
      field: "title",
      stored: st.ov.custom?.title ?? null,
      save: (value) => save({ title: value }),
      after: paintTitle,
    });
  }
  paintTitle();
  top.append(titleBox);
  const meta = el("div", "head-meta");
  meta.append(el("span", `badge host-${thread.hostId}`, thread.hostId));
  meta.append(el("span", "dim", overview.threadId));
  if (thread.cwd) {
    const cwd = el("span", "cwd", thread.cwd);
    cwd.title = thread.cwd;
    meta.append(cwd);
  }
  // A deep link to a hidden thread still works; say so, and offer the way back.
  if (st.ov.hidden) {
    const tag = el("span", "hidden-tag");
    tag.append(el("span", "badge hidden-badge", "hidden"));
    const unhide = el("button", "linkish", "unhide") as HTMLButtonElement;
    unhide.type = "button";
    unhide.title = "show this thread in the list again";
    unhide.onclick = () => {
      void api.hideThread(thread.hostId, thread.threadId, false).then(reload, reload);
    };
    tag.append(unhide);
    meta.append(tag);
  }
  top.append(meta);
  head.append(top);

  /*
   * One line about the thread, console-owned like the title. Absent is a
   * state worth showing rather than hiding: an empty header line that says
   * how to fill it is how anyone finds out this is editable at all.
   */
  const descBox = el("div", "head-desc");
  const paintDesc = (): void => {
    const desc = st.ov.custom?.description ?? null;
    const text = el(
      "span",
      desc ? "head-desc-text" : "head-desc-text empty",
      desc ?? "no description — click to add",
    );
    text.onclick = editDesc;
    descBox.replaceChildren(text, editAffordance("describe (console only)", editDesc));
  };
  function editDesc(): void {
    editName(descBox, {
      field: "description",
      stored: st.ov.custom?.description ?? null,
      save: (value) => save({ description: value }),
      after: paintDesc,
    });
  }
  paintDesc();
  head.append(descBox);

  const stamps = el("div", "head-stamps dim");
  stamps.textContent = `created ${fmtStamp(overview.createdAt)}  ·  last activity ${fmtStamp(s.lastEventAt)} (${fmtAgo(s.lastEventAt)})`;
  const fresh = el("span", "head-fresh");
  const freshLabel = el("span", "dim");
  const refreshBtn = el("button", "linkish", "refresh") as HTMLButtonElement;
  refreshBtn.type = "button";
  refreshBtn.title = "re-read the thread file now";
  refreshBtn.onclick = reload;
  fresh.append(freshLabel, el("span", "dim", " · "), refreshBtn);
  // Present for every host with a resume path. A missing command is not a
  // missing affordance: the modal explains why instead of leaving a blank.
  if (launch) {
    const launchBtn = el("button", "linkish launch-link") as HTMLButtonElement;
    launchBtn.type = "button";
    const paintLaunch = (): void => {
      const live = terminalFor(thread.hostId, thread.threadId);
      launchBtn.textContent = live ? "terminal" : "launch";
      launchBtn.classList.toggle("has-term", !!live);
      launchBtn.title = live
        ? `running: ${launch.command}`
        : (launch.command ?? launch.reason ?? "no resume path");
    };
    paintLaunch();
    launchBtn.onclick = () => {
      if (terminalFor(thread.hostId, thread.threadId)) {
        void openThreadTerminal(thread.hostId, thread.threadId);
      } else {
        openLaunchModal(launch, { hostId: thread.hostId, threadId: thread.threadId });
      }
    };
    // The modal stays reachable even when a terminal is already running.
    const cmdBtn = el("button", "linkish launch-cmd", "launch cmd") as HTMLButtonElement;
    cmdBtn.type = "button";
    cmdBtn.title = launch.command ?? launch.reason ?? "no resume path";
    cmdBtn.onclick = () =>
      openLaunchModal(launch, { hostId: thread.hostId, threadId: thread.threadId });
    const unsub = subscribeTerminals(paintLaunch);
    detachLaunch?.();
    detachLaunch = unsub;
    fresh.append(el("span", "dim", " · "), launchBtn, el("span", "dim", " · "), cmdBtn);
    // A live writer outside the console: the same marker the list rows carry,
    // neutral rather than warn-toned on shared-writer hosts.
    const strangers = (launch.attached ?? []).filter((a) => a.source === "process");
    const shared = launch.writerPolicy === "shared";
    if (strangers.length > 0 && (shared || launch.inUse)) {
      const mark = el(
        "span",
        shared ? "attached-mark shared dim" : "attached-mark dim",
        "attached",
      );
      mark.title = strangers.map((a) => `pid ${a.pid}: ${a.args}`).join("\n");
      fresh.append(el("span", "dim", " · "), mark);
    }
  }
  stamps.append(fresh);
  head.append(stamps);

  const paintFresh = (): void => {
    const secs = Math.round((Date.now() - st.loadedAt) / 1000);
    freshLabel.textContent = secs < 5 ? "updated just now" : `updated ${secs}s ago`;
  };
  paintFresh();

  const nums = el("div", "head-nums");
  const bits: [string, string][] = [
    ["turns", fmtCount(s.turnCount)],
    ["messages", fmtCount(s.messageCount)],
    ["tokens", fmtTokens(s.totalTokenEstimate)],
    ["context", fmtTokens(s.contextTokens)],
    ["size", fmtBytes(thread.fileSizeBytes)],
  ];
  for (const [k, v] of bits) {
    const item = el("span", "head-num");
    item.append(el("span", "dim", k));
    item.append(el("span", "num", v));
    nums.append(item);
  }
  head.append(nums);
  return { node: head, paintFresh };
}

// --- thread view tab --------------------------------------------------------

function viewTab(st: ThreadState): HTMLElement {
  const host = el("div", "vt-host");

  const mount = (data: ViewArrangement): void => {
    host.replaceChildren(
      viewTabPanel({
        data,
        turnHref: (turnOrder) => `#${threadPath(st, "turns", turnOrder)}`,
      }),
    );
  };

  if (st.arrangement) {
    mount(st.arrangement);
    return host;
  }

  host.append(el("div", "hint", "loading…"));
  api
    .viewArrangement(st.hostId, st.threadId)
    .then((data) => {
      st.arrangement = data;
      // The tab may have been navigated away from while the fetch was in flight.
      if (host.isConnected) mount(data);
    })
    .catch((e: unknown) => {
      if (host.isConnected) {
        host.replaceChildren(el("div", "error", e instanceof Error ? e.message : String(e)));
      }
    });
  return host;
}

// --- histogram tab ----------------------------------------------------------

function histogramTab(st: ThreadState): HTMLElement {
  const host = el("div", "hist-host");

  const mount = (rows: TurnKindRow[]): void => {
    const chart = histogramPanel({
      rows,
      compactPoint: st.ov.overview.view?.compactPoint ?? null,
      onSelect: (turnOrder) => {
        st.selectedTurnOrder = turnOrder;
        location.hash = threadPath(st, "turns", turnOrder);
      },
    });
    detachChart?.();
    detachChart = chart.dispose;
    host.replaceChildren(chart.node);
  };

  if (st.kinds) {
    mount(st.kinds);
    return host;
  }

  host.append(el("div", "hint", "loading…"));
  api
    .turnKinds(st.hostId, st.threadId)
    .then((rows) => {
      st.kinds = rows;
      // The tab may have been navigated away from while the fetch was in flight.
      if (host.isConnected) mount(rows);
    })
    .catch((e: unknown) => {
      if (host.isConnected) {
        host.replaceChildren(el("div", "error", e instanceof Error ? e.message : String(e)));
      }
    });
  return host;
}

// --- overview tab -----------------------------------------------------------

function kv(label: string, value: string, cls?: string): HTMLElement {
  const row = el("div", "kv");
  row.append(el("span", "kv-k", label));
  row.append(el("span", ["kv-v", cls].filter(Boolean).join(" "), value));
  return row;
}

/** Same shape as `kv`, but the value navigates — used to cross-link tabs. */
function kvLink(label: string, value: string, href: string): HTMLElement {
  const row = el("div", "kv");
  row.append(el("span", "kv-k", label));
  const a = el("a", "kv-v kv-link", value) as HTMLAnchorElement;
  a.href = href;
  row.append(a);
  return row;
}

function group(title: string, cls?: string): HTMLElement {
  const g = el("div", ["ov-group", cls].filter(Boolean).join(" "));
  g.append(el("div", "ov-title", title));
  return g;
}

const KIND_LABELS: [string, string][] = [
  ["user_prompt", "user prompts"],
  ["assistant_text", "assistant text"],
  ["assistant_thinking", "thinking"],
  ["tool_call", "tool calls"],
  ["tool_result", "tool results"],
  ["model_change", "model changes"],
  ["thinking_level_change", "thinking level"],
  ["runtime_note", "notes"],
];

function overviewPanel(st: ThreadState): HTMLElement {
  const { thread, overview } = st.ov;
  const s = overview.stats;
  const grid = el("div", "ov-grid");

  const identity = group("identity");
  identity.append(kv("thread id", overview.threadId));
  // The header may be showing a console-owned name; what the host itself calls
  // this thread stays visible here, unedited and unhidden.
  const registryTitle = kv("registry title", thread.title ?? "—", thread.title ? "" : "dim");
  if (thread.title) registryTitle.title = thread.title;
  identity.append(registryTitle);
  const path = kv("file path", thread.filePath, "path");
  path.title = thread.filePath;
  identity.append(path);
  identity.append(kv("estimator", overview.tokenEstimator));
  identity.append(kv("created", fmtStamp(overview.createdAt)));
  identity.append(kv("last event", `${fmtStamp(s.lastEventAt)} (${fmtAgo(s.lastEventAt)})`));
  grid.append(identity);

  const volume = group("volume");
  volume.append(kv("events", fmtCount(s.eventCount)));
  volume.append(kv("messages", fmtCount(s.messageCount)));
  const kinds = el("div", "kv-sub");
  const seen = new Set<string>();
  for (const [kind, label] of KIND_LABELS) {
    const n = overview.messageKinds[kind];
    if (n == null) continue;
    seen.add(kind);
    kinds.append(kv(label, fmtCount(n)));
  }
  for (const [kind, n] of Object.entries(overview.messageKinds)) {
    if (!seen.has(kind)) kinds.append(kv(kind, fmtCount(n)));
  }
  if (kinds.childElementCount > 0) volume.append(kinds);
  const open = s.turnCount - s.closedTurnCount;
  volume.append(
    kvLink(
      "turns",
      `${fmtCount(s.turnCount)} (${s.closedTurnCount} closed, ${open} open)`,
      `#${threadPath(st, "turns", st.selectedTurnOrder)}`,
    ),
  );
  volume.append(kv("chunks", fmtCount(overview.chunkCount)));
  volume.append(kv("total tokens", fmtTokens(s.totalTokenEstimate)));
  volume.append(kv("context tokens", fmtTokens(s.contextTokens)));
  volume.append(kv("file size", fmtBytes(thread.fileSizeBytes)));
  grid.append(volume);

  const view = group("thread view");
  if (overview.view) {
    const v = overview.view;
    view.append(kv("profile", v.profileName ?? "unnamed"));
    view.append(kv("created", `${fmtStamp(v.createdAt)} (${fmtAgo(v.createdAt)})`));
    view.append(kv("compact point", `event ${fmtCount(v.compactPoint)}`));
    view.append(kv("covered from", `event ${fmtCount(v.coveredFrom)}`));
    const viewHref = `#${threadPath(st, "view")}`;
    const bands = el("div", "kv-sub");
    for (const b of v.bands) {
      bands.append(kvLink(`${b.band} band`, `${fmtTokens(b.tokenCount)} tok`, viewHref));
    }
    if (v.bands.length === 0) bands.append(kvLink("bands", "none stored", viewHref));
    view.append(bands);
  } else {
    const note = el("a", "kv-note kv-link", "never compacted — whole thread is live");
    (note as HTMLAnchorElement).href = `#${threadPath(st, "view")}`;
    view.append(note);
  }
  grid.append(view);

  const health = group("health");
  const states = overview.derivationStates;
  const allReady = Object.entries(states).every(([k, n]) => k === "ready" || n === 0);
  for (const state of ["ready", "pending", "failed", "blocked"]) {
    const n = states[state];
    if (n == null) continue;
    const cls = state === "failed" || state === "blocked" ? "bad" : state === "ready" ? "dim" : "";
    health.append(kv(`derivations ${state}`, fmtCount(n), cls));
  }
  if (Object.keys(states).length === 0) {
    health.append(kv("derivations", "none", "dim"));
  } else if (allReady) {
    health.append(el("div", "kv-note dim", "all derivations ready"));
  }
  health.append(kv("queued work", fmtCount(s.pendingWork), s.pendingWork > 0 ? "" : "dim"));
  health.append(
    kv(
      "visibility boundary",
      overview.visibilityBoundary == null ? "—" : `event ${fmtCount(overview.visibilityBoundary)}`,
    ),
  );
  grid.append(health);

  const summaryText = overview.summary ?? s.summary;
  if (summaryText) {
    const sum = group("summary", "ov-wide");
    sum.append(el("p", "ov-summary", summaryText));
    grid.append(sum);
  }

  return grid;
}

// --- turns tab --------------------------------------------------------------

function turnsPanel(st: ThreadState): HTMLElement {
  const cols = el("div", "detail-cols");
  const turnCol = el("div", "turn-col");
  const msgCol = el("div", "msg-col");
  const mini = el("div", "msg-mini dim", "no turn selected");
  const msgBody = el("div", "msg-body");
  msgCol.append(mini, msgBody);
  cols.append(turnCol, msgCol);

  if (st.turns.length === 0) {
    turnCol.append(el("div", "hint", "no turns"));
    msgBody.append(el("div", "hint", "nothing to show"));
    return cols;
  }

  const cards = new Map<number, HTMLElement>();
  for (const t of st.turns) {
    const card = turnCard(t);
    card.onclick = () => select(t.turnOrder, false);
    cards.set(t.turnOrder, card);
    turnCol.append(card);
  }

  let loadSeq = 0;

  function select(order: number, scroll: boolean): void {
    const turn = st.turns.find((t) => t.turnOrder === order);
    if (!turn) return;
    st.selectedTurnOrder = order;
    for (const [o, c] of cards) c.classList.toggle("selected", o === order);
    const card = cards.get(order);
    // `nearest` only: never yank the list to centre a card that is already visible.
    if (card && scroll) card.scrollIntoView({ block: "nearest" });

    mini.className = "msg-mini";
    mini.textContent = `turn #${turn.turnOrder} · ${turn.messageCount} msgs · ${fmtTokens(turn.tokenEstimate)} tokens`;
    history.replaceState(null, "", `#${threadPath(st, "turns", order)}`);

    // Bumped for cached turns too, so an in-flight chunked render is abandoned.
    const seq = ++loadSeq;
    const stale = (): boolean => seq !== loadSeq;

    const cached = st.messages.get(turn.turnId);
    if (cached) {
      paintMessages(msgBody, cached, stale);
      return;
    }
    msgBody.replaceChildren(
      el(
        "div",
        "hint msg-pending",
        `${fmtCount(turn.messageCount)} message${turn.messageCount === 1 ? "" : "s"} · ` +
          `${fmtTokens(turn.tokenEstimate)} tokens · loading…`,
      ),
    );
    api
      .messages(st.hostId, st.threadId, turn.turnId)
      .then((msgs) => {
        st.messages.set(turn.turnId, msgs);
        if (stale()) return;
        paintMessages(msgBody, msgs, stale);
      })
      .catch((e: unknown) => {
        if (!stale()) {
          msgBody.replaceChildren(el("div", "error", e instanceof Error ? e.message : String(e)));
        }
      });
  }

  function move(delta: number): void {
    const idx = st.turns.findIndex((t) => t.turnOrder === st.selectedTurnOrder);
    if (idx < 0) {
      select(st.turns[delta > 0 ? 0 : st.turns.length - 1].turnOrder, true);
      return;
    }
    const next = Math.min(st.turns.length - 1, Math.max(0, idx + delta));
    if (next !== idx) select(st.turns[next].turnOrder, true);
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
    if (workspaceActive() || workspaceContains(e.target)) return;
    const delta =
      e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    move(delta);
  };
  detachKeys?.();
  window.addEventListener("keydown", onKey);
  detachKeys = () => window.removeEventListener("keydown", onKey);

  const initial = st.turns.some((t) => t.turnOrder === st.selectedTurnOrder)
    ? st.selectedTurnOrder!
    : st.turns[0].turnOrder;
  select(initial, false);
  // Scroll happens after the list is in the document.
  queueMicrotask(() => cards.get(initial)?.scrollIntoView({ block: "nearest" }));
  return cols;
}

/** Above this, building every card in one go is long enough to drop frames. */
const SYNC_MESSAGES = 150;
/** First paint of a big turn: enough to fill the pane, cheap to build. */
const FIRST_CHUNK = 100;
/** Cards appended per animation frame after that. */
const CHUNK = 40;

/**
 * Render a turn's messages into the pane. Small turns paint in one go; a turn
 * with hundreds of messages paints its first screenful immediately and appends
 * the rest in animation-frame batches, so switching tabs or turns never blocks.
 */
function paintMessages(body: HTMLElement, msgs: MessageRow[], stale: () => boolean): void {
  if (msgs.length === 0) {
    body.replaceChildren(el("div", "hint", "no messages"));
    return;
  }
  if (msgs.length <= SYNC_MESSAGES) {
    body.replaceChildren(...msgs.map(messageCard));
    body.scrollTop = 0;
    return;
  }

  body.replaceChildren(...msgs.slice(0, FIRST_CHUNK).map(messageCard));
  body.scrollTop = 0;
  const more = el("div", "hint msg-more");
  const remaining = (): number => msgs.length - i;
  let i = FIRST_CHUNK;
  more.textContent = `rendering ${fmtCount(remaining())} more messages…`;
  body.append(more);

  const step = (): void => {
    if (stale() || !body.isConnected) return;
    const frag = document.createDocumentFragment();
    for (let n = 0; n < CHUNK && i < msgs.length; n++, i++) frag.append(messageCard(msgs[i]));
    body.insertBefore(frag, more);
    if (i < msgs.length) {
      more.textContent = `rendering ${fmtCount(remaining())} more messages…`;
      requestAnimationFrame(step);
    } else {
      more.remove();
    }
  };
  requestAnimationFrame(step);
}

function turnCard(t: TurnRow): HTMLElement {
  const card = el("div", `turn-card${t.status === "open" ? " open" : ""}`);
  const top = el("div", "turn-top");
  top.append(el("span", `turn-dot ${t.status}`));
  top.append(el("span", "turn-order", `#${t.turnOrder}`));
  if (t.status === "open") top.append(el("span", "badge warn", "open"));
  top.append(el("span", "turn-spacer"));
  top.append(el("span", "num dim", `${t.messageCount} msgs`));
  top.append(el("span", "num", fmtTokens(t.tokenEstimate)));
  const when = el("span", "dim", fmtAgo(t.startedAt));
  when.title = t.startedAt ? new Date(t.startedAt).toLocaleString() : "unknown";
  top.append(when);
  card.append(top);
  const excerpt = t.promptExcerpt?.trim();
  card.append(
    excerpt ? el("div", "excerpt", excerpt) : el("div", "excerpt no-prompt", "(no prompt)"),
  );
  return card;
}

const KIND_ICON: Record<string, string> = {
  user_prompt: "🧑",
  assistant_text: "🤖",
  assistant_thinking: "💭",
  tool_call: "🔧",
  tool_result: "📄",
  model_change: "🔀",
  thinking_level_change: "🎚",
  runtime_note: "📌",
};

function messageCard(m: MessageRow): HTMLElement {
  const card = el("div", `msg msg-${m.kind}`);
  const head = el("div", "msg-head");
  const toolName = m.blocks.find((b) => b.toolName)?.toolName;
  head.append(
    el(
      "span",
      undefined,
      `${KIND_ICON[m.kind] ?? "•"} ${m.kind}${toolName ? ` · ${toolName}` : ""}`,
    ),
  );
  head.append(el("span", "dim", `#${m.sourceEventOrder}`));
  head.append(el("span", "num dim", fmtTokens(m.tokenEstimate)));
  card.append(head);
  for (const b of m.blocks) {
    const pre = el("pre", "msg-content");
    const truncated = b.contentLength > b.content.length;
    pre.textContent =
      b.content + (truncated ? `\n… (${b.contentLength - b.content.length} more chars)` : "");
    card.append(pre);
  }
  return card;
}
