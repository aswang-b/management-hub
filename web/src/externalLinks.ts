// Links to other sites open in this computer's default browser. The hub's
// window is Chrome's (an installed app), and links clicked in it would
// otherwise open in Chrome. Only when the page is used on the hub's own
// computer: on a phone, links open normally.
import { api } from "./api.ts";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export function openLinksInDefaultBrowser() {
  if (!LOCAL_HOSTS.includes(location.hostname)) return;
  const open = (e: MouseEvent) => {
    if (e.defaultPrevented || (e.type === "click" && e.button !== 0) || (e.type === "auxclick" && e.button !== 1)) return;
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || !/^https?:$/.test(a.protocol) || a.origin === location.origin) return;
    e.preventDefault();
    api.openUrl(a.href).then(
      (r) => !r.ok && window.open(a.href, "_blank", "noreferrer"),
      () => window.open(a.href, "_blank", "noreferrer"),
    );
  };
  document.addEventListener("click", open);
  document.addEventListener("auxclick", open);
}
