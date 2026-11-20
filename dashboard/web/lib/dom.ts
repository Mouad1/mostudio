export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | boolean | EventListener | undefined>,
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);

  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === false) {
        continue;
      }
      if (typeof value === "function") {
        const eventName = key.startsWith("on") ? key.slice(2).toLowerCase() : key;
        el.addEventListener(eventName, value as EventListener);
      } else if (typeof value === "boolean") {
        if (value) {
          el.setAttribute(key, "");
          if (key in el) {
            (el as Record<string, unknown>)[key] = true;
          }
        }
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }

  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    if (typeof child === "string") {
      el.appendChild(document.createTextNode(child));
    } else if (child instanceof Node) {
      el.appendChild(child);
    } else {
      el.appendChild(document.createTextNode(String(child)));
    }
  }

  return el;
}

type DetailsHost = { querySelectorAll(selector: "details"): ArrayLike<Element> };

function detailsKey(el: Element, index: number): string {
  return el.getAttribute("data-key") ?? `#${index}`;
}

/**
 * Keys of the open <details> under `root`. A details is keyed by its `data-key`, else by its
 * position, so a re-render can reopen the same ones.
 */
export function openDetailsKeys(root: DetailsHost): Set<string> {
  const keys = new Set<string>();
  Array.from(root.querySelectorAll("details")).forEach((el, i) => {
    if (el.getAttribute("open") != null) keys.add(detailsKey(el, i));
  });
  return keys;
}

/** Reopen the <details> under `root` whose keys were open before a re-render. */
export function restoreOpenDetails(root: DetailsHost, keys: Set<string>): void {
  if (keys.size === 0) return;
  Array.from(root.querySelectorAll("details")).forEach((el, i) => {
    if (keys.has(detailsKey(el, i))) el.setAttribute("open", "");
  });
}
