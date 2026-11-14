import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { stripTypeScriptTypes } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createRedactor,
  loadEnvFile,
  PACKAGE_ROOT,
  runBin,
  type StepModule,
} from "../../core/src/index.ts";
import type { DashboardContext } from "./context.ts";
import {
  checkAccess,
  HttpError,
  Router,
  sendJson,
  sessionCookie,
} from "./http.ts";
import { registerFinderRoutes } from "./routes/finder.ts";
import { registerInspirationRoutes } from "./routes/inspiration.ts";
import { serveWeb } from "./static.ts";

export type DashboardOptions = {
  home?: string;
  root?: string;
  port?: number;
  steps?: Record<string, StepModule>;
  processEnv?: Record<string, string>;
  fetch?: typeof fetch;
  token?: string;
  packaged?: boolean;
  openPath?: DashboardContext["openPath"];
  testRoutes?: (router: Router) => void;
};

function tryListen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    function onError(err: Error) {
      cleanup();
      reject(err);
    }
    function onListening() {
      cleanup();
      resolve();
    }
    function cleanup() {
      server.off("error", onError);
      server.off("listening", onListening);
    }
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function bindServer(server: Server, requestedPort?: number): Promise<void> {
  const host = "127.0.0.1";
  if (requestedPort !== undefined) {
    await tryListen(server, requestedPort, host);
    return;
  }
  const ports = [4317, 4318, 4319, 4320, 4321, 4322, 4323, 4324, 4325, 4326, 4327, 0];
  for (const port of ports) {
    try {
      await tryListen(server, port, host);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        continue;
      }
      throw err;
    }
  }
}

function safeTokenMatch(expected: string, candidate: string | null): boolean {
  if (!candidate) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(candidate);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function startDashboard(o: DashboardOptions = {}): Promise<{
  url: string;
  port: number;
  token: string;
  ctx: DashboardContext;
  close(): Promise<void>;
}> {
  // Trigger experimental strip-types warning once on startup
  try {
    stripTypeScriptTypes("");
  } catch {}

  let version = "0.0.0";
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
    if (pkg && typeof pkg.version === "string") {
      version = pkg.version;
    }
  } catch {}

  const token = o.token ?? crypto.randomBytes(24).toString("hex");

  const ctx: DashboardContext = {
    home: o.home ?? process.env.MOSTUDIO_HOME ?? join(homedir(), ".mostudio"),
    root: o.root,
    port: 0,
    token,
    packaged: o.packaged ?? false,
    version,
    steps: o.steps ?? {},
    processEnv: o.processEnv ?? (process.env as Record<string, string>),
    fetch: o.fetch ?? fetch,
    openPath:
      o.openPath ??
      (async (p: string, reveal: boolean) => {
        await runBin("open", reveal ? ["-R", p] : [p]);
      }),
  };

  const router = new Router();

  // GET /?t=<token> -> 302 with cookie or 401 expired; without t -> serveWeb (index.html)
  router.add("GET", "/", async (req, res, _params, url) => {
    if (url.searchParams.has("t")) {
      const queryToken = url.searchParams.get("t");
      if (safeTokenMatch(ctx.token, queryToken)) {
        res.writeHead(302, {
          location: "/",
          "set-cookie": sessionCookie(ctx.token),
          "x-content-type-options": "nosniff",
        });
        res.end();
      } else {
        res.writeHead(401, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
        });
        res.end(
          "<!DOCTYPE html><html><body><p>This link has expired. Close this tab and start mostudio again.</p></body></html>",
        );
      }
      return;
    }
    const handled = await serveWeb(req, res, url);
    if (!handled) {
      res.writeHead(404, { "x-content-type-options": "nosniff" });
      res.end("Not Found");
    }
  });

  // GET /api/health -> 200 { ok: true, version, root: ctx.root ?? null }
  router.add("GET", "/api/health", (_req, res) => {
    sendJson(res, 200, {
      ok: true,
      version: ctx.version,
      root: ctx.root ?? null,
    });
  });

  registerInspirationRoutes(router, ctx);
  registerFinderRoutes(router, ctx);

  if (o.testRoutes) {
    o.testRoutes(router);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? `127.0.0.1:${ctx.port}`;
      const parsedUrl = new URL(req.url ?? "/", `http://${host}`);

      // All /api/* endpoints require access check
      if (parsedUrl.pathname.startsWith("/api/")) {
        checkAccess(req, ctx.port, ctx.token);
      }

      let handled = await router.handle(req, res, parsedUrl);
      if (!handled) {
        const method = (req.method ?? "GET").toUpperCase();
        if ((method === "GET" || method === "HEAD") && !parsedUrl.pathname.startsWith("/api/")) {
          handled = await serveWeb(req, res, parsedUrl);
        }
      }
      if (!handled) {
        if (parsedUrl.pathname.startsWith("/api/")) {
          sendJson(res, 404, { error: "not found" });
        } else {
          res.writeHead(404, { "x-content-type-options": "nosniff" });
          res.end("Not Found");
        }
      }
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
      } else {
        const redactor = createRedactor([
          ctx.processEnv,
          loadEnvFile(join(ctx.home, ".env")),
          ctx.root ? loadEnvFile(join(ctx.root, ".env.local")) : undefined,
        ]);
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, { error: redactor.redact(msg) });
      }
    }
  });

  await bindServer(server, o.port);
  const boundPort = (server.address() as AddressInfo).port;
  ctx.port = boundPort;
  const url = `http://127.0.0.1:${boundPort}`;

  return {
    url,
    port: boundPort,
    token: ctx.token,
    ctx,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
