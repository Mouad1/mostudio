import { PROJECT_ID_RE, type ProjectStatus, type ProjectSummary } from "../../src/types.ts";
import type { Api } from "../lib/api.ts";
import { h } from "../lib/dom.ts";
import { errorBox } from "./error-box.ts";
import { renderStudioUpload } from "./studio-upload.ts";

function badgeConfig(status: ProjectSummary["lastStatus"]): { className: string; text: string } {
  switch (status) {
    case "new":
      return { className: "step-badge step-badge-idle", text: "New" };
    case "running":
      return { className: "step-badge step-badge-running", text: "Running…" };
    case "done":
      return { className: "step-badge step-badge-pass", text: "Done" };
    case "failed":
      return { className: "step-badge step-badge-fail", text: "Failed" };
    case "awaiting-approval":
      return { className: "step-badge step-badge-awaiting", text: "Needs review" };
    case "interrupted":
      return { className: "step-badge step-badge-interrupted", text: "Interrupted" };
    default:
      return { className: "step-badge step-badge-idle", text: status };
  }
}

function parseProjectId(id: string): { date: string; name: string } {
  if (PROJECT_ID_RE.test(id)) {
    return {
      date: id.slice(0, 10),
      name: id.slice(11),
    };
  }
  return { date: "", name: id };
}

function getUrlProjectId(): string | null {
  if (typeof window === "undefined" || !window.location) return null;
  const hash = window.location.hash || "";
  const qIdx = hash.indexOf("?");
  if (qIdx !== -1) {
    const params = new URLSearchParams(hash.slice(qIdx));
    const p = params.get("project");
    if (p) return p;
  }
  if (window.location.search) {
    const params = new URLSearchParams(window.location.search);
    const p = params.get("project");
    if (p) return p;
  }
  return null;
}

