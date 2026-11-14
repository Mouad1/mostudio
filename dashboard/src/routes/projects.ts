import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import {
  createProject,
  latest,
  listWorkflowFiles,
  parseWorkflow,
  pendingApprovals,
  readJson,
  readLedger,
  readProjectWorkflow,
  rmsEnvelope,
  writeOutputAtomic,
  type Workflow,
} from "../../../core/src/index.ts";
import type { DashboardContext } from "../context.ts";
import { requireRoot } from "../context.ts";
import { insideDir, safeFileName, saveStream, uniquePath } from "../files.ts";
import { HttpError, readJsonBody, sendJson, type Router } from "../http.ts";
import { serveFile } from "../static.ts";
import {
  PROJECT_ID_RE,
  UPLOAD_EXTS,
  type ProjectStatus,
  type ProjectSummary,
  type StepView,
  type WorkflowInfo,
} from "../types.ts";

export { PROJECT_ID_RE, UPLOAD_EXTS };
export type { ProjectStatus, ProjectSummary, StepView, WorkflowInfo };

export async function projectDir(ctx: DashboardContext, id: string): Promise<string> {
  if (!PROJECT_ID_RE.test(id)) {
    throw new HttpError(400, "invalid project id");
  }
  const root = requireRoot(ctx);
  const dir = join(root, "projects", id);
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) {
      throw new HttpError(404, "project not found");
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(404, "project not found");
  }
  return dir;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function workflowTitle(name: string): string {
  if (name === "short") return "Short vertical video (Reels, Shorts, TikTok)";
  if (name === "rough-cut") return "Long video (YouTube)";
  return name;
}

function computeLastStatus(status: {
  running: boolean;
  interrupted: string[];
  steps: Record<string, StepView>;
  pending: string[];
}): ProjectSummary["lastStatus"] {
  if (status.running) return "running";
  if (status.interrupted.length > 0) return "interrupted";
  if (Object.values(status.steps).some((s) => s.awaitingApproval)) return "awaiting-approval";
  if (Object.values(status.steps).some((s) => s.status === "fail")) return "failed";
  if (Object.keys(status.steps).length === 0) return "new";
  if (status.pending.length === 0) return "done";
  return "new";
}

export async function getProjectStatus(
  ctx: DashboardContext,
  id: string,
  dir: string,
): Promise<ProjectStatus> {
  const wfName = await readProjectWorkflow(dir);
  let wf: Workflow | undefined;
  if (wfName) {
    try {
      const files = await listWorkflowFiles(ctx.root);
      if (files[wfName]) {
        const json = await readJson(files[wfName]);
        wf = parseWorkflow(
          json,
          Object.keys(ctx.steps).length > 0 ? Object.keys(ctx.steps) : undefined,
        );
      }
    } catch {}
  }

  const ledger = await readLedger(dir);
  let waitingApprovals: Set<string> = new Set();
  if (wf) {
    try {
      const waiting = await pendingApprovals(dir, wf);
      waitingApprovals = new Set(waiting);
    } catch {}
  }

  const steps: Record<string, StepView> = {};
  for (const stepName of Object.keys(ledger.steps)) {
    const r = latest(ledger, stepName);
    if (r) {
      const stepView: StepView = { ...r };
      if (waitingApprovals.has(stepName)) {
        stepView.awaitingApproval = true;
      }
      steps[stepName] = stepView;
    }
  }

  const pending: string[] = [];
  if (wf) {
    for (const s of wf.steps) {
      const r = latest(ledger, s.step);
      if (!r || r.status === "fail") {
        pending.push(s.step);
      }
    }
  }

  // Running: false (until Task 11 job manager)
  const running = false;

  // Interrupted: steps/*.running where pid is dead and no job is running
  const interrupted: string[] = [];
  const stepsDir = join(dir, "steps");
  try {
    const entries = await readdir(stepsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isFile() && ent.name.endsWith(".running")) {
        const stepName = ent.name.slice(0, -".running".length);
        const markerPath = join(stepsDir, ent.name);
        try {
          const marker = await readJson<{ pid?: unknown }>(markerPath);
          const pid = typeof marker?.pid === "number" ? marker.pid : undefined;
          if (pid !== undefined) {
            if (!isPidAlive(pid)) {
              interrupted.push(stepName);
            }
          }
        } catch {}
      }
    }
  } catch {}
  interrupted.sort();

  // Uploads: list files in uploads/
  const uploads: string[] = [];
  const uploadsDir = join(dir, "uploads");
  try {
    const entries = await readdir(uploadsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isFile() && !ent.name.startsWith(".")) {
        uploads.push(ent.name);
      }
    }
  } catch {}
  uploads.sort();

  // Media: if media/ has ingested files or steps/ingest.json has probe info
  let media: ProjectStatus["media"] | undefined;
  try {
    const ingestJson =
      (await readJson<Record<string, unknown>>(join(dir, "media", "ingest.json"))) ??
      (await readJson<Record<string, unknown>>(join(dir, "steps", "ingest.json")));
    if (ingestJson && typeof ingestJson.file === "string") {
      media = {
        file: ingestJson.file,
        durationSec: Number(ingestJson.durationSec ?? 0),
        width: Number(ingestJson.width ?? 0),
        height: Number(ingestJson.height ?? 0),
      };
    }
  } catch {}

  const status: ProjectStatus = {
    id,
    dir,
    steps,
    pending,
    running,
    interrupted,
    uploads,
  };
  if (wfName) {
    status.workflow = wfName;
  }
  if (media) {
    status.media = media;
  }

  return status;
}

