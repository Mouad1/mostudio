import type { Api } from "../lib/api.ts";
import { h } from "../lib/dom.ts";
import { edlBar, formatTime, type Preview } from "../lib/previews.ts";

export async function renderPreview(
  p: Preview,
  api: Api,
  projectId: string
): Promise<HTMLElement> {
  const container = h("div", {
    class: `preview-pane preview-${p.kind}`,
    "data-kind": p.kind,
  });

  try {
    switch (p.kind) {
      case "media-info": {
        const info = await api.get<Record<string, unknown>>(api.fileUrl(projectId, p.path));
        const grid = h("div", { class: "preview-media-info-grid" });

        const addRow = (label: string, val: unknown) => {
          if (val === undefined || val === null || val === "") return;
          grid.appendChild(
            h(
              "div",
              { class: "preview-info-row" },
              h("span", { class: "preview-info-label" }, label),
              h("span", { class: "preview-info-value" }, String(val))
            )
          );
        };

        if (info.file) addRow("File", info.file);
        if (typeof info.durationSec === "number") {
          addRow("Duration", `${info.durationSec.toFixed(2)}s (${formatTime(info.durationSec)})`);
        }
        if (info.width && info.height) {
          addRow("Resolution", `${info.width}x${info.height}`);
        }
        if (info.fps) addRow("Frame Rate", `${info.fps} fps`);
        if (info.videoCodec) addRow("Video Codec", info.videoCodec);
        if (info.audioCodec) addRow("Audio Codec", info.audioCodec);
        if (info.audioChannels) addRow("Audio Channels", info.audioChannels);
        if (info.hasAudio !== undefined) addRow("Has Audio", info.hasAudio ? "Yes" : "No");

        container.appendChild(grid);
        break;
      }

      case "video": {
        const videoUrl = api.fileUrl(projectId, p.path);
        const video = h("video", {
          class: "preview-video-player",
          controls: true,
          src: videoUrl,
        });
        const toolbar = h(
          "div",
          { class: "preview-video-toolbar" },
          h(
            "button",
            {
              class: "btn-secondary btn-finder",
              onclick: async () => {
                try {
                  await api.send("POST", "/api/show-in-finder", {
                    path: p.path,
                    projectId,
                  });
                } catch (err: any) {
                  console.error("Failed to show in finder:", err);
                }
              },
            },
            "Show in Finder"
          )
        );
        container.appendChild(video);
        container.appendChild(toolbar);
        break;
      }

      case "audio": {
        const audioUrl = api.fileUrl(projectId, p.path);
        const audio = h("audio", {
          class: "preview-audio-player",
          controls: true,
          src: audioUrl,
        });
        const canvas = h("canvas", {
          class: "preview-waveform",
          width: "600",
          height: "80",
        });

        container.appendChild(audio);
        container.appendChild(canvas);

        // Fetch peaks asynchronously
        try {
          const peaksRes = await api.get<{ peaks: number[] }>(
            `/api/projects/${projectId}/peaks?path=${encodeURIComponent(p.path)}&file=${encodeURIComponent(p.path)}&buckets=200`
          );
          if (peaksRes && Array.isArray(peaksRes.peaks) && typeof canvas.getContext === "function") {
            const ctx = canvas.getContext("2d");
            if (ctx) {
              const peaks = peaksRes.peaks;
              const w = 600;
              const h = 80;
              ctx.clearRect(0, 0, w, h);
              ctx.fillStyle = "#FFD400";
              const barWidth = Math.max(1, w / peaks.length);
              for (let i = 0; i < peaks.length; i++) {
                const peak = Math.max(0, Math.min(1, peaks[i] ?? 0));
                const barHeight = peak * h;
                const x = i * barWidth;
                const y = (h - barHeight) / 2;
                ctx.fillRect(x, y, Math.max(1, barWidth - 1), barHeight);
              }
            }
          }
        } catch (err) {
          console.error("Failed to load peaks:", err);
        }
        break;
      }

      case "words": {
        const data = await api.get<any>(api.fileUrl(projectId, p.path));
        const wordsList: Array<{ w?: string; word?: string; start: number; end: number; conf?: number }> =
          Array.isArray(data) ? data : (data?.words ?? []);

        const displayWords = wordsList.slice(0, 300);
        const wordsContainer = h("div", { class: "preview-words-list" });

        for (const item of displayWords) {
          const wordText = item.w ?? item.word ?? "";
          const isLowConf = typeof item.conf === "number" && item.conf < 0.6;
          const wordEl = isLowConf
            ? h("span", { class: "low-conf", title: `Confidence: ${(item.conf! * 100).toFixed(0)}%` }, wordText)
            : h("span", { class: "word-text" }, wordText);

          const timeText = `[${formatTime(item.start)}] `;
          wordsContainer.appendChild(
            h("span", { class: "preview-word-token" }, h("span", { class: "word-time" }, timeText), wordEl, " ")
          );
        }

        if (wordsList.length > 300) {
          wordsContainer.appendChild(
            h("div", { class: "preview-truncated-notice" }, `… and ${wordsList.length - 300} more words`)
          );
        }

        container.appendChild(wordsContainer);
        break;
      }

      case "edl": {
        const edl = await api.get<{
          keep?: { start: number; end: number }[];
          removed?: { start: number; end: number; reason: string }[];
          sourceDurationSec?: number;
          outDurationSec?: number;
        }>(api.fileUrl(projectId, p.path));

        const keep = edl.keep ?? [];
        const removed = edl.removed ?? [];

        const maxEnd = Math.max(
          ...keep.map((k) => k.end),
          ...removed.map((r) => r.end),
          0
        );
        const total = edl.sourceDurationSec ?? maxEnd;
        const segments = edlBar({ keep, removed }, total);

        const barEl = h("div", { class: "edl-bar" });
        for (const seg of segments) {
          barEl.appendChild(
            h("div", {
              class: `edl-segment edl-segment-${seg.kind}`,
              style: `left: ${seg.left.toFixed(2)}%; width: ${seg.width.toFixed(2)}%;`,
              title: `${seg.kind}: ${seg.width.toFixed(1)}%`,
            })
          );
        }

        // Counts by reason
        const reasonCounts: Record<string, number> = {};
        for (const r of removed) {
          const rsn = r.reason || "other";
          reasonCounts[rsn] = (reasonCounts[rsn] || 0) + 1;
        }

        const countsText = Object.entries(reasonCounts)
          .map(([reason, count]) => `${count} ${reason}`)
          .join(", ") || "No cuts";

        const newDuration =
          edl.outDurationSec ?? keep.reduce((sum, k) => sum + (k.end - k.start), 0);

        const statsEl = h(
          "div",
          { class: "edl-stats" },
          h("div", { class: "edl-counts" }, countsText),
          h(
            "div",
            { class: "edl-new-duration" },
            `New duration: ${formatTime(newDuration)} (${newDuration.toFixed(2)}s)`
          )
        );

        container.appendChild(barEl);
        container.appendChild(statsEl);
        break;
      }

      case "units": {
        const data = await api.get<any>(api.fileUrl(projectId, p.path));
        const units: Array<{ id?: number | string; start: number; end: number; text: string; src?: string }> =
          Array.isArray(data) ? data : (data?.units ?? []);

        const unitsList = h("div", { class: "preview-units-list" });
        for (const u of units) {
          unitsList.appendChild(
            h(
              "div",
              { class: "preview-unit-row" },
              h(
                "span",
                { class: "unit-time" },
                `[${formatTime(u.start)} - ${formatTime(u.end)}] `
              ),
              h("span", { class: "unit-text" }, u.text)
            )
          );
        }
        container.appendChild(unitsList);
        break;
      }

      case "captions": {
        const text = await api.text(api.fileUrl(projectId, p.path));
        const lines = text.split("\n").filter((l) => l.trim().length > 0);
        const list = h("div", { class: "preview-captions-list" });
        for (const line of lines) {
          list.appendChild(h("div", { class: "preview-caption-line" }, line));
        }
        container.appendChild(list);
        break;
      }

      case "text": {
        const text = await api.text(api.fileUrl(projectId, p.path));
        let copyNotice: HTMLElement | null = null;
        const copyBtn = h(
          "button",
          {
            class: "btn-secondary btn-copy",
            onclick: async () => {
              try {
                if (typeof navigator !== "undefined" && navigator.clipboard) {
                  await navigator.clipboard.writeText(text);
                  if (copyNotice) copyNotice.textContent = "Copied!";
                }
              } catch (err) {
                console.error("Failed to copy:", err);
              }
            },
          },
          "Copy"
        );
        copyNotice = h("span", { class: "copy-notice" });
        const toolbar = h("div", { class: "preview-text-toolbar" }, copyBtn, copyNotice);
        const pre = h("pre", { class: "preview-text-body" }, text);
        container.appendChild(toolbar);
        container.appendChild(pre);
        break;
      }

      case "image": {
        const img = h("img", {
          class: "preview-image",
          src: api.fileUrl(projectId, p.path),
          alt: p.label,
        });
        container.appendChild(img);
        break;
      }

      case "report": {
        const text = await api.text(api.fileUrl(projectId, p.path));
        const pre = h("pre", { class: "preview-report" }, text);
        container.appendChild(pre);
        break;
      }
    }
  } catch (err: any) {
    container.appendChild(
      h(
        "div",
        { class: "preview-error" },
        h("p", {}, `Failed to load preview for ${p.label}: ${err?.message || String(err)}`)
      )
    );
  }

  return container;
}
