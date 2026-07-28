/**
 * 跨仓库联调启动器。
 *
 * Gateway 源码是 TypeScript，因此从 Gateway 仓库加载其本地 tsx runtime 后再
 * 执行联调主体；这样 agent-mcp 的正式 npm 包无需依赖 TypeScript 工具链。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siblingRoot = path.resolve(repoRoot, "..");
const gatewayRoot = process.env.AGENT_LLM_GATEWAY_REPO ?? path.join(siblingRoot, "agent-llm-gateway");
const runtimeScript = path.join(repoRoot, "scripts", "smoke-agent-integration-runtime.mjs");

const child = spawn(process.execPath, ["--import", "tsx", runtimeScript], {
  cwd: gatewayRoot,
  stdio: "inherit",
  env: process.env,
  shell: false
});
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`跨仓库联调被信号终止: ${signal}`));
    else resolve(code ?? 1);
  });
});
if (exitCode !== 0) process.exitCode = exitCode;
