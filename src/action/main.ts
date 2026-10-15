// GitHub Action entry point, bundled to action/dist/index.js by `npm run build:action`.
import { runFromEnv } from "./env.js";

process.exitCode = await runFromEnv(process.env);
