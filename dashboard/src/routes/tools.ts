import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  listWorkflowFiles,
  PACKAGE_ROOT,
  parseWorkflow,
  readJson,
} from "../../../core/src/index.ts";
import { defaultSteps } from "../../../steps/index.ts";
import { buildCatalog } from "../catalog.ts";
import type { DashboardContext } from "../context.ts";
import { Router, sendJson } from "../http.ts";
import type { WorkflowInfo } from "../types.ts";

function workflowTitle(name: string): string {
  if (name === "short") return "Short vertical video (Reels, Shorts, TikTok)";
  if (name === "rough-cut") return "Long video (YouTube)";
  return name;
}

export async function loadWorkflows(
  root: string | undefined,
  knownSteps?: string[],
): Promise<WorkflowInfo[]> {
  const files = await listWorkflowFiles(root ?? PACKAGE_ROOT);
  const workflows: WorkflowInfo[] = [];
  for (const [name, path] of Object.entries(files)) {
    try {
      const json = await readJson(path);
      const wf = parseWorkflow(json, knownSteps);
      workflows.push({
        name,
        title: workflowTitle(name),
        steps: wf.steps.map((s) => ({ step: s.step, approve: Boolean(s.approve) })),
      });
    } catch {}
  }
  return workflows;
}

export function registerToolsRoutes(router: Router, ctx: DashboardContext): void {
  // GET /api/tools
  router.add("GET", "/api/tools", async (_req, res) => {
    const steps = Object.keys(ctx.steps).length > 0 ? ctx.steps : defaultSteps;
    const workflows = await loadWorkflows(ctx.root, Object.keys(steps));
    const tools = buildCatalog(steps, workflows, (stepName) => {
      try {
        return readFileSync(join(PACKAGE_ROOT, "steps", stepName, "README.md"), "utf8");
      } catch {
        return "";
      }
    });
    sendJson(res, 200, { tools });
  });
}
