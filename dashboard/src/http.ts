import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export type Req = IncomingMessage;
export type Res = ServerResponse;

export type Handler = (
  req: Req,
  res: Res,
  params: Record<string, string>,
  url: URL,
) => Promise<void> | void;

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, "invalid url encoding");
  }
}

/** Matches pattern with :param and trailing * wildcard; throws HttpError(400) on bad % escape. */
export function matchRoute(pattern: string, path: string): Record<string, string> | undefined {
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  const hasWildcard = patternParts.length > 0 && patternParts[patternParts.length - 1] === "*";

  if (hasWildcard) {
    if (pathParts.length < patternParts.length) return undefined;
  } else {
    if (pathParts.length !== patternParts.length) return undefined;
  }

  const params: Record<string, string> = {};
  const prefixLength = hasWildcard ? patternParts.length - 1 : patternParts.length;

  for (let i = 0; i < prefixLength; i++) {
    const pPart = patternParts[i]!;
    const rawPathPart = pathParts[i]!;
    if (pPart.startsWith(":")) {
      params[pPart.slice(1)] = safeDecode(rawPathPart);
    } else {
      const decoded = safeDecode(rawPathPart);
      if (pPart !== decoded && pPart !== rawPathPart) {
        return undefined;
      }
    }
  }

  if (hasWildcard) {
    const rawRest = pathParts.slice(prefixLength).join("/");
    params["*"] = safeDecode(rawRest);
  }

  return params;
}

export class Router {
  #routes: Array<{ method: string; pattern: string; handler: Handler }> = [];

  add(method: string, pattern: string, handler: Handler): void {
    this.#routes.push({
      method: method.toUpperCase(),
      pattern,
      handler,
    });
  }

  async handle(req: Req, res: Res, url: URL): Promise<boolean> {
    const method = (req.method ?? "GET").toUpperCase();
    for (const route of this.#routes) {
      if (route.method !== method && route.method !== "*") {
        continue;
      }
      const params = matchRoute(route.pattern, url.pathname);
      if (params !== undefined) {
        await route.handler(req, res, params, url);
        return true;
      }
    }
    return false;
  }
}

/** Sends JSON response with nosniff and charset. */
export function sendJson(res: Res, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  res.end(json);
}

/** Reads JSON request body up to maxBytes (default 1 MiB); throws 400 or 413. */
export function readJsonBody<T>(req: Req, maxBytes: number = 1024 * 1024): Promise<T> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];

    function onData(chunk: Buffer) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        cleanup();
        req.destroy();
        reject(new HttpError(413, "payload too large"));
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      cleanup();
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        const parsed = JSON.parse(text) as T;
        resolve(parsed);
      } catch {
        reject(new HttpError(400, "invalid json"));
      }
    }

    function onError(err: Error) {
      cleanup();
      reject(err);
    }

    function cleanup() {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    }

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/** Formats the strict HttpOnly session cookie. */
export function sessionCookie(token: string): string {
  return `mostudio_session=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    cookies[key] = val;
  }
  return cookies;
}

function safeTokenMatch(expected: string, candidate: string | undefined): boolean {
  if (!candidate) return false;
  const expectedBuf = Buffer.from(expected);
  const candidateBuf = Buffer.from(candidate);
  if (expectedBuf.length !== candidateBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, candidateBuf);
}

/** Validates host, origin, and authorization token (header or cookie). */
export function checkAccess(req: Req, port: number, token: string): void {
  // 1. Host check
  const host = req.headers.host;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (port === 80) {
    allowedHosts.add("127.0.0.1");
    allowedHosts.add("localhost");
  }
  if (!host || !allowedHosts.has(host.toLowerCase())) {
    throw new HttpError(403, "forbidden host");
  }

  // 2. Origin check
  const origin = req.headers.origin;
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  if (port === 80) {
    allowedOrigins.add("http://127.0.0.1");
    allowedOrigins.add("http://localhost");
  }
  if (origin) {
    if (!allowedOrigins.has(origin.toLowerCase())) {
      throw new HttpError(403, "forbidden origin");
    }
  }

  // 3. Token check
  const headerToken = typeof req.headers["x-mostudio-token"] === "string"
    ? req.headers["x-mostudio-token"]
    : undefined;
  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies["mostudio_session"];

  const validHeader = safeTokenMatch(token, headerToken);
  const validCookie = safeTokenMatch(token, cookieToken);

  if (!validHeader && !validCookie) {
    throw new HttpError(401, "unauthorized");
  }

  // Mutating methods (POST/PUT/DELETE) require Origin equal to allowed origin (absent allowed only when header token is used)
  const method = (req.method ?? "GET").toUpperCase();
  if (["POST", "PUT", "DELETE", "PATCH"].includes(method)) {
    if (!origin && !validHeader) {
      throw new HttpError(403, "origin required");
    }
  }
}
