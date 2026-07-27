/**
 * Copying a command, on an origin that mostly cannot.
 *
 * The console is served over plain http on a tailnet, where
 * `navigator.clipboard` does not exist — so the hidden-textarea path is not a
 * fallback here, it is the usual one. It is synchronous on purpose: it still
 * counts as part of the user gesture that opened the modal.
 */

import { el } from "./format.ts";

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
export async function copyText(text: string): Promise<boolean> {
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
