import type {
  InspirationFile,
  InspirationKind,
  InspirationLink,
  InspirationShelf,
} from "../../src/types.ts";
import type { Api } from "../lib/api.ts";
import { h } from "../lib/dom.ts";
import { extractUrls, shelfCopy } from "../lib/inspiration.ts";
import { formatBytes } from "../lib/studio.ts";
import { errorBox } from "./error-box.ts";

interface Toast {
  id: string;
  message: string;
  url: string;
  kind: InspirationKind;
  note?: string;
}

export function mount(root: HTMLElement, api: Api): () => void {
  let mounted = true;
  let shelves: InspirationShelf[] = [];
  let loading = true;
  let generalError: string | null = null;
  let pasteError: string | null = null;
  let isAdding = false;
  let toasts: Toast[] = [];
  let activeUploads: Record<InspirationKind, { total: number; done: number }> = {
    shorts: { total: 0, done: 0 },
    long: { total: 0, done: 0 },
  };

  async function loadShelves() {
    try {
      const res = await api.get<{ shelves: InspirationShelf[] }>("/api/inspiration");
      if (!mounted) return;
      shelves = res.shelves || [];
      loading = false;
      generalError = null;
      render();
    } catch (err: any) {
      if (!mounted) return;
      loading = false;
      generalError = err?.message || "Failed to load inspiration shelves";
      render();
    }
  }

  function addToast(toast: Toast) {
    toasts.push(toast);
    render();
    setTimeout(() => {
      if (!mounted) return;
      toasts = toasts.filter((t) => t.id !== toast.id);
      render();
    }, 8000);
  }

  function removeToast(id: string) {
    toasts = toasts.filter((t) => t.id !== id);
    render();
  }

  async function handleMoveLink(toast: Toast) {
    const fromKind = toast.kind;
    const targetKind: InspirationKind = fromKind === "shorts" ? "long" : "shorts";
    try {
      await api.send("DELETE", "/api/inspiration/links", {
        url: toast.url,
        kind: fromKind,
      });
      await api.send("POST", "/api/inspiration/links", {
        url: toast.url,
        kind: targetKind,
        note: toast.note,
      });
      removeToast(toast.id);
      const targetTitle = targetKind === "shorts" ? "Short-form" : "Long-form";
      addToast({
        id: String(Date.now() + Math.random()),
        message: `Moved to ${targetTitle}`,
        url: toast.url,
        kind: targetKind,
        note: toast.note,
      });
      await loadShelves();
    } catch (err: any) {
      pasteError = err?.message || "Failed to move link";
      render();
    }
  }

  async function handlePasteSubmit(text: string, textareaEl: HTMLTextAreaElement) {
    pasteError = null;
    const urls = extractUrls(text);
    if (urls.length === 0) {
      if (text.trim().length > 0) {
        pasteError = "Only web links (http or https) can be added";
        render();
      }
      return;
    }

    isAdding = true;
    render();

    try {
      for (const url of urls) {
        try {
          const res = await api.send<{ kind: InspirationKind; link: InspirationLink }>(
            "POST",
            "/api/inspiration/links",
            { url }
          );
          const kindTitle = res.kind === "shorts" ? "Short-form" : "Long-form";
          addToast({
            id: String(Date.now() + Math.random()),
            message: `Added to ${kindTitle}`,
            url: res.link.url,
            kind: res.kind,
            note: res.link.note,
          });
        } catch (err: any) {
          pasteError = err?.message || `Failed to add ${url}`;
        }
      }
      if (textareaEl) {
        textareaEl.value = "";
      }
      await loadShelves();
    } finally {
      isAdding = false;
      render();
    }
  }

  async function handleFileUpload(kind: InspirationKind, files: FileList | File[]) {
    if (!files || files.length === 0) return;
    const fileList = Array.from(files);
    activeUploads[kind] = { total: fileList.length, done: 0 };
    render();

    try {
      for (const file of fileList) {
        const uploadUrl = `/api/inspiration/${kind}/files?name=${encodeURIComponent(file.name)}`;
        const handle = api.upload<InspirationFile>(uploadUrl, file, () => {});
        await handle.done;
        activeUploads[kind].done++;
        render();
      }
      await loadShelves();
    } catch (err: any) {
      generalError = err?.message || "Failed to upload file";
    } finally {
      activeUploads[kind] = { total: 0, done: 0 };
      render();
    }
  }

  function renderToasts(): HTMLElement | null {
    if (toasts.length === 0) return null;

    const items = toasts.map((t) => {
      const msg = h("span", { class: "inspiration-toast-msg" }, t.message);
      const moveBtn = h(
        "button",
        {
          type: "button",
          class: "btn btn-secondary btn-toast-move",
          onClick: () => handleMoveLink(t),
        },
        "Move"
      );
      const dismissBtn = h(
        "button",
        {
          type: "button",
          class: "btn-toast-dismiss",
          "aria-label": "Dismiss",
          onClick: () => removeToast(t.id),
        },
        "×"
      );
      return h("div", { class: "inspiration-toast" }, msg, moveBtn, dismissBtn);
    });

    return h("div", { class: "inspiration-toast-container", "aria-live": "polite" }, ...items);
  }

  function renderPasteSection(): HTMLElement {
    let textareaEl: HTMLTextAreaElement;

    textareaEl = h("textarea", {
      class: "inspiration-paste-input",
      placeholder: "Paste one or more links",
      rows: "3",
      onkeydown: (evt: any) => {
        if ((evt.metaKey || evt.ctrlKey) && evt.key === "Enter") {
          evt.preventDefault?.();
          handlePasteSubmit(textareaEl.value, textareaEl);
        }
      },
    }) as HTMLTextAreaElement;

    const addBtn = h(
      "button",
      {
        type: "button",
        class: "btn btn-primary btn-add-links",
        disabled: isAdding,
        onClick: () => handlePasteSubmit(textareaEl.value, textareaEl),
      },
      isAdding ? "Adding…" : "Add links"
    );

    const pasteBox = h(
      "div",
      { class: "inspiration-paste-box" },
      textareaEl,
      h("div", { class: "inspiration-paste-actions" }, addBtn)
    );

    const children: (Node | string)[] = [pasteBox];
    if (pasteError) {
      children.push(h("div", { class: "inspiration-paste-error" }, errorBox(pasteError)));
    }

    return h("section", { class: "inspiration-paste-section" }, ...children);
  }

  function renderDropzone(kind: InspirationKind): HTMLElement {
    const uploadState = activeUploads[kind];
    const isUploading = uploadState.total > 0;

    const fileInput = h("input", {
      type: "file",
      multiple: true,
      class: "inspiration-file-input",
      style: "display: none;",
      onChange: (evt: Event) => {
        const input = evt.target as HTMLInputElement;
        if (input.files && input.files.length > 0) {
          handleFileUpload(kind, input.files);
        }
      },
    }) as HTMLInputElement;

    const dropzone = h(
      "div",
      {
        class: `inspiration-dropzone ${isUploading ? "uploading" : ""}`,
        role: "button",
        tabindex: "0",
        "aria-label": `Upload files to ${kind}`,
        onClick: (evt: Event) => {
          if (isUploading) return;
          if (evt.target !== fileInput) {
            fileInput.click();
          }
        },
        onkeydown: (evt: any) => {
          if (isUploading) return;
          if (evt.key === "Enter" || evt.key === " ") {
            evt.preventDefault?.();
            fileInput.click();
          }
        },
        ondragover: (evt: any) => {
          evt.preventDefault?.();
          dropzone.classList.add("drag-over");
        },
        ondragleave: () => {
          dropzone.classList.remove("drag-over");
        },
        ondrop: (evt: any) => {
          evt.preventDefault?.();
          dropzone.classList.remove("drag-over");
          if (evt.dataTransfer?.files?.length) {
            handleFileUpload(kind, evt.dataTransfer.files);
          }
        },
      },
      fileInput,
      isUploading
        ? h(
            "div",
            { class: "dropzone-uploading-text" },
            `Uploading file ${uploadState.done + 1} of ${uploadState.total}…`
          )
        : h(
            "div",
            { class: "dropzone-idle-content" },
            h("span", { class: "dropzone-icon", "aria-hidden": "true" }, "↑"),
            h("span", { class: "dropzone-text" }, "Drop clips or notes here, or browse")
          )
    );

    return dropzone;
  }

  function renderShelf(kind: InspirationKind): HTMLElement {
    const copy = shelfCopy(kind);
    const shelf = shelves.find((s) => s.kind === kind) ?? {
      kind,
      folder: "",
      links: [],
      files: [],
    };

    // Header
    const titleEl = h("h2", { class: "shelf-title" }, copy.title);
    const acceptsEl = h("p", { class: "shelf-accepts" }, copy.accepts);

    const finderBtn = h(
      "button",
      {
        type: "button",
        class: "btn btn-secondary btn-show-finder",
        disabled: !shelf.folder,
        onClick: async () => {
          if (!shelf.folder) return;
          try {
            await api.send("POST", "/api/show-in-finder", { path: shelf.folder });
          } catch (err: any) {
            generalError = err?.message || "Failed to show folder in Finder";
            render();
          }
        },
      },
      "Show folder in Finder"
    );

    const shelfHeader = h(
      "header",
      { class: "shelf-header" },
      h("div", { class: "shelf-header-text" }, titleEl, acceptsEl),
      finderBtn
    );

    // Dropzone
    const dropzone = renderDropzone(kind);

    // Links section
    const linksHeader = h(
      "h3",
      { class: "shelf-section-heading" },
      `Links (${shelf.links.length})`
    );

    let linksContent: HTMLElement;
    if (shelf.links.length === 0) {
      linksContent = h("div", { class: "shelf-empty-state" }, "No links yet");
    } else {
      const linkItems = shelf.links.map((link) => {
        const platformBadge = h(
          "span",
          { class: `badge badge-platform badge-${link.platform}` },
          link.platform
        );
        const urlLink = h(
          "a",
          {
            href: link.url,
            class: "inspiration-link-url",
            target: "_blank",
            rel: "noopener noreferrer",
          },
          link.url
        );
        const noteEl = link.note
          ? h("span", { class: "inspiration-link-note" }, link.note)
          : null;

        const removeBtn = h(
          "button",
          {
            type: "button",
            class: "btn btn-secondary btn-remove-link",
            "aria-label": `Remove ${link.url}`,
            onClick: async () => {
              try {
                await api.send("DELETE", "/api/inspiration/links", {
                  url: link.url,
                  kind,
                });
                await loadShelves();
              } catch (err: any) {
                generalError = err?.message || "Failed to remove link";
                render();
              }
            },
          },
          "Remove"
        );

        const leftContent: (Node | string)[] = [platformBadge, urlLink];
        if (noteEl) leftContent.push(noteEl);

        return h(
          "div",
          { class: "inspiration-link-item" },
          h("div", { class: "inspiration-link-info" }, ...leftContent),
          removeBtn
        );
      });

      linksContent = h("div", { class: "inspiration-link-list" }, ...linkItems);
    }

    const linksSection = h(
      "section",
      { class: "shelf-links-section" },
      linksHeader,
      linksContent
    );

    // Files section
    const filesHeader = h(
      "h3",
      { class: "shelf-section-heading" },
      `Files (${shelf.files.length})`
    );

    let filesContent: HTMLElement;
    if (shelf.files.length === 0) {
      filesContent = h("div", { class: "shelf-empty-state" }, "No files yet");
    } else {
      const fileItems = shelf.files.map((file) => {
        const nameEl = h("span", { class: "inspiration-file-name" }, file.name);
        const sizeEl = h(
          "span",
          { class: "inspiration-file-size" },
          formatBytes(file.sizeBytes)
        );

        const removeBtn = h(
          "button",
          {
            type: "button",
            class: "btn btn-secondary btn-remove-file",
            "aria-label": `Remove ${file.name}`,
            onClick: async () => {
              try {
                await api.send("DELETE", "/api/inspiration/files", {
                  path: file.path,
                });
                await loadShelves();
              } catch (err: any) {
                generalError = err?.message || "Failed to remove file";
                render();
              }
            },
          },
          "Remove"
        );

        return h(
          "div",
          { class: "inspiration-file-item" },
          h("div", { class: "inspiration-file-info" }, nameEl, sizeEl),
          removeBtn
        );
      });

      filesContent = h("div", { class: "inspiration-file-list" }, ...fileItems);
    }

    const filesSection = h(
      "section",
      { class: "shelf-files-section" },
      filesHeader,
      filesContent
    );

    return h(
      "div",
      { class: `inspiration-shelf shelf-${kind}`, "data-kind": kind },
      shelfHeader,
      dropzone,
      linksSection,
      filesSection
    );
  }

  function render() {
    if (!mounted) return;

    const header = h(
      "header",
      { class: "inspiration-header" },
      h("h1", { class: "view-heading" }, "Inspiration"),
      h(
        "p",
        { class: "inspiration-intro" },
        "Save videos you like. mostudio keeps them in your folder for reference."
      )
    );

    const toastsEl = renderToasts();
    const pasteSection = renderPasteSection();

    const errorEl = generalError
      ? h("div", { class: "inspiration-error" }, errorBox(generalError))
      : null;

    const shelvesContainer = h(
      "div",
      { class: "inspiration-shelves" },
      renderShelf("shorts"),
      renderShelf("long")
    );

    const children: (Node | string)[] = [header];
    if (toastsEl) children.push(toastsEl);
    if (errorEl) children.push(errorEl);
    children.push(pasteSection, shelvesContainer);

    const container = h("div", { class: "view-container inspiration-view" }, ...children);
    root.replaceChildren(container);
  }

  loadShelves();

  return () => {
    mounted = false;
    root.replaceChildren();
  };
}
