/**
 * Console-owned thread names.
 *
 * Host registries do not carry names: a title is a cwd basename, a t3code
 * uuid, a hermes timestamp stem, and the list summary is whatever the latest
 * `chunk_summary_brief` happened to say. None of that is what a person calls
 * a thread. So the console keeps its own title and description per thread and
 * overlays them on the host's — the host row is never written.
 *
 * The trim/cap/merge rules live here, pure and free of any file, so they can
 * be tested directly; `apps/server/src/prefs.ts` owns the storage and the
 * atomic write.
 */

/** A name is a label, not a paragraph. */
export const NAME_TITLE_MAX = 80;
/** A description is a sentence or two, not a summary of the thread. */
export const NAME_DESCRIPTION_MAX = 300;

export interface ThreadName {
  title: string | null;
  description: string | null;
  updatedAt: string;
}

/** A partial update: an absent field is untouched, an explicit null clears it. */
export interface ThreadNamePatch {
  title?: string | null;
  description?: string | null;
}

/** Composite key; names are per host + resolved full thread id. */
export function nameKey(hostId: string, threadId: string): string {
  return `${hostId}/${threadId}`;
}

/**
 * One stored field: trimmed, capped, and empty-means-absent. Anything that is
 * not a string at all (a hand-edited prefs file, a stray JSON shape) reads as
 * absent rather than throwing.
 */
export function capField(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Cutting mid-sentence can leave a trailing space; do not store it.
  return trimmed.length > max ? trimmed.slice(0, max).trimEnd() : trimmed;
}

/** Tolerant read of the whole `names` record — unknown shapes are dropped. */
export function normalizeNames(raw: unknown): Record<string, ThreadName> {
  const out: Record<string, ThreadName> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !value || typeof value !== "object") continue;
    const title = capField((value as { title?: unknown }).title, NAME_TITLE_MAX);
    const description = capField(
      (value as { description?: unknown }).description,
      NAME_DESCRIPTION_MAX,
    );
    // An entry with nothing in it is not an entry.
    if (title === null && description === null) continue;
    const at = (value as { updatedAt?: unknown }).updatedAt;
    out[key] = {
      title,
      description,
      updatedAt: typeof at === "string" ? at : new Date(0).toISOString(),
    };
  }
  return out;
}

/**
 * Apply a patch to what is stored. Returns null when nothing is left to keep —
 * the caller deletes the entry rather than storing a pair of nulls.
 */
export function mergeName(
  current: ThreadName | undefined | null,
  patch: ThreadNamePatch,
  now: string = new Date().toISOString(),
): ThreadName | null {
  const title =
    patch.title === undefined ? (current?.title ?? null) : capField(patch.title, NAME_TITLE_MAX);
  const description =
    patch.description === undefined
      ? (current?.description ?? null)
      : capField(patch.description, NAME_DESCRIPTION_MAX);
  if (title === null && description === null) return null;
  return { title, description, updatedAt: now };
}

/**
 * Validate a request body. Wrong types are a client error, not something to
 * coerce: silently reading `{title: 42}` as "clear the title" would let a
 * buggy caller erase names it meant to set.
 */
export function parseNamePatch(
  raw: unknown,
): { ok: true; patch: ThreadNamePatch } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, patch: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "body must be an object" };
  }
  const patch: ThreadNamePatch = {};
  for (const field of ["title", "description"] as const) {
    const value = (raw as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (value !== null && typeof value !== "string") {
      return { ok: false, error: `${field} must be a string or null` };
    }
    patch[field] = value;
  }
  return { ok: true, patch };
}
