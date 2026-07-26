import "./style.css";
import {
  api,
  type MessageRow,
  type OverviewResponse,
  type ThreadRow,
  type TurnRow,
} from "./api.ts";

const app = document.querySelector<HTMLDivElement>("#app")!;

function fmtTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtBytes(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(0)} KB`;
  return `${n} B`;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const days = (Date.now() - d.getTime()) / 86_400_000;
  if (days < 1) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days < 7) return `${Math.floor(days)}d ago`;
  return d.toLocaleDateString();
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// --- routing ---------------------------------------------------------------

function route(): void {
  const hash = location.hash.slice(1);
  const m = hash.match(/^\/thread\/([^/]+)\/([^/]+)$/);
  if (m) {
    renderThread(m[1], m[2]).catch(showError);
  } else {
    renderList().catch(showError);
  }
}

function showError(err: unknown): void {
  app.replaceChildren(el("div", "error", String(err)));
}

window.addEventListener("hashchange", route);

// --- thread list -----------------------------------------------------------

let filterHost = "";
let filterText = "";

async function renderList(): Promise<void> {
  const [hosts, threads] = await Promise.all([
    api.hosts(),
    api.threads({ host: filterHost || undefined, q: filterText || undefined }),
  ]);

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
  hostSel.onchange = () => {
    filterHost = hostSel.value;
    renderList().catch(showError);
  };
  const search = el("input") as HTMLInputElement;
  search.type = "search";
  search.placeholder = "filter by title, cwd, thread id…";
  search.value = filterText;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  search.oninput = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      filterText = search.value;
      renderList().catch(showError);
    }, 200);
  };
  controls.append(hostSel, search);
  root.append(controls);

  const table = el("table", "threads");
  const thead = el("thead");
  const hr = el("tr");
  for (const h of [
    "host",
    "title",
    "cwd",
    "last activity",
    "turns",
    "msgs",
    "tokens",
    "size",
    "health",
  ])
    hr.append(el("th", undefined, h));
  thead.append(hr);
  table.append(thead);
  const tbody = el("tbody");
  for (const t of threads) tbody.append(threadRow(t));
  table.append(tbody);
  root.append(table);

  app.replaceChildren(root);
  search.focus();
}

function threadRow(t: ThreadRow): HTMLElement {
  const tr = el("tr", "thread-row");
  tr.onclick = () => {
    location.hash = `/thread/${t.hostId}/${t.threadId}`;
  };
  tr.append(el("td", `host host-${t.hostId}`, t.hostId));
  const title = el("td", "title", t.title ?? t.threadId);
  title.append(el("div", "thread-id", t.threadId));
  tr.append(title);
  tr.append(el("td", "cwd", t.cwd ?? "—"));
  tr.append(el("td", undefined, fmtWhen(t.stats?.lastEventAt ?? t.fileMtime)));
  tr.append(el("td", "num", String(t.stats?.turnCount ?? "—")));
  tr.append(el("td", "num", String(t.stats?.messageCount ?? "—")));
  tr.append(el("td", "num", fmtTokens(t.stats?.totalTokenEstimate)));
  tr.append(el("td", "num", fmtBytes(t.fileSizeBytes)));
  const health = el("td", "health");
  if (t.stats) {
    if (t.stats.failedDerivations > 0)
      health.append(el("span", "badge bad", `${t.stats.failedDerivations} failed`));
    if (t.stats.pendingWork > 0)
      health.append(el("span", "badge warn", `${t.stats.pendingWork} queued`));
    if (t.stats.lastCompactAt) health.append(el("span", "badge ok", "compacted"));
    if (!health.hasChildNodes()) health.append(el("span", "badge", "clean"));
  } else {
    health.append(el("span", "badge bad", "missing file"));
  }
  tr.append(health);
  return tr;
}

// --- thread detail ---------------------------------------------------------

async function renderThread(hostId: string, threadId: string): Promise<void> {
  const [ov, turns] = await Promise.all([
    api.overview(hostId, threadId),
    api.turns(hostId, threadId),
  ]);

  const root = el("div", "page");
  const back = el("a", "back", "← all threads") as HTMLAnchorElement;
  back.href = "#/";
  root.append(back);

  root.append(threadHeader(ov));

  const cols = el("div", "detail-cols");
  const turnCol = el("div", "turn-col");
  turnCol.append(el("h2", undefined, `turns (${turns.length})`));
  const msgCol = el("div", "msg-col");
  msgCol.append(el("h2", undefined, "messages"));
  const msgBody = el("div", "msg-body");
  msgBody.append(el("div", "hint", "select a turn"));
  msgCol.append(msgBody);

  for (const t of turns) {
    const card = turnCard(t);
    card.onclick = () => {
      turnCol
        .querySelectorAll(".turn-card.selected")
        .forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      msgBody.replaceChildren(el("div", "hint", "loading…"));
      api
        .messages(hostId, threadId, t.turnId)
        .then((msgs) => {
          msgBody.replaceChildren(...msgs.map(messageCard));
        })
        .catch((e) => msgBody.replaceChildren(el("div", "error", String(e))));
    };
    turnCol.append(card);
  }
  cols.append(turnCol, msgCol);
  root.append(cols);
  app.replaceChildren(root);
}

function threadHeader(ov: OverviewResponse): HTMLElement {
  const { thread, overview } = ov;
  const head = el("div", "thread-head");
  head.append(el("h1", undefined, thread.title ?? overview.threadId));
  const meta = el("div", "meta");
  meta.append(el("span", "badge", thread.hostId));
  meta.append(el("span", undefined, overview.threadId));
  if (thread.cwd) meta.append(el("span", "cwd", thread.cwd));
  meta.append(el("span", undefined, `created ${fmtWhen(overview.createdAt)}`));
  head.append(meta);

  const stats = el("div", "statline");
  const s = overview.stats;
  const bits = [
    `${s.turnCount} turns (${s.closedTurnCount} closed)`,
    `${s.messageCount} messages`,
    `${fmtTokens(s.totalTokenEstimate)} tokens`,
    `${overview.chunkCount} chunks`,
  ];
  if (overview.view) {
    const bandBits = overview.view.bands
      .map((b) => `${b.band} ${fmtTokens(b.tokenCount)}`)
      .join(" / ");
    bits.push(
      `view: ${overview.view.profileName ?? "unnamed"} @ ${fmtWhen(overview.view.createdAt)} (${bandBits})`,
    );
  } else {
    bits.push("never compacted");
  }
  if (overview.visibilityBoundary != null) bits.push(`boundary @ ${overview.visibilityBoundary}`);
  stats.textContent = bits.join("  ·  ");
  head.append(stats);

  const deriv = el("div", "statline dim");
  deriv.textContent =
    "derivations: " +
    Object.entries(overview.derivationStates)
      .map(([k, v]) => `${k} ${v}`)
      .join("  ·  ");
  head.append(deriv);
  return head;
}

function turnCard(t: TurnRow): HTMLElement {
  const card = el("div", "turn-card");
  const top = el("div", "turn-top");
  top.append(el("span", "turn-order", `#${t.turnOrder}`));
  top.append(el("span", `badge ${t.status === "open" ? "warn" : ""}`, t.status));
  top.append(el("span", "num", `${t.messageCount} msgs`));
  top.append(el("span", "num", fmtTokens(t.tokenEstimate)));
  top.append(el("span", "dim", fmtWhen(t.startedAt)));
  card.append(top);
  if (t.promptExcerpt) card.append(el("div", "excerpt", t.promptExcerpt));
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

route();
