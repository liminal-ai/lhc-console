/** Shared DOM helper + display formatters for the console. */

export function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function fmtCount(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString();
}

export function fmtBytes(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(0)} KB`;
  return `${n} B`;
}

export function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const days = (Date.now() - d.getTime()) / 86_400_000;
  if (days < 1) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days < 7) return `${Math.floor(days)}d ago`;
  return d.toLocaleDateString();
}

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Compact absolute stamp: `Jul 24 14:32`, with year when not the current one. */
export function fmtStamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const year = d.getFullYear() === new Date().getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${pad2(d.getDate())}${year} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Relative age, single token: `12m`, `5h`, `3d`, `2w`, `7mo`. */
export function fmtAgo(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  const mins = ms / 60_000;
  if (mins < 1) return "now";
  if (mins < 60) return `${Math.floor(mins)}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  const days = mins / 1440;
  if (days < 14) return `${Math.floor(days)}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

const HOME_RE = /^\/(?:home|Users)\/[^/]+(?=\/|$)/;

/** `/home/x/dev/proj` → `{ parent: "~/dev/", base: "proj" }`. */
export function splitDir(cwd: string | null): { parent: string; base: string } {
  if (!cwd) return { parent: "", base: "—" };
  const short = cwd.replace(HOME_RE, "~");
  const cut = short.lastIndexOf("/");
  if (cut < 0) return { parent: "", base: short };
  return { parent: `${short.slice(0, cut)}/`, base: short.slice(cut + 1) || "/" };
}
