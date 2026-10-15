export * from "./domain/types.js";
export { loadConfig, parseConfig, parseConfigText, defaultConfig, type OpendrsConfig } from "./domain/config.js";
export { scoreDiff, computeSignals, loadModel, type ScoreOptions } from "./engine.js";
