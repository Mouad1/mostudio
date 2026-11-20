import type { StepView } from "../../src/types.ts";
import { h } from "../lib/dom.ts";
import { STEP_LABELS } from "../lib/pipeline.ts";
import { checkDetails, missedChecks } from "../lib/verdicts.ts";

function checkList(result: StepView): HTMLElement {
  return h(
    "ul",
    { class: "check-list" },
    ...missedChecks(result).map((c) =>
      h(
        "li",
        { class: "check-item" },
        h("p", { class: "check-text" }, c.text),
        c.hint ? h("p", { class: "check-hint" }, h("strong", {}, "What you can do: "), c.hint) : null
      )
    )
  );
}

/**
 * A step finished but missed a must-pass check. Says which one in plain words, what to do about it,
 * and lets the user keep the result and go on (Retry, the main button, would most likely give the same).
 */
export function checkFailedBox(result: StepView, opts: { pending: boolean; onAccept: () => void }): HTMLElement {
  const label = STEP_LABELS[result.step] ?? result.step;
  return h(
    "div",
    { class: "check-failed-box", role: "alert" },
    h("h3", { class: "check-failed-title" }, `${label} didn't pass its quality check`),
    checkList(result),
    h(
      "p",
      { class: "check-failed-advice" },
      "The result is saved. Check it below: if it looks and sounds fine to you, continue anyway. Retry makes it again from the same video, so it will most likely miss the check again."
    ),
    h(
      "div",
      { class: "check-failed-actions" },
      h(
        "button",
        { type: "button", class: "btn btn-secondary btn-accept-check", disabled: opts.pending, onClick: opts.onAccept },
        "Continue anyway"
      )
    ),
    h(
      "details",
      // Keyed so a re-render keeps it open (restoreOpenDetails).
      { class: "check-details", "data-key": `checks:${result.step}:${result.endedAt}` },
      h("summary", {}, "Details"),
      h("pre", {}, h("code", {}, checkDetails(result).join("\n"))),
      h("p", { class: "check-details-logs" }, "What the step did is in the step logs below.")
    )
  );
}

/** The user kept a result that missed a check: say so calmly, and that a new run asks again. */
export function acceptedNote(result: StepView): HTMLElement {
  return h(
    "div",
    { class: "check-accepted-note" },
    h("h4", { class: "check-accepted-title" }, "You kept this result"),
    h("p", {}, "It missed a quality check, and you chose to continue anyway:"),
    checkList(result),
    h("p", { class: "check-accepted-foot" }, "If this step runs again with changes, mostudio checks it again and asks you.")
  );
}
