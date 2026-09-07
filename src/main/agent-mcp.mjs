/**
 * AgentMcp 对象运行时。
 *
 * 本文件管理用户级 MCP 服务启用状态，并把每个已启用服务转换为一个渐进式
 * AgentTool Provider 工具。真实 endpoint、命令和密钥始终由 Gateway 管理，
 * 本地注册表不会保存连接细节。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { brickDefinition } from "../brick-definition.mjs";

export const AGENT_MCP_REGISTRY_SCHEMA_VERSION = "agent-mcp.registry.v1";
export const DEFAULT_AGENT_MCP_GATEWAY_BASE_URL = "http://47.109.82.99/agent-llm-gateway";
export const DEFAULT_AGENT_MCP_HOME = path.join(os.homedir(), ".agent-cli", "mcp");

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 20;
const MAX_SEARCH_DESCRIPTION_CHARS = 320;
const MAX_BINARY_RESOURCE_BYTES = 20 * 1024 * 1024;
const TOOL_NAME_SUFFIX = "_mcp";
const SAFE_SERVER_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const SAFE_TOOL_NAME = /^[A-Za-z0-9_.:/-]{1,256}$/;
const SEARCH_SYNONYM_GROUPS = [
  ["profile", "画像", "概况", "概览", "详情", "档案", "商品信息", "产品信息", "基础信息"],
  ["product", "listing", "asin", "商品", "产品"],
  ["keyword", "query", "关键词", "搜索词"],
  ["competitor", "competition", "竞品", "竞争对手", "竞争"],
  ["discover", "discovery", "find", "search", "发现", "查找", "寻找"],
  ["traffic", "流量"],
  ["sales", "sale", "销量", "销售"],
  ["advertising", "advertisement", "ads", "ad", "广告"],
  ["trend", "history", "historical", "趋势", "历史"],
  ["market", "市场"],
  ["campaign", "广告活动", "活动"]
];

export class AgentMcpError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AgentMcpError";
    this.code = code;
    this.details = details;
  }
}

export class AgentMcp {
  #fetchImpl;
  #gatewayBaseUrl;
  #registryPath;
  #registry;
  #availableServers = new Map();
  #initialized = false;
  #writeQueue = Promise.resolve();
  #disposed = false;

  constructor(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new AgentMcpError("mcp_invalid_config", "AgentMcp 构造参数必须是对象。");
    }
    this.#fetchImpl = input.fetchImpl ?? globalThis.fetch;
    if (typeof this.#fetchImpl !== "function") {
      throw new AgentMcpError("mcp_invalid_config", "AgentMcp 需要可用的 fetch 实现。");
    }
    this.#gatewayBaseUrl = normalizeGatewayBaseUrl(input.gatewayBaseUrl ?? DEFAULT_AGENT_MCP_GATEWAY_BASE_URL);
    const home = normalizeAbsolutePath(input.agentMcpHome ?? DEFAULT_AGENT_MCP_HOME, "agentMcpHome");
    this.#registryPath = normalizeAbsolutePath(input.registryPath ?? path.join(home, "registry.json"), "registryPath");
    this.#registry = createEmptyRegistry();
  }

  get id() {
    return brickDefinition.id;
  }

  get definition() {
    return brickDefinition;
  }

  get gatewayBaseUrl() {
    return this.#gatewayBaseUrl;
  }

  get registryPath() {
    return this.#registryPath;
  }

  /**
   * 返回当前已启用服务对应的动态 Provider descriptors。
   *
   * getter 只读取内存注册表，因此 AgentTool 可以在每次模型请求前同步读取；
   * register、setEnabled 和 unregister 完成后下一次读取立即生效。
   */
  get toolDescriptors() {
    this._assertReady();
    return this.#registry.registrations
      .filter((registration) => (
        registration.enabled
        && this.#availableServers.get(registration.serverId)?.enabled === true
      ))
      .map((registration) => createServerToolDescriptor(
        registration.serverId,
        this.#availableServers.get(registration.serverId)
      ));
  }

  getToolDescriptors() {
    return this.toolDescriptors;
  }

  async initialize() {
    this._assertActive();
    if (this.#initialized) return this.snapshot();
    this.#registry = await readRegistryWithRecovery(this.#registryPath);
    this.#initialized = true;
    try {
      await this._refreshAvailableServers();
    } catch {
      // Gateway 暂时不可用不应阻止读取本地注册状态；diagnostics 会报告连接问题。
    }
    return this.snapshot();
  }

  snapshot() {
    this._assertReady();
    return {
      schemaVersion: AGENT_MCP_REGISTRY_SCHEMA_VERSION,
      registryPath: this.#registryPath,
      registrations: clone(this.#registry.registrations),
      visibleTools: this.toolDescriptors.map((item) => item.name)
    };
  }

  async listAvailableServers() {
    this._assertReady();
    await this._refreshAvailableServers();
    return [...this.#availableServers.values()].map(clone);
  }

  async listRegistrations() {
    this._assertReady();
    return clone(this.#registry.registrations);
  }

  async register(serverId) {
    this._assertReady();
    const id = normalizeServerId(serverId);
    const server = await this._requireAvailableServer(id);
    const current = this.#registry.registrations.find((item) => item.serverId === id);
    if (current) {
      if (!current.enabled) {
        current.enabled = true;
        current.updatedAt = new Date().toISOString();
        await this._persist();
      }
      return { status: "unchanged", registration: clone(current), server: clone(server) };
    }
    const now = new Date().toISOString();
    const registration = { serverId: id, enabled: true, registeredAt: now, updatedAt: now };
    this.#registry.registrations.push(registration);
    this._sortRegistrations();
    await this._persist();
    return { status: "registered", registration: clone(registration), server: clone(server) };
  }

  async unregister(serverId) {
    this._assertReady();
    const id = normalizeServerId(serverId);
    const index = this.#registry.registrations.findIndex((item) => item.serverId === id);
    if (index < 0) return { status: "unchanged", serverId: id };
    this.#registry.registrations.splice(index, 1);
    await this._persist();
    return { status: "unregistered", serverId: id };
  }

  async setEnabled(serverId, enabled) {
    this._assertReady();
    const id = normalizeServerId(serverId);
    if (typeof enabled !== "boolean") {
      throw new AgentMcpError("mcp_invalid_argument", "enabled 必须是 boolean。");
    }
    const registration = this.#registry.registrations.find((item) => item.serverId === id);
    if (!registration) {
      throw new AgentMcpError("mcp_not_registered", `MCP 服务尚未注册: ${id}`);
    }
    if (enabled) await this._requireAvailableServer(id);
    if (registration.enabled !== enabled) {
      registration.enabled = enabled;
      registration.updatedAt = new Date().toISOString();
      await this._persist();
    }
    return clone(registration);
  }

  async getStatus(serverId) {
    this._assertReady();
    const id = normalizeServerId(serverId);
    const response = await this._gatewayRequest(`/api/mcp/servers/${encodeURIComponent(id)}/status`);
    return {
      registration: clone(this.#registry.registrations.find((item) => item.serverId === id) ?? null),
      server: response.server ?? response
    };
  }

  async testConnection(serverId) {
    this._assertReady();
    const id = normalizeServerId(serverId);
    return await this._gatewayRequest(`/api/mcp/servers/${encodeURIComponent(id)}/probe`, {
      method: "POST",
      body: {}
    });
  }

  /**
   * AgentTool Provider 执行入口。
   *
   * 模型只看到每个服务的单一工具；本方法根据 action 渐进读取目录、schema、
   * 工具结果或资源，并在每次执行前重新检查本地启用状态。
   */
  async execute(name, args = {}, context = {}) {
    this._assertReady();
    const serverId = this._resolveEnabledServerId(name);
    const input = normalizeActionInput(args);
    switch (input.action) {
      case "help":
        return await this._help(serverId, context);
      case "search":
        return await this._search(serverId, input, context);
      case "describe":
        return await this._describe(serverId, input, context);
      case "call":
        return await this._call(serverId, input, context);
      case "read":
        return await this._read(serverId, input, context);
      default:
        throw new AgentMcpError("mcp_invalid_action", `不支持的 MCP action: ${input.action}`);
    }
  }

  getToolAvailability(name) {
    if (!this.#initialized || this.#disposed) return { available: false, reason: "mcp_not_initialized" };
    try {
      this._resolveEnabledServerId(name);
      return { available: true };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof AgentMcpError ? error.code : "mcp_unavailable"
      };
    }
  }

  async diagnostics() {
    this._assertReady();
    const checks = [{
      id: "mcp.registry",
      status: "pass",
      summary: "MCP 用户级注册表可读。",
      detail: this.#registryPath
    }];
    try {
      const servers = await this.listAvailableServers();
      checks.push({
        id: "mcp.gateway",
        status: "pass",
        summary: "MCP Gateway 可访问。",
        detail: `availableServers=${servers.length}`
      });
    } catch (error) {
      checks.push({
        id: "mcp.gateway",
        status: "warn",
        summary: "MCP Gateway 当前不可访问。",
        detail: formatError(error)
      });
    }
    for (const registration of this.#registry.registrations) {
      checks.push({
        id: `mcp.server.${registration.serverId}`,
        status: registration.enabled && !this.#availableServers.has(registration.serverId) ? "warn" : "pass",
        summary: registration.enabled ? "MCP 服务已启用。" : "MCP 服务已注册但未启用。",
        detail: registration.serverId
      });
    }
    return {
      status: checks.some((item) => item.status === "fail")
        ? "fail"
        : checks.some((item) => item.status === "warn") ? "warn" : "pass",
      checks
    };
  }

  async dispose() {
    if (this.#disposed) return { disposed: true };
    await this.#writeQueue;
    this.#disposed = true;
    return { disposed: true };
  }

  async _help(serverId, context) {
    const [status, tools, resources, templates] = await Promise.all([
      this._gatewayRequest(`/api/mcp/servers/${encodeURIComponent(serverId)}/status`, { signal: context.signal }),
      this._listTools(serverId, context.signal),
      this._listResources(serverId, context.signal),
      this._listResourceTemplates(serverId, context.signal)
    ]);
    const server = status.server ?? status;
    return completedResult({
      action: "help",
      server: {
        id: serverId,
        label: server.label ?? this.#availableServers.get(serverId)?.label ?? serverId,
        description: server.description ?? this.#availableServers.get(serverId)?.description ?? "",
        instructions: server.instructions ?? ""
      },
      capabilities: {
        tools: tools.length,
        resources: resources.length,
        resourceTemplates: templates.length
      },
      actions: {
        search: "按关键词查找工具和资源。",
        describe: "查看一个工具或资源模板的精确合同。",
        call: "调用已知 MCP tool。",
        read: "读取具体 resource URI。"
      },
      recommendedFlow: ["search", "describe", "call"]
    });
  }

  async _search(serverId, input, context) {
    const query = requireNonEmptyString(input.query, "search 需要 query。");
    const limit = normalizeLimit(input.limit);
    const kinds = normalizeSearchKinds(input.kind);
    const [tools, resources, templates] = await Promise.all([
      kinds.has("tool") ? this._listTools(serverId, context.signal) : [],
      kinds.has("resource") ? this._listResources(serverId, context.signal) : [],
      kinds.has("resource_template") ? this._listResourceTemplates(serverId, context.signal) : []
    ]);
    const ranked = rankSearchCandidates([
      ...tools.map((item) => createSearchCandidate("tool", item)),
      ...resources.map((item) => createSearchCandidate("resource", item)),
      ...templates.map((item) => createSearchCandidate("resource_template", item))
    ], query);
    const matches = ranked.slice(0, limit).map(({ summary, relevance }) => ({
      ...summary,
      relevance
    }));
    return completedResult({
      action: "search",
      serverId,
      query: input.query,
      total: ranked.length,
      returned: matches.length,
      results: matches
    });
  }

  async _describe(serverId, input, context) {
    const kind = normalizeDescribeKind(input.kind);
    const name = requireNonEmptyString(input.name, "describe 需要 name。");
    if (kind === "tool") {
      const tool = (await this._listTools(serverId, context.signal)).find((item) => item.name === name);
      if (!tool) throw new AgentMcpError("mcp_capability_not_found", `未找到 MCP tool: ${name}`);
      return completedResult({ action: "describe", serverId, kind, capability: tool });
    }
    const template = (await this._listResourceTemplates(serverId, context.signal))
      .find((item) => item.name === name || item.uriTemplate === name);
    if (!template) throw new AgentMcpError("mcp_capability_not_found", `未找到 MCP resource template: ${name}`);
    return completedResult({ action: "describe", serverId, kind, capability: template });
  }

  async _call(serverId, input, context) {
    const remoteToolName = requireSafeRemoteToolName(input.name);
    const argumentsValue = normalizeArguments(input.arguments);
    const response = await this._gatewayRequest(
      `/api/mcp/servers/${encodeURIComponent(serverId)}/tools/${encodeURIComponent(remoteToolName)}/call`,
      {
        method: "POST",
        signal: context.signal,
        body: {
          arguments: argumentsValue,
          trace: createTraceContext(context)
        }
      }
    );
    const materialized = await this._materializeBinaryContent(response.result ?? response, {
      serverId,
      workspace: context.workspace ?? context.workingDirectory
    });
    return completedResult({
      action: "call",
      serverId,
      toolName: remoteToolName,
      result: materialized.value,
      artifacts: materialized.artifacts
    }, readRemoteIsError(response));
  }

  async _read(serverId, input, context) {
    const uri = requireNonEmptyString(input.uri, "read 需要 uri。");
    const response = await this._gatewayRequest(
      `/api/mcp/servers/${encodeURIComponent(serverId)}/resources/read`,
      {
        method: "POST",
        signal: context.signal,
        body: {
          uri,
          trace: createTraceContext(context)
        }
      }
    );
    const materialized = await this._materializeBinaryContent(response.result ?? response, {
      serverId,
      workspace: context.workspace ?? context.workingDirectory
    });
    return completedResult({
      action: "read",
      serverId,
      uri,
      result: materialized.value,
      artifacts: materialized.artifacts
    }, readRemoteIsError(response));
  }

  async _listTools(serverId, signal) {
    const response = await this._gatewayRequest(`/api/mcp/servers/${encodeURIComponent(serverId)}/tools`, { signal });
    return normalizeArrayResponse(response, "tools");
  }

  async _listResources(serverId, signal) {
    const response = await this._gatewayRequest(`/api/mcp/servers/${encodeURIComponent(serverId)}/resources`, { signal });
    return normalizeArrayResponse(response, "resources");
  }

  async _listResourceTemplates(serverId, signal) {
    const response = await this._gatewayRequest(`/api/mcp/servers/${encodeURIComponent(serverId)}/resource-templates`, { signal });
    return normalizeArrayResponse(response, "resourceTemplates");
  }

  async _materializeBinaryContent(value, input) {
    const workspace = normalizeAbsolutePath(input.workspace ?? process.cwd(), "workspace");
    const artifacts = [];
    const walk = async (item) => {
      if (Array.isArray(item)) return await Promise.all(item.map(walk));
      if (!item || typeof item !== "object") return item;
      const binary = readBinaryPayload(item);
      if (binary) {
        if (binary.bytes > MAX_BINARY_RESOURCE_BYTES) {
          throw new AgentMcpError(
            "mcp_resource_too_large",
            `MCP 二进制资源超过 20MB 上限: ${binary.bytes} bytes。`
          );
        }
        const buffer = Buffer.from(binary.base64, "base64");
        if (buffer.byteLength !== binary.bytes) {
          throw new AgentMcpError("mcp_invalid_binary", "MCP 二进制资源长度与声明不一致。");
        }
        const hash = crypto.createHash("sha256").update(buffer).digest("hex");
        if (binary.hash && binary.hash !== hash) {
          throw new AgentMcpError("mcp_invalid_binary", "MCP 二进制资源 hash 校验失败。");
        }
        const relativePath = path.join("temp", "mcp", input.serverId, `${hash}.${extensionForMime(binary.mimeType)}`);
        const absolutePath = path.resolve(workspace, relativePath);
        assertPathInside(workspace, absolutePath);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, buffer);
        const artifact = {
          path: relativePath.replaceAll(path.sep, "/"),
          mimeType: binary.mimeType,
          bytes: buffer.byteLength,
          contentHash: hash
        };
        artifacts.push(artifact);
        return { type: "resource_file", ...artifact };
      }
      return Object.fromEntries(await Promise.all(Object.entries(item).map(async ([key, child]) => [key, await walk(child)])));
    };
    return { value: await walk(value), artifacts };
  }

  async _refreshAvailableServers() {
    const response = await this._gatewayRequest("/api/mcp/servers");
    const servers = normalizeArrayResponse(response, "servers");
    this.#availableServers = new Map(servers.map((server) => {
      const id = normalizeServerId(server?.id);
      return [id, {
        id,
        label: optionalString(server.label) ?? id,
        description: optionalString(server.description) ?? "",
        enabled: server.enabled !== false,
        transports: Array.isArray(server.transports) ? server.transports.filter((item) => typeof item === "string") : []
      }];
    }));
    return servers;
  }

  async _requireAvailableServer(serverId) {
    if (!this.#availableServers.has(serverId)) await this._refreshAvailableServers();
    const server = this.#availableServers.get(serverId);
    if (!server || server.enabled === false) {
      throw new AgentMcpError("mcp_server_unavailable", `Gateway 未配置或未启用 MCP 服务: ${serverId}`);
    }
    return server;
  }

  _resolveEnabledServerId(toolName) {
    const normalizedToolName = String(toolName ?? "").trim();
    const registration = this.#registry.registrations.find(
      (item) => (
        item.enabled
        && this.#availableServers.get(item.serverId)?.enabled === true
        && createServerToolName(item.serverId) === normalizedToolName
      )
    );
    if (!registration) {
      throw new AgentMcpError("tool_unavailable", `MCP 工具未注册、已禁用或已删除: ${normalizedToolName}`);
    }
    return registration.serverId;
  }

  async _gatewayRequest(route, options = {}) {
    this._assertActive();
    const method = options.method ?? "GET";
    let response;
    try {
      response = await this.#fetchImpl(`${this.#gatewayBaseUrl}${route}`, {
        method,
        headers: options.body === undefined ? undefined : { "content-type": "application/json" },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal
      });
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) throw error;
      throw new AgentMcpError("mcp_gateway_unreachable", `无法访问 MCP Gateway: ${formatError(error)}`);
    }
    const text = await response.text();
    const payload = parseJson(text);
    if (!response.ok) {
      const code = optionalString(payload?.error?.code) ?? `mcp_gateway_http_${response.status}`;
      const message = optionalString(payload?.error?.message) ?? (text.slice(0, 500) || response.statusText);
      throw new AgentMcpError(code, message, { status: response.status });
    }
    if (!payload || typeof payload !== "object") {
      throw new AgentMcpError("mcp_gateway_invalid_response", "MCP Gateway 返回了无效 JSON。");
    }
    return payload;
  }

  async _persist() {
    const snapshot = clone(this.#registry);
    this.#writeQueue = this.#writeQueue.then(() => writeRegistryAtomic(this.#registryPath, snapshot));
    await this.#writeQueue;
  }

  _sortRegistrations() {
    this.#registry.registrations.sort((left, right) => left.serverId.localeCompare(right.serverId));
  }

  _assertReady() {
    this._assertActive();
    if (!this.#initialized) {
      throw new AgentMcpError("mcp_not_initialized", "请先调用 AgentMcp.initialize()。");
    }
  }

  _assertActive() {
    if (this.#disposed) throw new AgentMcpError("mcp_disposed", "AgentMcp 已释放。");
  }
}

function createServerToolDescriptor(serverId, server = {}) {
  const name = createServerToolName(serverId);
  const label = optionalString(server?.label) ?? serverId;
  return {
    name,
    description: `渐进使用 ${label} MCP 服务。先 search 查找能力，再 describe 查看精确参数，最后 call；读取资源使用 read。`,
    permissions: ["network", "workspace.temp.write"],
    timeoutMs: 120_000,
    cancelable: true,
    defaultVisible: true,
    schema: {
      type: "function",
      function: {
        name,
        description: `访问 ${label} MCP。help 查看服务说明；search/describe 渐进发现；call 调用工具；read 读取资源。`,
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["help", "search", "describe", "call", "read"],
              description: "要执行的渐进动作。"
            },
            query: { type: "string", description: "search 的关键词。" },
            kind: {
              type: "string",
              enum: ["all", "tool", "resource", "resource_template"],
              description: "search 或 describe 的能力类型。"
            },
            name: { type: "string", description: "describe/call 的 tool 名或 resource template 名。" },
            arguments: { type: "object", description: "call 的 MCP tool 参数。", additionalProperties: true },
            uri: { type: "string", description: "read 的完整 resource URI。" },
            limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_LIMIT }
          },
          required: ["action"],
          additionalProperties: false
        }
      }
    }
  };
}

