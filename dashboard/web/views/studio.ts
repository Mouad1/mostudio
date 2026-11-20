import type { ProjectStatus, ProjectSummary } from "../../src/types.ts";

const PROJECT_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
import type { Api } from "../lib/api.ts";
import { h } from "../lib/dom.ts";
import { mediaSpecs, workflowLabel } from "../lib/studio.ts";
import { errorBox } from "./error-box.ts";
import { mountStudioRun } from "./studio-run.ts";
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

/**
 * Keep the open project in the address bar (?project=<id>) so a reload stays in it, while a fresh tab
 * without one starts on New video. replaceState: no new history entry and no hashchange (no remount).
 */
function setUrlProjectId(id: string | null): void {
  if (typeof window === "undefined" || !window.location || !window.history?.replaceState) return;
  const params = new URLSearchParams(window.location.search);
  if ((params.get("project") ?? null) === id) return;
  if (id) params.set("project", id);
  else params.delete("project");
  const query = params.toString();
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
}

export function mount(root: HTMLElement, api: Api): () => void {
  let mounted = true;
  let projects: ProjectSummary[] = [];
  let selectedProjectId: string | null = null;
  let currentStatus: ProjectStatus | null = null;
  let errorMessage: string | null = null;
  let isLoading = false;
  let currentRunCleanup: (() => void) | null = null;

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
      } else {
        // only a project named in the address bar (or picked in the list) opens: a fresh tab starts on New video
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
    if (currentRunCleanup) {
      currentRunCleanup();
      currentRunCleanup = null;
    }
    selectedProjectId = id;
    setUrlProjectId(id);
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

  /**
   * Fetch the project list again and redraw only the sidebar: the open project view (and any
   * upload in progress in it) stays mounted. Used after an upload outcome and when the tab comes
   * back, so projects made or removed in another tab show up.
   */
  async function refreshProjects() {
    try {
      const res = await api.get<{ projects: ProjectSummary[] }>("/api/projects");
      if (!mounted) return;
      projects = res.projects || [];
      refreshSidebar();
    } catch {}
  }

  /** Show the "New video" dropzone; the next upload creates its own project. */
  function startNewVideo() {
    if (currentRunCleanup) {
      currentRunCleanup();
      currentRunCleanup = null;
    }
    selectedProjectId = null;
    currentStatus = null;
    setUrlProjectId(null);
    render();
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
          onClick: startNewVideo,
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
          p.workflow ? h("span", { class: "project-workflow" }, workflowLabel(p.workflow)) : null
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
    if (currentRunCleanup) {
      currentRunCleanup();
      currentRunCleanup = null;
    }
    mediaPanelEl = null;
    addVideoEl = null;

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
        onFailed: refreshProjects,
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
        onFailed: refreshProjects,
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

    // Created once per project page so a status redraw never drops an upload in progress.
    const projectId = currentStatus.id;
    addVideoEl = renderStudioUpload({
      api,
      projectId,
      title: "Add or replace video",
      hint: "Drop a file or choose one. The next run uses the newest upload.",
      className: "studio-add-video",
      onUploaded: async () => {
        // Remount the page so the run view also sends the new upload (uploads[0]) next time.
        await selectProject(projectId);
        await refreshProjects();
      },
      onFailed: refreshProjects,
    });
    mediaPanelEl = h(
      "div",
      { class: "studio-media-panel" },
      ...renderMediaCards(currentStatus),
      addVideoEl
    );
    sections.push(mediaPanelEl);

    // Mount studio-run for this project
    const runContainer = h("div", { class: "studio-run-container" });
    currentRunCleanup = mountStudioRun(runContainer, {
      api,
      projectId: currentStatus.id,
      initialStatus: currentStatus,
      onNewProject: startNewVideo,
      onStatusChange: (updated) => {
        currentStatus = updated;
        // A run can import a newer upload: redraw the media cards from the server's status.
        refreshMediaPanel();
        const p = projects.find((x) => x.id === updated.id);
        // The server computes `state` with the same function as the list's `lastStatus`; the
        // workflow is recorded by the project's first run.
        if (p && (p.lastStatus !== updated.state || p.workflow !== updated.workflow)) {
          p.lastStatus = updated.state;
          p.workflow = updated.workflow;
          refreshSidebar();
        }
      },
    });
    sections.push(runContainer);

    workspace.replaceChildren(...sections);
    return workspace;
  }

  /** The "Current media" and "Uploads" cards for a project. */
  function renderMediaCards(status: ProjectStatus): HTMLElement[] {
    const cards: HTMLElement[] = [];
    if (status.media) {
      const m = status.media;
      cards.push(
        h(
          "div",
          { class: "studio-card studio-current-media" },
          h("h3", { class: "studio-card-title" }, "Current media"),
          h("p", { class: "media-file" }, m.file),
          h("p", { class: "media-specs" }, mediaSpecs(m))
        )
      );
    }

    if (status.uploads && status.uploads.length > 0) {
      const uploadList = h(
        "ul",
        { class: "studio-uploads-list" },
        ...status.uploads.map((upload) =>
          h(
            "li",
            { class: "studio-upload-item" },
            h("span", { class: "upload-filename" }, upload),
            h(
              "a",
              {
                class: "upload-link",
                href: api.fileUrl(status.id, upload),
                target: "_blank",
                rel: "noopener noreferrer",
              },
              "View"
            )
          )
        )
      );
      cards.push(
        h(
          "div",
          { class: "studio-card studio-uploads-card" },
          h("h3", { class: "studio-card-title" }, "Uploads"),
          uploadList
        )
      );
    }
    return cards;
  }

  let sidebarEl: HTMLElement | null = null;
  let mediaPanelEl: HTMLElement | null = null;
  let addVideoEl: HTMLElement | null = null;

  /** Redraw only the media cards, leaving the mounted run view and the uploader alone. */
  function refreshMediaPanel() {
    if (!mounted || !mediaPanelEl || !currentStatus) return;
    mediaPanelEl.replaceChildren(...renderMediaCards(currentStatus), ...(addVideoEl ? [addVideoEl] : []));
  }

  /** Redraw only the project list, leaving the mounted run view alone. */
  function refreshSidebar() {
    if (!mounted || !sidebarEl) return;
    sidebarEl.replaceChildren(...Array.from(renderSidebar().childNodes));
  }

  function render() {
    if (!mounted) return;
    sidebarEl = renderSidebar();
    const layout = h(
      "div",
      { class: "studio-layout" },
      sidebarEl,
      renderWorkspace()
    );
    root.replaceChildren(layout);
  }

  const onFocus = () => {
    void refreshProjects();
  };
  const onVisibility = () => {
    if (typeof document === "undefined" || document.visibilityState === "visible") void refreshProjects();
  };
  const win = typeof window !== "undefined" ? window : undefined;
  const doc = typeof document !== "undefined" ? document : undefined;
  if (typeof win?.addEventListener === "function") win.addEventListener("focus", onFocus);
  if (typeof doc?.addEventListener === "function") doc.addEventListener("visibilitychange", onVisibility);

  loadProjects();

  return () => {
    mounted = false;
    if (typeof win?.removeEventListener === "function") win.removeEventListener("focus", onFocus);
    if (typeof doc?.removeEventListener === "function") doc.removeEventListener("visibilitychange", onVisibility);
    if (currentRunCleanup) {
      currentRunCleanup();
      currentRunCleanup = null;
    }
    root.replaceChildren();
  };
}
