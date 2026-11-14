import type { DashboardContext } from "../context.ts";
import { type Router, sendJson } from "../http.ts";
import type { RunEvent } from "../types.ts";

function formatSse(e: RunEvent): string {
  return `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
}

export function registerEventsRoutes(router: Router, ctx: DashboardContext): void {
  // GET /api/projects/:id/events
  router.add("GET", "/api/projects/:id/events", async (req, res, params, url) => {
    const id = params.id;

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders?.();

    const lastHeader = req.headers["last-event-id"];
    const sinceQuery = url.searchParams.get("since");
    let afterId = 0;
    if (typeof lastHeader === "string" && lastHeader.trim() !== "") {
      const parsed = Number(lastHeader);
      if (!Number.isNaN(parsed)) {
        afterId = parsed;
      }
    } else if (typeof sinceQuery === "string" && sinceQuery.trim() !== "") {
      const parsed = Number(sinceQuery);
      if (!Number.isNaN(parsed)) {
        afterId = parsed;
      }
    }

    const historical = ctx.jobs.events(id, afterId);
    for (const e of historical) {
      res.write(formatSse(e));
    }

    let closed = false;
    let pingTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = undefined;
      }
      unsubscribe();
    };

    const unsubscribe = ctx.jobs.subscribe(id, (e) => {
      if (closed) return;
      try {
        res.write(formatSse(e));
      } catch {
        cleanup();
      }
    });

    pingTimer = setInterval(() => {
      if (closed) return;
      try {
        res.write(": ping\n\n");
      } catch {
        cleanup();
      }
    }, 15_000);
    pingTimer.unref?.();

    req.on("close", cleanup);
    res.on("close", cleanup);
  });

  // POST /api/projects/:id/cancel
  router.add("POST", "/api/projects/:id/cancel", async (_req, res, params) => {
    const id = params.id;
    const cancelled = ctx.jobs.cancel(id);
    sendJson(res, 200, { cancelled });
  });
}