function createServerToolName(serverId) {
  return `${serverId.replaceAll("-", "_")}${TOOL_NAME_SUFFIX}`;
}

function normalizeActionInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentMcpError("mcp_invalid_argument", "MCP 工具参数必须是对象。");
  }
  const action = requireNonEmptyString(value.action, "MCP action 不能为空。").toLowerCase();
  return { ...value, action };
}

function normalizeSearchKinds(value) {
  const kind = optionalString(value)?.toLowerCase() ?? "all";
  if (kind === "all") return new Set(["tool", "resource", "resource_template"]);
  if (!["tool", "resource", "resource_template"].includes(kind)) {
    throw new AgentMcpError("mcp_invalid_argument", `不支持的搜索 kind: ${kind}`);
  }
  return new Set([kind]);
}

function normalizeDescribeKind(value) {
  const kind = optionalString(value)?.toLowerCase() ?? "tool";
  if (!["tool", "resource_template"].includes(kind)) {
    throw new AgentMcpError("mcp_invalid_argument", "describe.kind 只支持 tool 或 resource_template。");
  }
  return kind;
}

function normalizeLimit(value) {
  if (value === undefined) return DEFAULT_SEARCH_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SEARCH_LIMIT) {
    throw new AgentMcpError("mcp_invalid_argument", `limit 必须是 1-${MAX_SEARCH_LIMIT} 的整数。`);
  }
  return parsed;
}

