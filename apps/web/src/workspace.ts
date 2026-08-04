/**
 * The terminal workspace: a second top-level mode (`#/term`) that takes over
 * the viewport with one thin bar plus 1–3 terminal panes.
 *
 * Terminals are server-owned PTYs; this module only mirrors them. The server
 * buffer is the truth — reload, disconnect and reconnect all resolve by
 * replaying it. What lives here instead is the *composition*: which terminals
 * share a screen, in what order, at what widths. That is local, and it is
 * persisted to localStorage keyed by terminal id.
 *
 * The workspace container is never unmounted: browser mode just hides it, so
 * xterm instances (and their scrollback) survive every flip.
 */

import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api, type TerminalRow, type ThreadRow } from "./api.ts";
import { displayTitle, el } from "./format.ts";
// Cyclic by nature (the modal spawns through this module, this module opens
// the modal) and safe: both directions are function references, resolved at
// click time rather than at module evaluation.
import { openNewSessionModal } from "./newsessionmodal.ts";

const RETRY_START_MS = 1000;
const RETRY_CAP_MS = 15_000;
const PING_MS = 25_000;
const CONFIRM_MS = 2000;
const MAX_PANES = 3;
const MIN_PANE_PX = 320;
const TITLE_MAX = 22;
const STORE_KEY = "lhc-console.workspace";
/** Running but silent for this long reads as "probably waiting for you". */
const IDLE_AFTER_MS = 3 * 60_000;
/** Ageing the idle tint needs a heartbeat; nothing else does. */
const ACTIVITY_TICK_MS = 20_000;
/** Output is continuous; tell subscribers about it at human speed. */
const ACTIVITY_NOTIFY_MS = 2000;

/** One live terminal: server row + its xterm + its socket + its DOM. */
interface Term {
  info: TerminalRow;
  term: Terminal | null;
  fit: FitAddon | null;
  ws: WebSocket | null;
  pane: HTMLElement;
  host: HTMLElement;
  strip: HTMLElement;
  retryMs: number;
  retryTimer: number | null;
  pingTimer: number | null;
  gone: boolean;
}

interface Screen {
  id: string;
  /** Terminal ids, left to right. A terminal is on exactly one screen. */
  panes: string[];
  /** Flex weights, parallel to `panes`. */
  widths: number[];
  row: HTMLElement;
  /** When this screen was last on view — output after it counts as unseen. */
  lastViewedAt: number;
}

const terms = new Map<string, Term>();
const screens: Screen[] = [];
const subs = new Set<() => void>();

let root: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
let tabsEl: HTMLElement | null = null;
let controlsEl: HTMLElement | null = null;
let popover: HTMLElement | null = null;
let indicator: HTMLButtonElement | null = null;
let activeScreen: string | null = null;
let focusedPane: string | null = null;
let visible = false;
let screenSeq = 0;
/** The browser route to come back to; `← threads` and the flip both use it. */
let lastBrowserRoute = "#/";

function notify(): void {
  for (const fn of subs) fn();
}

export function subscribeTerminals(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** True while the workspace owns the viewport — browser keybindings must yield. */
export function workspaceActive(): boolean {
  return visible;
}

export function workspaceContains(target: EventTarget | null): boolean {
  return target instanceof Node && !!root && root.contains(target);
}

/** The running terminal for a thread, if one exists. */
export function terminalFor(hostId: string, threadId: string): TerminalRow | null {
  for (const t of terms.values()) {
    // Idle terminals count: the session persists at a shell and can resume.
    const live = t.info.status === "running" || t.info.state === "idle";
    if (live && t.info.hostId === hostId && t.info.threadId === threadId) {
      return t.info;
    }
  }
  return null;
}

export function terminalCount(): { total: number; running: number } {
  let running = 0;
  for (const t of terms.values()) if (t.info.status === "running") running += 1;
  return { total: terms.size, running };
}

export function rememberBrowserRoute(hash: string): void {
  if (hash && hash !== "#/term") lastBrowserRoute = hash;
}

// --- persistence ------------------------------------------------------------

function persist(): void {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        screens: screens.map((s) => ({ id: s.id, panes: s.panes, widths: s.widths })),
        active: activeScreen,
      }),
    );
  } catch {
    // private mode or quota — composition just won't survive the reload
  }
}

interface StoredScreen {
  id: string;
  panes: string[];
  widths: number[];
}

