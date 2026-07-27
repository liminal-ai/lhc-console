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

export function openLaunchModal(command: string, target?: LaunchTarget): void {
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

  const pre = el("pre", "modal-cmd", command);
  box.append(pre);
  box.append(el("div", "modal-hint dim", "paste into a terminal on the server"));

  const status = el("div", "modal-status");
  box.append(status);

  const actions = el("div", "modal-actions");
  if (target) {
    const openBtn = el("button", "modal-open", "open in terminal") as HTMLButtonElement;
    openBtn.type = "button";
    openBtn.title = "run this on the server, in a workspace screen";
    openBtn.onclick = () => {
      dismiss();
      void openThreadTerminal(target.hostId, target.threadId).catch((e: unknown) => {
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