function normalizeArguments(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentMcpError("mcp_invalid_argument", "call.arguments 必须是对象。");
  }
  return value;
}

function requireSafeRemoteToolName(value) {
  const name = requireNonEmptyString(value, "call 需要 name。");
  if (!SAFE_TOOL_NAME.test(name)) {
    throw new AgentMcpError("mcp_invalid_argument", "MCP tool name 包含不安全字符。");
  }
  return name;
}

function summarizeTool(tool) {
  return {
    kind: "tool",
    name: tool.name,
    description: compactCapabilityDescription(tool.description),
    title: optionalString(tool.title),
    requiredArguments: Array.isArray(tool.inputSchema?.required)
      ? tool.inputSchema.required.filter((item) => typeof item === "string")
      : []
  };
}

function summarizeResource(resource) {
  return {
    kind: "resource",
    name: optionalString(resource.name) ?? optionalString(resource.uri) ?? "resource",
    description: compactCapabilityDescription(resource.description),
    uri: optionalString(resource.uri),
    mimeType: optionalString(resource.mimeType)
  };
}

function summarizeResourceTemplate(template) {
  return {
    kind: "resource_template",
    name: optionalString(template.name) ?? optionalString(template.uriTemplate) ?? "resource-template",
    description: compactCapabilityDescription(template.description),
    uriTemplate: optionalString(template.uriTemplate),
    mimeType: optionalString(template.mimeType)
  };
}

