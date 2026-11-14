import type { ScaffoldEntry } from "../../../core/src/index.ts";
import type { ProbeResult, SetupState } from "../../src/types.ts";
import type { Api } from "../lib/api.ts";
import { h } from "../lib/dom.ts";
import { checkRows, nextSetupStep, type SetupStepId } from "../lib/setup.ts";
import { errorBox } from "./error-box.ts";

export function mount(root: HTMLElement, api: Api): () => void {
  let mounted = true;
  let state: SetupState | null = null;
  let currentStep: SetupStepId = "folder";
  let createdEntries: ScaffoldEntry[] = [];
  let groqKeyInput = "";
  let laterNotice: string | null = null;
  let testResult: { ok: boolean; message: string } | null = null;
  let formError: string | null = null;
  let isWorking = false;

  async function loadInitial() {
    try {
      const res = await api.get<SetupState>("/api/setup");
      if (!mounted) return;
      state = res;
      currentStep = nextSetupStep(res);
      render();
    } catch (err: any) {
      if (!mounted) return;
      root.replaceChildren(errorBox(err?.message || "Failed to load setup state"));
    }
  }

  function render() {
    if (!mounted || !state) return;

    let content: HTMLElement;

    switch (currentStep) {
      case "folder":
        content = renderFolderStep(state);
        break;
      case "check":
        content = renderCheckStep(state);
        break;
      case "key":
        content = renderKeyStep(state);
        break;
      case "done":
        content = renderDoneStep();
        break;
    }

    const container = h(
      "div",
      { class: "setup-container" },
      renderProgress(currentStep),
      content
    );

    root.replaceChildren(container);
  }

  function renderProgress(active: SetupStepId): HTMLElement {
    const steps: { id: SetupStepId; label: string }[] = [
      { id: "folder", label: "Folder" },
      { id: "check", label: "System" },
      { id: "key", label: "AI Key" },
      { id: "done", label: "Ready" },
    ];

    const stepEls = steps.map((s, idx) => {
      const isActive = s.id === active;
      return h(
        "div",
        {
          class: `setup-progress-step ${isActive ? "active" : ""}`,
        },
        h("span", { class: "step-number" }, String(idx + 1)),
        h("span", { class: "step-label" }, s.label)
      );
    });

    return h("div", { class: "setup-progress" }, ...stepEls);
  }

  function renderFolderStep(s: SetupState): HTMLElement {
    const errorEl = formError
      ? h("div", { class: "setup-error", role: "alert" }, formError)
      : null;

    if (createdEntries.length > 0) {
      const entryList = createdEntries.map((e) =>
        h(
          "div",
          { class: "setup-entry-row" },
          h("div", { class: "entry-path" }, e.path),
          h(
            "button",
            {
              class: "btn-secondary btn-finder",
              onclick: async () => {
                try {
                  await api.send("POST", "/api/show-in-finder", { path: e.path });
                } catch (err: any) {
                  formError = err?.message || "Failed to open folder";
                  render();
                }
              },
            },
            "Show in Finder"
          )
        )
      );

      return h(
        "div",
        { class: "setup-card" },
        h("h1", { class: "setup-heading" }, "Where should mostudio keep your videos?"),
        h("p", { class: "setup-subheading" }, "Workspace folders created:"),
        h("div", { class: "setup-entries-list" }, ...entryList),
        errorEl,
        h(
          "div",
          { class: "setup-actions" },
          h(
            "button",
            {
              class: "btn-primary",
              onclick: () => {
                formError = null;
                currentStep = "check";
                render();
              },
            },
            "Continue"
          )
        )
      );
    }

    const input = h("input", {
      type: "text",
      class: "setup-input",
      value: s.suggestedWorkspace,
      placeholder: s.suggestedWorkspace,
      disabled: isWorking,
    }) as HTMLInputElement;

    input.value = s.suggestedWorkspace;

    input.addEventListener("input", () => {
      formError = null;
    });

    const submitBtn = h(
      "button",
      {
        class: "btn-primary",
        disabled: isWorking,
        onclick: async () => {
          const val = input.value.trim();
          if (!val) {
            formError = "Please specify a folder path";
            render();
            return;
          }
          isWorking = true;
          formError = null;
          render();
          try {
            const res = await api.send<{ entries: ScaffoldEntry[]; state: SetupState }>(
              "POST",
              "/api/setup/workspace",
              { path: val }
            );
            isWorking = false;
            createdEntries = res.entries || [];
            if (res.state) {
              state = res.state;
            } else if (state) {
              state.workspace = val;
            }
            render();
          } catch (err: any) {
            isWorking = false;
            formError = err?.message || "Failed to configure workspace";
            render();
          }
        },
      },
      isWorking ? "Configuring..." : "Use this folder"
    );

    return h(
      "div",
      { class: "setup-card" },
      h("h1", { class: "setup-heading" }, "Where should mostudio keep your videos?"),
      h(
        "p",
        { class: "setup-subheading" },
        "mostudio will organize projects, raw media, and exports here."
      ),
      h("div", { class: "setup-form-group" }, input),
      errorEl,
      h("div", { class: "setup-actions" }, submitBtn)
    );
  }

  function renderCheckStep(s: SetupState): HTMLElement {
    const rows = checkRows(s.checks);
    const hasRequiredFail = s.checks.some((c) => c.required && !c.ok);

    const checkList = rows.map((r) => {
      return h(
        "div",
        {
          class: `setup-check-row ${r.ok ? "ok" : r.required ? "fail" : "optional"}`,
        },
        h(
          "div",
          { class: "check-title-bar" },
          h("span", { class: "check-status-badge" }, r.ok ? "✓" : "✗"),
          h("strong", { class: "check-label" }, r.label),
          !r.required
            ? h("span", { class: "check-tag-optional" }, "Optional")
            : null
        ),
        h("div", { class: "check-detail-text" }, r.text)
      );
    });

    const blockMsg = hasRequiredFail
      ? h(
          "div",
          { class: "setup-block-alert" },
          "Please fix required dependencies above before proceeding."
        )
      : null;

    const continueBtn = h(
      "button",
      {
        class: "btn-primary",
        disabled: hasRequiredFail,
        onclick: () => {
          if (!hasRequiredFail) {
            currentStep = "key";
            render();
          }
        },
      },
      "Continue"
    );

    return h(
      "div",
      { class: "setup-card" },
      h("h1", { class: "setup-heading" }, "Checking your Mac"),
      h("div", { class: "setup-checks-list" }, ...checkList),
      blockMsg,
      h("div", { class: "setup-actions" }, continueBtn)
    );
  }

  function renderKeyStep(_s: SetupState): HTMLElement {
    const errorEl = formError
      ? h("div", { class: "setup-error", role: "alert" }, formError)
      : null;

    const testResultEl = testResult
      ? h(
          "div",
          { class: `setup-probe-result ${testResult.ok ? "probe-ok" : "probe-fail"}` },
          testResult.message
        )
      : null;

    const keyInput = h("input", {
      type: "password",
      class: "setup-input",
      placeholder: "gsk_...",
      value: groqKeyInput,
      disabled: isWorking,
    }) as HTMLInputElement;

    keyInput.value = groqKeyInput;

    keyInput.addEventListener("input", (e: any) => {
      groqKeyInput = e.target.value;
      testResult = null;
      formError = null;
    });

    const testBtn = h(
      "button",
      {
        class: "btn-secondary",
        disabled: isWorking,
        onclick: async () => {
          const val = (keyInput.value || groqKeyInput).trim();
          if (!val) {
            formError = "Please enter an API key to test";
            render();
            return;
          }
          groqKeyInput = val;
          isWorking = true;
          testResult = null;
          formError = null;
          render();
          try {
            const probe = await api.send<ProbeResult>("POST", "/api/settings/test", {
              provider: "groq",
              values: { GROQ_API_KEY: val },
            });
            isWorking = false;
            testResult = {
              ok: probe.ok,
              message: probe.message || (probe.ok ? `Key valid (${probe.ms}ms)` : "Key test failed"),
            };
            render();
          } catch (err: any) {
            isWorking = false;
            testResult = { ok: false, message: err?.message || "Test request failed" };
            render();
          }
        },
      },
      isWorking ? "Testing..." : "Test"
    );

    const saveBtn = h(
      "button",
      {
        class: "btn-primary",
        disabled: isWorking,
        onclick: async () => {
          const val = (keyInput.value || groqKeyInput).trim();
          if (!val) {
            formError = "Please enter an API key to save";
            render();
            return;
          }
          groqKeyInput = val;
          isWorking = true;
          formError = null;
          render();
          try {
            await api.send("PUT", "/api/settings", {
              values: { GROQ_API_KEY: val },
            });
            isWorking = false;
            if (state) state.hasAiKey = true;
            currentStep = "done";
            render();
          } catch (err: any) {
            isWorking = false;
            formError = err?.message || "Failed to save settings";
            render();
          }
        },
      },
      isWorking ? "Saving..." : "Save"
    );

    const laterLink = h(
      "button",
      {
        class: "btn-link setup-later-link",
        onclick: () => {
          laterNotice = "Transcription won't work until you add a key.";
          currentStep = "done";
          render();
        },
      },
      "I'll do this later"
    );

    return h(
      "div",
      { class: "setup-card" },
      h("h1", { class: "setup-heading" }, "Add your free Groq key"),
      h(
        "div",
        { class: "setup-instructions" },
        h("p", {}, "1. Open console.groq.com/keys and sign in."),
        h("p", {}, "2. Create a key and copy it."),
        h("p", {}, "3. Paste it here.")
      ),
      h("div", { class: "setup-form-group" }, keyInput),
      testResultEl,
      errorEl,
      h(
        "div",
        { class: "setup-actions" },
        testBtn,
        saveBtn,
        laterLink
      )
    );
  }

  function renderDoneStep(): HTMLElement {
    const warningEl = laterNotice
      ? h("div", { class: "setup-notice warning", role: "alert" }, laterNotice)
      : null;

    const makeBtn = h(
      "button",
      {
        class: "btn-primary btn-large",
        onclick: () => {
          if (typeof window !== "undefined") {
            window.location.hash = "#studio";
          }
        },
      },
      "Make my first video"
    );

    return h(
      "div",
      { class: "setup-card ready-card" },
      h("h1", { class: "setup-heading" }, "You're ready"),
      warningEl,
      h(
        "p",
        { class: "setup-subheading" },
        "Workspace and dependencies are set up. Time to produce something amazing."
      ),
      h("div", { class: "setup-actions" }, makeBtn)
    );
  }

  loadInitial();

  return () => {
    mounted = false;
  };
}
