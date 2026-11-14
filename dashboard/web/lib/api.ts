import type { RunEvent } from "../../src/types.ts";

export class ApiFailure extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function extractError(res: Response): Promise<string> {
  let errText = res.statusText || String(res.status);
  try {
    const json = await res.json();
    if (json && typeof json.error === "string") {
      errText = json.error;
    }
  } catch {}
  return errText;
}

export function createApi(f: typeof fetch = fetch) {
  return {
    async get<T>(path: string): Promise<T> {
      const res = await f(path, { method: "GET" });
      if (!res.ok) {
        throw new ApiFailure(res.status, await extractError(res));
      }
      return (await res.json()) as T;
    },

    async send<T>(
      method: "POST" | "PUT" | "DELETE",
      path: string,
      body?: unknown
    ): Promise<T> {
      const init: RequestInit = { method };
      if (body !== undefined) {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(body);
      }
      const res = await f(path, init);
      if (!res.ok) {
        throw new ApiFailure(res.status, await extractError(res));
      }
      if (res.status === 204) {
        return undefined as T;
      }
      const text = await res.text();
      if (!text) {
        return undefined as T;
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    },

    async text(path: string): Promise<string> {
      const res = await f(path, { method: "GET" });
      if (!res.ok) {
        throw new ApiFailure(res.status, await extractError(res));
      }
      return await res.text();
    },

    async putText(path: string, text: string): Promise<void> {
      const res = await f(path, {
        method: "PUT",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: text,
      });
      if (!res.ok) {
        throw new ApiFailure(res.status, await extractError(res));
      }
    },

    upload<T>(
      path: string,
      file: Blob,
      onProgress: (fraction: number) => void
    ): { done: Promise<T>; abort(): void } {
      if (typeof XMLHttpRequest !== "undefined") {
        const xhr = new XMLHttpRequest();
        const done = new Promise<T>((resolve, reject) => {
          if (xhr.upload) {
            xhr.upload.onprogress = (evt) => {
              if (evt.lengthComputable && evt.total > 0) {
                onProgress(evt.loaded / evt.total);
              }
            };
          }
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                const parsed = xhr.responseText
                  ? JSON.parse(xhr.responseText)
                  : undefined;
                resolve(parsed as T);
              } catch (err) {
                reject(err);
              }
            } else {
              let errText = xhr.statusText || String(xhr.status);
              try {
                const json = JSON.parse(xhr.responseText);
                if (json && typeof json.error === "string") {
                  errText = json.error;
                }
              } catch {}
              reject(new ApiFailure(xhr.status, errText));
            }
          };
          xhr.onerror = () =>
            reject(new ApiFailure(xhr.status || 0, "Network error"));
          xhr.onabort = () => reject(new ApiFailure(0, "Upload aborted"));
          xhr.open("PUT", path, true);
          xhr.send(file);
        });
        return {
          done,
          abort() {
            xhr.abort();
          },
        };
      } else {
        const controller = new AbortController();
        const done = (async () => {
          onProgress(0);
          const res = await f(path, {
            method: "PUT",
            body: file,
            signal: controller.signal,
          });
          if (!res.ok) {
            throw new ApiFailure(res.status, await extractError(res));
          }
          onProgress(1);
          const text = await res.text();
          return (text ? JSON.parse(text) : undefined) as T;
        })();
        return {
          done,
          abort() {
            controller.abort();
          },
        };
      }
    },

    events(projectId: string, onEvent: (e: RunEvent) => void): () => void {
      if (typeof EventSource === "undefined") {
        return () => {};
      }
      const es = new EventSource(`/api/projects/${projectId}/events`);
      const handler = (evt: MessageEvent) => {
        try {
          const data = JSON.parse(evt.data) as RunEvent;
          onEvent(data);
        } catch {}
      };
      es.onmessage = handler;
      const types = [
        "run-start",
        "step-start",
        "log",
        "step-end",
        "approved",
        "run-end",
      ] as const;
      for (const t of types) {
        es.addEventListener(t, handler as EventListener);
      }
      return () => {
        es.close();
      };
    },

    fileUrl(projectId: string, rel: string): string {
      return `/api/projects/${projectId}/files/${rel}`;
    },
  };
}

export type Api = ReturnType<typeof createApi>;