export function registerProjectsRoutes(router: Router, ctx: DashboardContext): void {
  // GET /api/workflows
  router.add("GET", "/api/workflows", async (_req, res) => {
    const files = await listWorkflowFiles(ctx.root);
    const workflows: WorkflowInfo[] = [];
    for (const [name, path] of Object.entries(files)) {
      try {
        const json = await readJson(path);
        const known = Object.keys(ctx.steps).length > 0 ? Object.keys(ctx.steps) : undefined;
        const wf = parseWorkflow(json, known);
        workflows.push({
          name,
          title: workflowTitle(name),
          steps: wf.steps.map((s) => ({ step: s.step, approve: Boolean(s.approve) })),
        });
      } catch {}
    }
    sendJson(res, 200, { workflows });
  });

  // GET /api/projects
  router.add("GET", "/api/projects", async (_req, res) => {
    const root = requireRoot(ctx);
    const projectsDir = join(root, "projects");
    let entries: Dirent[] = [];
    try {
      entries = await readdir(projectsDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const projectDirs = entries
      .filter((e) => e.isDirectory() && PROJECT_ID_RE.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a));

    const projects: ProjectSummary[] = [];
    for (const id of projectDirs) {
      const dir = join(projectsDir, id);
      const status = await getProjectStatus(ctx, id, dir);
      projects.push({
        id,
        ...(status.workflow ? { workflow: status.workflow } : {}),
        lastStatus: computeLastStatus(status),
      });
    }
    sendJson(res, 200, { projects });
  });

  // POST /api/projects
  router.add("POST", "/api/projects", async (req, res) => {
    const root = requireRoot(ctx);
    const body = await readJsonBody<{ slug?: unknown; brief?: unknown }>(req);
    if (typeof body?.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.slug)) {
      throw new HttpError(400, "invalid slug");
    }
    const brief = typeof body.brief === "string" ? body.brief : undefined;
    const projectsDir = join(root, "projects");
    let dir: string;
    try {
      dir = await createProject(projectsDir, body.slug, { brief });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new HttpError(409, "project already exists");
      }
      throw err;
    }
    const id = basename(dir);
    const status = await getProjectStatus(ctx, id, dir);
    sendJson(res, 201, status);
  });

  // GET /api/projects/:id
  router.add("GET", "/api/projects/:id", async (_req, res, params) => {
    const id = params.id!;
    const dir = await projectDir(ctx, id);
    const status = await getProjectStatus(ctx, id, dir);
    sendJson(res, 200, status);
  });

  // PUT /api/projects/:id/uploads?name=
  router.add("PUT", "/api/projects/:id/uploads", async (req, res, params, url) => {
    const id = params.id!;
    const dir = await projectDir(ctx, id);
    const rawName = url.searchParams.get("name") || "";
    const name = safeFileName(rawName);
    const ext = extname(name).toLowerCase();
    if (!UPLOAD_EXTS.includes(ext)) {
      throw new HttpError(
        415,
        `mostudio can't use this file type (${ext}). Use a video or audio file.`,
      );
    }
    const uploadsDir = join(dir, "uploads");
    await mkdir(uploadsDir, { recursive: true });
    const targetPath = await uniquePath(uploadsDir, name);
    const sizeBytes = await saveStream(req, targetPath);
    const rel = relative(dir, targetPath).replace(/\\/g, "/");
    sendJson(res, 200, { path: rel, sizeBytes });
  });

  // GET /api/projects/:id/files/*
  router.add("GET", "/api/projects/:id/files/*", async (req, res, params) => {
    const id = params.id!;
    const dir = await projectDir(ctx, id);
    const rel = params["*"];
    if (typeof rel !== "string" || !rel) {
      throw new HttpError(400, "path required");
    }
    const absPath = await insideDir(dir, rel);
    await serveFile(req, res, absPath);
  });

  // GET /api/projects/:id/replacements
  router.add("GET", "/api/projects/:id/replacements", async (_req, res, params) => {
    const id = params.id!;
    const dir = await projectDir(ctx, id);
    const replacementsFile = join(dir, "edits", "replacements.txt");
    let text = "";
    try {
      text = await readFile(replacementsFile, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    sendJson(res, 200, { text });
  });

  // PUT /api/projects/:id/replacements
  router.add("PUT", "/api/projects/:id/replacements", async (req, res, params) => {
    const id = params.id!;
    const dir = await projectDir(ctx, id);
    const body = await readJsonBody<{ text?: unknown }>(req);
    const text = body?.text;
    if (typeof text !== "string") {
      throw new HttpError(400, "invalid replacements text");
    }
    if (Buffer.byteLength(text, "utf8") > 256 * 1024) {
      throw new HttpError(413, "replacements text exceeds 256 KiB");
    }
    const editsDir = join(dir, "edits");
    await mkdir(editsDir, { recursive: true });
    const target = join(editsDir, "replacements.txt");
    await writeOutputAtomic(target, async (tmp) => {
      await writeFile(tmp, text, "utf8");
    });
    sendJson(res, 200, { ok: true });
  });

  // GET /api/projects/:id/peaks
  router.add("GET", "/api/projects/:id/peaks", async (_req, res, params, url) => {
    const id = params.id!;
    const dir = await projectDir(ctx, id);
    const relPath = url.searchParams.get("path");
    if (!relPath) throw new HttpError(400, "path is required");
    if (!relPath.endsWith(".wav")) throw new HttpError(400, "only .wav files supported");

    const bStr = url.searchParams.get("buckets");
    let buckets = 100;
    if (bStr !== null) {
      const parsed = Number(bStr);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2000) {
        throw new HttpError(400, "buckets must be an integer between 1 and 2000");
      }
      buckets = parsed;
    }

    const absPath = await insideDir(dir, relPath);
    try {
      await stat(absPath);
    } catch {
      throw new HttpError(404, "file not found");
    }

    let env: Float32Array;
    try {
      env = await rmsEnvelope(absPath, 10);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }

    if (env.length === 0) {
      sendJson(res, 200, { peaks: new Array(buckets).fill(0) });
      return;
    }

    const bucketValues: number[] = new Array(buckets);
    for (let b = 0; b < buckets; b++) {
      const start = Math.floor((b * env.length) / buckets);
      const end = Math.floor(((b + 1) * env.length) / buckets);
      let maxDb = -96;
      for (let i = start; i < Math.max(start + 1, end); i++) {
        const val = env[i] as number;
        if (val > maxDb) maxDb = val;
      }
      bucketValues[b] = maxDb <= -95.99 ? 0 : Math.pow(10, maxDb / 20);
    }

    const peak = Math.max(...bucketValues);
    const peaks = peak === 0
      ? bucketValues.map(() => 0)
      : bucketValues.map((v) => v / peak);

    sendJson(res, 200, { peaks });
  });
}
