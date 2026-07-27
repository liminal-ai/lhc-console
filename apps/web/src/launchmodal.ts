import type { LaunchRecipe } from "./api.ts";
import { el } from "./format.ts";
import { openThreadTerminal } from "./workspace.ts";

/**
 * Copy via a hidden textarea. Synchronous, so it still counts as part of the
 * user gesture that opened the modal — the only path that works on the plain
 * http origin this console is served from (no `navigator.clipboard` there).
 */
function copyViaTextarea(text: string): boolean {
  const hadFocus = document.activeElement;
  const ta = el("textarea") as HTMLTextAreaElement;
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;";
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  // Selecting the textarea took focus off whatever had it — put it back.
  if (hadFocus instanceof HTMLElement && hadFocus.isConnected) hadFocus.focus();
  return ok;
}

/** Clipboard API when the origin allows it, hidden textarea otherwise. */
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // permission denied or insecure context — fall through to the old way
    }
  }
  return copyViaTextarea(text);
}

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
 * The launch modal, in two moods.
 *
 * Normally it just hands over the command. When the server's one-writer guard
 * found something already attached to this session, it says so first and turns
 * the spawn button into a deliberate "attach anyway" — a second writer freezes
 * capture for one of them, and lost turns do not come back. Copying the
 * command stays available either way; the user may well want to attach from a
 * terminal they can see.
 */
export function openLaunchModal(launch: LaunchRecipe | string, target?: LaunchTarget): void {
  const recipe: LaunchRecipe = typeof launch === "string" ? { command: launch } : launch;
  const command = recipe.command;
  const attached = (recipe.attached ?? []).filter((a) => a.source === "process");
  const inUse = !!recipe.inUse && attached.length > 0;
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

  const pre = el("pre", "modal-cmd", command);
  box.append(pre);
  box.append(el("div", "modal-hint dim", "paste into a terminal on the server"));

  const status = el("div", "modal-status");
  box.append(status);

  const actions = el("div", "modal-actions");
  if (target) {
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
  const copyBtn = el("button", "modal-copy", "copy") as HTMLButtonElement;
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
    void copyText(command).then((ok) => {
      if (ok) dismiss();
      else setStatus("copy failed — select the command above and copy manually", "bad");
    });
  };

  document.body.append(backdrop);
  close = dismiss;
  copyBtn.focus();

  // Auto-copy attempt, still inside the gesture that opened the modal.
  setStatus("copying…", "dim");
  void copyText(command).then((ok) => {
    if (close !== dismiss) return;
    copyBtn.focus();
    if (ok) setStatus("copied to clipboard", "ok");
    else setStatus("copy failed — use the button", "bad");
  });
}
