import type { StepModule } from "../core/src/index.ts";
import { assemble } from "./assemble/src/assemble.ts";
import { captions } from "./captions/src/captions.ts";
import { chapters } from "./chapters/src/chapters.ts";
import { cut } from "./cut/src/cut.ts";
import { ingest } from "./ingest/src/ingest.ts";
import { localize } from "./localize/src/localize.ts";
import { mix } from "./mix/src/mix.ts";
import { qa } from "./qa/src/qa.ts";
import { transcribe } from "./transcribe/src/transcribe.ts";

/** Step registry: name -> module. Later tasks register real steps here. */
export const defaultSteps: Record<string, StepModule> = { ingest, transcribe, cut, localize, captions, chapters, mix, assemble, qa };
