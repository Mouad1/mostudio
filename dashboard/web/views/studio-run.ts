import type { ProjectStatus, RunEvent, RunMode, WorkflowInfo } from "../../src/types.ts";
import type { Api } from "../lib/api.ts";
import { h } from "../lib/dom.ts";
import {
  applyEvent,
  initialState,
  STEP_LABELS,
  type PipelineState,
  type StepCard,
} from "../lib/pipeline.ts";
import { previewsFor } from "../lib/previews.ts";
import { buildRunRequest, modeCopy, primaryAction } from "../lib/run.ts";
import { errorBox } from "./error-box.ts";
import { renderPreview } from "./previews.ts";
import { renderStepper } from "./stepper.ts";

export type StudioRunOptions = {
  api: Api;
  projectId: string;
  initialStatus: ProjectStatus;
  onStatusChange?: (status: ProjectStatus) => void;
};

const DEFAULT_WORKFLOW: WorkflowInfo = {
  name: "short",
  title: "Short clip",
  steps: [
    { step: "ingest", approve: false },
    { step: "transcribe", approve: false },
    { step: "cut", approve: false },
    { step: "localize", approve: false },
    { step: "captions", approve: true },
    { step: "mix", approve: false },
    { step: "assemble", approve: false },
    { step: "qa", approve: false },
  ],
};

function computeDefaultStep(ps: PipelineState, status: ProjectStatus): string {
  const awaitingCard = ps.cards.find((c) => c.state === "awaiting");
  if (awaitingCard) return awaitingCard.step;

  const runningCard = ps.cards.find((c) => c.state === "running");
  if (runningCard) return runningCard.step;

  const failedCard = ps.cards.find((c) => c.state === "fail");
  if (failedCard) return failedCard.step;

  if (status.steps?.assemble?.status === "pass") return "assemble";

  const passedCards = ps.cards.filter(
    (c) => c.state === "pass" || c.state === "warn" || c.state === "cached"
  );
  if (passedCards.length > 0) return passedCards[passedCards.length - 1]!.step;

  return ps.cards[0]?.step ?? "ingest";
}

