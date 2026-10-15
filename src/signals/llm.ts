import type { SignalProvider } from "../domain/types.js";

/** Spec §4 "llm.semantic". Workstream D. Emits nothing when ctx.llm is absent. */
export const llmSignals: SignalProvider = async () => [];
