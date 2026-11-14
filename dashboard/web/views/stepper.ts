import { h } from "../lib/dom.ts";
import { elapsed, STEP_LABELS, type PipelineState, type StepCard } from "../lib/pipeline.ts";

export function badgeText(card: StepCard): string {
  switch (card.state) {
    case "idle":
      return "Waiting";
    case "running":
      return "Running…";
    case "pass":
      return card.autoApproved ? "Approved automatically" : "Done";
    case "warn":
      return "Done with warnings";
    case "fail":
      return "Failed";
    case "cached":
      return "Reused";
    case "awaiting":
      return "Needs your review";
    case "interrupted":
      return "Interrupted";
    case "cancelled":
      return "Stopped";
    default:
      return card.state;
  }
}

export function renderStepper(
  s: PipelineState,
  opts: { selected?: string; onSelect(step: string): void }
): HTMLElement {
  const container = h("div", { class: "pipeline-stepper" });

  for (const card of s.cards) {
    const isSelected = opts.selected === card.step;
    const timeText = elapsed(card);

    const cardEl = h(
      "div",
      {
        class: `step-card step-card-${card.state}${isSelected ? " selected" : ""}`,
        "data-step": card.step,
        role: "button",
        tabindex: "0",
        onclick: () => opts.onSelect(card.step),
        onkeydown: (e: Event) => {
          const k = (e as KeyboardEvent).key;
          if (k === "Enter" || k === " ") {
            e.preventDefault();
            opts.onSelect(card.step);
          }
        },
      },
      h(
        "div",
        { class: "step-card-header" },
        h("span", { class: "step-card-label" }, STEP_LABELS[card.step] ?? card.step),
        timeText ? h("span", { class: "step-card-elapsed" }, timeText) : null
      ),
      h(
        "div",
        { class: "step-card-footer" },
        h("span", { class: `step-badge step-badge-${card.state}` }, badgeText(card))
      )
    );

    container.appendChild(cardEl);
  }

  return container;
}
