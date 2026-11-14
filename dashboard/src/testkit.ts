import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DashboardContext } from "./context.ts";
import { startDashboard, type DashboardOptions } from "./server.ts";
import type { RunEvent } from "./types.ts";

export type TestDashboardOptions = DashboardOptions & {
  noWorkspace?: boolean;
};

export function rawRequest(
  port: string | number,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: Number(port),
        method,
        path,
        headers,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

export async function startTestDashboard(o: TestDashboardOptions = {}): Promise<{
  base: string;
  token: string;
  ws: string;
  home: string;
  ctx: DashboardContext;
  api(path: string, init?: RequestInit): Promise<Response>;
  idle(id?: string): Promise<void>;
  events(id?: string): RunEvent[];
  close(): Promise<void>;
}> {
  const home = o.home ?? mkdtempSync(join(tmpdir(), "mostudio-home-"));
  let ws = o.root;
  if (!ws && !o.noWorkspace) {
    ws = mkdtempSync(join(tmpdir(), "mostudio-ws-"));
    writeFileSync(join(ws, "mostudio.config.json"), JSON.stringify({ billing: "free-only" }));
    mkdirSync(join(ws, "workflows"), { recursive: true });
    writeFileSync(join(ws, "workflows", "t.json"), JSON.stringify({ steps: [] }));
  }

  const d = await startDashboard({
    ...o,
    home,
    root: ws,
    port: o.port ?? 0,
  });

  const api = (path: string, init?: RequestInit): Promise<Response> => {
    const p = path.startsWith("/") ? path : `/${path}`;
    const url = `${d.url}${p}`;
    const headers = new Headers(init?.headers);
    if (!headers.has("origin")) {
      headers.set("origin", d.url);
    }
    if (!headers.has("x-mostudio-token")) {
      headers.set("x-mostudio-token", d.token);
    }
    return (o.fetch ?? fetch)(url, { ...init, headers });
  };

  const close = async (): Promise<void> => {
    await d.close();
    try {
      rmSync(home, { recursive: true, force: true });
      if (ws && !o.root && !o.noWorkspace) {
        rmSync(ws, { recursive: true, force: true });
      }
    } catch {}
  };

  return {
    base: d.url,
    token: d.token,
    ws: ws ?? "",
    home,
    ctx: d.ctx,
    api,
    idle: async (id?: string) => {
      if (id) {
        await d.ctx.jobs.idle(id);
      } else {
        await Promise.all(d.ctx.jobs.runningIds().map((i) => d.ctx.jobs.idle(i)));
      }
    },
    events: (id?: string) => (id ? d.ctx.jobs.events(id) : []),
    close,
  };
}
