import { createApi, type Api } from "./lib/api.ts";
import { h } from "./lib/dom.ts";
import type { SetupState } from "../src/types.ts";

export type ViewMount = (root: HTMLElement, api: Api) => (() => void) | void;

export const TABS = [
  { id: "studio", hash: "#studio", label: "Studio" },
  { id: "inspiration", hash: "#inspiration", label: "Inspiration" },
  { id: "tools", hash: "#tools", label: "Tools" },
  { id: "settings", hash: "#settings", label: "Settings" },
] as const;

export const routes: Record<string, ViewMount> = {};

export function registerRoute(hash: string, mount: ViewMount): void {
  routes[hash] = mount;
}

function renderDefault(root: HTMLElement, hash: string): void {
  const tab = TABS.find((t) => t.hash === hash);
  const title = tab ? tab.label : hash.replace(/^#/, "");
  root.replaceChildren(
    h(
      "div",
      { class: "view-container" },
      h("h1", { class: "view-heading" }, title)
    )
  );
}

export async function initApp(
  container: HTMLElement,
  customApi?: Api
): Promise<{ navigate(hash: string): Promise<void>; destroy(): void }> {
  const api = customApi ?? createApi();
  let needsSetup = false;
  let currentCleanup: (() => void) | void;

  try {
    const setup = await api.get<SetupState>("/api/setup");
    needsSetup = Boolean(setup.needsSetup);
  } catch {
    needsSetup = false;
  }

  const tabElements: HTMLAnchorElement[] = TABS.map((tab) =>
    h(
      "a",
      { class: "nav-tab", href: tab.hash, "data-tab": tab.id },
      tab.label
    )
  );

  const navRail = h(
    "nav",
    { class: "nav-rail", "aria-label": "Main Navigation" },
    h(
      "div",
      { class: "nav-brand" },
      h("span", { class: "accent-dot" }),
      "mostudio"
    ),
    h("div", { class: "nav-tabs" }, ...tabElements)
  );

  const mainContent = h("main", {
    id: "main-content",
    class: "main-content",
    role: "main",
  });

  container.replaceChildren(navRail, mainContent);

  async function navigate(hash: string): Promise<void> {
    if (needsSetup && hash !== "#setup") {
      if (window.location.hash !== "#setup") {
        window.location.hash = "#setup";
      }
      hash = "#setup";
    }

    const validHashes = [
      "#studio",
      "#inspiration",
      "#tools",
      "#settings",
      "#setup",
    ];
    const targetHash = validHashes.includes(hash) ? hash : "#studio";

    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash;
      return;
    }

    for (const link of tabElements) {
      if (link.getAttribute("href") === targetHash) {
        link.classList.add("active");
        link.setAttribute("aria-current", "page");
      } else {
        link.classList.remove("active");
        link.removeAttribute("aria-current");
      }
    }

    if (currentCleanup) {
      try {
        currentCleanup();
      } catch (err) {
        console.error("View cleanup error:", err);
      }
      currentCleanup = undefined;
    }

    mainContent.replaceChildren();

    const mount = routes[targetHash];
    if (mount) {
      currentCleanup = mount(mainContent, api);
    } else {
      renderDefault(mainContent, targetHash);
    }
  }

  const onHashChange = () => {
    navigate(window.location.hash || "#studio");
  };

  window.addEventListener("hashchange", onHashChange);

  const initialHash = window.location.hash || (needsSetup ? "#setup" : "#studio");
  await navigate(initialHash);

  return {
    navigate,
    destroy() {
      window.removeEventListener("hashchange", onHashChange);
      if (currentCleanup) {
        try {
          currentCleanup();
        } catch {}
        currentCleanup = undefined;
      }
      container.replaceChildren();
    },
  };
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const mountPoint = document.getElementById("app");
  if (mountPoint) {
    initApp(mountPoint);
  } else {
    window.addEventListener("DOMContentLoaded", () => {
      const el = document.getElementById("app");
      if (el) initApp(el);
    });
  }
}