function readStore(): { screens: StoredScreen[]; active: string | null } {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { screens: [], active: null };
    const parsed = JSON.parse(raw) as { screens?: StoredScreen[]; active?: string | null };
    return { screens: parsed.screens ?? [], active: parsed.active ?? null };
  } catch {
    return { screens: [], active: null };
  }
}

// --- screens ----------------------------------------------------------------

function newScreenId(): string {
  screenSeq += 1;
  return `s${screenSeq}_${Math.random().toString(36).slice(2, 6)}`;
}

function makeScreen(id = newScreenId()): Screen {
  const row = el("div", "ws-screen");
  row.style.display = "none";
  bodyEl?.append(row);
  const s: Screen = { id, panes: [], widths: [], row, lastViewedAt: Date.now() };
  screens.push(s);
  return s;
}

// --- activity ---------------------------------------------------------------

/*
 * Which screens have something to say. The server timestamps every byte, and
 * an attached socket sees them live, so this is derivation rather than
 * plumbing: output newer than the last time a screen was on view is unseen,
 * and a running pane that has said nothing for minutes is probably waiting.
 */

let lastActivityNotify = 0;

/** Newest output across a screen's panes, as epoch ms. */
function screenOutputAt(s: Screen): number {
  let newest = 0;
  for (const id of s.panes) {
    const at = terms.get(id)?.info.lastOutputAt;
    const ms = at ? Date.parse(at) : 0;
    if (ms > newest) newest = ms;
  }
  return newest;
}

function screenUnseen(s: Screen): boolean {
  if (visible && s.id === activeScreen) return false;
  return screenOutputAt(s) > s.lastViewedAt;
}

/** Running, attached, and quiet for a while — no news is its own signal. */
function screenIdle(s: Screen): boolean {
  if (!screenRunning(s)) return false;
  const at = screenOutputAt(s);
  return at > 0 && Date.now() - at > IDLE_AFTER_MS;
}

/** Mark output on a terminal the client is watching, and throttle the fan-out. */
function markOutput(t: Term): void {
  t.info = { ...t.info, lastOutputAt: new Date().toISOString() };
  const now = Date.now();
  const s = screenOf(t.info.id);
  // Only the bar cares immediately, and only for screens that are off view.
  if (s && (!visible || s.id !== activeScreen)) paintBar();
  if (now - lastActivityNotify < ACTIVITY_NOTIFY_MS) return;
  lastActivityNotify = now;
  notify();
}

function screenOf(termId: string): Screen | undefined {
  return screens.find((s) => s.panes.includes(termId));
}

function dropScreen(s: Screen): void {
  const i = screens.indexOf(s);
  if (i >= 0) screens.splice(i, 1);
  s.row.remove();
  if (activeScreen === s.id) activeScreen = screens[0]?.id ?? null;
}

/** Re-lay a screen's panes and dividers; existing xterm nodes are re-parented. */
function renderScreen(s: Screen): void {
  s.row.replaceChildren();
  s.panes.forEach((id, i) => {
    const t = terms.get(id);
    if (!t) return;
    t.pane.style.flex = `${s.widths[i] ?? 1} 1 0`;
    s.row.append(t.pane);
    if (i < s.panes.length - 1) {
      const div = el("div", "ws-div");
      div.addEventListener("pointerdown", (e) => startDividerDrag(e as PointerEvent, s, i));
      s.row.append(div);
    }
  });
}

function showScreen(id: string): void {
  activeScreen = id;
  for (const s of screens) s.row.style.display = s.id === id ? "flex" : "none";
  const s = screens.find((x) => x.id === id);
  if (s) {
    s.lastViewedAt = Date.now();
    for (const tid of s.panes) attachTerm(terms.get(tid)!);
    if (!s.panes.includes(focusedPane ?? "")) focusedPane = s.panes[0] ?? null;
  }
  paintBar();
  persist();
  // Layout settles a frame after the display flip; fit once it has.
  requestAnimationFrame(() => {
    fitVisible();
    if (visible && focusedPane) terms.get(focusedPane)?.term?.focus();
    paintFocus();
  });
}

function paintFocus(): void {
  for (const [id, t] of terms) t.pane.classList.toggle("focused", id === focusedPane);
}

function focusPane(id: string): void {
  focusedPane = id;
  paintFocus();
  const t = terms.get(id);
  t?.term?.focus();
  // Focusing a pane claims input for this tab (single-owner rule server-side).
  if (t?.ws && t.ws.readyState === 1) {
    try {
      t.ws.send(JSON.stringify({ type: "claimInput" }));
    } catch {
      // socket mid-reconnect
    }
  }
}

