import { h } from "../lib/dom.ts";
import { detailsAddInfo, explainError } from "../lib/errors.ts";

export function errorBox(message: string): HTMLElement {
  const explained = explainError(message);
  const actionLink = explained.action
    ? h(
        "a",
        { class: "error-action", href: explained.action.href },
        explained.action.label
      )
    : null;

  return h(
    "div",
    { class: "error-box", role: "alert" },
    h("h3", { class: "error-title" }, explained.title),
    h("p", { class: "error-advice" }, explained.advice),
    actionLink,
    // Only when they show more than the advice above (a stack, the engine's own words).
    detailsAddInfo(explained)
      ? h(
          "details",
          // Keyed by the message so a re-render keeps it open (restoreOpenDetails).
          { class: "error-details", "data-key": `error:${message}` },
          h("summary", {}, "Details"),
          h("pre", {}, h("code", {}, explained.details))
        )
      : null
  );
}
