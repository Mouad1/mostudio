import type { StepModule } from "../core/src/index.ts";
import { ingest } from "./ingest/src/ingest.ts";

/** Step registry: name -> module. Later tasks register real steps here. */
export const defaultSteps: Record<string, StepModule> = { ingest };
