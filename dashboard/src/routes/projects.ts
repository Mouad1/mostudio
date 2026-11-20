import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import {
  acceptedSteps,
  createProject,
  latest,
  listWorkflowFiles,
  loadLayeredEnv,
  parseWorkflow,
  pendingApprovals,
  readJson,
  readLedger,
  readProjectWorkflow,
  rmsEnvelope,
  stepParams,
  writeOutputAtomic,
  type Workflow,
} from "../../../core/src/index.ts";
import type { DashboardContext } from "../context.ts";
import { requireRoot } from "../context.ts";
import { ensureReadableMedia, insideDir, safeFileName, saveStream, uniquePath } from "../files.ts";
import { HttpError, readJsonBody, sendJson, type Router } from "../http.ts";
import { serveFile } from "../static.ts";
import {
  PROJECT_ID_RE,
  UPLOAD_EXTS,
  type ProjectState,
  type ProjectStatus,
  type ProjectSummary,
  type StepView,
  type WorkflowInfo,
} from "../types.ts";

export { PROJECT_ID_RE, UPLOAD_EXTS };
export type { ProjectState, ProjectStatus, ProjectSummary, StepView, WorkflowInfo };

/** How many same-name projects one day can hold (<slug>, <slug>-2 … <slug>-999). */
const MAX_SLUG_SUFFIX = 999;

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

/** Folders a new project starts with (core `createProject`) plus `uploads/`; all must be empty. */
const EMPTY_DIRS = new Set(["media", "cache", "scenes", "renders", "steps", "uploads"]);

/**
 * True when the project holds nothing but what `createProject` wrote: `brief.md`,
 * `edits/replacements.txt` and empty folders. Any other entry (an upload, even one still being
 * written, media, step results, `run.json`) means it is not untouched.
 */
async function isUntouchedProject(dir: string): Promise<boolean> {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.name === "brief.md" && ent.isFile()) continue;
    if (ent.name === "edits" && ent.isDirectory()) {
      const inside = await readdir(join(dir, "edits"), { withFileTypes: true });
      if (inside.every((e) => e.name === "replacements.txt" && e.isFile())) continue;
      return false;
    }
    if (EMPTY_DIRS.has(ent.name) && ent.isDirectory()) {
      if ((await readdir(join(dir, ent.name))).length === 0) continue;
    }
    return false;
  }
  return true;
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

/**
 * The one place a project's state is derived. The project list (`lastStatus`) and the project page
 * (`ProjectStatus.state`) both use it, so they can't disagree. `awaitingApproval` on a step comes
 * from core `pendingApprovals`, the same check `mostudio status` uses.
 */
export function computeProjectState(status: {
  running: boolean;
  interrupted: string[];
  steps: Record<string, StepView>;
  pending: string[];
}): ProjectState {
  if (status.running) return "running";
  if (status.interrupted.length > 0) return "interrupted";
  if (Object.values(status.steps).some((s) => s.awaitingApproval)) return "awaiting-approval";
  if (Object.values(status.steps).some((s) => s.status === "fail" && !s.accepted)) return "failed";
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

  const accepted = await acceptedSteps(dir).catch(() => new Set<string>());
  const steps: Record<string, StepView> = {};
  for (const stepName of Object.keys(ledger.steps)) {
    const r = latest(ledger, stepName);
    if (r) {
      const stepView: StepView = { ...r };
      if (waitingApprovals.has(stepName)) {
        stepView.awaitingApproval = true;
      }
      if (accepted.has(stepName)) {
        stepView.accepted = true;
      }
      steps[stepName] = stepView;
    }
  }

  const pending: string[] = [];
  if (wf) {
    for (const s of wf.steps) {
      const r = latest(ledger, s.step);
      if (!r || (r.status === "fail" && !accepted.has(s.step))) {
        pending.push(s.step);
      }
    }
  }

  const running = ctx.jobs.isRunning(id);

  // Interrupted: steps/*.running where pid is dead and no job is running
  const interrupted: string[] = [];
  if (!running) {
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
  }

  // Uploads: project-relative paths ("uploads/<name>", the same form PUT /uploads returns and
  // POST /run takes as `source`), newest first so the latest upload is uploads[0].
  const found: { path: string; mtimeMs: number }[] = [];
  const uploadsDir = join(dir, "uploads");
  try {
    const entries = await readdir(uploadsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isFile() && !ent.name.startsWith(".")) {
        const { mtimeMs } = await stat(join(uploadsDir, ent.name));
        found.push({ path: `uploads/${ent.name}`, mtimeMs });
      }
    }
  } catch {}
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  const uploads = found.map((f) => f.path);

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
        ...(typeof ingestJson.hasVideo === "boolean" ? { hasVideo: ingestJson.hasVideo } : {}),
      };
    }
  } catch {}

  const status: ProjectStatus = {
    id,
    dir,
    steps,
    pending,
    running,
    state: computeProjectState({ running, interrupted, steps, pending }),
    interrupted,
    uploads,
  };
  if (wfName) {
    status.workflow = wfName;
  }
  if (wf) {
    // What the next run uses unless told otherwise (workflow defaults + params remembered from earlier runs).
    const params: Record<string, Record<string, unknown>> = {};
    for (const s of wf.steps) {
      try {
        const p = await stepParams(dir, wf, s.step);
        if (Object.keys(p).length > 0) params[s.step] = p;
      } catch {}
    }
    if (Object.keys(params).length > 0) status.params = params;
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
    // Newest first: the date in the id, then the folder's creation time for projects made the same day.
    const dated = await Promise.all(
      entries
        .filter((e) => e.isDirectory() && PROJECT_ID_RE.test(e.name))
        .map(async (e) => ({ id: e.name, born: (await stat(join(projectsDir, e.name))).birthtimeMs })),
    );
    const projectDirs = dated
      .sort((a, b) => b.id.slice(0, 10).localeCompare(a.id.slice(0, 10)) || b.born - a.born || b.id.localeCompare(a.id))
      .map((p) => p.id);

    const projects: ProjectSummary[] = [];
    for (const id of projectDirs) {
      const dir = join(projectsDir, id);
      const status = await getProjectStatus(ctx, id, dir);
      projects.push({
        id,
        ...(status.workflow ? { workflow: status.workflow } : {}),
        lastStatus: status.state,
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
    // A new upload must always get its own project: the same file name on the same day becomes
    // <slug>-2, <slug>-3, … instead of a refusal.
    let dir: string | undefined;
    for (let n = 1; n <= MAX_SLUG_SUFFIX && !dir; n++) {
      const slug = n === 1 ? body.slug : `${body.slug}-${n}`;
      try {
        dir = await createProject(projectsDir, slug, { brief });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    if (!dir) {
      throw new HttpError(409, "Too many projects with this name today. Rename the file and try again.");
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

  // DELETE /api/projects/:id — only for a project nothing has happened to yet (the one a refused
  // or cancelled first upload leaves behind). Anything with uploads, media or results is refused.
  router.add("DELETE", "/api/projects/:id", async (_req, res, params) => {
    const id = params.id!;
    const dir = await projectDir(ctx, id);
    if (ctx.jobs.isRunning(id) || !(await isUntouchedProject(dir))) {
      throw new HttpError(409, "This project already has files or results, so it was not deleted.");
    }
    await rm(dir, { recursive: true, force: true });
    sendJson(res, 200, { ok: true });
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
    const { env } = loadLayeredEnv({ home: ctx.home, root: requireRoot(ctx), processEnv: ctx.processEnv });
    await ensureReadableMedia(targetPath, env);
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
