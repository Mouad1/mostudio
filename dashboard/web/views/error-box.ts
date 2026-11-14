import { h } from "../lib/dom.ts";
import { explainError } from "../lib/errors.ts";

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
    h(
      "details",
      { class: "error-details" },
      h("summary", {}, "Details"),
      h("pre", {}, h("code", {}, explained.details))
    )
  );
}