/**
 * 为远端能力构造“轻量返回 + 完整检索文本”双层结构。
 *
 * 搜索可以利用完整说明和参数名提高召回率，但模型只会收到压缩后的摘要，
 * 避免 SIF 一类服务在 description 中附带的大段输出规范撑爆 tool result。
 */
function createSearchCandidate(kind, source) {
  const summary = kind === "tool"
    ? summarizeTool(source)
    : kind === "resource"
      ? summarizeResource(source)
      : summarizeResourceTemplate(source);
  const inputPropertyNames = kind === "tool" && source.inputSchema?.properties
    ? Object.keys(source.inputSchema.properties)
    : [];
  return {
    summary,
    nameText: [
      summary.name,
      summary.title,
      kind,
      ...inputPropertyNames
    ].filter(Boolean).join(" "),
    summaryText: summary.description,
    fullText: [
      searchableCapabilityDescription(source.description),
      source.uri,
      source.uriTemplate,
      ...inputPropertyNames
    ].filter((item) => typeof item === "string").join(" ")
  };
}

/**
 * 对中英文混合查询进行相关度排序。
 *
 * 工具名和短功能摘要权重最高，完整远端说明只作为低权重召回来源；
 * 中文连续文本额外生成二至四字片段，因此“商品画像”可以命中
 * “查询一个或多个 ASIN 的基础画像”，不要求整句连续出现。
 */
