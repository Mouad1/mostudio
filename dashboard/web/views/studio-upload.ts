import type { ProjectStatus } from "../../src/types.ts";
import type { Api } from "../lib/api.ts";
import { h } from "../lib/dom.ts";
import { acceptsMedia, formatBytes, MEDIA_EXTS, slugFromFileName } from "../lib/studio.ts";
import { errorBox } from "./error-box.ts";

export interface StudioUploadOptions {
  api: Api;
  projectId?: string;
  getProjectId?: (file: File) => Promise<string> | string;
  onUploaded?: (path: string) => void;
  onProjectCreated?: (project: ProjectStatus) => void;
}

export function renderStudioUpload(options: StudioUploadOptions): HTMLElement {
  const root = h("div", {
    class: "studio-dropzone",
    tabindex: "0",
    role: "button",
    "aria-label": "Upload video",
  });

  let uploadHandle: { done: Promise<any>; abort(): void } | null = null;
  let isUploading = false;
  let lastError: string | null = null;

  function renderIdle() {
    isUploading = false;
    uploadHandle = null;
    root.classList.remove("uploading");

    const fileInput = h("input", {
      type: "file",
      class: "studio-file-input",
      accept: MEDIA_EXTS.join(","),
      style: "display: none;",
      onChange: (evt: Event) => {
        const input = evt.target as HTMLInputElement;
        const file = input.files?.[0];
        if (file) {
          handleFile(file);
        }
      },
    }) as HTMLInputElement;

    const errorEl = lastError
      ? h("div", { class: "dropzone-error" }, errorBox(lastError))
      : null;

    const content = h(
      "div",
      { class: "dropzone-content" },
      h("div", { class: "dropzone-icon", "aria-hidden": "true" }, "↑"),
      h("p", { class: "dropzone-title" }, "Drop your video here"),
      h("p", { class: "dropzone-subtitle" }, "or choose a file")
    );

    const children: (Node | string)[] = [fileInput];
    if (errorEl) children.push(errorEl);
    children.push(content);
    root.replaceChildren(...children);
  }

  function renderProgress(file: File, sent: number, total: number) {
    root.classList.add("uploading");
    const fraction = total > 0 ? Math.min(1, Math.max(0, sent / total)) : 0;
    const pct = Math.round(fraction * 100);

    const progressBar = h(
      "div",
      { class: "upload-progress-bar-track" },
      h("div", {
        class: "upload-progress-bar-fill",
        style: `width: ${pct}%`,
      })
    );

    const progressText = h(
      "p",
      { class: "upload-progress-text" },
      `${formatBytes(sent)} of ${formatBytes(total)}`
    );

    const cancelBtn = h(
      "button",
      {
        type: "button",
        class: "btn btn-secondary btn-cancel-upload",
        onClick: ((evt: MouseEvent) => {
          if (typeof evt.stopPropagation === "function") evt.stopPropagation();
          if (uploadHandle) {
            uploadHandle.abort();
          }
          renderIdle();
        }) as EventListener,
      },
      "Cancel upload"
    );

    const uploadingContent = h(
      "div",
      { class: "dropzone-uploading-content", "aria-live": "polite" },
      h("p", { class: "upload-filename" }, `Uploading ${file.name}…`),
      progressBar,
      progressText,
      cancelBtn
    );

    root.replaceChildren(uploadingContent);
  }

  async function handleFile(file: File) {
    if (isUploading) return;
    lastError = null;

    if (!acceptsMedia(file.name)) {
      lastError = `mostudio can't use this file type (${file.name}). Use a video or audio file.`;
      renderIdle();
      return;
    }

    isUploading = true;
    let sent = 0;
    const total = file.size || 0;
    renderProgress(file, sent, total);

    try {
      let pid = options.projectId;
      if (!pid && options.getProjectId) {
        pid = await options.getProjectId(file);
      }
      if (!pid) {
        const slug = slugFromFileName(file.name);
        const project = await options.api.send<ProjectStatus>("POST", "/api/projects", { slug });
        options.onProjectCreated?.(project);
        pid = project.id;
      }

      const uploadUrl = `/api/projects/${pid}/uploads?name=${encodeURIComponent(file.name)}`;
      uploadHandle = options.api.upload<{ path: string; sizeBytes: number }>(
        uploadUrl,
        file,
        (fraction) => {
          sent = Math.round(fraction * total);
          renderProgress(file, sent, total);
        }
      );

      const res = await uploadHandle.done;
      isUploading = false;
      uploadHandle = null;
      options.onUploaded?.(res?.path ?? file.name);
    } catch (err: any) {
      if (err?.message === "Upload aborted" || err?.name === "AbortError") {
        renderIdle();
        return;
      }
      lastError = err?.message || "Upload failed";
      renderIdle();
    }
  }

  root.addEventListener("click", (evt: Event) => {
    if (isUploading) return;
    const input = root.querySelector("input");
    if (input && evt.target !== input) {
      input.click();
    }
  });

  root.addEventListener("keydown", (evt: any) => {
    if (isUploading) return;
    if (evt.key === "Enter" || evt.key === " ") {
      if (typeof evt.preventDefault === "function") evt.preventDefault();
      const input = root.querySelector("input");
      if (input) input.click();
    }
  });

  root.addEventListener("dragover", (evt: any) => {
    if (typeof evt.preventDefault === "function") evt.preventDefault();
    root.classList.add("drag-over");
  });

  root.addEventListener("dragleave", () => {
    root.classList.remove("drag-over");
  });

  root.addEventListener("drop", (evt: any) => {
    if (typeof evt.preventDefault === "function") evt.preventDefault();
    root.classList.remove("drag-over");
    const file = evt.dataTransfer?.files?.[0];
    if (file) {
      handleFile(file);
    }
  });

  renderIdle();
  return root;
}

export function mountStudioUpload(
  root: HTMLElement,
  options: StudioUploadOptions
): () => void {
  const el = renderStudioUpload(options);
  root.replaceChildren(el);
  return () => {
    root.replaceChildren();
  };
}
