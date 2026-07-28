/**
 * 校验 agent-mcp 的公开 SDK 与 runtime contract。
 *
 * 本脚本不访问网络，只验证构造、公开导出和动态 Provider 基础形状。
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { validateBrickDefinition } from "../main/release-foundation.mjs";
import {
  AgentMcp,
  DEFAULT_AGENT_MCP_GATEWAY_BASE_URL,
  brickDefinition,
  createAgentMcpRuntimeContract
} from "../index.mjs";

assert.equal(brickDefinition.id, "agent-mcp");
assert.equal(brickDefinition.kind, "capability");
assert.equal(brickDefinition.version, "0.1.0");
assert.equal(validateBrickDefinition(brickDefinition).ok, true);
assert.equal(brickDefinition.runtimeDependencies.some((item) => item.type === "node-runtime" && item.required === true), true);

const instance = new AgentMcp({
  registryPath: path.join(os.tmpdir(), "agent-mcp-contract", "registry.json"),
  fetchImpl: async () => new Response(JSON.stringify({ servers: [] }), { status: 200 })
});
assert.equal(instance.definition.id, "agent-mcp");
assert.equal(instance.id, "agent-mcp");
assert.equal(instance.gatewayBaseUrl, DEFAULT_AGENT_MCP_GATEWAY_BASE_URL);

const runtimeContract = createAgentMcpRuntimeContract();
assert.equal(runtimeContract.artifactType, "agent-mcp");
assert.equal(runtimeContract.entrypoint, "sdk-only");
assert.equal(runtimeContract.providerContract.dynamicDescriptors, true);
assert.equal(runtimeContract.registry.storesSecrets, false);

console.log("[smoke-contract] ok");