function rankSearchCandidates(candidates, query) {
  const normalizedQuery = normalizeSearchText(query);
  const directTerms = createSearchTerms(query);
  const expandedTerms = expandSearchTerms(query, directTerms);
  const queryTerms = [
    ...directTerms.map((term) => ({ term, weight: 1 })),
    ...expandedTerms.map((term) => ({ term, weight: 0.65 }))
  ];
  return candidates
    .map((candidate, index) => {
      const nameText = normalizeSearchText(candidate.nameText);
      const summaryText = normalizeSearchText(candidate.summaryText);
      const fullText = normalizeSearchText(candidate.fullText);
      const nameTerms = new Set(createSearchTerms(candidate.nameText));
      let score = 0;
      let matched = 0;
      const matchedNameTerms = new Set();

      if (normalizedQuery && nameText.includes(normalizedQuery)) score += 160;
      if (normalizedQuery && summaryText.includes(normalizedQuery)) score += 100;
      if (normalizedQuery && fullText.includes(normalizedQuery)) score += 20;

      for (const { term, weight } of queryTerms) {
        if (nameTerms.has(term)) {
          score += (term.length >= 4 ? 36 : 24) * weight;
          matched += 1;
          matchedNameTerms.add(term);
          continue;
        }
        if (nameText.includes(term)) {
          score += (term.length >= 4 ? 28 : 18) * weight;
          matched += 1;
          matchedNameTerms.add(term);
          continue;
        }
        if (summaryText.includes(term)) {
          score += (term.length >= 4 ? 16 : 10) * weight;
          matched += 1;
          continue;
        }
        if (fullText.includes(term)) {
          score += (term.length >= 4 ? 4 : 2) * weight;
          matched += 1;
        }
      }
      // 同样命中两个意图词时，名称更短、更聚焦的能力优先于附带更多限定词的能力。
      const nameDensity = nameTerms.size > 0 ? matchedNameTerms.size / nameTerms.size : 0;
      score += nameDensity * 60;
      return {
        ...candidate,
        relevance: Math.round((score + Math.min(matched, 10)) * 100) / 100,
        index
      };
    })
    .filter((candidate) => candidate.relevance > 0)
    .sort((left, right) => right.relevance - left.relevance || left.index - right.index);
}

