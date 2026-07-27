import type { LaunchRecipe } from "./api.ts";
import { copyText } from "./clipboard.ts";
import { el } from "./format.ts";
import { openThreadTerminal } from "./workspace.ts";

/** Whatever modal is on screen; opening a second one replaces the first. */
let close: (() => void) | null = null;

export function closeLaunchModal(): void {
  close?.();
}

/** Which thread the command belongs to, so the modal can actually run it. */
export interface LaunchTarget {
  hostId: string;
  threadId: string;
}

/**
 * The launch modal, in several moods.
 *
 * Normally it just hands over the command. When the session id had to be
 * recovered from the rollout files, or the command is only a `--continue`
 * approximation, it says so quietly — the command still works, the user just
 * deserves to know how sure we are. When there is no command at all it explains
 * why rather than showing an empty box, because a dead end with a reason beats
 * an affordance that silently does nothing.
 *
 * Attachments read differently per host. On a single-writer host (cc-lhc,
 * codex-lhc) a stranger on the session is a warning and the spawn button
 * becomes a deliberate "attach anyway" — a second writer freezes capture and
 * lost turns do not come back. On a shared-writer host (hermes, pi-lhc) it is
 * just a fact worth stating, in dim text, next to an ordinary button.
 */
export function openLaunchModal(launch: LaunchRecipe | string, target?: LaunchTarget): void {
  const recipe: LaunchRecipe =
    typeof launch === "string" ? { command: launch, writerPolicy: "single" } : launch;
  const command = recipe.command;
  const attached = (recipe.attached ?? []).filter((a) => a.source === "process");
  const single = recipe.writerPolicy !== "shared";
  /** Attached, on a host where that is dangerous: warn and force. */
  const inUse = single && !!recipe.inUse && attached.length > 0;
  /** Attached, on a host where that is normal: mention and carry on. */
  const alsoAttached = !single && attached.length > 0;
  closeLaunchModal();
  const restoreFocus = document.activeElement;

  const backdrop = el("div", "modal-backdrop");
  const box = el("div", "modal panel");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", "launch thread");

  const head = el("div", "modal-head");
  head.append(el("h2", "modal-title", "launch thread"));
  const x = el("button", "modal-x", "✕") as HTMLButtonElement;
  x.type = "button";
  x.title = "close (esc)";
  head.append(x);
  box.append(head);

  if (inUse) {
    const warn = el("div", "modal-warn");
    warn.append(
      el(
        "div",
        "modal-warn-line",
        "a live process is already attached to this session — a second writer can corrupt capture",
      ),
    );
    for (const a of attached) {
      const line = el("div", "modal-warn-proc dim", `pid ${a.pid}  ${a.args}`);
      if (a.startedAt) line.title = `started ${new Date(a.startedAt).toLocaleString()}`;
      warn.append(line);
    }
    box.append(warn);
  }

  if (alsoAttached) {
    // Neutral, not a warning: this host takes more than one attachment.
    const note = el("div", "modal-note dim");
    for (const a of attached) {
      // One line each. This is context, not evidence — the full argv and the
      // start time live in the tooltip rather than wrapping over three rows.
      const shortArgs = a.args.length > 74 ? `${a.args.slice(0, 73)}…` : a.args;
      const line = el("div", "modal-note-proc", `also attached: pid ${a.pid} · ${shortArgs}`);
      line.title = a.startedAt
        ? `${a.args}\nstarted ${new Date(a.startedAt).toLocaleString()}`
        : a.args;
      note.append(line);
    }
    box.append(note);
  }

  if (command) {
    box.append(el("pre", "modal-cmd", command));
    box.append(el("div", "modal-hint dim", "paste into a terminal on the server"));
    if (recipe.recovered) {
      box.append(
        el("div", "modal-hint dim", "session id recovered from rollout files (lineage db empty)"),
      );
    }
    if (recipe.fallback === "continue") {
      box.append(
        el(
          "div",
          "modal-hint dim",
          "no session mapping found — --continue resumes the most recent session in this directory, which may not be this thread",
        ),
      );
    }
  } else {
    box.append(
      el(
        "div",
        "modal-hint modal-why dim",
        recipe.reason ?? "this thread has no known way to resume",
      ),
    );
  }

  const status = el("div", "modal-status");
  box.append(status);

  const actions = el("div", "modal-actions");
  if (target && command) {
    const openBtn = el(
      "button",
      inUse ? "modal-open danger" : "modal-open",
      inUse ? "attach anyway" : "open in terminal",
    ) as HTMLButtonElement;
    openBtn.type = "button";
    openBtn.title = inUse
      ? "spawn a second writer on this session anyway"
      : "run this on the server, in a workspace screen";
    openBtn.onclick = () => {
      dismiss();
      // `force` only when the user acted on a button that says so.
      void openThreadTerminal(target.hostId, target.threadId, false, inUse).catch((e: unknown) => {
        setStatus(e instanceof Error ? e.message : String(e), "bad");
      });
    };
    actions.append(openBtn);
  }
  const copyBtn = el("button", "modal-copy", command ? "copy" : "close") as HTMLButtonElement;
  copyBtn.type = "button";
  actions.append(copyBtn);
  box.append(actions);

  backdrop.append(box);

  const setStatus = (text: string, cls: string): void => {
    status.className = `modal-status ${cls}`;
    status.textContent = text;
  };

  const dismiss = (): void => {
    if (close !== dismiss) return;
    close = null;
    window.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    if (restoreFocus instanceof HTMLElement && restoreFocus.isConnected) restoreFocus.focus();
  };

  /**
   * Capture phase and stopped here: Esc closes the modal and must never also
   * reach the detail page's Esc-goes-back binding.
   */
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
  copyBtn.onclick = () => {
    if (!command) {
      dismiss();
      return;
    }
    void copyText(command).then((ok) => {
      if (ok) dismiss();
      else setStatus("copy failed — select the command above and copy manually", "bad");
    });
  };

  document.body.append(backdrop);
  close = dismiss;
  copyBtn.focus();

  // Nothing to copy: the modal is an explanation, so it says nothing further.
  if (!command) return;

  // Auto-copy attempt, still inside the gesture that opened the modal.
  setStatus("copying…", "dim");
  void copyText(command).then((ok) => {
    if (close !== dismiss) return;
    copyBtn.focus();
    if (ok) setStatus("copied to clipboard", "ok");
    else setStatus("copy failed — use the button", "bad");
  });
}
