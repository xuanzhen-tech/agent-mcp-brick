/**
 * AgentMcp 注册表与渐进式工具验收。
 *
 * 测试启动真实本地 HTTP Gateway fixture，并让 AgentMcp 经 fetch 完成
 * register、help、search、describe、call、read 和二进制落盘，不直接 mock
 * AgentMcp 内部方法。
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { AgentMcp, AgentMcpError } from "../index.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-mcp-smoke-"));
const registryPath = path.join(root, "home", "registry.json");
const workspace = path.join(root, "workspace");
await fs.mkdir(workspace, { recursive: true });
const fixture = await startGatewayFixture();

try {
  const mcp = new AgentMcp({ gatewayBaseUrl: fixture.baseUrl, registryPath });
  await mcp.initialize();
  assert.deepEqual(await mcp.listRegistrations(), []);
  assert.deepEqual(mcp.toolDescriptors, []);

  const registered = await mcp.register("sif");
  assert.equal(registered.status, "registered");
  assert.equal(mcp.toolDescriptors[0].name, "sif_mcp");
  assert.equal(mcp.toolDescriptors[0].schema.function.parameters.properties.action.enum.includes("read"), true);

  const help = await mcp.execute("sif_mcp", { action: "help" }, { workspace });
  assert.equal(help.details.capabilities.tools, 4);
  assert.equal(help.details.server.instructions, "先搜索，再查看参数，最后调用。");
  assert.equal(JSON.stringify(help).includes("inputSchema"), false);

  const search = await mcp.execute("sif_mcp", { action: "search", query: "keyword" }, { workspace });
  assert.equal(search.details.results.some((item) => item.name === "keyword-research"), true);
  const profileSearch = await mcp.execute("sif_mcp", {
    action: "search",
    query: "ASIN商品画像 product profile",
    kind: "tool"
  }, { workspace });
  assert.equal(profileSearch.details.results[0].name, "market_get_asin_profile");
  assert.equal(profileSearch.details.results[0].description, "查询一个或多个 ASIN 的基础商品画像。");
  assert.deepEqual(profileSearch.details.results[0].requiredArguments, ["asins"]);
  assert.equal(profileSearch.details.results[0].description.length < 100, true);
  assert.equal(JSON.stringify(profileSearch).includes("输出格式铁律"), false);
  assert.equal(profileSearch.details.returned <= 20, true);
  const chineseProfileSearch = await mcp.execute("sif_mcp", {
    action: "search",
    query: "商品画像",
    kind: "tool"
  }, { workspace });
  assert.equal(chineseProfileSearch.details.results[0].name, "market_get_asin_profile");
  const productInfoSearch = await mcp.execute("sif_mcp", {
    action: "search",
    query: "亚马逊商品信息查询",
    kind: "tool"
  }, { workspace });
  assert.equal(productInfoSearch.details.results[0].name, "market_get_asin_profile");
  const describe = await mcp.execute("sif_mcp", { action: "describe", kind: "tool", name: "keyword-research" }, { workspace });
  assert.equal(describe.details.capability.inputSchema.required.includes("keyword"), true);

  const trace = {
    traceId: "trace-test",
    threadId: "thread-test",
    turnId: "turn-test",
    requestId: "request-test",
    toolCallId: "tool-call-test"
  };
  const call = await mcp.execute("sif_mcp", {
    action: "call",
    name: "keyword-research",
    arguments: { keyword: "portable monitor" }
  }, { workspace, ...trace });
  assert.equal(call.status, "completed");
  assert.equal(call.details.result.content[0].text.includes("portable monitor"), true);
  assert.deepEqual(fixture.lastTrace, trace);

  const remoteError = await mcp.execute("sif_mcp", {
    action: "call",
    name: "remote-error",
    arguments: {}
  }, { workspace, ...trace });
  assert.equal(remoteError.status, "failed");
  assert.equal(remoteError.error.code, "mcp_tool_error");

  const readText = await mcp.execute("sif_mcp", { action: "read", uri: "sif://guide" }, { workspace, ...trace });
  assert.equal(readText.details.result.contents[0].text, "SIF guide");

  const readBinary = await mcp.execute("sif_mcp", { action: "read", uri: "sif://logo" }, { workspace, ...trace });
  assert.equal(readBinary.details.artifacts.length, 1);
  const artifact = readBinary.details.artifacts[0];
  assert.equal(artifact.path.startsWith("temp/mcp/sif/"), true);
  assert.equal(await fs.readFile(path.join(workspace, artifact.path), "utf8"), "fake-png");
  assert.equal(JSON.stringify(readBinary).includes(Buffer.from("fake-png").toString("base64")), false);
  await assert.rejects(
    () => mcp.execute("sif_mcp", { action: "read", uri: "sif://too-large" }, { workspace, ...trace }),
    (error) => error instanceof AgentMcpError && error.code === "mcp_resource_too_large"
  );

  await mcp.setEnabled("sif", false);
  assert.deepEqual(mcp.toolDescriptors, []);
  await assert.rejects(
    () => mcp.execute("sif_mcp", { action: "help" }, { workspace }),
    (error) => error instanceof AgentMcpError && error.code === "tool_unavailable"
  );
  await mcp.setEnabled("sif", true);

  const second = new AgentMcp({ gatewayBaseUrl: fixture.baseUrl, registryPath });
  await second.initialize();
  assert.equal(second.toolDescriptors[0].name, "sif_mcp");
  await second.unregister("sif");
  assert.deepEqual(second.toolDescriptors, []);
  await second.dispose();
  await mcp.dispose();

  // 同一个 AgentMcp 必须能同时管理多个 Gateway 服务，并为每个已启用服务
  // 生成一个渐进式入口；单个服务的启停不能改变其它服务的模型工具。
  const multiRegistryPath = path.join(root, "multi-home", "registry.json");
  const multi = new AgentMcp({ gatewayBaseUrl: fixture.baseUrl, registryPath: multiRegistryPath });
  await multi.initialize();
  await multi.register("sif");
  await multi.register("sellersprite");
  await multi.register("sorftime");
  assert.deepEqual(
    multi.toolDescriptors.map((descriptor) => descriptor.name).sort(),
    ["sellersprite_mcp", "sif_mcp", "sorftime_mcp"]
  );
  await multi.setEnabled("sellersprite", false);
  assert.deepEqual(
    multi.toolDescriptors.map((descriptor) => descriptor.name).sort(),
    ["sif_mcp", "sorftime_mcp"]
  );
  await multi.unregister("sorftime");
  assert.deepEqual(multi.toolDescriptors.map((descriptor) => descriptor.name), ["sif_mcp"]);
  await multi.dispose();

  await fs.writeFile(registryPath, "{broken json", "utf8");
  const recovered = new AgentMcp({ gatewayBaseUrl: fixture.baseUrl, registryPath });
  await recovered.initialize();
  assert.deepEqual(await recovered.listRegistrations(), []);
  const entries = await fs.readdir(path.dirname(registryPath));
  assert.equal(entries.some((name) => name.startsWith("registry.json.corrupt-")), true);
  await recovered.dispose();

  console.log("[smoke-mcp] ok");
} finally {
  await fixture.close();
  await fs.rm(root, { recursive: true, force: true });
}

async function startGatewayFixture() {
  let lastTrace;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const body = await readJsonBody(request);
    const send = (value, status = 200) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && url.pathname === "/api/mcp/servers") {
      return send({ servers: [
        { id: "sif", label: "SIF", description: "SIF MCP", enabled: true },
        { id: "sellersprite", label: "SellerSprite", description: "SellerSprite MCP", enabled: true },
        { id: "sorftime", label: "Sorftime", description: "Sorftime MCP", enabled: true }
      ] });
    }
    if (request.method === "GET" && url.pathname === "/api/mcp/servers/sif/status") {
      return send({ server: { id: "sif", label: "SIF", instructions: "先搜索，再查看参数，最后调用。" } });
    }
    if (request.method === "POST" && url.pathname === "/api/mcp/servers/sif/probe") {
      return send({ ok: true, serverId: "sif" });
    }
    if (request.method === "GET" && url.pathname === "/api/mcp/servers/sif/tools") {
      return send({ tools: [
        {
          name: "market_get_asin_profile",
          description: [
            "【输出格式铁律】这是一段不应该进入搜索结果的通用输出规范。".repeat(40),
            "功能：查询一个或多个 ASIN 的基础商品画像。",
            "触发时机：用户需要商品价格、评分和规格时使用。",
            "入参：asins、country。"
          ].join("\n"),
          inputSchema: {
            type: "object",
            properties: {
              asins: { type: "array", items: { type: "string" } },
              country: { type: "string" }
            },
            required: ["asins"]
          }
        },
        {
          name: "keyword-research",
          description: "Research keyword demand",
          inputSchema: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] }
        },
        { name: "competitor-search", description: "Find competitors", inputSchema: { type: "object" } },
        { name: "remote-error", description: "Return isError", inputSchema: { type: "object" } }
      ] });
    }
    if (request.method === "GET" && url.pathname === "/api/mcp/servers/sif/resources") {
      return send({ resources: [{ name: "guide", uri: "sif://guide", description: "Keyword guide" }] });
    }
    if (request.method === "GET" && url.pathname === "/api/mcp/servers/sif/resource-templates") {
      return send({ resourceTemplates: [{ name: "report", uriTemplate: "sif://report/{id}", description: "Keyword report" }] });
    }
    if (request.method === "POST" && url.pathname === "/api/mcp/servers/sif/tools/keyword-research/call") {
      lastTrace = body.trace;
      return send({ result: { content: [{ type: "text", text: `result:${body.arguments.keyword}` }], isError: false } });
    }
    if (request.method === "POST" && url.pathname === "/api/mcp/servers/sif/tools/remote-error/call") {
      lastTrace = body.trace;
      return send({
        isError: true,
        result: {
          isError: true,
          content: [{ type: "text", text: "remote failed" }]
        }
      });
    }
    if (request.method === "POST" && url.pathname === "/api/mcp/servers/sif/resources/read") {
      lastTrace = body.trace;
      if (body.uri === "sif://too-large") {
        return send({ result: { contents: [{
          uri: body.uri,
          mimeType: "application/octet-stream",
          base64: "YQ==",
          bytes: 20 * 1024 * 1024 + 1
        }] } });
      }
      if (body.uri === "sif://logo") {
        const buffer = Buffer.from("fake-png");
        return send({ result: { contents: [{
          uri: body.uri,
          mimeType: "image/png",
          base64: buffer.toString("base64"),
          bytes: buffer.length
        }] } });
      }
      return send({ result: { contents: [{ uri: body.uri, mimeType: "text/plain", text: "SIF guide" }] } });
    }
    return send({ error: { code: "not_found", message: "not found" } }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get lastTrace() {
      return lastTrace;
    },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
