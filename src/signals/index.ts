import type { SignalProvider } from "../domain/types.js";
import { blastSignals } from "./blast.js";
import { complexitySignals } from "./complexity.js";
import { diffusionSignals } from "./diffusion.js";
import { expertiseSignals } from "./expertise.js";
import { historySignals } from "./history.js";
import { languageSignals } from "./language.js";
import { llmSignals } from "./llm.js";
import { pathsSignals } from "./paths.js";
import { sizeSignals } from "./size.js";
import { testsSignals } from "./tests.js";

/** Every provider runs on every diff. Order is report order. */
export const SIGNAL_PROVIDERS: SignalProvider[] = [
  sizeSignals,
  diffusionSignals,
  historySignals,
  expertiseSignals,
  complexitySignals,
  languageSignals,
  blastSignals,
  pathsSignals,
  testsSignals,
  llmSignals,
];
