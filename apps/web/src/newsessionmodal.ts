/**
 * The new-session modal: pick what to run, pick where, then run it.
 *
 * It is the same two actions as the launch modal — open in terminal, copy the
 * command — over a different question. What it never does is compose the
 * command: the string on screen is fetched from the server that would run it,
 * so what you copy and what a spawn executes cannot drift apart.
 *
 * hermes is the odd host: it restores each session's own directory, so it gets
 * a profile picker where the others get a path picker.
 */

import { api, type NewSessionOptions, type QuickDir } from "./api.ts";
import { copyText } from "./clipboard.ts";
import { el, fmtAgo } from "./format.ts";
import { createPathPicker, type PathPicker, type PickerResult } from "./pathpicker.ts";
import { startNewTerminal } from "./workspace.ts";

export interface NewSessionModalOptions {
  /**
   * Directory to start in. The split popover passes the focused pane's cwd —
   * the common split is "another shell here", not "somewhere else entirely".
   */
  seedCwd?: string | null;
  /** Preselect the plain shell rather than the last host used. */
  prefer?: "shell" | "session";
  /** Where the terminal lands: a screen of its own, or the active split. */
  place?: "screen" | "split";
  /** Called once a terminal actually starts (the popover closes on it). */
  onOpened?: () => void;
}

/** The choice sticks between openings — most people start the same thing twice. */
let lastChoice: string | null = null;
/** Host options change only when something is installed; one fetch is plenty. */
let optionsCache: NewSessionOptions | null = null;

let close: (() => void) | null = null;

export function closeNewSessionModal(): void {
  close?.();
}

const PREVIEW_DEBOUNCE_MS = 120;

/** `3 threads · cc-lhc, pi-lhc · 2h` — what makes a bare path recognisable. */
function quickDirSublabel(d: QuickDir): string {
  const threads = `${d.threadCount} thread${d.threadCount === 1 ? "" : "s"}`;
  return `${threads} · ${d.hosts.join(" ")} · ${fmtAgo(d.lastActiveAt)}`;
}

