import type { ProbeResult, SettingField } from "../../src/types.ts";
import type { Api } from "../lib/api.ts";
import { h } from "../lib/dom.ts";
import { dirtyValues, groupFields, sourceText, type ProviderGroup } from "../lib/settings.ts";
import { errorBox } from "./error-box.ts";

export function mount(root: HTMLElement, api: Api): () => void {
  let mounted = true;
  let keysFile = "";
  let fields: SettingField[] = [];
  let originalAnimatedCaptions = false;
  let currentAnimatedCaptions = false;
  let edits: Record<string, string> = {};
  const revealTimers = new Map<string, any>();

  // Cached DOM elements
  let saveBar: HTMLElement;
  let saveBtn: HTMLElement;

  async function load() {
    try {
      const data = await api.get<{
        keysFile: string;
        fields: SettingField[];
        animatedCaptions: boolean;
      }>("/api/settings");
      if (!mounted) return;
      keysFile = data.keysFile;
      fields = data.fields;
      originalAnimatedCaptions = Boolean(data.animatedCaptions);
      currentAnimatedCaptions = originalAnimatedCaptions;
      edits = {};
      render();
    } catch (err: any) {
      if (!mounted) return;
      root.replaceChildren(errorBox(err?.message || "Failed to load settings"));
    }
  }

  function updateSaveBar() {
    const dirty = dirtyValues(fields, edits);
    const captionsChanged = currentAnimatedCaptions !== originalAnimatedCaptions;
    const isDirty = Object.keys(dirty).length > 0 || captionsChanged;

    if (isDirty) {
      saveBar.classList.remove("hidden");
    } else {
      saveBar.classList.add("hidden");
    }
  }

  function renderProviderCard(group: ProviderGroup): HTMLElement {
    const card = h("div", { class: "settings-card", "data-provider": group.id });

    // Card Header
    const cardHeader = h(
      "div",
      { class: "settings-card-header" },
      h(
        "div",
        { class: "settings-card-title-group" },
        h("h3", { class: "settings-card-title" }, group.title),
        group.recommended
          ? h("span", { class: "badge badge-recommended" }, "Recommended")
          : null
      )
    );
    card.appendChild(cardHeader);

    // Fields
    const fieldsContainer = h("div", { class: "settings-fields-container" });
    for (const f of group.fields) {
      const fieldEl = h("div", { class: "settings-field", "data-field": f.name });

      const labelRow = h(
        "div",
        { class: "field-label-row" },
        h("span", { class: "field-label" }, f.label),
        f.getKeyUrl
          ? h(
              "a",
              {
                class: "get-key-link",
                href: f.getKeyUrl,
                target: "_blank",
                rel: "noopener noreferrer",
              },
              "Get a key"
            )
          : null
      );
      fieldEl.appendChild(labelRow);

      if (f.help) {
        fieldEl.appendChild(h("p", { class: "field-help" }, f.help));
      }

      const valueRow = h("div", { class: "field-value-row" });
      const valueSpan = h(
        "span",
        { class: "field-value" },
        f.masked ? f.masked : "Not set"
      );
      const sourceSpan = h("span", { class: "field-source" }, sourceText(f));

      const actionsGroup = h("div", { class: "field-actions-group" });

      const changeBtn = h(
        "button",
        { type: "button", class: "btn btn-secondary btn-sm change-btn" },
        "Change"
      );
      actionsGroup.appendChild(changeBtn);

      if (f.source === "app" && f.kind === "secret") {
        const revealBtn = h(
          "button",
          { type: "button", class: "btn btn-secondary btn-sm reveal-btn" },
          "Reveal"
        );
        revealBtn.addEventListener("click", async () => {
          try {
            const res = await api.send<{ value: string }>(
              "POST",
              "/api/settings/reveal",
              { name: f.name }
            );
            valueSpan.textContent = res.value || "(empty)";
            if (revealTimers.has(f.name)) {
              clearTimeout(revealTimers.get(f.name));
            }
            const timer = setTimeout(() => {
              if (mounted) {
                valueSpan.textContent = f.masked || "Not set";
              }
              revealTimers.delete(f.name);
            }, 30000);
            revealTimers.set(f.name, timer);
          } catch (err: any) {
            alert(err?.message || "Failed to reveal key");
          }
        });
        actionsGroup.appendChild(revealBtn);
      }

      valueRow.appendChild(valueSpan);
      valueRow.appendChild(sourceSpan);
      valueRow.appendChild(actionsGroup);
      fieldEl.appendChild(valueRow);

      // Edit container
      const editContainer = h("div", { class: "field-edit-container hidden" });
      const isSecret = f.kind === "secret";
      const input = h("input", {
        type: isSecret ? "password" : "text",
        class: isSecret ? "secret-input form-control" : "text-input form-control",
        autocomplete: "off",
        spellcheck: "false",
        placeholder: isSecret ? "Enter key..." : f.label,
        value: edits[f.name] !== undefined ? edits[f.name] : (isSecret ? "" : (f.masked ?? "")),
      }) as HTMLInputElement;

      input.addEventListener("input", () => {
        edits[f.name] = input.value;
        updateSaveBar();
      });

      editContainer.appendChild(input);

      if (isSecret) {
        const toggleBtn = h(
          "button",
          { type: "button", class: "btn btn-secondary btn-sm toggle-visibility-btn" },
          "Show"
        );
        toggleBtn.addEventListener("click", () => {
          if (input.getAttribute("type") === "password") {
            input.setAttribute("type", "text");
            input.type = "text";
            toggleBtn.textContent = "Hide";
          } else {
            input.setAttribute("type", "password");
            input.type = "password";
            toggleBtn.textContent = "Show";
          }
        });
        editContainer.appendChild(toggleBtn);
      }

      changeBtn.addEventListener("click", () => {
        editContainer.classList.toggle("hidden");
        if (!editContainer.classList.contains("hidden")) {
          input.focus?.();
        }
      });

      fieldEl.appendChild(editContainer);
      fieldsContainer.appendChild(fieldEl);
    }
    card.appendChild(fieldsContainer);

    // Test connection action
    const cardFooter = h("div", { class: "settings-card-footer" });
    const testBtn = h(
      "button",
      { type: "button", class: "btn btn-secondary btn-sm test-connection-btn" },
      "Test connection"
    );
    const resultLine = h("div", { class: "test-result hidden" });

    testBtn.addEventListener("click", async () => {
      testBtn.setAttribute("disabled", "true");
      (testBtn as any).disabled = true;
      testBtn.textContent = "Testing...";
      resultLine.className = "test-result hidden";
      resultLine.textContent = "";

      try {
        const providerEdits: Record<string, string> = {};
        for (const field of group.fields) {
          if (edits[field.name] !== undefined) {
            providerEdits[field.name] = edits[field.name];
          }
        }
        const res = await api.send<ProbeResult>("POST", "/api/settings/test", {
          provider: group.id,
          values: providerEdits,
        });

        resultLine.classList.remove("hidden");
        if (res.ok) {
          resultLine.classList.add("test-result-success");
          resultLine.textContent = res.message;
        } else {
          resultLine.classList.add("test-result-failure");
          resultLine.textContent = res.message || "Connection test failed";
        }
      } catch (err: any) {
        resultLine.classList.remove("hidden");
        resultLine.classList.add("test-result-failure");
        resultLine.textContent = err?.message || "Failed to test connection";
      } finally {
        testBtn.removeAttribute("disabled");
        (testBtn as any).disabled = false;
        testBtn.textContent = "Test connection";
      }
    });

    cardFooter.appendChild(testBtn);
    cardFooter.appendChild(resultLine);
    card.appendChild(cardFooter);

    return card;
  }

  function render() {
    if (!mounted) return;

    const { recommended, more, paths } = groupFields(fields);

    const container = h("div", { class: "settings-view view-container" });

    // Header
    const header = h(
      "header",
      { class: "settings-header" },
      h("h1", { class: "view-heading" }, "Settings"),
      h(
        "p",
        { class: "settings-header-note text-muted" },
        `Your keys stay on this Mac, in ${keysFile}.`
      )
    );
    container.appendChild(header);

    // Recommended Section
    const recSection = h(
      "section",
      { class: "settings-section" },
      h("h2", { class: "settings-section-title" }, "Recommended"),
      h(
        "div",
        { class: "settings-grid" },
        ...recommended.map((g) => renderProviderCard(g))
      )
    );
    container.appendChild(recSection);

    // More Section
    if (more.length > 0) {
      const details = h(
        "details",
        { class: "settings-more-details" },
        h("summary", { class: "settings-more-summary" }, "More providers"),
        h(
          "div",
          { class: "settings-grid settings-more-grid" },
          ...more.map((g) => renderProviderCard(g))
        )
      );
      container.appendChild(details);
    }

    // Paths Section
    if (paths.length > 0) {
      const pathsCard = h(
        "div",
        { class: "settings-card settings-paths-card" },
        h(
          "div",
          { class: "settings-card-header" },
          h("h3", { class: "settings-card-title" }, "Local paths")
        )
      );

      const pathsFields = h("div", { class: "settings-fields-container" });
      for (const p of paths) {
        const fieldEl = h("div", { class: "settings-field", "data-field": p.name });
        fieldEl.appendChild(
          h("div", { class: "field-label-row" }, h("span", { class: "field-label" }, p.label))
        );
        if (p.help) {
          fieldEl.appendChild(h("p", { class: "field-help" }, p.help));
        }

        const valueRow = h(
          "div",
          { class: "field-value-row" },
          h("span", { class: "field-value" }, p.masked || "Not set"),
          h("span", { class: "field-source" }, sourceText(p))
        );
        const changeBtn = h(
          "button",
          { type: "button", class: "btn btn-secondary btn-sm change-btn" },
          "Change"
        );
        valueRow.appendChild(changeBtn);
        fieldEl.appendChild(valueRow);

        const editContainer = h("div", { class: "field-edit-container hidden" });
        const input = h("input", {
          type: "text",
          class: "text-input form-control",
          autocomplete: "off",
          spellcheck: "false",
          placeholder: p.label,
          value: edits[p.name] !== undefined ? edits[p.name] : (p.masked ?? ""),
        }) as HTMLInputElement;

        input.addEventListener("input", () => {
          edits[p.name] = input.value;
          updateSaveBar();
        });

        editContainer.appendChild(input);
        changeBtn.addEventListener("click", () => {
          editContainer.classList.toggle("hidden");
          if (!editContainer.classList.contains("hidden")) {
            input.focus?.();
          }
        });

        fieldEl.appendChild(editContainer);
        pathsFields.appendChild(fieldEl);
      }
      pathsCard.appendChild(pathsFields);
      container.appendChild(pathsCard);
    }

    // Animated Captions Card
    const captionsCard = h(
      "div",
      { class: "settings-card animated-captions-card" },
      h(
        "div",
        { class: "settings-card-header" },
        h("h3", { class: "settings-card-title" }, "Animated captions")
      ),
      h(
        "div",
        { class: "settings-field" },
        h(
          "label",
          { class: "switch-container" },
          (() => {
            const sw = h("input", {
              type: "checkbox",
              class: "animated-captions-switch",
            }) as HTMLInputElement;
            sw.checked = currentAnimatedCaptions;
            if (currentAnimatedCaptions) {
              sw.setAttribute("checked", "");
            }
            sw.addEventListener("change", () => {
              currentAnimatedCaptions = Boolean(sw.checked);
              updateSaveBar();
            });
            return sw;
          })(),
          h("span", { class: "switch-text" }, "Animated captions")
        ),
        h(
          "p",
          { class: "field-help" },
          "Moving word-by-word captions. Needs internet the first time and takes longer to render."
        )
      )
    );
    container.appendChild(captionsCard);

    // Sticky Save Bar
    saveBtn = h(
      "button",
      { type: "button", class: "btn btn-primary save-changes-btn" },
      "Save changes"
    );
    saveBtn.addEventListener("click", async () => {
      saveBtn.setAttribute("disabled", "true");
      (saveBtn as any).disabled = true;
      saveBtn.textContent = "Saving...";

      try {
        const dirty = dirtyValues(fields, edits);
        const payload: { values?: Record<string, string>; animatedCaptions?: boolean } = {};
        if (Object.keys(dirty).length > 0) {
          payload.values = dirty;
        }
        if (currentAnimatedCaptions !== originalAnimatedCaptions) {
          payload.animatedCaptions = currentAnimatedCaptions;
        }

        const updated = await api.send<{
          keysFile: string;
          fields: SettingField[];
          animatedCaptions: boolean;
        }>("PUT", "/api/settings", payload);

        keysFile = updated.keysFile;
        fields = updated.fields;
        originalAnimatedCaptions = Boolean(updated.animatedCaptions);
        currentAnimatedCaptions = originalAnimatedCaptions;
        edits = {};
        render();
      } catch (err: any) {
        saveBtn.removeAttribute("disabled");
        (saveBtn as any).disabled = false;
        saveBtn.textContent = "Save changes";
        alert(err?.message || "Failed to save settings");
      }
    });

    saveBar = h(
      "div",
      { class: "settings-save-bar hidden" },
      h(
        "div",
        { class: "save-bar-content" },
        h("span", { class: "save-bar-text" }, "You have unsaved changes"),
        h("div", { class: "save-bar-buttons" }, saveBtn)
      )
    );
    container.appendChild(saveBar);

    root.replaceChildren(container);
    updateSaveBar();
  }

  load();

  return () => {
    mounted = false;
    for (const timer of revealTimers.values()) {
      clearTimeout(timer);
    }
    revealTimers.clear();
    root.replaceChildren();
  };
}