function fitVisible(): void {
  if (!visible) return;
  const s = screens.find((x) => x.id === activeScreen);
  if (!s) return;
  for (const id of s.panes) fitTerm(terms.get(id));
}

/** Fit one pane to its box and tell its pty the new size. Never shared. */
function fitTerm(t: Term | undefined): void {
  if (!t?.term || !t.fit) return;
  try {
    t.fit.fit();
  } catch {
    return; // not laid out yet
  }
  sendControl(t, { type: "resize", cols: t.term.cols, rows: t.term.rows });
}

function startDividerDrag(e: PointerEvent, s: Screen, leftIndex: number): void {
  e.preventDefault();
  const grip = e.currentTarget as HTMLElement;
  grip.setPointerCapture(e.pointerId);
  const leftEl = terms.get(s.panes[leftIndex])?.pane;
  const rightEl = terms.get(s.panes[leftIndex + 1])?.pane;
  if (!leftEl || !rightEl) return;
  const startX = e.clientX;
  const lw = leftEl.getBoundingClientRect().width;
  const rw = rightEl.getBoundingClientRect().width;
  const total = lw + rw;
  const weight = (s.widths[leftIndex] ?? 1) + (s.widths[leftIndex + 1] ?? 1);

  const move = (ev: PointerEvent): void => {
    const delta = ev.clientX - startX;
    const nl = Math.min(Math.max(lw + delta, MIN_PANE_PX), total - MIN_PANE_PX);
    s.widths[leftIndex] = (nl / total) * weight;
    s.widths[leftIndex + 1] = ((total - nl) / total) * weight;
    leftEl.style.flex = `${s.widths[leftIndex]} 1 0`;
    rightEl.style.flex = `${s.widths[leftIndex + 1]} 1 0`;
  };
  const up = (ev: PointerEvent): void => {
    grip.releasePointerCapture(ev.pointerId);
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", up);
    fitTerm(terms.get(s.panes[leftIndex]));
    fitTerm(terms.get(s.panes[leftIndex + 1]));
    persist();
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
}

// --- websocket + xterm ------------------------------------------------------

function sendControl(t: Term, frame: Record<string, unknown>): void {
  if (t.ws?.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify(frame));
}

function setStrip(t: Term, text: string, cls: string): void {
  t.strip.className = `ws-strip ${cls}`;
  t.strip.textContent = text;
}

function exitStrip(t: Term): void {
  const code = t.info.exitCode ?? "?";
  setStrip(t, `process exited (code ${code}) — ✕ to dismiss`, t.info.exitCode ? "bad" : "dim");
}

/**
 * ctrl+` (mode flip) and alt+1..9 (screen switch) belong to the console, so
 * xterm must not forward them to the TUI. Everything else — Esc very much
 * included — goes to the session.
 */
function isConsoleKey(e: KeyboardEvent): boolean {
  if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "`" || e.code === "Backquote"))
    return true;
  if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) return true;
  return false;
}

