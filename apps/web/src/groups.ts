/**
 * Group line web view: the same transcript the iMessage line writes, read
 * top to bottom, with a composer that posts through the same router. Pull
 * based: polls `since` the last seq while the page is open. Tag rules are the
 * line's (`@flint`, `@sable`, `@all`); untagged text lands in the transcript
 * and wakes nobody, exactly as on the phone.
 */
import { api, type GroupMessage, type GroupRow } from "./api.ts";
import { el, fmtAgo, fmtStamp } from "./format.ts";

const POLL_MS = 2_000;

let abort: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function teardownGroup(): void {
  abort?.abort();
  abort = null;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Which members a draft would wake, by the same tag rule the router uses. */
export function draftWakes(text: string, members: Array<{ id: string; label: string }>): string[] {
  if (/(?<![\w@])@(?:all|everyone|both)\b/i.test(text)) return members.map((m) => m.label);
  return members
    .filter((m) => new RegExp(String.raw`(?<![\w@])@?${m.id}\b[,\-:]?`, "i").test(text))
    .map((m) => m.label);
}

export async function renderGroups(app: HTMLElement): Promise<void> {
  document.title = "groups · lhc console";
  const groups = await api.groups();
  const root = el("div", "page");
  const header = el("header");
  const row = el("div", "head-row");
  row.append(el("h1", undefined, "group lines"));
  const back = el("a", "chip", "all threads") as HTMLAnchorElement;
  back.href = "#/";
  row.append(back);
  header.append(row);
  root.append(header);
  if (!groups.length) {
    root.append(el("div", "dim", "no group lines in the registry"));
  }
  const list = el("div", "group-list");
  for (const g of groups) {
    const card = el("a", "group-card") as HTMLAnchorElement;
    card.href = `#/group/${encodeURIComponent(g.id)}`;
    card.append(el("div", "group-name", g.name));
    card.append(el("div", "dim", g.description));
    card.append(el("div", "group-members", g.members.map((m) => m.label).join(" · ")));
    list.append(card);
  }
  root.append(list);
  app.replaceChildren(root);
}

export async function renderGroup(app: HTMLElement, groupId: string): Promise<void> {
  teardownGroup();
  const groups = await api.groups();
  const group = groups.find((g) => g.id === groupId);
  if (!group) throw Object.assign(new Error(`unknown group: ${groupId}`), { status: 404 });
  document.title = `${group.name} · lhc console`;
  const root = el("div", "page group-page");
  root.append(groupHeader(group));
  const log = el("div", "group-log");
  root.append(log);
  root.append(composer(group, log));
  app.replaceChildren(root);

  let lastSeq = 0;
  const controller = new AbortController();
  abort = controller;
  const tick = async () => {
    if (controller.signal.aborted) return;
    try {
      const page = await api.groupMessages(group.id, lastSeq, controller.signal);
      for (const m of page.messages) {
        appendLine(log, m);
        lastSeq = Math.max(lastSeq, m.seq);
      }
      if (page.messages.length) log.scrollTop = log.scrollHeight;
    } catch (err) {
      if (!controller.signal.aborted) console.warn(err);
    }
    if (!controller.signal.aborted) timer = setTimeout(tick, POLL_MS);
  };
  await tick();
}

function groupHeader(group: GroupRow): HTMLElement {
  const header = el("header");
  const row = el("div", "head-row");
  row.append(el("h1", undefined, group.name));
  const back = el("a", "chip", "groups") as HTMLAnchorElement;
  back.href = "#/groups";
  row.append(back);
  header.append(row);
  const sub = el("div", "subtitle");
  sub.append(
    el(
      "span",
      undefined,
      `members: ${group.members.map((m) => `${m.label} (@${m.id})`).join(", ")} · tag to wake, @all wakes everyone`,
    ),
  );
  header.append(sub);
  return header;
}

export function appendLine(log: HTMLElement, m: GroupMessage): void {
  const line = el("div", `group-line ${m.senderId === "lee" ? "owner" : "member"}`);
  line.dataset.seq = String(m.seq);
  const who = el("span", "group-who", m.senderLabel);
  const when = el("span", "group-when dim", fmtAgo(m.at));
  when.title = fmtStamp(m.at);
  line.append(who, when, el("div", "group-text", m.text));
  log.append(line);
}

function composer(group: GroupRow, log: HTMLElement): HTMLElement {
  const box = el("form", "group-composer") as HTMLFormElement;
  const input = el("textarea", "group-input") as HTMLTextAreaElement;
  input.placeholder = `@${group.members[0]?.id ?? "member"} ... or @all`;
  input.rows = 3;
  const hint = el("div", "group-hint dim", "wakes: nobody");
  const send = el("button", "chip on", "send") as HTMLButtonElement;
  send.type = "submit";
  input.addEventListener("input", () => {
    const wakes = draftWakes(input.value, group.members);
    hint.textContent = `wakes: ${wakes.length ? wakes.join(", ") : "nobody (untagged text enters the transcript only)"}`;
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      box.requestSubmit();
    }
  });
  box.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      await api.postGroupMessage(group.id, text, crypto.randomUUID());
      input.value = "";
      hint.textContent = "wakes: nobody";
    } catch (err) {
      hint.textContent = `send failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      send.disabled = false;
      input.focus();
      log.scrollTop = log.scrollHeight;
    }
  });
  const row = el("div", "group-composer-row");
  row.append(hint, send);
  box.append(input, row);
  return box;
}
