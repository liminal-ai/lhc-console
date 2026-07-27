import "./style.css";
import { ApiError } from "./api.ts";
import { isTab, renderThread, teardownDetail } from "./detail.ts";
import { el } from "./format.ts";
import { renderList, teardownList } from "./list.ts";

const app = document.querySelector<HTMLDivElement>("#app")!;

/** `#/thread/<host>/<id>[/<tab>[/<turnOrder>]]`, everything else is the list. */
const THREAD_RE = /^\/thread\/([^/]+)\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/;

function route(): void {
  teardownDetail();
  teardownList();
  const m = location.hash.slice(1).match(THREAD_RE);
  if (m) {
    const tab = isTab(m[3]) ? m[3] : "overview";
    const order = m[4] !== undefined && /^\d+$/.test(m[4]) ? Number(m[4]) : null;
    renderThread(app, m[1], m[2], tab, order).catch(showError);
  } else {
    document.title = "lhc console";
    renderList(app).catch(showError);
  }
}

/** A missing host/thread is an expected state, not a stack trace. */
function showError(err: unknown): void {
  const notFound = err instanceof ApiError && err.status === 404;
  const box = el("div", "page error-page");
  if (notFound) {
    document.title = "not found · lhc console";
    box.append(el("div", "notfound-code", "404"));
    box.append(el("div", "notfound-what", (err as ApiError).detail));
    box.append(el("div", "notfound-where dim", location.hash || "#/"));
  } else {
    document.title = "error · lhc console";
    box.append(el("div", "error", err instanceof Error ? err.message : String(err)));
  }
  const back = el("a", "back", "← all threads") as HTMLAnchorElement;
  back.href = "#/";
  box.append(back);
  app.replaceChildren(box);
}

window.addEventListener("hashchange", route);
route();
