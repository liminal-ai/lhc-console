/**
 * Thread view tab — the latest projection, read top to bottom.
 *
 * One scrollable column in turn order: every arrangement entry with the
 * derivation content the compact actually used, then the live tail. The only
 * dimension encoded by color here is **fidelity**, not message kind: a four-step
 * ramp from the panel border (brief, the most compressed history) up to the
 * accent (live, the uncompressed present), so scrolling reads as old history
 * fading up into now. Band names are always spelled out beside the rail, so the
 * ramp is a reinforcement and never the only carrier.
 */

import type { ViewArrangement, ViewEntry, ViewTailTurn } from "./api.ts";
import { el, fmtAgo, fmtCount, fmtStamp, fmtTokens } from "./format.ts";

/** Fidelity ramp, most compressed → live. Keys match `thread_view_band.band`. */
const BANDS = ["brief", "detailed", "smooth", "live"] as const;

const BAND_COLOR: Record<string, string> = {
  brief: "var(--band-brief)",
  detailed: "var(--band-detailed)",
  smooth: "var(--band-smooth)",
  live: "var(--band-live)",
  unknown: "var(--dim)",
};

/** Collapsed height of an entry's content, in lines. */
const CLAMP_LINES = 12;

function bandClass(band: string): string {
  return BANDS.includes(band as (typeof BANDS)[number]) ? `band-${band}` : "band-unknown";
}

/** `chunk c12 · turns 18–19`, `turn 31`, or the raw id when nothing resolves. */
function subjectLabel(e: ViewEntry): string {
  const span =
    e.turnOrderFrom == null
      ? null
      : e.turnOrderFrom === e.turnOrderTo
        ? `turn ${e.turnOrderFrom}`
        : `turns ${e.turnOrderFrom}–${e.turnOrderTo}`;
  if (e.subjectKind === "chunk") {
    return `chunk ${e.subjectId}${span ? ` · ${span}` : " · no live turns"}`;
  }
  return span ?? `turn ${e.subjectId}`;
}

/** A clamped entry, exposed so the strip's expand-all can drive every one. */
interface Clamp {
  setExpanded: (on: boolean) => void;
}

function entryCard(e: ViewEntry, clamps: Clamp[]): HTMLElement {
  const card = el("div", `vt-entry ${bandClass(e.band)}`);

  const head = el("div", "vt-entry-head");
  head.append(el("span", "vt-band", e.band));
  head.append(el("span", "vt-subject", subjectLabel(e)));
  head.append(el("span", "vt-spacer"));
  if (e.derivationUsed) head.append(el("span", "dim vt-deriv", e.derivationUsed));
  if (e.degraded) head.append(el("span", "badge warn", "degraded"));
  if (e.gap) head.append(el("span", "badge bad", "gap"));
  if (e.turns.some((t) => t.missing)) head.append(el("span", "badge bad", "missing turns"));
  if (!e.gap) head.append(el("span", "dim num", `${fmtCount(e.contentLength)} ch`));
  card.append(head);

  if (e.gap) {
    const why = e.derivationUsed
      ? `no content — ${e.derivationUsed} is ${e.derivationState ?? "absent"}`
      : "no content — entry names no derivation";
    card.append(el("div", "vt-gap", why));
    return card;
  }

  const capped = e.contentLength > e.content.length;
  const body = el("pre", "vt-content");
  body.textContent =
    e.content + (capped ? `\n… (${fmtCount(e.contentLength - e.content.length)} more chars)` : "");
  card.append(body);

  // Wrapped long lines overflow the clamp too, so the char count decides as
  // well as the newline count — no measuring pass over a hundred entries.
  if (e.content.split("\n").length > CLAMP_LINES || e.content.length > 900) {
    body.classList.add("clamped");
    const toggle = el("button", "vt-toggle", "expand");
    (toggle as HTMLButtonElement).type = "button";
    const setExpanded = (on: boolean): void => {
      body.classList.toggle("clamped", !on);
      toggle.textContent = on ? "collapse" : "expand";
    };
    toggle.onclick = () => setExpanded(body.classList.contains("clamped"));
    clamps.push({ setExpanded });
    card.append(toggle);
  }
  return card;
}

function turnCard(t: ViewTailTurn, href: string, archived = false): HTMLElement {
  const card = el("a", `vt-tail${t.status === "open" ? " open" : ""}`) as HTMLAnchorElement;
  card.href = href;

  const top = el("div", "vt-tail-top");
  top.append(el("span", "vt-tail-order", `turn ${t.turnOrder}`));
  if (t.status === "open") top.append(el("span", "badge warn", "open"));
  if (archived) {
    const badge = el("span", "badge", "archived");
    badge.title = "retained history omitted from the current view";
    top.append(badge);
  }
  top.append(el("span", "vt-spacer"));
  top.append(
    el("span", "num dim", `${fmtCount(t.messageCount)} msg${t.messageCount === 1 ? "" : "s"}`),
  );
  top.append(el("span", "num", fmtTokens(t.tokenEstimate)));
  top.append(el("span", "dim vt-unit", "tok"));
  card.append(top);

  const excerpt = t.promptExcerpt?.trim();
  card.append(
    excerpt ? el("div", "excerpt", excerpt) : el("div", "excerpt no-prompt", "(no prompt)"),
  );
  return card;
}