function expandSearchTerms(query, directTerms) {
  const normalizedQuery = normalizeSearchText(query);
  const direct = new Set(directTerms);
  const expanded = new Set();
  for (const group of SEARCH_SYNONYM_GROUPS) {
    const matched = group.some((alias) => {
      const normalizedAlias = normalizeSearchText(alias);
      return direct.has(normalizedAlias) || normalizedQuery.includes(normalizedAlias);
    });
    if (!matched) continue;
    for (const alias of group) {
      for (const term of createSearchTerms(alias)) {
        if (!direct.has(term)) expanded.add(term);
      }
    }
  }
  return [...expanded];
}

function createSearchTerms(value) {
  const normalized = normalizeSearchText(value);
  const terms = new Set();
  for (const token of normalized.match(/[a-z0-9]+|[\p{Script=Han}]+/gu) ?? []) {
    terms.add(token);
    if (!/^\p{Script=Han}+$/u.test(token)) continue;
    for (let size = 2; size <= Math.min(4, token.length); size += 1) {
      for (let index = 0; index <= token.length - size; index += 1) {
        terms.add(token.slice(index, index + size));
      }
    }
  }
  return [...terms].filter((term) => term.length >= 2);
}

function normalizeSearchText(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[_./:|-]+/g, " ")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 优先抽取服务说明中的“功能”段，去掉通用输出规范和后续参数细节。
 */
