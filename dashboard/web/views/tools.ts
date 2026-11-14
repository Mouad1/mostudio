import type {
  ProjectStatus,
  ProjectSummary,
  RunEvent,
  StepView,
  ToolInfo,
  ToolParam,
} from "../../src/types.ts";
import type { Api } from "../lib/api.ts";
import { h } from "../lib/dom.ts";
import { STEP_LABELS } from "../lib/pipeline.ts";
import { previewsFor } from "../lib/previews.ts";
import { formToParams, missingSteps, PROVIDERS_BY_CAPABILITY } from "../lib/tools.ts";
import { errorBox } from "./error-box.ts";
import { renderPreview } from "./previews.ts";

export function mount(root: HTMLElement, api: Api): () => void {
  let mounted = true;
  let tools: ToolInfo[] = [];
  let projects: ProjectSummary[] = [];
  let selectedToolName: string | null = null;
  let selectedProjectId: string | null = null;
  let selectedProjectStatus: ProjectStatus | null = null;

  let loading = true;
  let generalError: string | null = null;
  let formError: string | null = null;
  let isRunning = false;
  let logLines: string[] = [];
  let lastStepResult: StepView | null = null;

  let unsubscribeEvents: (() => void) | null = null;
  let currentEventsProjectId: string | null = null;

  function ensureEventsSubscribed(projectId: string) {
    if (currentEventsProjectId === projectId && unsubscribeEvents) {
      return;
    }
    if (unsubscribeEvents) {
      unsubscribeEvents();
      unsubscribeEvents = null;
    }
    currentEventsProjectId = projectId;
    unsubscribeEvents = api.events(projectId, async (ev: RunEvent) => {
      if (!mounted) return;

      if (ev.type === "log") {
        logLines.push(ev.message);
        const logEl = root.querySelector(".tool-logs");
        if (logEl) {
          logEl.textContent = logLines.join("\n");
        }
      } else if (ev.type === "step-end") {
        if (selectedToolName && ev.result.step === selectedToolName) {
          lastStepResult = ev.result;
          isRunning = false;
          try {
            const updated = await api.get<ProjectStatus>(`/api/projects/${projectId}`);
            if (mounted) {
              selectedProjectStatus = updated;
            }
          } catch {}
          render();
        }
      } else if (ev.type === "run-end") {
        isRunning = false;
        try {
          const updated = await api.get<ProjectStatus>(`/api/projects/${projectId}`);
          if (mounted) {
            selectedProjectStatus = updated;
          }
        } catch {}
        render();
      }
    });
  }

  async function loadData() {
    try {
      loading = true;
      generalError = null;
      render();

      const [toolsRes, projectsRes] = await Promise.all([
        api.get<{ tools: ToolInfo[] }>("/api/tools"),
        api.get<{ projects: ProjectSummary[] }>("/api/projects"),
      ]);

      if (!mounted) return;
      tools = toolsRes.tools || [];
      projects = projectsRes.projects || [];

      if (!selectedProjectId && projects.length > 0) {
        selectedProjectId = projects[0]!.id;
      }

      if (selectedProjectId) {
        try {
          selectedProjectStatus = await api.get<ProjectStatus>(
            `/api/projects/${selectedProjectId}`
          );
        } catch {
          selectedProjectStatus = null;
        }
      }

      loading = false;
      render();
    } catch (err: any) {
      if (!mounted) return;
      loading = false;
      generalError = err?.message || "Failed to load tools and projects";
      render();
    }
  }

  async function selectProject(projectId: string) {
    selectedProjectId = projectId;
    try {
      selectedProjectStatus = await api.get<ProjectStatus>(
        `/api/projects/${projectId}`
      );
      if (selectedToolName && selectedProjectStatus?.steps?.[selectedToolName]) {
        lastStepResult = selectedProjectStatus.steps[selectedToolName] ?? null;
      }
    } catch {
      selectedProjectStatus = null;
    }
    render();
  }

  function selectTool(toolName: string) {
    selectedToolName = toolName;
    formError = null;
    logLines = [];
    if (selectedProjectStatus?.steps?.[toolName]) {
      lastStepResult = selectedProjectStatus.steps[toolName] ?? null;
    } else {
      lastStepResult = null;
    }
    render();
  }

  async function handleRun(tool: ToolInfo) {
    if (!selectedProjectId) return;
    formError = null;

    const inputs = root.querySelectorAll(".tool-param-input");
    const values: Record<string, string | boolean> = {};

    for (const el of inputs) {
      const name = el.getAttribute("name");
      if (!name) continue;
      const param = tool.params.find((p) => p.name === name);
      const type = el.getAttribute("type");
      if (type === "checkbox") {
        if ((el as any).checked) {
          values[name] = true;
        } else if (!param?.optional) {
          values[name] = false;
        }
      } else {
        values[name] = (el as any).value;
      }
    }

    const forceEl = root.querySelector(".tool-force-checkbox") as any;
    const force = Boolean(forceEl?.checked);

    let params: Record<string, string | number | boolean>;
    try {
      params = formToParams(tool.params, values);
    } catch (err: any) {
      formError = err?.message || "Invalid parameters";
      render();
      return;
    }

    isRunning = true;
    logLines = [];
    render();

    ensureEventsSubscribed(selectedProjectId);

    try {
      await api.send("POST", `/api/projects/${selectedProjectId}/steps/${tool.name}`, {
        params,
        force,
      });
    } catch (err: any) {
      if (!mounted) return;
      formError = err?.message || `Failed to run ${tool.name}`;
      isRunning = false;
      render();
    }
  }

  function renderParamInput(param: ToolParam, tool: ToolInfo): HTMLElement {
    const field = h("div", { class: "tool-field", "data-param": param.name });

    if (param.input === "toggle" || param.type === "boolean") {
      const checkbox = h("input", {
        type: "checkbox",
        name: param.name,
        class: "tool-param-input tool-param-checkbox",
      });
      field.classList.add("tool-field-toggle");
      field.appendChild(
        h(
          "label",
          { class: "tool-toggle-label" },
          checkbox,
          h("span", { class: "tool-toggle-text" }, param.label)
        )
      );
      if (param.help) {
        field.appendChild(h("p", { class: "tool-param-help" }, param.help));
      }
      return field;
    }

    field.appendChild(h("label", { class: "tool-param-label" }, param.label));

    let inputEl: HTMLElement;

    if (param.choices && param.choices.length > 0) {
      const select = h("select", {
        name: param.name,
        class: "tool-param-input tool-param-select",
      });
      if (param.optional) {
        select.appendChild(h("option", { value: "" }, "(Default)"));
      }
      for (const c of param.choices) {
        select.appendChild(h("option", { value: c.value }, c.label));
      }
      inputEl = select;
    } else if (param.input === "file") {
      const select = h("select", {
        name: param.name,
        class: "tool-param-input tool-param-select",
      });
      select.appendChild(h("option", { value: "" }, "Select a file..."));
      const uploads = selectedProjectStatus?.uploads || [];
      for (const u of uploads) {
        select.appendChild(h("option", { value: u }, u));
      }
      inputEl = select;
    } else if (param.input === "provider") {
      const select = h("select", {
        name: param.name,
        class: "tool-param-input tool-param-select",
      });
      select.appendChild(h("option", { value: "" }, "(Default)"));
      const providers = tool.capability
        ? PROVIDERS_BY_CAPABILITY[tool.capability] || []
        : [];
      for (const p of providers) {
        select.appendChild(h("option", { value: p }, p));
      }
      inputEl = select;
    } else if (param.input === "textarea") {
      inputEl = h("textarea", {
        name: param.name,
        class: "tool-param-input tool-param-textarea",
        placeholder: param.help || "",
        rows: "3",
      });
    } else if (param.input === "number" || param.type === "number") {
      inputEl = h("input", {
        type: "number",
        name: param.name,
        class: "tool-param-input tool-param-number",
        placeholder: param.help || "",
      });
    } else {
      inputEl = h("input", {
        type: "text",
        name: param.name,
        class: "tool-param-input tool-param-text",
        placeholder: param.help || "",
      });
    }

    field.appendChild(inputEl);
    if (param.help) {
      field.appendChild(h("p", { class: "tool-param-help" }, param.help));
    }
    return field;
  }

  function renderToolDetail(tool: ToolInfo): HTMLElement {
    const panel = h("div", { class: "tool-detail-panel" });

    // Header
    const header = h(
      "div",
      { class: "tool-detail-header" },
      h("h2", { class: "tool-detail-title" }, tool.title),
      h("p", { class: "tool-detail-summary" }, tool.summary)
    );
    panel.appendChild(header);

    // Project select
    const projSelect = h(
      "select",
      {
        id: "tool-project-select",
        class: "tool-project-select",
        onChange: ((e: Event) => {
          selectProject((e.target as HTMLSelectElement).value);
        }) as EventListener,
      },
      ...projects.map((p) =>
        h(
          "option",
          {
            value: p.id,
            ...(p.id === selectedProjectId ? { selected: true } : {}),
          },
          p.id
        )
      )
    );

    const projectField = h(
      "div",
      { class: "tool-field tool-field-project" },
      h("label", { for: "tool-project-select", class: "tool-param-label" }, "Project"),
      projSelect
    );
    panel.appendChild(projectField);

    // Params form
    const form = h("form", {
      class: "tool-options-form",
      onSubmit: ((e: Event) => {
        e.preventDefault();
        handleRun(tool);
      }) as EventListener,
    });

    const standardParams = tool.params.filter((p) => !p.advanced);
    const advancedParams = tool.params.filter((p) => p.advanced);

    for (const p of standardParams) {
      form.appendChild(renderParamInput(p, tool));
    }

    if (advancedParams.length > 0) {
      const advancedDetails = h(
        "details",
        { class: "tool-advanced" },
        h("summary", { class: "tool-advanced-summary" }, "More options"),
        h(
          "div",
          { class: "tool-advanced-content" },
          ...advancedParams.map((p) => renderParamInput(p, tool))
        )
      );
      form.appendChild(advancedDetails);
    }

    // Run controls
    const missing = selectedProjectStatus
      ? missingSteps(tool, selectedProjectStatus, tools)
      : [];
    const isMissing = missing.length > 0;
    const canRun = !isMissing && Boolean(selectedProjectId) && !isRunning;

    const runControls = h("div", { class: "tool-run-controls" });

    const forceCheckbox = h("input", {
      type: "checkbox",
      class: "tool-force-checkbox",
      name: "force",
    });

    runControls.appendChild(
      h(
        "label",
        { class: "tool-force-label" },
        forceCheckbox,
        h("span", {}, "Run again even if nothing changed")
      )
    );

    const runBtn = h(
      "button",
      {
        type: "button",
        class: "btn btn-primary tool-run-button",
        disabled: !canRun,
        onClick: () => handleRun(tool),
      },
      isRunning ? "Running…" : "Run on this project"
    );
    runControls.appendChild(runBtn);

    if (isMissing) {
      const missingLabels = missing.map((s) => STEP_LABELS[s] ?? s).join(", ");
      runControls.appendChild(
        h(
          "div",
          { class: "tool-missing-message" },
          `Run ${missingLabels} first`
        )
      );
    }

    form.appendChild(runControls);
    panel.appendChild(form);

    if (formError) {
      panel.appendChild(errorBox(formError));
    }

    // Live logs container
    if (logLines.length > 0 || isRunning) {
      const logsPre = h("pre", { class: "tool-logs" }, logLines.join("\n"));
      panel.appendChild(
        h(
          "div",
          { class: "tool-logs-section" },
          h("h4", { class: "tool-section-title" }, "Logs"),
          logsPre
        )
      );
    }

    // Results & previews
    if (lastStepResult) {
      const resultContainer = h("div", { class: "tool-result-section" });
      const badgeClass =
        lastStepResult.status === "pass"
          ? "step-badge step-badge-pass"
          : lastStepResult.status === "warn"
          ? "step-badge step-badge-warn"
          : "step-badge step-badge-fail";

      const badge = h("span", { class: badgeClass }, lastStepResult.status);
      resultContainer.appendChild(
        h(
          "div",
          { class: "tool-result-header" },
          badge,
          lastStepResult.durationMs
            ? h(
                "span",
                { class: "tool-result-duration" },
                `${(lastStepResult.durationMs / 1000).toFixed(1)}s`
              )
            : null
        )
      );

      if (lastStepResult.error) {
        resultContainer.appendChild(errorBox(lastStepResult.error));
      }
      panel.appendChild(resultContainer);
    }

    if (selectedProjectStatus) {
      const previews = previewsFor(tool.name, selectedProjectStatus);
      if (previews.length > 0) {
        const previewsContainer = h("div", { class: "step-previews-container tool-previews" });
        panel.appendChild(previewsContainer);
        for (const p of previews) {
          renderPreview(p, api, selectedProjectId!).then((el) => {
            if (mounted) previewsContainer.appendChild(el);
          });
        }
      }
    }

    // Technical details
    const techDetails = h(
      "details",
      { class: "tool-tech-details" },
      h("summary", { class: "tool-tech-summary" }, "Technical details"),
      h(
        "div",
        { class: "tool-tech-content" },
        h(
          "div",
          { class: "tool-tech-row" },
          h("strong", {}, "Inputs: "),
          tool.inputs.length > 0 ? tool.inputs.join(", ") : "none"
        ),
        h(
          "div",
          { class: "tool-tech-row" },
          h("strong", {}, "Outputs: "),
          tool.outputs.length > 0 ? tool.outputs.join(", ") : "none"
        ),
        h(
          "div",
          { class: "tool-tech-row" },
          h("strong", {}, "Gate: "),
          tool.gate.length > 0
            ? tool.gate.map((g) => `${g.metric} ${g.op} ${g.value}`).join(", ")
            : "none"
        )
      )
    );
    panel.appendChild(techDetails);

    return panel;
  }

  function render() {
    if (!mounted) return;

    if (loading) {
      root.replaceChildren(
        h(
          "div",
          { class: "view-container" },
          h("div", { class: "loading-spinner" }, "Loading tools…")
        )
      );
      return;
    }

    if (generalError) {
      root.replaceChildren(
        h(
          "div",
          { class: "view-container" },
          h("h1", { class: "view-heading" }, "Tools"),
          errorBox(generalError)
        )
      );
      return;
    }

    const container = h("div", { class: "view-container tools-view-container" });

    const header = h(
      "div",
      { class: "tools-view-header" },
      h("h1", { class: "view-heading" }, "Tools"),
      h(
        "p",
        { class: "view-subheading" },
        "Inspect catalog steps, tweak options, and run tools individually on any project."
      )
    );
    container.appendChild(header);

    const layout = h("div", { class: "tools-layout" });

    // Grid of cards
    const grid = h("div", { class: "tools-grid" });
    for (const tool of tools) {
      const isSelected = tool.name === selectedToolName;
      const card = h(
        "div",
        {
          class: `tool-card ${isSelected ? "selected" : ""}`,
          "data-tool": tool.name,
          onClick: () => selectTool(tool.name),
        },
        h("h3", { class: "tool-card-title" }, tool.title),
        h("p", { class: "tool-card-summary" }, tool.summary)
      );

      if (tool.workflows && tool.workflows.length > 0) {
        const wfContainer = h(
          "div",
          { class: "tool-workflows" },
          ...tool.workflows.map((wf) =>
            h("span", { class: "tool-workflow-chip" }, wf)
          )
        );
        card.appendChild(wfContainer);
      }

      grid.appendChild(card);
    }

    layout.appendChild(grid);

    // Detail panel
    const selectedTool = tools.find((t) => t.name === selectedToolName);
    if (selectedTool) {
      layout.appendChild(renderToolDetail(selectedTool));
    }

    container.appendChild(layout);
    root.replaceChildren(container);
  }

  loadData();

  return () => {
    mounted = false;
    if (unsubscribeEvents) {
      unsubscribeEvents();
      unsubscribeEvents = null;
    }
    root.replaceChildren();
  };
}
