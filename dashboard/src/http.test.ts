import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  checkAccess,
  HttpError,
  matchRoute,
  readJsonBody,
  Router,
  sendJson,
  sessionCookie,
} from "./http.ts";

test("matchRoute", () => {
  assert.deepEqual(matchRoute("/api/projects/:id", "/api/projects/2026-a"), { id: "2026-a" });
  assert.deepEqual(matchRoute("/api/projects/:id/files/*", "/api/projects/p/files/a/b%20c.mp4"), { id: "p", "*": "a/b c.mp4" });
  assert.equal(matchRoute("/api/projects/:id", "/api/projects/a/b"), undefined);
  assert.throws(() => matchRoute("/api/projects/:id", "/api/projects/%E0%A4%A"), (e: unknown) => (e as HttpError).status === 400);
});

test("Router handles matching route and ignores non-matching", async () => {
  const router = new Router();
  let called = false;
  let receivedParams: Record<string, string> = {};

  router.add("GET", "/api/items/:id", (_req, _res, params) => {
    called = true;
    receivedParams = params;
  });

  const reqGet = { method: "GET" } as http.IncomingMessage;
  const reqPost = { method: "POST" } as http.IncomingMessage;
  const res = {} as http.ServerResponse;

  // Different method -> not handled
  const handledPost = await router.handle(reqPost, res, new URL("http://127.0.0.1/api/items/42"));
  assert.equal(handledPost, false);
  assert.equal(called, false);

  // Matching route -> handled
  const handledGet = await router.handle(reqGet, res, new URL("http://127.0.0.1/api/items/42"));
  assert.equal(handledGet, true);
  assert.equal(called, true);
  assert.deepEqual(receivedParams, { id: "42" });
});

test("sendJson sends JSON with security headers", async () => {
  let statusCode = 0;
  let headers: Record<string, string> = {};
  let payload = "";

  const res = {
    writeHead(status: number, h: Record<string, string>) {
      statusCode = status;
      headers = h;
      return this;
    },
    end(data?: string) {
      payload = data ?? "";
      return this;
    },
  } as unknown as http.ServerResponse;

  sendJson(res, 201, { ok: true });
  assert.equal(statusCode, 201);
  assert.equal(headers["content-type"], "application/json; charset=utf-8");
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(payload, JSON.stringify({ ok: true }));
});

test("readJsonBody parses valid JSON, rejects malformed and oversized payloads", async () => {
  // Valid JSON
  const validStream = Readable.from([Buffer.from(JSON.stringify({ greeting: "hello" }))]) as http.IncomingMessage;
  const parsed = await readJsonBody<{ greeting: string }>(validStream);
  assert.deepEqual(parsed, { greeting: "hello" });

  // Malformed JSON -> 400
  const malformedStream = Readable.from([Buffer.from("not valid json")]) as http.IncomingMessage;
  await assert.rejects(
    () => readJsonBody(malformedStream),
    (err: unknown) => (err as HttpError).status === 400,
  );

  // Oversized payload -> 413
  const largeStream = Readable.from([Buffer.alloc(200)]) as http.IncomingMessage;
  await assert.rejects(
    () => readJsonBody(largeStream, 100),
    (err: unknown) => (err as HttpError).status === 413,
  );
});

test("sessionCookie formats strict HttpOnly cookie", () => {
  const cookie = sessionCookie("tok_secret_123");
  assert.equal(cookie, "mostudio_session=tok_secret_123; HttpOnly; SameSite=Strict; Path=/");
});

test("checkAccess validates Host, Origin, and Token", () => {
  const port = 4317;
  const token = "secret_token_123";

  // Allowed Host and header token
  const validReq = {
    method: "GET",
    headers: {
      host: `127.0.0.1:${port}`,
      "x-mostudio-token": token,
    },
  } as unknown as http.IncomingMessage;
  assert.doesNotThrow(() => checkAccess(validReq, port, token));

  // Foreign Host -> 403
  const badHostReq = {
    method: "GET",
    headers: {
      host: `attacker.com:${port}`,
      "x-mostudio-token": token,
    },
  } as unknown as http.IncomingMessage;
  assert.throws(() => checkAccess(badHostReq, port, token), (e: unknown) => (e as HttpError).status === 403);

  // Foreign Origin -> 403
  const badOriginReq = {
    method: "POST",
    headers: {
      host: `127.0.0.1:${port}`,
      origin: "https://evil.test",
      "x-mostudio-token": token,
    },
  } as unknown as http.IncomingMessage;
  assert.throws(() => checkAccess(badOriginReq, port, token), (e: unknown) => (e as HttpError).status === 403);

  // Missing token -> 401
  const missingTokenReq = {
    method: "GET",
    headers: {
      host: `127.0.0.1:${port}`,
    },
  } as unknown as http.IncomingMessage;
  assert.throws(() => checkAccess(missingTokenReq, port, token), (e: unknown) => (e as HttpError).status === 401);

  // Cookie token passes
  const cookieReq = {
    method: "GET",
    headers: {
      host: `localhost:${port}`,
      cookie: `mostudio_session=${token}; other=abc`,
    },
  } as unknown as http.IncomingMessage;
  assert.doesNotThrow(() => checkAccess(cookieReq, port, token));

  // Mutating method with cookie but no Origin -> 403
  const mutatingNoOriginReq = {
    method: "POST",
    headers: {
      host: `127.0.0.1:${port}`,
      cookie: `mostudio_session=${token}`,
    },
  } as unknown as http.IncomingMessage;
  assert.throws(() => checkAccess(mutatingNoOriginReq, port, token), (e: unknown) => (e as HttpError).status === 403);

  // Mutating method with cookie AND matching Origin -> 200/passes
  const mutatingWithOriginReq = {
    method: "POST",
    headers: {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      cookie: `mostudio_session=${token}`,
    },
  } as unknown as http.IncomingMessage;
  assert.doesNotThrow(() => checkAccess(mutatingWithOriginReq, port, token));
});
