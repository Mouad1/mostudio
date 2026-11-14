import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  approveStep,
  checkParams,
  createRedactor,
  listWorkflowFiles,
  parseWorkflow,
  readAppSettings,
  readJson,
  readProjectWorkflow,
  recordStep,
  runStep,
  runWorkflow,
  stepParams,
  writeJsonAtomic,
  type StepResult,
  type Workflow,
} from "../../../core/src/index.ts";
import type { DashboardContext } from "../context.ts";
import { runtime } from "../context.ts";
import { insideDir } from "../files.ts";
import { HttpError, readJsonBody, sendJson, type Router } from "../http.ts";
import { projectDir } from "./projects.ts";
import type { ApproveRequest, RunMode, RunRequest, StepRequest } from "../types.ts";

function workflowTitle(name: string): string {
  if (name === "short") return "Short vertical video (Reels, Shorts, TikTok)";
  if (name === "rough-cut") return "Long video (YouTube)";
  return name;
}

export function registerRunsRoutes(router: Router, ctx: DashboardContext): void {
  async function loadWorkflow(name: string): Promise<Workflow> {
    const files = await listWorkflowFiles(ctx.root);
    const wfPath = files[name];
    if (!wfPath) {
      throw new HttpError(404, `Unknown workflow: ${name}`);
    }
    const wfJson = await readJson(wfPath);
    const known = Object.keys(ctx.steps).length > 0 ? Object.keys(ctx.steps) : undefined;
    return parseWorkflow(wfJson, known);
  }

  async function startWorkflowJob(opts: {
    projDir: string;
    id: string;
    wf: Workflow;
    mode: RunMode;
    params?: Record<string, Record<string, unknown>>;
    force?: string[];
  }): Promise<void> {
    const { projDir, id, wf, mode, force } = opts;
    const rt = await runtime(ctx);

    const mergedParams: Record<string, Record<string, unknown>> = {
      ...(opts.params ?? {}),
    };

    const hasAssemble = wf.steps.some((s) => s.step === "assemble");
    const hasCaptionsRenderer = mergedParams.assemble?.captionsRenderer !== undefined;
    if (hasAssemble && !hasCaptionsRenderer && ctx.packaged) {
      const settings = await readAppSettings(ctx.home);
      const renderer = settings.animatedCaptions === true ? "hyperframes" : "ass";
      mergedParams.assemble = { ...mergedParams.assemble, captionsRenderer: renderer };
    }

    ctx.jobs.start(id, async (emit, signal) => {
      emit({
        type: "run-start",
        kind: "workflow",
        name: wf.name,
        mode,
      });

      const res = await runWorkflow(projDir, wf, ctx.steps, {
        params: mergedParams,
        force,
        autoApprove: mode === "auto",
        signal,
        config: rt.config,
        providers: rt.providers,
        env: rt.env,
        onStepStart: (step) => {
          emit({ type: "step-start", step });
        },
        onStep: (result) => {
          emit({ type: "step-end", result });
        },
        onApprove: (step, auto) => {
          emit({ type: "approved", step, auto });
        },
        log: (msg) => {
          const m = msg.match(/^\[([^\]]+)\]\s*(.*)$/);
          if (m) {
            emit({ type: "log", step: m[1], message: m[2] });
          } else {
            emit({ type: "log", message: msg });
          }
        },
      });

      if (signal.aborted) {
        emit({ type: "run-end", status: "cancelled" });
      } else if (res.status === "failed") {
        emit({
          type: "run-end",
          status: "failed",
          stoppedAt: res.stoppedAt,
          ...(res.results.at(-1)?.error ? { error: res.results.at(-1)!.error } : {}),
        });
      } else if (res.status === "awaiting-approval") {
        emit({
          type: "run-end",
          status: "awaiting-approval",
          stoppedAt: res.stoppedAt,
        });
      } else {
        emit({
          type: "run-end",
          status: "done",
        });
      }
    });
  }

  // POST /api/projects/:id/run
  router.add("POST", "/api/projects/:id/run", async (req, res, params) => {
    const id = params.id;
    const projDir = await projectDir(ctx, id);
    const body = await readJsonBody<RunRequest>(req);

    if (!body || typeof body.workflow !== "string" || !body.workflow) {
      throw new HttpError(400, "workflow is required");
    }
    if (body.mode !== "manual" && body.mode !== "auto") {
      throw new HttpError(400, "mode must be manual or auto");
    }

    const wf = await loadWorkflow(body.workflow);

    const recordedWf = await readProjectWorkflow(projDir);
    if (recordedWf && recordedWf !== body.workflow) {
      throw new HttpError(
        409,
        `This project already made a ${workflowTitle(recordedWf)}. Start a new project for a different kind of video.`,
      );
    }

    if (body.source !== undefined) {
      await insideDir(projDir, body.source);
    }

    const runParams: Record<string, Record<string, unknown>> = {};
    if (body.params) {
      for (const [step, p] of Object.entries(body.params)) {
        const mod = ctx.steps[step];
        if (!mod) {
          throw new HttpError(400, `unknown step "${step}"`);
        }
        try {
          checkParams(mod.contract.params, p);
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
        const fileParams = mod.contract.fileParams ?? [];
        const stepCopy: Record<string, unknown> = { ...p };
        for (const fp of fileParams) {
          const val = stepCopy[fp];
          if (typeof val === "string") {
            stepCopy[fp] = await insideDir(projDir, val);
          }
        }
        runParams[step] = stepCopy;
      }
    }

    if (body.source !== undefined) {
      const resolvedSource = await insideDir(projDir, body.source);
      let injected = false;
      if (wf.steps.some((s) => s.step === "ingest")) {
        runParams.ingest = { source: resolvedSource, ...(runParams.ingest ?? {}) };
        injected = true;
      }
      if (!injected) {
        for (const s of wf.steps) {
          const mod = ctx.steps[s.step];
          if (mod?.contract.fileParams?.includes("source") || mod?.contract.params?.source) {
            runParams[s.step] = { source: resolvedSource, ...(runParams[s.step] ?? {}) };
            break;
          }
        }
      }
    }

    await startWorkflowJob({
      projDir,
      id,
      wf,
      mode: body.mode,
      params: runParams,
      force: body.force,
    });

    sendJson(res, 202, { started: true });
  });

  // POST /api/projects/:id/approve
  router.add("POST", "/api/projects/:id/approve", async (req, res, params) => {
    const id = params.id;
    const projDir = await projectDir(ctx, id);
    const body = await readJsonBody<ApproveRequest>(req);

    if (!body || typeof body.step !== "string" || !body.step) {
      throw new HttpError(400, "step is required");
    }

    if (body.continue && ctx.jobs.isRunning(id)) {
      throw new HttpError(409, "This project is already running.");
    }

    try {
      await approveStep(projDir, body.step);
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }

    ctx.jobs.emit(id, { type: "approved", step: body.step, auto: false });

    if (body.continue) {
      const recordedWf = await readProjectWorkflow(projDir);
      if (!recordedWf) {
        throw new HttpError(400, "project has no recorded workflow");
      }
      const wf = await loadWorkflow(recordedWf);
      await startWorkflowJob({
        projDir,
        id,
        wf,
        mode: body.mode ?? "manual",
      });
      sendJson(res, 202, { started: true });
    } else {
      sendJson(res, 200, { ok: true });
    }
  });

  // POST /api/projects/:id/rerun
  router.add("POST", "/api/projects/:id/rerun", async (req, res, params) => {
    const id = params.id;
    const projDir = await projectDir(ctx, id);
    const body = await readJsonBody<{ step: string }>(req);

    if (!body || typeof body.step !== "string" || !body.step) {
      throw new HttpError(400, "step is required");
    }

    const recordedWf = await readProjectWorkflow(projDir);
    if (!recordedWf) {
      throw new HttpError(400, "project has no recorded workflow");
    }

    const wf = await loadWorkflow(recordedWf);

    await startWorkflowJob({
      projDir,
      id,
      wf,
      mode: "manual",
      force: [body.step],
    });

    sendJson(res, 202, { started: true });
  });

  // POST /api/projects/:id/steps/:name
  router.add("POST", "/api/projects/:id/steps/:name", async (req, res, params) => {
    const id = params.id;
    const stepName = params.name;
    const projDir = await projectDir(ctx, id);
    const mod = ctx.steps[stepName];
    if (!mod) {
      throw new HttpError(404, `Unknown step: ${stepName}`);
    }

    let body: StepRequest = {};
    try {
      body = await readJsonBody<StepRequest>(req);
    } catch {
      body = {};
    }

    let baseParams: Record<string, unknown> = {};
    const recordedWf = await readProjectWorkflow(projDir);
    if (recordedWf) {
      const files = await listWorkflowFiles(ctx.root);
      if (files[recordedWf]) {
        try {
          const wfJson = await readJson(files[recordedWf]);
          const wf = parseWorkflow(
            wfJson,
            Object.keys(ctx.steps).length > 0 ? Object.keys(ctx.steps) : undefined,
          );
          baseParams = await stepParams(projDir, wf, stepName);
        } catch {}
      }
    }

    const givenParams = { ...(body.params ?? {}) };
    if (body.params) {
      try {
        checkParams(mod.contract.params, givenParams);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      const fileParams = mod.contract.fileParams ?? [];
      for (const fp of fileParams) {
        const val = givenParams[fp];
        if (typeof val === "string") {
          givenParams[fp] = await insideDir(projDir, val);
        }
      }
    }

    const mergedParams = { ...baseParams, ...givenParams };
    const rt = await runtime(ctx);

    if (body.force) {
      try {
        const approvalsPath = join(projDir, "steps", "approvals.json");
        const approvals = (await readJson<Record<string, string>>(approvalsPath)) ?? {};
        if (stepName in approvals) {
          delete approvals[stepName];
          await writeJsonAtomic(approvalsPath, approvals);
        }
      } catch {}
    }

    ctx.jobs.start(id, async (emit, signal) => {
      emit({
        type: "run-start",
        kind: "step",
        name: stepName,
        mode: "manual",
      });
      emit({
        type: "step-start",
        step: stepName,
      });

      let result: StepResult & { cached: boolean };
      try {
        result = await runStep(projDir, mod, {
          config: rt.config,
          providers: rt.providers,
          env: rt.env,
          signal,
          params: mergedParams,
          force: Boolean(body.force),
          log: (msg) => {
            emit({ type: "log", step: stepName, message: msg });
          },
        });
      } catch (err) {
        const now = new Date().toISOString();
        const redactor = createRedactor([process.env, rt.env]);
        result = {
          step: stepName,
          status: "fail",
          startedAt: now,
          endedAt: now,
          durationMs: 0,
          inputsHash: "",
          metrics: {},
          verdicts: [],
          artifacts: [],
          error: redactor.redact(err instanceof Error ? err.message : String(err)),
          cached: false,
        };
        try {
          await mkdir(join(projDir, "steps"), { recursive: true });
          await recordStep(projDir, result);
        } catch {}
      }

      emit({
        type: "step-end",
        result,
      });

      if (signal.aborted) {
        emit({ type: "run-end", status: "cancelled" });
      } else if (result.status === "fail") {
        emit({
          type: "run-end",
          status: "failed",
          stoppedAt: stepName,
          error: result.error,
        });
      } else {
        emit({
          type: "run-end",
          status: "done",
        });
      }
    });

    sendJson(res, 202, { started: true });
  });
}
