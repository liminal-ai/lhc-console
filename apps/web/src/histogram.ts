/**
 * Turn-by-turn stacked bar chart of a whole run — hand-rendered SVG.
 *
 * One bar per turn (x = turn order), height = token estimate, stacked by
 * message-kind bucket. Colors are the message-card border colors from
 * `style.css`, so a segment and its message cards read as the same thing.
 *
 * Stack order is not arbitrary: it is the order (of the six fixed hues) with
 * the best adjacent-pair separation under simulated protanopia/deuteranopia —
 * worst adjacent pair ΔE 10.1 CVD / 17.4 normal vision, both above the gates.
 * Two hues carried over from the app's palette sit below the chroma floor
 * (tool result C 0.076, other C 0.023, the deliberately-neutral residual
 * bucket); the 2px surface gaps, the always-present legend, and the tooltip's
 * exact per-kind numbers are the secondary encoding that covers them. Every
 * number here is also reachable without hovering, in the Turns tab.
 */

import type { TurnKindBucket, TurnKindRow } from "./api.ts";
import { el, fmtCount, fmtTokens } from "./format.ts";

const NS = "http://www.w3.org/2000/svg";

/** Stack order, bottom → top; the legend follows the same order. */
const KINDS: { key: TurnKindBucket; label: string; color: string }[] = [
  { key: "user_prompt", label: "user prompt", color: "var(--accent)" },
  { key: "assistant_text", label: "assistant text", color: "var(--ok)" },
  { key: "assistant_thinking", label: "thinking", color: "var(--think)" },
  { key: "tool_result", label: "tool result", color: "var(--tool-result)" },
  { key: "tool_call", label: "tool call", color: "var(--warn)" },
  { key: "other", label: "other", color: "var(--dim)" },
];

const PLOT_H = 260;
const PAD = { top: 14, right: 10, bottom: 22, left: 56 };
/** Bar geometry: never wider than the mark cap, never thinner than 2px. */
const BAND_MIN = 2;
const BAND_MAX = 40;
const BAR_MAX = 24;
/** Surface gap between touching fills — stacked segments and neighbours alike. */
const GAP = 2;
/** Minimum horizontal room a turn-number label needs. */
const LABEL_ROOM = 46;

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** Round tick step for a 3–5 label axis, always on 1/2/5×10ⁿ. */
function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0];
  const mag = 10 ** Math.floor(Math.log10(max / 4));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => max / s <= 4) ?? 10 * mag;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(Math.round(v));
  return out;
}

/** Path for a bar cap: rounded at the data end, square at the baseline. */
function cappedBar(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  if (rr < 1) return `M${x} ${y}h${w}v${h}h${-w}z`;
  return `M${x} ${y + rr}a${rr} ${rr} 0 0 1 ${rr} ${-rr}h${w - 2 * rr}a${rr} ${rr} 0 0 1 ${rr} ${rr}v${h - rr}h${-w}z`;
}

export interface HistogramArgs {
  rows: TurnKindRow[];
  /** Event order of the latest compact, when the thread has a view. */
  compactPoint: number | null;
  onSelect: (turnOrder: number) => void;
}

