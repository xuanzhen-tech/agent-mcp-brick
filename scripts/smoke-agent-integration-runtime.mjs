/**
 * AgentCli + AgentTool + AgentMcp + Gateway 的真实对象联调主体。
 *
 * LLM 只使用确定性运行时决定渐进动作；MCP 目录、工具调用、stdio 子进程、
 * Gateway HTTP、AgentTool Provider 路由和 AgentCli 工具循环全部走正式实现。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AgentMcp } from "../src/index.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siblingRoot = path.resolve(repoRoot, "..");
const gatewayRoot = process.env.AGENT_LLM_GATEWAY_REPO ?? path.join(siblingRoot, "agent-llm-gateway");
const toolRoot = process.env.AGENT_TOOL_REPO ?? path.join(siblingRoot, "agent-tool-brick");
const cliRoot = process.env.AGENT_CLI_REPO ?? path.join(siblingRoot, "agent-cli-brick");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-mcp-integration-"));

const [{ createLlmGatewayRuntime }, { AgentTool }, { AgentCli }] = await Promise.all([
  import(pathToFileURL(path.join(gatewayRoot, "src", "http.ts"))),
  import(pathToFileURL(path.join(toolRoot, "src", "index.mjs"))),
  import(pathToFileURL(path.join(cliRoot, "src", "index.mjs")))
]);

const fixturePath = path.join(gatewayRoot, "tests", "mcp-stdio-fixture.ts");
const tsxPath = path.join(gatewayRoot, "node_modules", "tsx", "dist", "cli.mjs");
const gatewayData = path.join(temporaryRoot, "gateway-data");
const workspace = path.join(temporaryRoot, "workspace");
const registryPath = path.join(temporaryRoot, "mcp", "registry.json");
await fs.mkdir(workspace, { recursive: true });

const gatewayRuntime = createLlmGatewayRuntime({
  env: {
    ...process.env,
    LLM_GATEWAY_DATA_DIR: gatewayData,
    LLM_GATEWAY_MCP_SERVERS_JSON: JSON.stringify([{
      id: "sif",
      label: "SIF",
      description: "真实 stdio fixture",
      enabled: true,
      transport: {
        type: "stdio",
        command: process.execPath,
        args: [tsxPath, fixturePath],
        cwd: path.dirname(fixturePath),
        env: { MCP_FIXTURE_SECRET: "MCP_INTEGRATION_SECRET" }
      }
    }]),
    MCP_INTEGRATION_SECRET: "server-only-secret"
  }
});
const gatewayHttp = await startFetchHandlerServer(gatewayRuntime.handler);

let agent;
let agentTool;
let agentMcp;
try {
  agentMcp = new AgentMcp({
    gatewayBaseUrl: gatewayHttp.baseUrl,
    registryPath
  });
  await agentMcp.initialize();
  await agentMcp.register("sif");

  agentTool = new AgentTool({
    workspace,
    tools: ["sif_mcp"],
    toolProviders: [agentMcp]
  });
  assert.deepEqual(agentTool.definitions.map((item) => item.function.name), ["sif_mcp"]);

  const modelRequests = [];
  agent = new AgentCli({
    workspace,
    threadStore: createInMemoryThreadStore(),
    toolRuntime: agentTool,
    llmRuntime: {
      async chat(request) {
        modelRequests.push(request);
        const sequence = modelRequests.length;
        if (sequence === 1) return toolCall("call-search", "search", { query: "echo" });
        if (sequence === 2) {
          assert.match(readLatestToolResult(request), /echo/);
          return toolCall("call-describe", "describe", { kind: "tool", name: "echo" });
        }
        if (sequence === 3) {
          assert.match(readLatestToolResult(request), /"inputSchema"/);
          return toolCall("call-execute", "call", { name: "echo", arguments: { text: "真实联调" } });
        }
        assert.match(readLatestToolResult(request), /真实联调/);
        request.emit({ type: "assistant_delta", content: "MCP 调用成功。" });
        return { assistantContent: "MCP 调用成功。", toolCalls: [] };
      }
    }
  });

  const traceId = `trace-${crypto.randomUUID()}`;
  const threadId = `thread-${crypto.randomUUID()}`;
  const events = [];
  for await (const event of agent.chat("使用 SIF MCP 回显“真实联调”。", {
    traceId,
    threadId,
    workspace
  })) {
    events.push(event);
  }
  assert.equal(modelRequests.length, 4, JSON.stringify(events, null, 2));
  assert.equal(events.some((event) => event.type === "tool_end"), true);
  assert.equal(events.some((event) => event.type === "assistant_delta" && event.content === "MCP 调用成功。"), true);

  const traceResponse = await fetch(`${gatewayHttp.baseUrl}/api/llm/traces/${encodeURIComponent(traceId)}/readable`);
  assert.equal(traceResponse.status, 200);
  const readable = await traceResponse.json();
  const turnId = readable.trace.turns[0]?.turnId;
  assert.equal(typeof turnId, "string");
  const turnResponse = await fetch(
    `${gatewayHttp.baseUrl}/api/llm/traces/${encodeURIComponent(traceId)}/turns/${encodeURIComponent(turnId)}`
  );
  assert.equal(turnResponse.status, 200);
  const turn = await turnResponse.json();
  const mcpOperations = turn.timeline.filter((entry) => entry?.type === "mcp_operation");
  assert.equal(mcpOperations.length, 1);
  assert.equal(mcpOperations[0].remoteName, "echo");
  assert.equal(typeof mcpOperations[0].toolCallId, "string");
  assert.equal(JSON.stringify(turn).includes("server-only-secret"), false);

  console.log("[smoke-agent-integration] ok");
} finally {
  await agent?.dispose();
  await agentTool?.dispose();
  await agentMcp?.dispose();
  await gatewayRuntime.mcpBroker.close();
  gatewayRuntime.close();
  await gatewayHttp.close();
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

function toolCall(id, action, input) {
  return {
    assistantContent: "",
    toolCalls: [{
      id,
      name: "sif_mcp",
      arguments: JSON.stringify({ action, ...input })
    }]
  };
}

function readLatestToolResult(request) {
  return String([...request.messages].reverse().find((message) => message.role === "tool")?.content ?? "");
}

async function startFetchHandlerServer(handler) {
  const server = http.createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://127.0.0.1${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers,
      ...(body ? { body } : {})
    });
    const response = await handler(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法获取 Gateway 联调端口。");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

function createInMemoryThreadStore() {
  const records = new Map();
  const threads = new Map();
  return {
    filePath: "memory://agent-mcp-integration",
    markStaleRunningThreadsInterrupted() {},
    markUserInput(threadId, userInputAt) {
      threads.set(threadId, { ...(threads.get(threadId) ?? { threadId }), userInputAt });
    },
    upsertThread(thread) {
      const next = { ...(threads.get(thread.threadId) ?? {}), ...thread };
      threads.set(thread.threadId, next);
      return next;
    },
    getThread(threadId) { return threads.get(threadId) ?? null; },
    listThreads() { return [...threads.values()]; },
    appendEvent(threadId, runId, event) {
      const items = records.get(threadId) ?? [];
      const seq = items.length + 1;
      const stored = { ...event, threadId, runId, seq };
      items.push({ threadId, runId, seq, type: stored.type, event: stored });
      records.set(threadId, items);
      return { event: stored };
    },
    loadEvents(threadId, afterSeq = 0) {
      return (records.get(threadId) ?? []).filter((item) => item.seq > afterSeq);
    }
  };
}