export function mount(root: HTMLElement, api: Api): () => void {
  let mounted = true;
  let projects: ProjectSummary[] = [];
  let selectedProjectId: string | null = null;
  let currentStatus: ProjectStatus | null = null;
  let errorMessage: string | null = null;
  let isLoading = false;

  async function loadProjects() {
    try {
      isLoading = true;
      errorMessage = null;
      render();

      const res = await api.get<{ projects: ProjectSummary[] }>("/api/projects");
      if (!mounted) return;
      projects = res.projects || [];

      const urlProj = getUrlProjectId();
      if (urlProj && projects.some((p) => p.id === urlProj)) {
        selectedProjectId = urlProj;
      } else if (selectedProjectId && projects.some((p) => p.id === selectedProjectId)) {
        // keep current selection
      } else if (projects.length > 0) {
        selectedProjectId = projects[0]!.id;
      } else {
        selectedProjectId = null;
      }

      if (selectedProjectId) {
        await selectProject(selectedProjectId, false);
      } else {
        currentStatus = null;
        isLoading = false;
        render();
      }
    } catch (err: any) {
      if (!mounted) return;
      errorMessage = err?.message || "Failed to load projects";
      isLoading = false;
      render();
    }
  }

  async function selectProject(id: string, updateState = true) {
    selectedProjectId = id;
    try {
      const status = await api.get<ProjectStatus>(`/api/projects/${id}`);
      if (!mounted) return;
      currentStatus = status;
    } catch (err: any) {
      if (!mounted) return;
      currentStatus = null;
      errorMessage = err?.message || `Failed to load project ${id}`;
    }
    isLoading = false;
    if (updateState) {
      render();
    } else {
      render();
    }
  }

  function renderSidebar(): HTMLElement {
    const header = h(
      "div",
      { class: "studio-sidebar-header" },
      h("h2", { class: "studio-sidebar-title" }, "Projects"),
      h(
        "button",
        {
          type: "button",
          class: "btn btn-primary btn-new-video",
          onClick: () => {
            selectedProjectId = null;
            currentStatus = null;
            render();
          },
        },
        "New video"
      )
    );

    const projectItems = projects.map((p) => {
      const { date, name } = parseProjectId(p.id);
      const badge = badgeConfig(p.lastStatus);
      const isSelected = p.id === selectedProjectId;

      return h(
        "div",
        {
          class: `studio-project-item ${isSelected ? "active" : ""}`,
          role: "button",
          tabindex: "0",
          onClick: () => {
            if (p.id !== selectedProjectId) {
              selectProject(p.id);
            }
          },
          onKeydown: ((evt: KeyboardEvent) => {
            if (evt.key === "Enter" || evt.key === " ") {
              evt.preventDefault();
              selectProject(p.id);
            }
          }) as EventListener,
        },
        h(
          "div",
          { class: "project-header" },
          h("span", { class: "project-name" }, name),
          h("span", { class: badge.className }, badge.text)
        ),
        h(
          "div",
          { class: "project-meta" },
          date ? h("span", { class: "project-date" }, date) : null,
          p.workflow ? h("span", { class: "project-workflow" }, p.workflow) : null
        )
      );
    });

    const list = h(
      "div",
      { class: "studio-project-list", role: "list" },
      ...(projectItems.length > 0
        ? projectItems
        : [h("div", { class: "studio-empty-projects" }, "No projects yet")])
    );

    return h("aside", { class: "studio-sidebar" }, header, list);
  }

  function renderWorkspace(): HTMLElement {
    const workspace = h("section", { class: "studio-workspace" });

    if (errorMessage) {
      workspace.replaceChildren(errorBox(errorMessage));
      return workspace;
    }

    if (isLoading && !currentStatus && !selectedProjectId) {
      workspace.replaceChildren(h("div", { class: "studio-loading" }, "Loading…"));
      return workspace;
    }

    // If no project selected or creating a new video:
    if (!selectedProjectId || !currentStatus) {
      const uploadView = renderStudioUpload({
        api,
        onProjectCreated: (proj) => {
          selectedProjectId = proj.id;
          currentStatus = proj;
        },
        onUploaded: async () => {
          await loadProjects();
        },
      });

      workspace.replaceChildren(
        h(
          "div",
          { class: "studio-new-video-container" },
          h("h2", { class: "studio-view-heading" }, "New video"),
          uploadView
        )
      );
      return workspace;
    }

    // Has project, but no media and no uploads yet:
    const hasMedia = Boolean(currentStatus.media);
    const hasUploads = currentStatus.uploads && currentStatus.uploads.length > 0;

    if (!hasMedia && !hasUploads) {
      const uploadView = renderStudioUpload({
        api,
        projectId: currentStatus.id,
        onUploaded: async () => {
          await selectProject(currentStatus!.id);
          const res = await api.get<{ projects: ProjectSummary[] }>("/api/projects");
          projects = res.projects || [];
          render();
        },
      });

      workspace.replaceChildren(
        h(
          "div",
          { class: "studio-empty-project-container" },
          h("h2", { class: "studio-view-heading" }, parseProjectId(currentStatus.id).name),
          uploadView
        )
      );
      return workspace;
    }

    // Project has media or uploads:
    const sections: HTMLElement[] = [];
    const { name, date } = parseProjectId(currentStatus.id);

    const projectInfo = h(
      "div",
      { class: "studio-project-info" },
      h("h2", { class: "studio-view-heading" }, name),
      date ? h("span", { class: "project-date" }, date) : null
    );
    sections.push(projectInfo);

    if (currentStatus.media) {
      const m = currentStatus.media;
      const mediaCard = h(
        "div",
        { class: "studio-card studio-current-media" },
        h("h3", { class: "studio-card-title" }, "Current media"),
        h("p", { class: "media-file" }, m.file),
        h(
          "p",
          { class: "media-specs" },
          `${m.width}x${m.height} · ${m.durationSec.toFixed(1)}s`
        )
      );
      sections.push(mediaCard);
    }

    if (hasUploads) {
      const uploadList = h(
        "ul",
        { class: "studio-uploads-list" },
        ...currentStatus.uploads.map((upload) =>
          h(
            "li",
            { class: "studio-upload-item" },
            h("span", { class: "upload-filename" }, upload),
            h(
              "a",
              {
                class: "upload-link",
                href: api.fileUrl(currentStatus!.id, upload),
                target: "_blank",
                rel: "noopener noreferrer",
              },
              "View"
            )
          )
        )
      );

      const uploadsCard = h(
        "div",
        { class: "studio-card studio-uploads-card" },
        h("h3", { class: "studio-card-title" }, "Uploads"),
        uploadList
      );
      sections.push(uploadsCard);
    }

    workspace.replaceChildren(...sections);
    return workspace;
  }

  function render() {
    if (!mounted) return;
    const layout = h(
      "div",
      { class: "studio-layout" },
      renderSidebar(),
      renderWorkspace()
    );
    root.replaceChildren(layout);
  }

  loadProjects();

  return () => {
    mounted = false;
    root.replaceChildren();
  };
}