/** The histogram panel plus its teardown (drops the resize observer). */
export function histogramPanel(args: HistogramArgs): {
  node: HTMLElement;
  dispose: () => void;
} {
  const { rows, compactPoint, onSelect } = args;
  const panel = el("div", "hist-panel");

  if (rows.length === 0) {
    panel.append(el("div", "hint", "no turns — nothing to plot"));
    return { node: panel, dispose: () => {} };
  }

  const totals = new Map<TurnKindBucket, number>();
  for (const r of rows) {
    for (const k of KINDS) totals.set(k.key, (totals.get(k.key) ?? 0) + r.tokens[k.key]);
  }
  const present = KINDS.filter((k) => (totals.get(k.key) ?? 0) > 0);

  // --- legend (always present; only buckets that occur in this thread) ------
  if (present.length > 0) {
    const legend = el("div", "hist-legend");
    for (const k of present) {
      const item = el("span", "hist-key");
      const chip = el("span", "hist-chip");
      chip.style.background = k.color;
      item.append(chip, el("span", undefined, k.label));
      legend.append(item);
    }
    panel.append(legend);
  }

  const scroller = el("div", "hist-scroll");
  panel.append(scroller);

  const tip = el("div", "hist-tip");
  tip.hidden = true;
  panel.append(tip);

  const caption = el("div", "hist-caption dim");
  panel.append(caption);

  const grand = rows.reduce((s, r) => s + r.totalTokens, 0);
  const largest = rows.reduce((a, b) => (b.totalTokens > a.totalTokens ? b : a));
  caption.textContent =
    `${fmtCount(rows.length)} turn${rows.length === 1 ? "" : "s"} · ${fmtTokens(grand)} estimated tokens` +
    ` · largest turn #${largest.turnOrder} (${fmtTokens(largest.totalTokens)} estimated tokens)` +
    ` · click a bar to open the turn`;

  // First turn whose messages land after the compact point: the live tail.
  const compactIdx =
    compactPoint == null
      ? -1
      : rows.findIndex((r) => (r.firstEventOrder ?? Number.POSITIVE_INFINITY) > compactPoint);

  const maxTotal = rows.reduce((m, r) => Math.max(m, r.totalTokens), 0);
  const ticks = niceTicks(maxTotal);
  const top = ticks[ticks.length - 1] || 1;

  let band = 0;
  let barW = 0;
  let hoverIdx: number | null = null;
  let lastWidth = -1;
  let highlight: SVGRectElement | null = null;
  let svg: SVGSVGElement | null = null;

  const yOf = (v: number): number => PAD.top + PLOT_H - (v / top) * PLOT_H;
  const xOf = (i: number): number => PAD.left + i * band + (band - barW) / 2;

  function draw(width: number): void {
    const n = rows.length;
    const avail = Math.max(120, width - PAD.left - PAD.right);
    band = Math.min(BAND_MAX, Math.max(BAND_MIN, avail / n));
    barW = Math.max(2, Math.min(BAR_MAX, band - GAP));
    const plotW = band * n;
    // Bars are capped in width, so a short thread leaves the band's slack as
    // air: keep the axis spanning the panel rather than stopping mid-air.
    const svgW = Math.max(PAD.left + plotW + PAD.right, width);
    const svgH = PAD.top + PLOT_H + PAD.bottom;

    const s = svgEl("svg", {
      class: "hist-svg",
      width: svgW,
      height: svgH,
      viewBox: `0 0 ${svgW} ${svgH}`,
      tabindex: 0,
      role: "img",
      "aria-label": `Token estimate per turn for ${n} turns, stacked by message kind. Use arrow keys to read each turn; Enter opens it.`,
    });

    // gridlines + y ticks
    for (const t of ticks) {
      const y = yOf(t);
      s.append(
        svgEl("line", { class: "hist-grid", x1: PAD.left, x2: svgW - PAD.right, y1: y, y2: y }),
      );
      const label = svgEl("text", {
        class: "hist-axis",
        x: PAD.left - 8,
        y,
        "text-anchor": "end",
        "dominant-baseline": "middle",
      });
      label.textContent = fmtTokens(t);
      s.append(label);
    }
    s.append(
      svgEl("line", {
        class: "hist-baseline",
        x1: PAD.left,
        x2: svgW - PAD.right,
        y1: PAD.top + PLOT_H,
        y2: PAD.top + PLOT_H,
      }),
    );

    // compact-point marker: history to the left, live tail to the right
    if (compactIdx > 0) {
      const cx = PAD.left + compactIdx * band - (band - barW) / 2;
      s.append(
        svgEl("line", {
          class: "hist-compact",
          x1: cx,
          x2: cx,
          y1: PAD.top - 4,
          y2: PAD.top + PLOT_H,
        }),
      );
      const tag = svgEl("text", { class: "hist-compact-tag", x: cx + 4, y: PAD.top + 4 });
      tag.textContent = "compact";
      s.append(tag);
    }

    highlight = svgEl("rect", {
      class: "hist-highlight",
      x: 0,
      y: PAD.top,
      width: band,
      height: PLOT_H,
      visibility: "hidden",
    });
    s.append(highlight);

    // bars
    const radius = barW >= 6 ? 3 : 1;
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      const x = xOf(i);
      const segs = KINDS.map((k) => ({ k, v: r.tokens[k.key] })).filter((seg) => seg.v > 0);
      let acc = 0;
      for (let si = 0; si < segs.length; si++) {
        const { k, v } = segs[si];
        const yBottom = yOf(acc);
        acc += v;
        let y = yOf(acc);
        let h = Math.max(0.6, yBottom - y);
        const isTop = si === segs.length - 1;
        // Gap comes off the segment's top edge, so neighbours never touch.
        if (!isTop && h > GAP + 1.5) {
          y += GAP;
          h -= GAP;
        }
        if (isTop) {
          s.append(svgEl("path", { fill: k.color, d: cappedBar(x, y, barW, h, radius) }));
        } else {
          s.append(svgEl("rect", { fill: k.color, x, y, width: barW, height: h }));
        }
      }
      // Open turn: floating warn cap — "this context is still growing".
      if (r.status === "open") {
        const barTop = r.totalTokens > 0 ? yOf(r.totalTokens) : PAD.top + PLOT_H;
        s.append(
          svgEl("rect", {
            class: "hist-open-cap",
            x,
            y: Math.max(2, barTop - 5),
            width: barW,
            height: 2,
          }),
        );
      }
    }

    // x ticks, thinned to whatever fits
    const every = Math.max(1, Math.ceil(LABEL_ROOM / band));
    for (let i = 0; i < n; i += every) {
      // Drop a trailing label that would run past the plot rather than clip it.
      if (xOf(i) + barW / 2 + 14 > svgW) continue;
      const label = svgEl("text", {
        class: "hist-axis",
        x: xOf(i) + barW / 2,
        y: PAD.top + PLOT_H + 14,
        "text-anchor": "middle",
      });
      label.textContent = String(rows[i].turnOrder);
      s.append(label);
    }

    svg = s;
    scroller.replaceChildren(s);
    wire(s, plotW);
    if (hoverIdx != null) show(hoverIdx, null);
  }

  // --- hover / focus readout ------------------------------------------------

  function indexAt(clientX: number): number | null {
    if (!svg) return null;
    const box = svg.getBoundingClientRect();
    const i = Math.floor((clientX - box.left - PAD.left) / band);
    return i >= 0 && i < rows.length ? i : null;
  }

  function show(i: number, ev: { clientX: number; clientY: number } | null): void {
    const r = rows[i];
    hoverIdx = i;
    if (highlight) {
      highlight.setAttribute("x", String(PAD.left + i * band));
      highlight.setAttribute("width", String(band));
      highlight.setAttribute("visibility", "visible");
    }

    const head = el("div", "hist-tip-head");
    head.append(el("span", "hist-tip-turn", `turn #${r.turnOrder}`));
    if (r.status === "open") head.append(el("span", "badge warn", "open"));
    head.append(el("span", "dim", `${fmtCount(r.messageCount)} msgs`));
    const body = el("div", "hist-tip-rows");
    for (const k of KINDS) {
      const v = r.tokens[k.key];
      if (v <= 0) continue;
      const row = el("div", "hist-tip-row");
      const key = el("span", "hist-key-line");
      key.style.background = k.color;
      row.append(key, el("span", "hist-tip-label", k.label), el("span", "num", fmtTokens(v)));
      body.append(row);
    }
    const totalRow = el("div", "hist-tip-row total");
    totalRow.append(
      el("span", "hist-key-line blank"),
      el("span", "hist-tip-label", "total"),
      el("span", "num", fmtTokens(r.totalTokens)),
    );
    body.append(totalRow);
    tip.replaceChildren(head, body);
    tip.hidden = false;

    const panelBox = panel.getBoundingClientRect();
    let px: number;
    let py: number;
    if (ev) {
      px = ev.clientX - panelBox.left + 14;
      py = ev.clientY - panelBox.top + 12;
    } else if (svg) {
      // `getBoundingClientRect` already carries the scroll offset.
      const box = svg.getBoundingClientRect();
      px = box.left - panelBox.left + xOf(i) + barW + 8;
      py = box.top - panelBox.top + yOf(r.totalTokens);
    } else {
      px = 0;
      py = 0;
    }
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    if (px + w > panelBox.width - 4) px = Math.max(4, px - w - 28);
    tip.style.left = `${Math.max(4, px)}px`;
    tip.style.top = `${Math.max(4, Math.min(py, panelBox.height - h - 4))}px`;
  }

  function hide(): void {
    hoverIdx = null;
    tip.hidden = true;
    highlight?.setAttribute("visibility", "hidden");
  }

  function wire(s: SVGSVGElement, plotW: number): void {
    s.addEventListener("pointermove", (e) => {
      const box = s.getBoundingClientRect();
      const x = e.clientX - box.left;
      const i = x >= PAD.left && x <= PAD.left + plotW ? indexAt(e.clientX) : null;
      if (i == null) hide();
      else show(i, e);
    });
    s.addEventListener("pointerleave", hide);
    s.addEventListener("click", (e) => {
      const i = indexAt(e.clientX);
      if (i != null) onSelect(rows[i].turnOrder);
    });
    s.addEventListener("focus", () => show(hoverIdx ?? 0, null));
    s.addEventListener("blur", hide);
    s.addEventListener("keydown", (e) => {
      const cur = hoverIdx ?? 0;
      let next: number | null = null;
      if (e.key === "ArrowRight" || e.key === "l") next = Math.min(rows.length - 1, cur + 1);
      else if (e.key === "ArrowLeft" || e.key === "h") next = Math.max(0, cur - 1);
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = rows.length - 1;
      else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(rows[cur].turnOrder);
        return;
      }
      if (next == null) return;
      e.preventDefault();
      // Keep the read-out bar in view on a chart wider than its panel.
      const left = PAD.left + next * band;
      const view = scroller.clientWidth;
      if (left - 40 < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, left - 40);
      else if (left + band + 40 > scroller.scrollLeft + view) {
        scroller.scrollLeft = left + band + 40 - view;
      }
      show(next, null);
    });
  }

  const ro = new ResizeObserver(() => {
    const w = scroller.clientWidth;
    if (w > 0 && Math.abs(w - lastWidth) >= 1) {
      lastWidth = w;
      draw(w);
    }
  });
  ro.observe(scroller);

  return { node: panel, dispose: () => ro.disconnect() };
}
