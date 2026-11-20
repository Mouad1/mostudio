import type { ProjectStatus, RunEvent, RunMode, WorkflowInfo } from "../../src/types.ts";
import type { Api } from "../lib/api.ts";
import { h, openDetailsKeys, restoreOpenDetails } from "../lib/dom.ts";
import { revealLabel } from "../lib/platform.ts";
import {
  applyEvent,
  initialState,
  reconcile,
  STEP_LABELS,
  type PipelineState,
  type StepCard,
} from "../lib/pipeline.ts";
import { previewsFor } from "../lib/previews.ts";
import {
  buildRunRequest,
  defaultSpokenLanguage,
  modeCopy,
  primaryAction,
  type SpokenLanguage,
} from "../lib/run.ts";
import { lockedWorkflowReason } from "../lib/studio.ts";
import { canAccept, gateNotes } from "../lib/verdicts.ts";
import { acceptedNote, checkFailedBox } from "./check-failed.ts";
import { errorBox } from "./error-box.ts";
import { renderPreview } from "./previews.ts";
import { badgeText, renderStepper } from "./stepper.ts";

export type StudioRunOptions = {
  api: Api;
  projectId: string;
  initialStatus: ProjectStatus;
  onStatusChange?: (status: ProjectStatus) => void;
  /** Start a new project (offered when this project's workflow can't be changed). */
  onNewProject?: () => void;
  /** Ticker period in ms (tests shorten it). */
  tickMs?: number;
};

/** While running, ask the server for the status every this many 1 s ticks. */
const STATUS_POLL_TICKS = 3;

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

/** A finished render is on disk: Render passed, or missed a check and the user kept it. */
function hasFinalRender(status: ProjectStatus): boolean {
  const a = status.steps?.assemble;
  return a?.status === "pass" || a?.accepted === true;
}