function makeTerminal(t: Term): void {
  const term = new Terminal({
    fontFamily: '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace',
    fontSize: 13,
    lineHeight: 1.15,
    scrollback: 10_000,
    allowProposedApi: true,
    theme: {
      background: "#101216",
      foreground: "#d6dae2",
      cursor: "#6aa8ff",
      cursorAccent: "#101216",
      selectionBackground: "rgb(106 168 255 / 30%)",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.attachCustomKeyEventHandler((e) => !isConsoleKey(e));
  term.open(t.host);
  term.onData((d) => {
    if (t.info.status !== "running") return;
    if (t.ws?.readyState === WebSocket.OPEN) t.ws.send(new TextEncoder().encode(d));
  });
  if (t.info.status === "exited") term.options.disableStdin = true;
  t.term = term;
  t.fit = fit;
}

function scheduleRetry(t: Term): void {
  if (t.gone || t.retryTimer !== null) return;
  const wait = t.retryMs;
  t.retryMs = Math.min(t.retryMs * 2, RETRY_CAP_MS);
  t.retryTimer = window.setTimeout(() => {
    t.retryTimer = null;
    t.ws = null;
    attachTerm(t);
  }, wait);
}

function attachTerm(t: Term): void {
  if (t.gone) return;
  if (!t.term) makeTerminal(t);
  if (t.ws && t.ws.readyState <= WebSocket.OPEN) return;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/terminals/${t.info.id}/ws`);
  ws.binaryType = "arraybuffer";
  t.ws = ws;

  ws.onopen = () => {
    t.retryMs = RETRY_START_MS;
    if (t.info.status === "running") setStrip(t, "", "off");
    if (t.pingTimer !== null) clearInterval(t.pingTimer);
    t.pingTimer = window.setInterval(() => sendControl(t, { type: "ping" }), PING_MS);
    fitTerm(t);
  };

  ws.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data !== "string") {
      t.term?.write(new Uint8Array(ev.data as ArrayBuffer));
      markOutput(t);
      return;
    }
    let msg: {
      type?: string;
      data?: string;
      status?: string;
      exitCode?: number | null;
      threadId?: string;
      hostId?: string;
      title?: string | null;
      state?: string;
      humanAttached?: boolean;
      reason?: string;
      epoch?: number;
      revision?: number;
    };
    try {
      msg = JSON.parse(ev.data) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === "replay") {
      // Server buffer is the truth: every attach starts from a clean screen.
      t.term?.reset();
      if (msg.data) t.term?.write(msg.data);
      if (msg.status === "exited") markExited(t, msg.exitCode ?? null);
      else if (msg.humanAttached) setStrip(t, "attached elsewhere — read-only", "warn");
      else setStrip(t, "", "off");
      if (msg.state) t.info = { ...t.info, state: msg.state as TerminalRow["state"] };
      fitTerm(t);
    } else if (msg.type === "state") {
      t.info = { ...t.info, state: msg.state as TerminalRow["state"] };
      if (msg.state === "dead") setStrip(t, "shell died — restart from the tab menu", "warn");
      else if (!t.info.humanAttached) setStrip(t, "", "off");
      paintBar();
      notify();
    } else if (msg.type === "attachChanged") {
      t.info = { ...t.info, humanAttached: msg.humanAttached === true };
      if (msg.humanAttached) setStrip(t, "attached elsewhere — read-only", "warn");
      else setStrip(t, "", "off");
    } else if (msg.type === "inputSuspended") {
      setStrip(t, "attached elsewhere — read-only", "warn");
    } else if (msg.type === "inputDenied") {
      setStrip(t, "another tab owns input — click here to take over", "warn");
    } else if (msg.type === "inputOwner") {
      if (!t.info.humanAttached) setStrip(t, "", "off");
    } else if (msg.type === "associated") {
      /*
       * The session this pane started has written its registry row: it now
       * has a thread, a real title, and a place in the list. Nothing is
       * re-fetched — the frame carries everything the label needs.
       */
      t.info = {
        ...t.info,
        hostId: msg.hostId ?? t.info.hostId,
        threadId: msg.threadId ?? t.info.threadId,
        title: msg.title ?? t.info.title,
        awaitingThread: false,
      };
      const titleEl = t.pane.querySelector(".ws-corner-title");
      if (titleEl) titleEl.textContent = truncate(t.info.title ?? t.info.id, 40);
      paintBar();
      notify();
    } else if (msg.type === "exit") {
      markExited(t, msg.exitCode ?? null);
    } else if (msg.type === "gone") {
      removeTerm(t.info.id, false);
    }
  };

  ws.onclose = () => {
    if (t.pingTimer !== null) {
      clearInterval(t.pingTimer);
      t.pingTimer = null;
    }
    if (t.gone || t.info.status === "exited") return;
    setStrip(t, "disconnected — reconnecting…", "warn");
    scheduleRetry(t);
  };
}

function markExited(t: Term, exitCode: number | null): void {
  t.info = { ...t.info, status: "exited", exitCode };
  if (t.term) t.term.options.disableStdin = true;
  exitStrip(t);
  paintBar();
  paintIndicator();
  notify();
}

// --- terminals --------------------------------------------------------------

function confirmingButton(label: string, onConfirm: () => void): HTMLButtonElement {
  const b = el("button", "ws-x", label) as HTMLButtonElement;
  b.type = "button";
  let timer: number | null = null;
  b.onclick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (timer === null) {
      b.textContent = "sure?";
      b.classList.add("confirm");
      timer = window.setTimeout(() => {
        timer = null;
        b.textContent = label;
        b.classList.remove("confirm");
      }, CONFIRM_MS);
      return;
    }
    clearTimeout(timer);
    timer = null;
    onConfirm();
  };
  return b;
}

function ensureTerm(info: TerminalRow): Term {
  const found = terms.get(info.id);
  if (found) {
    found.info = { ...found.info, ...info };
    return found;
  }
  const pane = el("div", "ws-pane");
  const host = el("div", "ws-pane-host");
  const strip = el("div", "ws-strip off");
  const corner = el("div", "ws-corner");
  corner.append(
    el("span", "ws-corner-title", truncate(info.title ?? info.threadId ?? info.id, 40)),
    confirmingButton("✕", () => removeTerm(info.id, true)),
  );
  pane.append(host, corner, strip);
  pane.addEventListener("mousedown", () => focusPane(info.id));
  const t: Term = {
    info,
    term: null,
    fit: null,
    ws: null,
    pane,
    host,
    strip,
    retryMs: RETRY_START_MS,
    retryTimer: null,
    pingTimer: null,
    gone: false,
  };
  terms.set(info.id, t);
  if (info.status === "exited") exitStrip(t);
  return t;
}

function removeTerm(id: string, kill: boolean): void {
  const t = terms.get(id);
  if (!t) return;
  t.gone = true;
  if (t.retryTimer !== null) clearTimeout(t.retryTimer);
  if (t.pingTimer !== null) clearInterval(t.pingTimer);
  try {
    t.ws?.close();
  } catch {
    // already closing
  }
  t.term?.dispose();
  t.pane.remove();
  terms.delete(id);
  if (kill) void api.killTerminal(id).catch(() => undefined);

  const s = screenOf(id);
  if (s) {
    const i = s.panes.indexOf(id);
    s.panes.splice(i, 1);
    s.widths.splice(i, 1);
    if (s.panes.length === 0) dropScreen(s);
    else renderScreen(s);
  }
  if (focusedPane === id) focusedPane = null;
  if (activeScreen && !screens.some((x) => x.id === activeScreen)) {
    activeScreen = screens[0]?.id ?? null;
  }
  if (activeScreen) showScreen(activeScreen);
  else if (visible) location.hash = lastBrowserRoute;
  paintBar();
  paintIndicator();
  persist();
  notify();
}

function addPane(s: Screen, id: string, weight = 1): void {
  s.panes.push(id);
  s.widths.push(weight);
  renderScreen(s);
}

/** Move a terminal onto the active screen, emptying its old screen if needed. */
function movePane(id: string): void {
  const target = screens.find((x) => x.id === activeScreen);
  if (!target || target.panes.length >= MAX_PANES) return;
  const from = screenOf(id);
  if (from === target) return;
  if (from) {
    const i = from.panes.indexOf(id);
    from.panes.splice(i, 1);
    from.widths.splice(i, 1);
    if (from.panes.length === 0) dropScreen(from);
    else renderScreen(from);
  }
  addPane(target, id);
  showScreen(target.id);
  focusPane(id);
  notify();
}

// --- bar --------------------------------------------------------------------

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function screenLabel(s: Screen): string {
  const first = terms.get(s.panes[0]);
  const base = truncate(first?.info.title ?? first?.info.threadId ?? "terminal", TITLE_MAX);
  return s.panes.length > 1 ? `${base} +${s.panes.length - 1}` : base;
}

function screenRunning(s: Screen): boolean {
  return s.panes.some((id) => terms.get(id)?.info.status === "running");
}

function paintBar(): void {
  if (!tabsEl || !controlsEl) return;
  tabsEl.replaceChildren();
  screens.forEach((s, i) => {
    const b = el("button", `ws-tab${s.id === activeScreen ? " active" : ""}`) as HTMLButtonElement;
    b.type = "button";
    // The dot carries three facts at once: alive, unseen output, gone quiet.
    const unseen = screenUnseen(s);
    const idle = !unseen && screenIdle(s);
    b.title = unseen
      ? `alt+${i + 1} · new output`
      : idle
        ? `alt+${i + 1} · quiet for a while`
        : `alt+${i + 1}`;
    b.append(
      el(
        "span",
        `ws-dot ${screenRunning(s) ? "ok" : "dim"}${unseen ? " unseen" : ""}${idle ? " idle" : ""}`,
      ),
    );
    b.append(el("span", "ws-tab-label", screenLabel(s)));
    b.onclick = () => showScreen(s.id);
    tabsEl!.append(b);
  });

  controlsEl.replaceChildren();
  const s = screens.find((x) => x.id === activeScreen);
  if (s && s.panes.length < MAX_PANES) {
    const split = el("button", "ws-btn", "split") as HTMLButtonElement;
    split.type = "button";
    split.title = "add a pane to this screen";
    split.onclick = (e) => {
      e.stopPropagation();
      toggleSplitPopover();
    };
    controlsEl.append(split);
  }
}

// --- split popover ----------------------------------------------------------

let threadCache: ThreadRow[] | null = null;

function closePopover(): void {
  popover?.classList.add("hidden");
  popover?.replaceChildren();
}

function toggleSplitPopover(): void {
  if (!popover) return;
  if (!popover.classList.contains("hidden")) {
    closePopover();
    return;
  }
  popover.classList.remove("hidden");
  popover.replaceChildren();

  const others = [...terms.values()].filter((t) => screenOf(t.info.id)?.id !== activeScreen);
  if (others.length) {
    popover.append(el("div", "ws-pop-head", "move here"));
    for (const t of others) {
      const b = el("button", "ws-pop-row") as HTMLButtonElement;
      b.type = "button";
      b.append(el("span", `ws-dot ${t.info.status === "running" ? "ok" : "dim"}`));
      b.append(
        el("span", "ws-pop-title", truncate(t.info.title ?? t.info.threadId ?? t.info.id, 34)),
      );
      b.append(el("span", "ws-pop-host dim", t.info.hostId));
      b.onclick = () => {
        closePopover();
        movePane(t.info.id);
      };
      popover.append(b);
    }
  }

  /*
   * Starting something new here. The picker seeds with the focused pane's
   * directory rather than the configured root: a split is nearly always
   * "another one of these, same repo".
   */
  popover.append(el("div", "ws-pop-head", "start here…"));
  for (const [label, prefer] of [
    ["new session", "session"],
    ["new shell", "shell"],
  ] as const) {
    const b = el("button", "ws-pop-row") as HTMLButtonElement;
    b.type = "button";
    b.append(el("span", "ws-pop-title", label));
    const seed = focusedPaneCwd();
    b.append(el("span", "ws-pop-host dim", seed ? shortDir(seed) : "…"));
    b.onclick = () => {
      closePopover();
      openNewSessionModal({ seedCwd: seed, prefer, place: "split" });
    };
    popover.append(b);
  }

  popover.append(el("div", "ws-pop-head", "resume thread…"));
  const filter = el("input", "ws-pop-filter") as HTMLInputElement;
  filter.placeholder = "filter threads";
  filter.spellcheck = false;
  const listBox = el("div", "ws-pop-list");
  popover.append(filter, listBox);

  const paintList = (): void => {
    listBox.replaceChildren();
    const q = filter.value.toLowerCase();
    const rows = (threadCache ?? [])
      .filter((t) => t.launch)
      .filter(
        (t) =>
          !q ||
          (t.title ?? "").toLowerCase().includes(q) ||
          (t.custom?.title ?? "").toLowerCase().includes(q) ||
          t.hostId.includes(q) ||
          (t.cwd ?? "").toLowerCase().includes(q),
      )
      .slice(0, 40);
    if (!rows.length) {
      listBox.append(el("div", "ws-pop-empty dim", threadCache ? "no matches" : "loading…"));
      return;
    }
    for (const r of rows) {
      const b = el("button", "ws-pop-row") as HTMLButtonElement;
      b.type = "button";
      b.append(el("span", "ws-pop-title", truncate(displayTitle(r), 34)));
      b.append(el("span", "ws-pop-host dim", r.hostId));
      b.onclick = () => {
        closePopover();
        void addThreadToActiveScreen(r.hostId, r.threadId);
      };
      listBox.append(b);
    }
  };
  filter.oninput = paintList;
  paintList();
  filter.focus();

  if (!threadCache) {
    void api
      .threads()
      .then((rows) => {
        threadCache = rows;
        paintList();
      })
      .catch(() => {
        threadCache = [];
        paintList();
      });
  }
}

/** The directory of the pane the user is in — what a split should inherit. */
export function focusedPaneCwd(): string | null {
  const t = focusedPane ? terms.get(focusedPane) : null;
  if (t?.info.cwd) return t.info.cwd;
  const s = screens.find((x) => x.id === activeScreen);
  for (const id of s?.panes ?? []) {
    const cwd = terms.get(id)?.info.cwd;
    if (cwd) return cwd;
  }
  return null;
}

/** `/srv/work/lhc-console` → `…/lhc-console`, for a 320px popover row. */
function shortDir(cwd: string): string {
  const cut = cwd.lastIndexOf("/");
  return cut > 0 ? `…/${cwd.slice(cut + 1)}` : cwd;
}

/**
 * Start a brand-new session or shell. The body names a host and a directory
 * and nothing else — the server owns the command. `place` decides whether it
 * takes a screen of its own or joins the active split.
 */
export async function startNewTerminal(
  body: {
    newSession?: { hostId: string; cwd?: string; profile?: string | null };
    shell?: { cwd: string };
  },
  place: "screen" | "split" = "screen",
): Promise<TerminalRow> {
  const s = screens.find((x) => x.id === activeScreen);
  const split = place === "split" && !!s && s.panes.length < MAX_PANES;
  const info = await api.openTerminal({ ...body, cols: 100, rows: 30 });
  attachTerm(ensureTerm(info));
  if (split && s) {
    addPane(s, info.id);
    showScreen(s.id);
    focusPane(info.id);
  } else {
    newScreenWith(info.id);
  }
  paintBar();
  paintIndicator();
  persist();
  notify();
  enterWorkspace();
  return info;
}

async function addThreadToActiveScreen(hostId: string, threadId: string): Promise<void> {
  const s = screens.find((x) => x.id === activeScreen);
  if (!s || s.panes.length >= MAX_PANES) return;
  const existing = terminalFor(hostId, threadId);
  if (existing) {
    movePane(existing.id);
    return;
  }
  const info = await api.openTerminal({ hostId, threadId, cols: 100, rows: 30 });
  attachTerm(ensureTerm(info));
  addPane(s, info.id);
  showScreen(s.id);
  focusPane(info.id);
  paintBar();
  paintIndicator();
  persist();
  notify();
}

// --- entry points -----------------------------------------------------------

function newScreenWith(id: string): void {
  const s = makeScreen();
  addPane(s, id);
  activeScreen = s.id;
  focusedPane = id;
}

/** Launch (or reveal) a thread's terminal on its own screen and go there. */
export async function openThreadTerminal(
  hostId: string,
  threadId: string,
  fresh = false,
  /**
   * Proceed past the one-writer guard. Only the launch modal sets this, and
   * only after showing the user what is already attached — a 409 here is the
   * server refusing to help create a second writer.
   */
  force = false,
): Promise<void> {
  const existing = fresh ? null : terminalFor(hostId, threadId);
  if (existing) {
    const s = screenOf(existing.id);
    if (s) activeScreen = s.id;
    else newScreenWith(existing.id);
    focusedPane = existing.id;
    enterWorkspace();
    // An idle terminal auto-resumes: the click means "get me back into this
    // agent", and the shell is still there after the CLI exits again.
    if (existing.state === "idle") {
      try {
        const info = await api.resumeTerminal(existing.id, force);
        const term = terms.get(existing.id);
        if (term) term.info = info;
      } catch {
        // refused (busy/attached elsewhere); the pane itself shows why
      }
      notify();
    }
    return;
  }
  const info = await api.openTerminal({ hostId, threadId, fresh, force, cols: 100, rows: 30 });
  attachTerm(ensureTerm(info));
  newScreenWith(info.id);
  paintIndicator();
  notify();
  enterWorkspace();
}

/**
 * Dev spawn; used by the browser tests. Needs loopback AND the shared secret
 * (`LHC_CONSOLE_DEV_SECRET`), and is disabled outright when none is set.
 */
export async function openDevTerminal(
  devCommand: string,
  threadId?: string,
  devSecret?: string,
): Promise<TerminalRow> {
  const info = await api.openTerminal({
    devCommand,
    devSecret,
    hostId: "dev",
    threadId,
    cols: 100,
    rows: 30,
  });
  attachTerm(ensureTerm(info));
  newScreenWith(info.id);
  paintIndicator();
  notify();
  enterWorkspace();
  return info;
}

function enterWorkspace(): void {
  if (location.hash !== "#/term") location.hash = "/term";
  else setWorkspaceVisible(true);
}

/** Rebuild from the server list, reconciling the stored composition. */
export async function refreshTerminals(): Promise<void> {
  let rows: TerminalRow[];
  try {
    rows = await api.terminals();
  } catch {
    return;
  }
  const live = new Map(rows.map((r) => [r.id, r]));
  // Terminals the server forgot are gone for good; drop them and their panes.
  for (const id of Array.from(terms.keys())) {
    if (!live.has(id)) removeTerm(id, false);
  }

  const stored = readStore();
  const placed = new Set<string>();
  if (screens.length === 0 && stored.screens.length) {
    for (const st of stored.screens) {
      const panes = st.panes.filter((id) => live.has(id));
      if (!panes.length) continue; // every terminal on it is gone
      const s = makeScreen(st.id);
      panes.forEach((id, i) => {
        ensureTerm(live.get(id)!);
        s.panes.push(id);
        s.widths.push(st.widths?.[i] ?? 1);
        placed.add(id);
      });
      renderScreen(s);
    }
    if (stored.active && screens.some((x) => x.id === stored.active)) activeScreen = stored.active;
  }
  // Anything the store didn't account for gets a screen of its own.
  for (const r of rows) {
    if (placed.has(r.id) || screenOf(r.id)) {
      ensureTerm(r);
      continue;
    }
    ensureTerm(r);
    const s = makeScreen();
    s.panes.push(r.id);
    s.widths.push(1);
    renderScreen(s);
  }
  if (!activeScreen || !screens.some((x) => x.id === activeScreen)) {
    activeScreen = screens[0]?.id ?? null;
  }
  /*
   * Every terminal gets a socket, not just the visible ones. A screen that is
   * off view is exactly the one whose activity dot matters, and the dot is
   * derived from bytes arriving here — attaching only what is on screen would
   * make the indicator blind to the case it exists for. The server broadcasts
   * to whoever is listening; eight sockets is nothing.
   */
  for (const t of terms.values()) attachTerm(t);
  if (activeScreen) showScreen(activeScreen);
  paintBar();
  paintIndicator();
  persist();
  notify();
}

// --- mode -------------------------------------------------------------------

/** Show/hide the workspace. Never unmounts — xterm state survives the flip. */
export function setWorkspaceVisible(next: boolean): void {
  visible = next;
  if (root) root.style.display = next ? "flex" : "none";
  document.body.classList.toggle("ws-on", next);
  paintIndicator();
  if (!next) {
    closePopover();
    return;
  }
  if (!activeScreen && screens.length) activeScreen = screens[0].id;
  if (activeScreen) showScreen(activeScreen);
  requestAnimationFrame(() => {
    fitVisible();
    if (focusedPane) terms.get(focusedPane)?.term?.focus();
  });
}

function paintIndicator(): void {
  if (!indicator) return;
  const { total, running } = terminalCount();
  const show = total > 0 && !visible;
  indicator.classList.toggle("hidden", !show);
  indicator.replaceChildren(
    el("span", `ws-dot ${running ? "ok" : "dim"}`),
    el("span", undefined, `terminals ${total}`),
  );
}

function onGlobalKey(e: KeyboardEvent): void {
  if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "`" || e.code === "Backquote")) {
    if (terms.size === 0 && !visible) return; // nothing to flip to
    e.preventDefault();
    e.stopPropagation();
    if (visible) location.hash = lastBrowserRoute;
    else location.hash = "/term";
    return;
  }
  if (visible && e.altKey && !e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
    const s = screens[Number(e.key) - 1];
    if (!s) return;
    e.preventDefault();
    e.stopPropagation();
    showScreen(s.id);
  }
}

/** Mount once from main.ts, outside the router. Never touches document.title. */
export function mountWorkspace(): void {
  if (root) return;
  root = el("div", "ws");
  root.style.display = "none";

  const bar = el("div", "ws-bar");
  const back = el("button", "ws-back", "← threads") as HTMLButtonElement;
  back.type = "button";
  back.onclick = () => {
    location.hash = lastBrowserRoute;
  };
  tabsEl = el("div", "ws-screens");
  controlsEl = el("div", "ws-controls");
  bar.append(back, tabsEl, controlsEl);

  bodyEl = el("div", "ws-body");
  popover = el("div", "ws-pop hidden");
  root.append(bar, bodyEl, popover);
  document.body.append(root);

  indicator = el("button", "ws-indicator hidden") as HTMLButtonElement;
  indicator.type = "button";
  indicator.title = "terminals (ctrl+`)";
  indicator.onclick = () => {
    location.hash = "/term";
  };
  document.body.append(indicator);

  document.addEventListener("mousedown", (e) => {
    if (popover && !popover.classList.contains("hidden")) {
      const inPop = e.target instanceof Node && popover.contains(e.target);
      const onSplit = e.target instanceof HTMLElement && e.target.closest(".ws-controls");
      if (!inPop && !onSplit) closePopover();
    }
    // Clicking the page in browser mode takes focus off the session.
    if (!workspaceContains(e.target) && focusedPane) terms.get(focusedPane)?.term?.blur();
  });
  window.addEventListener("keydown", onGlobalKey, true);
  window.addEventListener("resize", () => fitVisible());
  // The idle tint is a function of elapsed time, so it needs a heartbeat.
  setInterval(() => {
    if (terms.size) paintBar();
  }, ACTIVITY_TICK_MS);

  paintBar();
  void refreshTerminals();
}
