# 产品接入说明

## 职责划分

产品层负责：

- 展示 Gateway 已配置的 MCP 服务。
- 接收用户的注册、启用、禁用和删除操作。
- 创建并复用 `AgentMcp`、`AgentTool`、`AgentCli` 对象。
- 决定 `AgentTool.tools` 白名单。

`AgentMcp` 负责：

- 用户级注册表。
- 动态生成每个服务的单一模型入口。
- 渐进式 Tools/Resources 发现。
- 将结构化上下文透传给 Gateway。

Gateway 负责：

- 保存 endpoint、stdio command 和 secret。
- 建立并复用官方 MCP Client。
- 执行 Tools 和读取 Resources。
- 记录有界 MCP 现场并关联 Agent trace。

模型不能管理连接。`register()`、`setEnabled()` 和 `unregister()` 只允许产品代码调用。

## 初始化

```js
const agentMcp = new AgentMcp();
await agentMcp.initialize();

const agentTool = new AgentTool({
  workspace,
  toolProviders: [agentMcp]
});

const agent = new AgentCli({
  workspace,
  toolRuntime: agentTool
});
```

`initialize()` 必须在 `AgentTool` 第一次读取 definitions 前完成。Gateway 暂时不可用
时，本地注册状态仍能加载；`diagnostics()` 会返回连接告警。

## 设置页操作

```js
const available = await agentMcp.listAvailableServers();
const registrations = await agentMcp.listRegistrations();

await agentMcp.register("sif");
await agentMcp.setEnabled("sif", false);
await agentMcp.setEnabled("sif", true);
await agentMcp.unregister("sif");
```

产品只能选择 `listAvailableServers()` 返回的 server id，不能传任意 URL、command、
header 或 env。用户禁用后，`sif_mcp` 会立即从下一次模型 tools schema 中消失。

## Agent 调用

模型首次使用一个服务时，通常按以下顺序调用同一个工具：

```json
{ "action": "help" }
```

```json
{ "action": "search", "query": "关键词趋势", "kind": "tool" }
```

```json
{ "action": "describe", "kind": "tool", "name": "matched-tool-name" }
```

```json
{
  "action": "call",
  "name": "matched-tool-name",
  "arguments": {
    "field": "value"
  }
}
```

`help` 不返回全部 schema，`search` 只返回轻量摘要，只有 `describe` 返回一个目标
能力的精确合同。这样服务包含大量工具时，也不会一次性占满模型上下文。

## Resources

文本 Resources 作为普通结构化 tool result 返回。

二进制 Resources 会落盘到：

```text
<workspace>/temp/mcp/<serverId>/<sha256>.<ext>
```

tool result 只保留路径、MIME、字节数和 hash。需要模型查看图片时，再调用
`image_present`；需要向用户展示时，产品沿用现有 workspace artifact 机制。

## 生命周期

关闭顺序建议如下：

```js
await agent.dispose();
await agentTool.dispose();
await agentMcp.dispose();
```

本地禁用服务不会要求 Gateway 断开共享连接。Gateway 会在空闲超时后关闭 Client
或 stdio 子进程。

## 错误处理

- 服务未注册或已禁用：`tool_unavailable`。
- Gateway 不可访问：`mcp_gateway_unreachable`。
- 服务端未配置：`mcp_server_not_found`。
- 服务端缺少 secret：`mcp_secret_missing`。
- 取消：`mcp_canceled`。
- 二进制超限：`mcp_resource_too_large`。

这些错误会经过 `AgentTool` 的统一异常捕获，形成模型可恢复的结构化 tool result，
而不是让产品 HTTP 层直接返回 500。

## Trace

`AgentCli` 会将以下字段传入 `AgentTool`，再由 `AgentMcp` 透传 Gateway：

```text
traceId
threadId
turnId
requestId
toolCallId
```

Gateway 的 readable trace 用 `requestId + toolCallId` 连接模型 tool call、
AgentTool 生命周期和远端 MCP 现场。密钥、endpoint、stdio command 和二进制
base64 不进入 readable trace。