function computeDefaultStep(ps: PipelineState, status: ProjectStatus): string {
  const awaitingCard = ps.cards.find((c) => c.state === "awaiting");
  if (awaitingCard) return awaitingCard.step;

  const runningCard = ps.cards.find((c) => c.state === "running");
  if (runningCard) return runningCard.step;

  const failedCard = ps.cards.find((c) => c.state === "fail");
  if (failedCard) return failedCard.step;

  if (hasFinalRender(status)) return "assemble";

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
  // One workflow per project: locked once the project ran one (status.workflow can appear after a run).
  const isWorkflowLocked = (): boolean => Boolean(status.workflow);
  let selectedMode: RunMode = "manual";
  /**
   * The user's quick-setting picks. Until they pick, each setting shows what the next run uses:
   * the project's remembered params (workflow defaults + earlier runs, from the server's status).
   */
  const quickChoice: { lang?: string; pace?: string } = {};
  const remembered = (step: string, key: string): string => {
    const v = status.params?.[step]?.[key];
    return typeof v === "string" ? v : "";
  };
  const shownLang = (): string => quickChoice.lang ?? remembered("localize", "lang");
  const shownPace = (): string => quickChoice.pace ?? remembered("cut", "pace");
  /** The user's Spoken language pick; until they pick, it follows defaultSpokenLanguage. */
  let spokenChoice: SpokenLanguage | null = null;
  const spokenLanguage = (): SpokenLanguage =>
    spokenChoice ?? defaultSpokenLanguage(shownLang(), status.params);

  let pipelineState: PipelineState = initialState(DEFAULT_WORKFLOW, status);

  let selectedStep = computeDefaultStep(pipelineState, status);
  let replacementsText = "";
  let replacementsLoaded = false;
  let autoScrollLogs = true;
  /**
   * Rendered previews per step output version ("mix@<endedAt>"). The page redraws every second
   * while running and on every event: re-rendering would refetch each file (and the waveform).
   */
  const previewCache = new Map<string, HTMLElement>();
  let actionPending = false;
  /** The server's message when a button's request (run, approve, stop, fixes) was refused. */
  let actionError: string | null = null;

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
      selectedStep = computeDefaultStep(pipelineState, status);
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

  /**
   * Fetch the project status. Once the server says nothing runs, rebuild the pipeline from it so
   * the controls leave the running state even if the run-end event was missed.
   */
  async function refreshStatus(): Promise<void> {
    try {
      const updated = await api.get<ProjectStatus>(`/api/projects/${projectId}`);
      if (!mounted) return;
      status = updated;
      opts.onStatusChange?.(updated);
      if (!updated.running) {
        const wasRunning = pipelineState.running;
        pipelineState = reconcile(pipelineState, getActiveWorkflow(), updated);
        if (wasRunning) selectedStep = computeDefaultStep(pipelineState, updated);
      }
    } catch (err) {
      console.error("Failed to refresh project status:", err);
    }
  }

  async function onRunEvent(ev: RunEvent) {
    if (!mounted) return;
    pipelineState = applyEvent(pipelineState, ev);

    if (ev.type === "run-start") {
      selectedMode = ev.mode;
    } else if (ev.type === "step-start") {
      if (pipelineState.running) {
        selectedStep = ev.step;
      }
    } else if (ev.type === "run-end") {
      await refreshStatus();
      if (!mounted) return;
      if (ev.status === "awaiting-approval" && ev.stoppedAt) {
        selectedStep = ev.stoppedAt;
      } else if (ev.status === "failed" && ev.stoppedAt) {
        selectedStep = ev.stoppedAt;
      } else if (ev.status === "done") {
        selectedStep = "assemble";
      }
    }

    render();
  }

  // Subscribe once the workflow is known: loadWorkflows rebuilds the pipeline, which would
  // otherwise drop events (and the replayed history) that arrived before it finished.
  let unsubscribeEvents: () => void = () => {};
  void loadWorkflows().finally(() => {
    if (mounted) unsubscribeEvents = api.events(projectId, onRunEvent);
  });

  // While a run is going: re-render each second for the elapsed timers, and ask the server every
  // few seconds whether it is still running, in case the event stream dropped.
  let ticks = 0;
  const tickerInterval = setInterval(() => {
    if (!mounted || !pipelineState.running) return;
    ticks++;
    if (ticks % STATUS_POLL_TICKS === 0) {
      refreshStatus().then(render);
    } else {
      render();
    }
  }, opts.tickMs ?? 1000);
  tickerInterval.unref?.();

  function getActiveWorkflow(): WorkflowInfo {
    return (
      workflows.find((w) => w.name === selectedWorkflow) ||
      DEFAULT_WORKFLOW
    );
  }

  function handleSelectWorkflow(wfName: string) {
    if (isWorkflowLocked() || pipelineState.running) return;
    selectedWorkflow = wfName;
    const wf = getActiveWorkflow();
    pipelineState = initialState(wf, status);
    selectedStep = computeDefaultStep(pipelineState, status);
    render();
  }

  async function handleStart() {
    if (actionPending) return;
    actionPending = true;
    actionError = null;
    render();
    try {
      // Always send the latest upload (uploads[0], newest first): Import is cached by its inputs, so
      // re-sending the same file costs nothing, and a re-run without a source fails with "missing param".
      // No upload (media imported another way): the project's remembered source is used.
      const source = status.uploads?.[0] || undefined;
      const req = buildRunRequest({
        workflow: selectedWorkflow,
        mode: selectedMode,
        source,
        // Only what the user changed: the rest is already what the server will use.
        params: { localize: { lang: quickChoice.lang }, cut: { pace: quickChoice.pace } },
        spoken: spokenLanguage(),
      });
      const lastEventBefore = pipelineState.lastEventId;
      await api.send("POST", `/api/projects/${projectId}/run`, req);
      // Events come on their own connection and can beat this response: a run that fails at once
      // may already have sent run-end. Only assume "running" if no event has arrived yet.
      if (pipelineState.lastEventId === lastEventBefore) {
        pipelineState = { ...pipelineState, running: true, outcome: undefined, error: undefined };
      }
    } catch (err: any) {
      actionError = err?.message || String(err);
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
    actionError = null;
    render();
    try {
      await api.send("POST", `/api/projects/${projectId}/cancel`);
    } catch (err: any) {
      actionError = err?.message || String(err);
    } finally {
      actionPending = false;
      render();
    }
  }

  async function handleApprove(stepToApprove?: string) {
    if (actionPending) return;
    // Only a step the server marked as waiting for review can be approved.
    const step = stepToApprove ?? pipelineState.cards.find((c) => c.state === "awaiting")?.step;
    if (!step) {
      actionError = "Nothing is waiting for your review.";
      render();
      return;
    }
    await resume("approve", step);
  }

  /** Keep a result that missed a quality check and go on with the workflow. */
  async function handleAccept(step: string) {
    if (actionPending) return;
    await resume("accept", step);
  }

  /** Approve or accept `step`, then let the server continue the workflow. */
  async function resume(action: "approve" | "accept", step: string) {
    actionPending = true;
    actionError = null;
    render();
    try {
      const lastEventBefore = pipelineState.lastEventId;
      await api.send("POST", `/api/projects/${projectId}/${action}`, {
        step,
        continue: true,
        mode: selectedMode,
      });
      if (pipelineState.lastEventId === lastEventBefore) {
        pipelineState = { ...pipelineState, running: true, outcome: undefined, error: undefined };
      }
    } catch (err: any) {
      actionError = err?.message || String(err);
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
    actionError = null;
    render();
    try {
      await api.send("PUT", `/api/projects/${projectId}/replacements`, {
        text: replacementsText,
      });
      await api.send("POST", `/api/projects/${projectId}/rerun`, {
        step: "captions",
      });
    } catch (err: any) {
      actionError = err?.message || String(err);
    } finally {
      actionPending = false;
      render();
    }
  }

  function renderWorkflowPicker(): HTMLElement {
    const list = workflows.length > 0 ? workflows : [DEFAULT_WORKFLOW];
    const isLocked = isWorkflowLocked();
    let hasUnavailable = false;
    const cards = list.map((w) => {
      const isSelected = w.name === selectedWorkflow;
      // On a project that already ran a workflow, the other cards can't be picked: say why.
      const unavailable = isLocked && !isSelected;
      if (unavailable) hasUnavailable = true;
      const reasonId = `workflow-locked-reason-${w.name}`;

      return h(
        "div",
        {
          class: `workflow-card ${isSelected ? "selected active" : ""} ${isLocked ? "locked" : ""}`,
          "data-workflow": w.name,
          role: "button",
          tabindex: isLocked ? "-1" : "0",
          "aria-pressed": isSelected ? "true" : "false",
          "aria-disabled": unavailable ? "true" : undefined,
          "aria-describedby": unavailable ? reasonId : undefined,
          onClick: () => handleSelectWorkflow(w.name),
          onKeydown: ((evt: KeyboardEvent) => {
            if (evt.key === "Enter" || evt.key === " ") {
              evt.preventDefault();
              handleSelectWorkflow(w.name);
            }
          }) as EventListener,
        },
        h("div", { class: "workflow-card-header" },
          h("h4", { class: "workflow-card-title" }, w.title || w.name),
          isLocked && isSelected ? h("span", { class: "workflow-locked-label" }, "(locked)") : null
        ),
        h(
          "div",
          { class: "workflow-card-steps" },
          w.steps.map((s) => STEP_LABELS[s.step] || s.step).join(" → ")
        ),
        unavailable
          ? h(
              "p",
              { class: "workflow-card-locked-reason", id: reasonId },
              lockedWorkflowReason(selectedWorkflow, w.name)
            )
          : null
      );
    });

    const newProjectAction =
      hasUnavailable && opts.onNewProject
        ? h(
            "div",
            { class: "workflow-locked-actions" },
            h(
              "button",
              {
                type: "button",
                class: "btn btn-secondary btn-new-project",
                onClick: () => opts.onNewProject?.(),
              },
              "New project"
            )
          )
        : null;

    return h(
      "div",
      { class: `studio-section workflow-picker ${isLocked ? "workflow-picker-locked" : ""}` },
      h("h3", { class: "studio-section-title" }, "What are you making?"),
      h("div", { class: "workflow-cards-grid" }, ...cards),
      newProjectAction
    );
  }

  function renderQuickParams(): HTMLElement {
    const langSelect = h(
      "select",
      {
        id: "studio-param-lang",
        class: "param-select select-lang",
        disabled: pipelineState.running,
        onChange: ((evt: Event) => {
          quickChoice.lang = (evt.target as HTMLSelectElement).value;
          // Arabizi subtitles change the default Spoken language: redraw it.
          render();
        }) as EventListener,
      },
      h("option", { value: "" }, "Default"),
      h("option", { value: "arabizi" }, "Arabizi (Darija)"),
      h("option", { value: "fr" }, "French"),
      h("option", { value: "en" }, "English")
    );
    langSelect.value = shownLang();

    const paceSelect = h(
      "select",
      {
        id: "studio-param-pace",
        class: "param-select select-pace",
        disabled: pipelineState.running,
        onChange: ((evt: Event) => {
          quickChoice.pace = (evt.target as HTMLSelectElement).value;
        }) as EventListener,
      },
      h("option", { value: "" }, "Default"),
      h("option", { value: "natural" }, "Natural"),
      h("option", { value: "tight" }, "Tight")
    );
    paceSelect.value = shownPace();

    const spokenSelect = h(
      "select",
      {
        id: "studio-param-spoken",
        class: "param-select select-spoken",
        disabled: pipelineState.running,
        "aria-describedby": "studio-param-spoken-help",
        onChange: ((evt: Event) => {
          spokenChoice = (evt.target as HTMLSelectElement).value === "darija" ? "darija" : "auto";
        }) as EventListener,
      },
      h("option", { value: "darija" }, "Darija (Moroccan)"),
      h("option", { value: "auto" }, "Auto-detect")
    );
    spokenSelect.value = spokenLanguage();

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
          h("label", { class: "param-label", for: "studio-param-spoken" }, "Spoken language"),
          spokenSelect,
          h(
            "p",
            { class: "param-help", id: "studio-param-spoken-help" },
            "Darija keeps the words as spoken instead of turning them into formal Arabic."
          )
        ),
        h(
          "div",
          { class: "param-group" },
          h("label", { class: "param-label", for: "studio-param-lang" }, "Subtitles language"),
          langSelect
        ),
        h(
          "div",
          { class: "param-group" },
          h("label", { class: "param-label", for: "studio-param-pace" }, "Pace"),
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
      const choose = () => {
        if (!pipelineState.running) {
          selectedMode = m;
          render();
        }
      };

      return h(
        "div",
        {
          class: `mode-card ${isSelected ? "selected active" : ""}`,
          "data-mode": m,
          role: "button",
          tabindex: pipelineState.running ? "-1" : "0",
          "aria-pressed": isSelected ? "true" : "false",
          "aria-disabled": pipelineState.running ? "true" : undefined,
          onClick: choose,
          onKeydown: ((evt: KeyboardEvent) => {
            if (evt.key === "Enter" || evt.key === " ") {
              evt.preventDefault();
              choose();
            }
          }) as EventListener,
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
      case "retry":
        btnText = "Retry";
        btnClass = "btn btn-primary btn-run-retry";
        btnAction = handleStart;
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

    return h(
      "div",
      { class: "studio-run-actions" },
      btn,
      actionError
        ? h(
            "div",
            { class: "error-box run-action-error", role: "alert" },
            h("h3", { class: "error-title" }, "That didn't work"),
            h("p", { class: "error-advice" }, actionError)
          )
        : null
    );
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
        card ? h("span", { class: `step-badge step-badge-${card.state}` }, badgeText(card)) : null
      )
    );

    // Error box if failed
    if (pipelineState.error && (card?.state === "fail" || pipelineState.outcome === "failed")) {
      panel.appendChild(errorBox(pipelineState.error));
    } else if (card?.result?.error) {
      panel.appendChild(errorBox(card.result.error));
    }

    // A missed must-pass check: what failed, what to do, Continue anyway. Kept results say so.
    const result = card?.result;
    const notes = gateNotes(result);
    if (card && result && card.state === "fail" && !pipelineState.running && canAccept(result)) {
      panel.appendChild(checkFailedBox(result, { pending: actionPending, onAccept: () => handleAccept(card.step) }));
    } else if (card?.state === "accepted" && result) {
      panel.appendChild(acceptedNote(result));
    } else if (notes.length > 0) {
      // "Done with warnings" / "Failed" checks, in plain words.
      panel.appendChild(
        h(
          "div",
          { class: "step-gate-notes" },
          h("h4", { class: "step-gate-notes-title" }, "What to check"),
          h(
            "ul",
            { class: "step-gate-notes-list" },
            ...notes.map((n) => h("li", { class: `step-gate-note step-gate-note-${n.level}` }, n.text))
          )
        )
      );
    }

    // Previews container. A step waiting or running in this run has no new output yet: what is on
    // disk is the previous run's (or is being rewritten), so show nothing until it finishes.
    const outputPending = card?.state === "idle" || card?.state === "running";
    const previews = outputPending ? [] : previewsFor(currentStep, status);
    if (previews.length > 0) {
      // A new result of the step (it ran again) is a new version: fetch its outputs once more.
      const version = card?.result?.endedAt ?? status.steps[currentStep]?.endedAt ?? "";
      const key = `${currentStep}@${version}`;
      let previewsContainer = previewCache.get(key);
      if (!previewsContainer) {
        for (const k of previewCache.keys()) {
          if (k.startsWith(`${currentStep}@`)) previewCache.delete(k);
        }
        const fresh = h("div", { class: "step-previews-container" });
        previewCache.set(key, fresh);
        for (const p of previews) {
          renderPreview(p, api, projectId).then((el) => {
            if (mounted) fresh.appendChild(el);
          });
        }
        previewsContainer = fresh;
      }
      panel.appendChild(previewsContainer);
    }

    // Captions review editor once the captions step has made captions
    if (currentStep === "captions" && card?.result && card.result.status !== "fail") {
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

      // Approve only when the server says the captions wait for review.
      const approveCaptionsBtn =
        card?.state === "awaiting"
          ? h(
              "button",
              {
                type: "button",
                class: "btn btn-primary btn-approve-captions",
                disabled: actionPending,
                onClick: () => handleApprove("captions"),
              },
              "Approve & continue"
            )
          : null;

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
    const hasFinal = hasFinalRender(status);
    // A workflow run is re-making the video: the render on disk is the previous version.
    const remaking = pipelineState.running && pipelineState.runKind !== "step";
    if (remaking && !hasFinal) return null;
    if (!remaking && pipelineState.outcome !== "done" && !hasFinal) return null;

    const finalVideoUrl = api.fileUrl(projectId, "renders/final.mp4");
    const video = h("video", {
      class: `final-video-player${remaking ? " final-video-previous" : ""}`,
      controls: true,
      src: finalVideoUrl,
    });

    if (remaking) {
      return h(
        "div",
        { class: "studio-section studio-done-section studio-done-remaking" },
        h("h3", { class: "studio-section-title" }, "Making your video again…"),
        h(
          "p",
          { class: "final-video-note" },
          "The new version appears here when Render and Check finish."
        ),
        h(
          "div",
          { class: "final-video-wrapper" },
          h("span", { class: "final-video-previous-label" }, "Previous version"),
          video
        )
      );
    }

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
      revealLabel()
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

    // Re-renders (the 1 s ticker, events) must not close a Details panel the user opened.
    const openDetails = openDetailsKeys(container);
    container.replaceChildren(...children);
    restoreOpenDetails(container, openDetails);
  }

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