export function mountStudioRun(container: HTMLElement, opts: StudioRunOptions): () => void {
  const { api, projectId } = opts;
  let mounted = true;
  let status: ProjectStatus = opts.initialStatus;
  let workflows: WorkflowInfo[] = [];
  let selectedWorkflow = status.workflow || "short";
  const isWorkflowLocked = Boolean(status.workflow);
  let selectedMode: RunMode = "manual";
  const quickParams = {
    localize: { lang: "" },
    cut: { pace: "" },
  };

  let pipelineState: PipelineState = initialState(DEFAULT_WORKFLOW, status);
  if (status.pending && status.pending.length > 0) {
    pipelineState.outcome = "awaiting-approval";
  } else if (!status.running && status.steps?.assemble?.status === "pass") {
    pipelineState.outcome = "done";
  } else if (!status.running && Object.values(status.steps || {}).some((s) => s.status === "fail")) {
    pipelineState.outcome = "failed";
  }

  let selectedStep = computeDefaultStep(pipelineState, status);
  let replacementsText = "";
  let replacementsLoaded = false;
  let autoScrollLogs = true;
  let actionPending = false;

  async function loadWorkflows() {
    try {
      const res = await api.get<{ workflows: WorkflowInfo[] }>("/api/workflows");
      if (!mounted) return;
      workflows = res.workflows || [];
      const currentWf =
        workflows.find((w) => w.name === selectedWorkflow) ||
        workflows[0] ||
        DEFAULT_WORKFLOW;

      if (!status.workflow && !selectedWorkflow && workflows[0]) {
        selectedWorkflow = workflows[0].name;
      }

      pipelineState = initialState(currentWf, status);
      if (status.pending && status.pending.length > 0) {
        pipelineState.outcome = "awaiting-approval";
      } else if (!status.running && status.steps?.assemble?.status === "pass") {
        pipelineState.outcome = "done";
      } else if (!status.running && Object.values(status.steps || {}).some((s) => s.status === "fail")) {
        pipelineState.outcome = "failed";
      }
      render();
    } catch (err) {
      console.error("Failed to load workflows:", err);
    }
  }

  async function loadReplacements() {
    if (replacementsLoaded) return;
    try {
      const res = await api.get<{ text?: string }>(`/api/projects/${projectId}/replacements`);
      if (!mounted) return;
      replacementsText = res?.text ?? "";
      replacementsLoaded = true;
      render();
    } catch {}
  }

  const unsubscribeEvents = api.events(projectId, async (ev: RunEvent) => {
    if (!mounted) return;
    pipelineState = applyEvent(pipelineState, ev);

    if (ev.type === "run-start") {
      selectedMode = ev.mode;
    } else if (ev.type === "step-start") {
      if (pipelineState.running) {
        selectedStep = ev.step;
      }
    } else if (ev.type === "run-end") {
      try {
        const updated = await api.get<ProjectStatus>(`/api/projects/${projectId}`);
        if (!mounted) return;
        status = updated;
        opts.onStatusChange?.(updated);
      } catch (err) {
        console.error("Failed to refetch status on run-end:", err);
      }
      if (ev.status === "awaiting-approval" && ev.stoppedAt) {
        selectedStep = ev.stoppedAt;
      } else if (ev.status === "done") {
        selectedStep = "assemble";
      }
    }

    render();
  });

  const tickerInterval = setInterval(() => {
    if (mounted && pipelineState.running) {
      render();
    }
  }, 1000);
  tickerInterval.unref?.();

  function getActiveWorkflow(): WorkflowInfo {
    return (
      workflows.find((w) => w.name === selectedWorkflow) ||
      DEFAULT_WORKFLOW
    );
  }

  function handleSelectWorkflow(wfName: string) {
    if (isWorkflowLocked || pipelineState.running) return;
    selectedWorkflow = wfName;
    const wf = getActiveWorkflow();
    pipelineState = initialState(wf, status);
    selectedStep = computeDefaultStep(pipelineState, status);
    render();
  }

  async function handleStart() {
    if (actionPending) return;
    actionPending = true;
    render();
    try {
      const source = status.media?.file
        ? undefined
        : status.uploads?.[0] || undefined;
      const req = buildRunRequest({
        workflow: selectedWorkflow,
        mode: selectedMode,
        source,
        params: quickParams,
      });
      await api.send("POST", `/api/projects/${projectId}/run`, req);
      pipelineState.running = true;
    } catch (err: any) {
      pipelineState.error = err?.message || String(err);
    } finally {
      actionPending = false;
      render();
    }
  }

  async function handleStop() {
    if (actionPending) return;
    const confirmed =
      typeof window !== "undefined" && window.confirm
        ? window.confirm("Stop this run? Finished steps are kept.")
        : true;
    if (!confirmed) return;

    actionPending = true;
    render();
    try {
      await api.send("POST", `/api/projects/${projectId}/cancel`);
    } catch (err: any) {
      pipelineState.error = err?.message || String(err);
    } finally {
      actionPending = false;
      render();
    }
  }

  async function handleApprove(stepToApprove?: string) {
    if (actionPending) return;
    actionPending = true;
    render();
    try {
      const step =
        stepToApprove ||
        pipelineState.cards.find((c) => c.state === "awaiting")?.step ||
        selectedStep ||
        "captions";
      await api.send("POST", `/api/projects/${projectId}/approve`, {
        step,
        continue: true,
        mode: selectedMode,
      });
    } catch (err: any) {
      pipelineState.error = err?.message || String(err);
    } finally {
      actionPending = false;
      render();
    }
  }

  async function handleApplyFixes() {
    if (actionPending) return;
    const textareaEl = container.querySelector("textarea") as HTMLTextAreaElement | null;
    if (textareaEl && typeof textareaEl.value === "string") {
      replacementsText = textareaEl.value;
    }
    actionPending = true;
    render();
    try {
      await api.send("PUT", `/api/projects/${projectId}/replacements`, {
        text: replacementsText,
      });
      await api.send("POST", `/api/projects/${projectId}/rerun`, {
        step: "captions",
      });
    } catch (err: any) {
      pipelineState.error = err?.message || String(err);
    } finally {
      actionPending = false;
      render();
    }
  }

  function renderWorkflowPicker(): HTMLElement {
    const list = workflows.length > 0 ? workflows : [DEFAULT_WORKFLOW];
    const cards = list.map((w) => {
      const isSelected = w.name === selectedWorkflow;
      const isLocked = isWorkflowLocked;

      return h(
        "div",
        {
          class: `workflow-card ${isSelected ? "selected active" : ""} ${isLocked ? "locked" : ""}`,
          "data-workflow": w.name,
          role: "button",
          tabindex: isLocked ? "-1" : "0",
          onClick: () => handleSelectWorkflow(w.name),
        },
        h("div", { class: "workflow-card-header" },
          h("h4", { class: "workflow-card-title" }, w.title || w.name),
          isLocked && isSelected ? h("span", { class: "workflow-locked-label" }, "(locked)") : null
        ),
        h(
          "div",
          { class: "workflow-card-steps" },
          w.steps.map((s) => STEP_LABELS[s.step] || s.step).join(" → ")
        )
      );
    });

    return h(
      "div",
      { class: `studio-section workflow-picker ${isWorkflowLocked ? "workflow-picker-locked" : ""}` },
      h("h3", { class: "studio-section-title" }, "What are you making?"),
      h("div", { class: "workflow-cards-grid" }, ...cards)
    );
  }

  function renderQuickParams(): HTMLElement {
    const langSelect = h(
      "select",
      {
        class: "param-select select-lang",
        disabled: pipelineState.running,
        onChange: ((evt: Event) => {
          quickParams.localize.lang = (evt.target as HTMLSelectElement).value;
        }) as EventListener,
      },
      h("option", { value: "" }, "Default"),
      h("option", { value: "arabizi" }, "Arabizi (Darija)"),
      h("option", { value: "fr" }, "French"),
      h("option", { value: "en" }, "English")
    );
    if (quickParams.localize.lang) {
      langSelect.value = quickParams.localize.lang;
    }

    const paceSelect = h(
      "select",
      {
        class: "param-select select-pace",
        disabled: pipelineState.running,
        onChange: ((evt: Event) => {
          quickParams.cut.pace = (evt.target as HTMLSelectElement).value;
        }) as EventListener,
      },
      h("option", { value: "" }, "Default (natural)"),
      h("option", { value: "natural" }, "Natural"),
      h("option", { value: "tight" }, "Tight")
    );
    if (quickParams.cut.pace) {
      paceSelect.value = quickParams.cut.pace;
    }

    return h(
      "div",
      { class: "studio-section studio-quick-params" },
      h("h3", { class: "studio-section-title" }, "Quick settings"),
      h(
        "div",
        { class: "params-row" },
        h(
          "div",
          { class: "param-group" },
          h("label", { class: "param-label" }, "Subtitles language"),
          langSelect
        ),
        h(
          "div",
          { class: "param-group" },
          h("label", { class: "param-label" }, "Pace"),
          paceSelect
        )
      )
    );
  }

  function renderModePicker(): HTMLElement {
    const modes: RunMode[] = ["manual", "auto"];

    const cards = modes.map((m) => {
      const copy = modeCopy(m);
      const isSelected = selectedMode === m;

      return h(
        "div",
        {
          class: `mode-card ${isSelected ? "selected active" : ""}`,
          "data-mode": m,
          role: "button",
          tabindex: pipelineState.running ? "-1" : "0",
          onClick: () => {
            if (!pipelineState.running) {
              selectedMode = m;
              render();
            }
          },
        },
        h("div", { class: "mode-card-title" }, copy.title),
        h("div", { class: "mode-card-help" }, copy.help)
      );
    });

    return h(
      "div",
      { class: "studio-section studio-mode-picker" },
      h("h3", { class: "studio-section-title" }, "Review mode"),
      h("div", { class: "mode-cards-grid" }, ...cards)
    );
  }

  function renderPrimaryButton(): HTMLElement {
    const hasSource = Boolean(
      status.media?.file || (status.uploads && status.uploads.length > 0)
    );
    const action = primaryAction(pipelineState, hasSource);

    let btnText = "Make my video";
    let btnClass = "btn btn-primary btn-run-primary";
    let btnAction = handleStart;
    let isDisabled = actionPending;

    switch (action) {
      case "start":
        btnText = "Make my video";
        btnClass = "btn btn-primary btn-run-primary";
        btnAction = handleStart;
        break;
      case "stop":
        btnText = "Stop";
        btnClass = "btn btn-danger btn-run-stop";
        btnAction = handleStop;
        break;
      case "continue":
        btnText = "Approve & continue";
        btnClass = "btn btn-primary btn-run-approve";
        btnAction = () => handleApprove();
        break;
      case "start-over":
        btnText = "Make it again";
        btnClass = "btn btn-secondary btn-run-start-over";
        btnAction = handleStart;
        break;
      case "none":
        btnText = "Make my video";
        btnClass = "btn btn-primary btn-run-primary";
        isDisabled = true;
        break;
    }

    const btn = h(
      "button",
      {
        type: "button",
        class: btnClass,
        disabled: isDisabled,
        onClick: btnAction,
      },
      actionPending ? "Working…" : btnText
    );

    return h("div", { class: "studio-run-actions" }, btn);
  }

  function renderSelectedStepDetail(): HTMLElement {
    const card =
      pipelineState.cards.find((c) => c.step === selectedStep) ||
      pipelineState.cards[0];
    const currentStep = card?.step ?? selectedStep;

    const panel = h(
      "div",
      { class: "step-detail-panel", "data-step": currentStep },
      h(
        "div",
        { class: "step-detail-header" },
        h("h3", { class: "step-detail-title" }, STEP_LABELS[currentStep] || currentStep),
        card ? h("span", { class: `step-badge step-badge-${card.state}` }, card.state) : null
      )
    );

    // Error box if failed
    if (pipelineState.error && (card?.state === "fail" || pipelineState.outcome === "failed")) {
      panel.appendChild(errorBox(pipelineState.error));
    } else if (card?.result?.error) {
      panel.appendChild(errorBox(card.result.error));
    }

    // Previews container
    const previews = previewsFor(currentStep, status);
    if (previews.length > 0) {
      const previewsContainer = h("div", { class: "step-previews-container" });
      panel.appendChild(previewsContainer);
      for (const p of previews) {
        renderPreview(p, api, projectId).then((el) => {
          if (mounted) previewsContainer.appendChild(el);
        });
      }
    }

    // Captions review editor if captions step
    if (currentStep === "captions") {
      loadReplacements();

      const textarea = h("textarea", {
        class: "replacements-textarea",
        placeholder: "One fix per line: wrong => right",
        rows: "4",
        onInput: ((evt: Event) => {
          replacementsText = (evt.target as HTMLTextAreaElement).value;
        }) as EventListener,
      });
      textarea.value = replacementsText;

      const applyFixesBtn = h(
        "button",
        {
          type: "button",
          class: "btn btn-secondary btn-apply-fixes",
          disabled: actionPending,
          onClick: handleApplyFixes,
        },
        "Apply fixes"
      );

      const approveCaptionsBtn = h(
        "button",
        {
          type: "button",
          class: "btn btn-primary btn-approve-captions",
          disabled: actionPending,
          onClick: () => handleApprove("captions"),
        },
        "Approve & continue"
      );

      const captionsEditor = h(
        "div",
        { class: "captions-review-editor" },
        h("h4", { class: "editor-title" }, "Fix words"),
        h("p", { class: "editor-help" }, "Correct any misspelled words before final rendering:"),
        textarea,
        h("div", { class: "editor-actions" }, applyFixesBtn, approveCaptionsBtn)
      );

      panel.appendChild(captionsEditor);
    }

    // Step logs
    const logs = card?.logs ?? [];
    const logViewer = h("div", {
      class: "step-logs-viewer",
      onScroll: ((evt: Event) => {
        const el = evt.target as HTMLElement;
        if (el.scrollHeight && el.clientHeight) {
          const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 20;
          autoScrollLogs = atBottom;
        }
      }) as EventListener,
    });

    if (logs.length > 0) {
      for (const line of logs) {
        logViewer.appendChild(h("div", { class: "step-log-line" }, line));
      }
    } else {
      logViewer.appendChild(
        h("div", { class: "step-logs-empty" }, "No logs for this step yet.")
      );
    }

    panel.appendChild(
      h(
        "div",
        { class: "step-logs-section" },
        h("h4", { class: "logs-title" }, "Step logs"),
        logViewer
      )
    );

    // Auto-scroll logs
    if (autoScrollLogs && logViewer.scrollHeight) {
      logViewer.scrollTop = logViewer.scrollHeight;
    }

    return panel;
  }

  function renderDoneSection(): HTMLElement | null {
    const isDone =
      pipelineState.outcome === "done" ||
      status.steps?.assemble?.status === "pass";
    if (!isDone) return null;

    const finalVideoUrl = api.fileUrl(projectId, "renders/final.mp4");
    const video = h("video", {
      class: "final-video-player",
      controls: true,
      src: finalVideoUrl,
    });

    const finderBtn = h(
      "button",
      {
        type: "button",
        class: "btn btn-secondary btn-finder",
        onClick: async () => {
          try {
            await api.send("POST", "/api/show-in-finder", {
              path: "renders/final.mp4",
              projectId,
            });
          } catch (err) {
            console.error("Failed to show in finder:", err);
          }
        },
      },
      "Show in Finder"
    );

    return h(
      "div",
      { class: "studio-section studio-done-section" },
      h("h3", { class: "studio-section-title" }, "Your video is ready!"),
      h("div", { class: "final-video-wrapper" }, video),
      h("div", { class: "final-video-toolbar" }, finderBtn)
    );
  }

  function render() {
    if (!mounted) return;

    const stepper = renderStepper(pipelineState, {
      selected: selectedStep,
      onSelect: (st) => {
        selectedStep = st;
        render();
      },
    });

    const doneSection = renderDoneSection();

    const children = [
      renderWorkflowPicker(),
      renderQuickParams(),
      renderModePicker(),
      renderPrimaryButton(),
      stepper,
      doneSection,
      renderSelectedStepDetail(),
    ].filter((c): c is HTMLElement => c !== null);

    container.replaceChildren(...children);
  }

  loadWorkflows();
  render();

  return () => {
    mounted = false;
    unsubscribeEvents();
    clearInterval(tickerInterval);
    container.replaceChildren();
  };
}

export function renderStudioRun(opts: StudioRunOptions): {
  element: HTMLElement;
  destroy(): void;
} {
  const element = h("div", { class: "studio-run-view" });
  const destroy = mountStudioRun(element, opts);
  return { element, destroy };
}