/** Full-width bar segmented by band token count, plus a spelled-out legend. */
function ribbon(segments: { band: string; tokens: number }[]): HTMLElement {
  const wrap = el("div", "vt-ribbon-wrap");
  const total = segments.reduce((s, x) => s + x.tokens, 0);
  const bar = el("div", "vt-ribbon");
  for (const s of segments) {
    const seg = el("div", `vt-seg ${bandClass(s.band)}`);
    // Percentage share, floored so a tiny band stays visible rather than vanishing.
    seg.style.flex = `${Math.max(s.tokens, total / 200)} 0 0`;
    seg.title = `${s.band} · ${fmtCount(s.tokens)} stored view tokens`;
    bar.append(seg);
  }
  wrap.append(bar);

  const legend = el("div", "vt-legend");
  for (const s of segments) {
    const item = el("span", "vt-key");
    const chip = el("span", "vt-chip");
    chip.style.background = BAND_COLOR[s.band] ?? BAND_COLOR.unknown;
    item.append(chip, el("span", undefined, s.band), el("span", "num", fmtTokens(s.tokens)));
    if (total > 0) {
      item.append(el("span", "dim", `${Math.round((s.tokens / total) * 100)}%`));
    }
    legend.append(item);
  }
  wrap.append(legend);
  return wrap;
}

export interface ViewTabArgs {
  data: ViewArrangement;
  /** `#/thread/<host>/<id>/turns/<order>` for a tail turn. */
  turnHref: (turnOrder: number) => string;
}

export function viewMeasurementLabels(data: ViewArrangement): {
  liveTail: string;
  archivedHistory: string | null;
} {
  return {
    liveTail: `live tail · ${fmtCount(data.liveTail.length)} turn${
      data.liveTail.length === 1 ? "" : "s"
    } · ${fmtTokens(data.liveTailTokens)} estimated tokens${data.view ? " after compact" : ""}`,
    archivedHistory: data.view
      ? `archived history omitted from current view · ${fmtCount(
          data.archivedHistory.length,
        )} turn${data.archivedHistory.length === 1 ? "" : "s"} · ${fmtTokens(
          data.archivedHistoryTokens,
        )} estimated tokens`
      : null,
  };
}

export function viewTabPanel(args: ViewTabArgs): HTMLElement {
  const { data, turnHref } = args;
  const labels = viewMeasurementLabels(data);
  const panel = el("div", "vt-panel");
  const clamps: Clamp[] = [];

  // --- top strip ------------------------------------------------------------
  const strip = el("div", "vt-strip");
  if (data.view) {
    const v = data.view;
    const meta = el("div", "vt-meta");
    meta.append(el("span", "vt-profile", v.profileName ?? "unnamed profile"));
    meta.append(el("span", "dim", `compacted ${fmtStamp(v.createdAt)} (${fmtAgo(v.createdAt)})`));
    meta.append(el("span", "dim", `compact point event ${fmtCount(v.compactPoint)}`));
    meta.append(el("span", "dim", `current view starts at event ${fmtCount(v.coveredFrom)}`));
    meta.append(
      el(
        "span",
        undefined,
        `${fmtCount(data.turnsSinceView)} turn${data.turnsSinceView === 1 ? "" : "s"} since view`,
      ),
    );
    if (v.gaps.length > 0) {
      meta.append(el("span", "badge bad", `${fmtCount(v.gaps.length)} gaps`));
    }
    strip.append(meta);

    const segments = v.bands.map((b) => ({ band: b.band, tokens: b.tokenCount }));
    segments.push({ band: "live", tokens: data.liveTailTokens });
    strip.append(ribbon(segments));
  } else {
    strip.append(
      el("div", "vt-meta", "never compacted — whole thread is live"),
      ribbon([{ band: "live", tokens: data.liveTailTokens }]),
    );
  }
  // Expand-all sits with the meta, but only matters once something is clamped.
  const expandAll = el("button", "vt-expand-all linkish", "expand all") as HTMLButtonElement;
  expandAll.type = "button";
  let allOpen = false;
  expandAll.onclick = () => {
    allOpen = !allOpen;
    for (const c of clamps) c.setExpanded(allOpen);
    expandAll.textContent = allOpen ? "collapse all" : "expand all";
  };
  strip.append(expandAll);
  panel.append(strip);

  // --- entries + tail, one scrolling column ---------------------------------
  const list = el("div", "vt-list");

  if (data.view && data.entries.length === 0) {
    list.append(el("div", "hint", "the view covers no turns — its arrangement is empty"));
  }
  for (const e of data.entries) list.append(entryCard(e, clamps));
  expandAll.hidden = clamps.length === 0;

  const divider = el("div", "vt-divider");
  divider.append(
    el("span", "vt-rule"),
    el("span", "vt-divider-label", labels.liveTail),
    el("span", "vt-rule"),
  );
  list.append(divider);

  if (data.liveTail.length === 0) {
    list.append(el("div", "hint", "no turns after the compact point — the view is current"));
  }
  for (const turn of data.liveTail) list.append(turnCard(turn, turnHref(turn.turnOrder)));

  if (data.view) {
    const historyDivider = el("div", "vt-divider");
    historyDivider.append(
      el("span", "vt-rule"),
      el("span", "vt-divider-label", labels.archivedHistory ?? "archived history"),
      el("span", "vt-rule"),
    );
    list.append(historyDivider);
    if (data.archivedHistory.length === 0) {
      list.append(el("div", "hint", "all retained history is represented in the current view"));
    }
    for (const turn of data.archivedHistory) {
      list.append(turnCard(turn, turnHref(turn.turnOrder), true));
    }
  }

  panel.append(list);
  return panel;
}