function compactCapabilityDescription(value) {
  const raw = searchableCapabilityDescription(value);
  if (!raw) return "";
  let selected = raw;
  const endMatch = /\n\s*(?:触发时机|入参|返回|注意|NEXT_STEP)[：:]/u.exec(raw);
  if (endMatch) selected = raw.slice(0, endMatch.index);
  const compact = selected.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_SEARCH_DESCRIPTION_CHARS) return compact;
  return `${compact.slice(0, MAX_SEARCH_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

function searchableCapabilityDescription(value) {
  const raw = optionalString(value)?.replaceAll("\r", "") ?? "";
  if (!raw) return "";
  const featureMatch = /(?:^|\n)\s*功能[：:]\s*/u.exec(raw);
  if (!featureMatch) return raw;
  return raw.slice(featureMatch.index + featureMatch[0].length);
}

function createTraceContext(context = {}) {
  return Object.fromEntries([
    ["traceId", context.traceId],
    ["threadId", context.threadId],
    ["turnId", context.turnId],
    ["requestId", context.requestId],
    ["toolCallId", context.toolCallId ?? context.tool_call_id]
  ].filter(([, value]) => typeof value === "string" && value.trim()));
}

function completedResult(details, isError = false) {
  return {
    status: isError ? "failed" : "completed",
    content: JSON.stringify(details, null, 2),
    details,
    ...(isError ? { error: { code: "mcp_tool_error", message: "MCP server returned isError=true." } } : {})
  };
}

function readRemoteIsError(response) {
  return response?.isError === true || response?.result?.isError === true;
}

function readBinaryPayload(value) {
  const base64 = optionalString(value.base64 ?? value.blob);
  const mimeType = optionalString(value.mimeType);
  if (!base64 || !mimeType) return undefined;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new AgentMcpError("mcp_invalid_binary", "MCP 二进制资源不是合法 base64。");
  }
  if (mimeType.length > 127 || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(mimeType)) {
    throw new AgentMcpError("mcp_invalid_binary", "MCP 二进制资源 MIME 无效。");
  }
  const bytes = Number(value.bytes ?? Buffer.byteLength(base64, "base64"));
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new AgentMcpError("mcp_invalid_binary", "MCP 二进制资源 bytes 无效。");
  }
  return {
    base64,
    mimeType,
    bytes,
    hash: optionalString(value.hash ?? value.contentHash)
  };
}

function extensionForMime(mimeType) {
  const known = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "text/plain": "txt",
    "application/json": "json"
  };
  return known[mimeType.toLowerCase()] ?? "bin";
}

async function readRegistryWithRecovery(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return validateRegistry(JSON.parse(stripBom(text)));
  } catch (error) {
    if (error?.code === "ENOENT") {
      const registry = createEmptyRegistry();
      await writeRegistryAtomic(filePath, registry);
      return registry;
    }
    // 只有内容损坏才执行备份恢复；权限、磁盘或目录错误必须暴露给调用方，
    // 否则可能把真实基础设施故障误报成“已恢复空注册表”。
    if (!(error instanceof SyntaxError) && !(error instanceof AgentMcpError)) {
      throw error;
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const backupPath = `${filePath}.corrupt-${Date.now()}`;
    try {
      await fs.rename(filePath, backupPath);
    } catch (renameError) {
      if (renameError?.code !== "ENOENT") throw renameError;
    }
    const registry = createEmptyRegistry();
    await writeRegistryAtomic(filePath, registry);
    return registry;
  }
}

async function writeRegistryAtomic(filePath, registry) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

function validateRegistry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentMcpError("mcp_registry_invalid", "MCP 注册表必须是对象。");
  }
  if (value.schemaVersion !== AGENT_MCP_REGISTRY_SCHEMA_VERSION || !Array.isArray(value.registrations)) {
    throw new AgentMcpError("mcp_registry_invalid", "MCP 注册表 schema 无效。");
  }
  const ids = new Set();
  const registrations = value.registrations.map((item) => {
    const serverId = normalizeServerId(item?.serverId);
    if (ids.has(serverId)) throw new AgentMcpError("mcp_registry_invalid", `注册表包含重复服务: ${serverId}`);
    ids.add(serverId);
    if (typeof item.enabled !== "boolean") {
      throw new AgentMcpError("mcp_registry_invalid", `注册项 enabled 无效: ${serverId}`);
    }
    return {
      serverId,
      enabled: item.enabled,
      registeredAt: normalizeIsoDate(item.registeredAt),
      updatedAt: normalizeIsoDate(item.updatedAt)
    };
  });
  registrations.sort((left, right) => left.serverId.localeCompare(right.serverId));
  return { schemaVersion: AGENT_MCP_REGISTRY_SCHEMA_VERSION, registrations };
}

function createEmptyRegistry() {
  return { schemaVersion: AGENT_MCP_REGISTRY_SCHEMA_VERSION, registrations: [] };
}

function normalizeArrayResponse(response, key) {
  const value = Array.isArray(response) ? response : response?.[key];
  if (!Array.isArray(value)) {
    throw new AgentMcpError("mcp_gateway_invalid_response", `MCP Gateway 响应缺少 ${key} 数组。`);
  }
  return value;
}

function normalizeServerId(value) {
  const id = requireNonEmptyString(value, "serverId 不能为空。").toLowerCase();
  if (!SAFE_SERVER_ID.test(id)) {
    throw new AgentMcpError("mcp_invalid_server_id", `非法 MCP serverId: ${id}`);
  }
  return id;
}

function normalizeGatewayBaseUrl(value) {
  const raw = requireNonEmptyString(value, "gatewayBaseUrl 不能为空。");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new AgentMcpError("mcp_invalid_config", "gatewayBaseUrl 必须是 HTTP(S) 绝对 URL。");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new AgentMcpError("mcp_invalid_config", "gatewayBaseUrl 必须是 HTTP(S) 绝对 URL。");
  }
  return url.toString().replace(/\/+$/, "");
}

function normalizeAbsolutePath(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AgentMcpError("mcp_invalid_config", `${field} 必须是非空路径。`);
  }
  return path.resolve(value);
}

function normalizeIsoDate(value) {
  const text = requireNonEmptyString(value, "注册时间不能为空。");
  if (Number.isNaN(Date.parse(text))) throw new AgentMcpError("mcp_registry_invalid", `无效 ISO 时间: ${text}`);
  return new Date(text).toISOString();
}

function assertPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AgentMcpError("mcp_path_escape", "MCP 资源目标路径逃逸 workspace。");
  }
}

function requireNonEmptyString(value, message) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AgentMcpError("mcp_invalid_argument", message);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function clone(value) {
  return structuredClone(value);
}

function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}