export function openNewSessionModal(opts: NewSessionModalOptions = {}): void {
  closeNewSessionModal();
  const restoreFocus = document.activeElement;

  const backdrop = el("div", "modal-backdrop");
  const box = el("div", "modal panel ns-modal");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", "new session");

  const head = el("div", "modal-head");
  head.append(el("h2", "modal-title", "new session"));
  const x = el("button", "modal-x", "✕") as HTMLButtonElement;
  x.type = "button";
  x.title = "close (esc)";
  head.append(x);
  box.append(head);

  const hostRow = el("div", "ns-hosts");
  box.append(hostRow);

  const body = el("div", "ns-body");
  box.append(body);

  const cmd = el("pre", "modal-cmd", "…");
  box.append(cmd);
  const status = el("div", "modal-status");
  box.append(status);

  const actions = el("div", "modal-actions");
  const openBtn = el("button", "modal-open", "open in terminal") as HTMLButtonElement;
  openBtn.type = "button";
  openBtn.title = "run this on the server, in a workspace screen";
  const copyBtn = el("button", "modal-copy", "copy command") as HTMLButtonElement;
  copyBtn.type = "button";
  actions.append(openBtn, copyBtn);
  box.append(actions);
  backdrop.append(box);

  // --- state ---------------------------------------------------------------

  /**
   * Selected host id, or "shell". Empty until the options land: the very
   * first opening should default to a real LHC host — that is what this
   * console is for — and which hosts exist is not known until then.
   */
  let choice = opts.prefer === "shell" ? "shell" : (lastChoice ?? "");
  let cwd = opts.seedCwd ?? "";
  let profile: string | null = null;
  let command: string | null = null;
  let picker: PathPicker | null = null;
  let quick: QuickDir[] = [];
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let previewSeq = 0;

  const setStatus = (text: string, cls: string): void => {
    status.className = `modal-status ${cls}`;
    status.textContent = text;
  };

  function rootFor(hostId: string): string {
    const o = optionsCache;
    if (!o) return "/srv/work";
    return o.rootByHost[hostId] ?? o.defaultRoot;
  }

  // --- preview -------------------------------------------------------------

  function refreshPreview(): void {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const mine = ++previewSeq;
      const kind = choice === "shell" ? ("shell" as const) : ("newSession" as const);
      void api
        .newSessionPreview({
          kind,
          hostId: choice === "shell" ? undefined : choice,
          cwd: choice === "hermes" ? undefined : cwd,
          profile,
        })
        .then((res) => {
          if (mine !== previewSeq || close !== dismiss) return;
          command = res.command;
          cmd.textContent = res.command ?? res.error ?? "nothing to run";
          cmd.classList.toggle("dim", !res.command);
          openBtn.disabled = !res.command;
          copyBtn.disabled = !res.command;
          if (!res.command && status.textContent) setStatus("", "");
        })
        .catch((e: unknown) => {
          if (mine !== previewSeq) return;
          command = null;
          cmd.textContent = e instanceof Error ? e.message : String(e);
          openBtn.disabled = true;
          copyBtn.disabled = true;
        });
    }, PREVIEW_DEBOUNCE_MS);
  }

  // --- body: path picker or profile picker ---------------------------------

  /**
   * Quick selects, narrowed by whatever is typed. Two ways to hit: the query
   * is a prefix of the path (typing down from `/srv/`), or a prefix of the
   * basename (typing `lhc` because you want `/srv/work/lhc-console` and are
   * not going to type the rest). Prefixes only — a list that reshuffles around
   * fragments is noise, and the browse section is right underneath.
   */
  function quickSection(query: string): PickerResult {
    const q = query.trim().toLowerCase();
    const hits = q
      ? quick.filter(
          (d) => d.path.toLowerCase().startsWith(q) || d.basename.toLowerCase().startsWith(q),
        )
      : quick;
    return {
      entries: hits.map((d) => ({
        label: d.path,
        sublabel: quickDirSublabel(d),
        path: d.path,
      })),
      // Silent when a query simply rules them all out: browse has the answer.
      note: quick.length || q ? undefined : "no directories with threads yet",
    };
  }

  function buildPathBody(): void {
    picker?.destroy();
    body.replaceChildren();
    body.append(el("div", "ns-label dim", "directory"));
    picker = createPathPicker({
      seed: cwd || rootFor(choice),
      placeholder: "/srv/work/…",
      sections: [
        {
          label: "quick selects",
          provide: (q) => quickSection(q),
        },
        {
          label: "browse",
          provide: async (q) => {
            const res = await api.browse(q);
            return {
              entries: res.entries.map((e) => ({ label: e.name, path: e.path })),
              note:
                res.error ??
                (res.truncated
                  ? `more than ${res.entries.length} directories — keep typing`
                  : res.entries.length
                    ? undefined
                    : "no directories here"),
            };
          },
        },
      ],
      onChange: (v) => {
        cwd = v.trim();
        refreshPreview();
      },
      onSelect: (path) => {
        cwd = path;
        picker?.setValue(path);
        refreshPreview();
        openBtn.focus();
      },
      onEscape: dismiss,
    });
    cwd = picker.value();
    body.append(picker.root);
    picker.focus();
  }

  function buildProfileBody(): void {
    picker?.destroy();
    picker = null;
    body.replaceChildren();
    body.append(el("div", "ns-label dim", "profile"));
    const names = ["default", ...(optionsCache?.hermesProfiles ?? [])];
    const chips = el("div", "ns-chips");
    for (const name of names) {
      const b = el("button", "chip ns-chip", name) as HTMLButtonElement;
      b.type = "button";
      b.classList.toggle("on", (profile ?? "default") === name);
      b.onclick = () => {
        profile = name === "default" ? null : name;
        buildProfileBody();
        refreshPreview();
      };
      chips.append(b);
    }
    body.append(chips);
    body.append(
      el(
        "div",
        "ns-hint dim",
        "hermes restores each session's own directory, so there is none to pick",
      ),
    );
  }

  function buildBody(): void {
    if (choice === "hermes") buildProfileBody();
    else buildPathBody();
  }

  // --- host row ------------------------------------------------------------

  function paintHosts(): void {
    hostRow.replaceChildren();
    const ids = [...(optionsCache?.hosts.map((h) => h.id) ?? []), "shell"];
    for (const id of ids) {
      const b = el("button", "chip ns-chip", id === "shell" ? "shell" : id) as HTMLButtonElement;
      b.type = "button";
      b.title = id === "shell" ? "a plain login shell, no LHC" : `start a new ${id} session`;
      b.classList.toggle("on", id === choice);
      b.onclick = () => {
        if (choice === id) return;
        choice = id;
        lastChoice = id;
        // Each host may have its own root; keep the typed path when there is one.
        if (!cwd) cwd = rootFor(id);
        buildBody();
        paintHosts();
        refreshPreview();
      };
      hostRow.append(b);
    }
  }

  // --- lifecycle -----------------------------------------------------------

  const dismiss = (): void => {
    if (close !== dismiss) return;
    close = null;
    clearTimeout(previewTimer);
    picker?.destroy();
    window.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    if (restoreFocus instanceof HTMLElement && restoreFocus.isConnected) restoreFocus.focus();
  };

  /** Capture phase: Esc belongs to the modal and must not reach the page. */
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    e.preventDefault();
    dismiss();
  };
  window.addEventListener("keydown", onKey, true);

  backdrop.onclick = (e) => {
    if (e.target === backdrop) dismiss();
  };
  x.onclick = dismiss;

  openBtn.onclick = () => {
    if (!command) return;
    setStatus("starting…", "dim");
    const body_ =
      choice === "shell"
        ? { shell: { cwd } }
        : { newSession: { hostId: choice, cwd: choice === "hermes" ? undefined : cwd, profile } };
    void startNewTerminal(body_, opts.place ?? "screen")
      .then(() => {
        opts.onOpened?.();
        dismiss();
      })
      .catch((e: unknown) => {
        setStatus(e instanceof Error ? e.message : String(e), "bad");
      });
  };

  copyBtn.onclick = () => {
    if (!command) return;
    void copyText(command).then((ok) => {
      if (ok) dismiss();
      else setStatus("copy failed — select the command above and copy manually", "bad");
    });
  };

  document.body.append(backdrop);
  close = dismiss;

  // Options first (they decide which chips exist and where the picker starts),
  // then the quick selects, which only enrich a list that already works.
  const ready = optionsCache
    ? Promise.resolve(optionsCache)
    : api.newSessionOptions().then((o) => {
        optionsCache = o;
        return o;
      });
  void ready
    .then((o) => {
      if (close !== dismiss) return;
      // No remembered choice, or one that is no longer installed: the first
      // launchable host, and only a shell when there is no host at all.
      if (choice !== "shell" && !o.hosts.some((h) => h.id === choice)) {
        choice = o.hosts[0]?.id ?? "shell";
      }
      if (!cwd) cwd = rootFor(choice);
      paintHosts();
      buildBody();
      refreshPreview();
    })
    .catch(() => {
      cmd.textContent = "could not load host options";
    });
  void api
    .quickDirs()
    .then((rows) => {
      if (close !== dismiss) return;
      quick = rows;
      // Re-query so the freshly arrived quick selects show up under the input.
      if (picker) picker.setValue(picker.input.value);
    })
    .catch(() => {
      // No quick selects is a smaller picker, not a broken one.
    });
}
