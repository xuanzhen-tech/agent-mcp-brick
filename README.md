# agent-mcp-brick

`agent-mcp` 是 MCP 服务注册、渐进式能力发现与 `AgentTool` Provider 积木。

它解决三个边界问题：

- 产品只管理“用户启用了哪些 Gateway 已配置服务”，不接触 endpoint、command 或密钥。
- Agent 每个服务只看到一个入口工具，不把几十个 MCP schema 一次性塞进模型上下文。
- 真实 MCP 连接、transport 生命周期和 secret 始终由 Gateway 管理。

## 能力边界

本积木负责：

- 保存用户级启用状态到 `~/.agent-cli/mcp/registry.json`。
- 将启用的服务映射为 `<serverId>_mcp` 动态工具。
- 提供 `help`、`search`、`describe`、`call`、`read` 渐进式动作。
- 将 MCP 二进制内容安全落入当前 workspace 的 `temp/mcp/`。
- 作为动态 Provider 注入 `AgentTool`。

本积木不负责：

- 保存 MCP URL、stdio command、header 或密钥。
- 允许模型注册、删除或修改连接。
- 执行 MCP transport；这由 `agent-llm-gateway` 完成。
- 修改 `AgentCli` system prompt。
- 提供面向最终用户的命令行界面。

## 产品接入

```js
import { AgentCli } from "@xuanzhen-tech/agent-cli-brick";
import { AgentMcp } from "@xuanzhen-tech/agent-mcp-brick";
import { AgentTool } from "@xuanzhen-tech/agent-tool-brick";

const agentMcp = new AgentMcp();
await agentMcp.initialize();

// 该操作由产品设置页响应用户选择，不允许模型调用。
await agentMcp.register("sif");
await agentMcp.register("sellersprite");
await agentMcp.register("sorftime");

const agentTool = new AgentTool({
  toolProviders: [agentMcp]
});

const agent = new AgentCli({
  toolRuntime: agentTool
});
```

产品如需进一步限制工具，可继续使用 `AgentTool` 白名单：

```js
const agentTool = new AgentTool({
  tools: ["run_shell", "sif_mcp"],
  toolProviders: [agentMcp]
});
```

注册、启用、禁用或删除完成后，下一次读取 `agentTool.definitions` 会立即反映
最新状态，不需要重建 `AgentTool` 或 `AgentCli`。

每个服务始终只对应一个渐进式模型入口。当前 Gateway 配置 SIF、SellerSprite
和 Sorftime 时，三个入口分别为 `sif_mcp`、`sellersprite_mcp` 和
`sorftime_mcp`；远端数十个工具仍通过 `search → describe → call` 按需发现，
不会一次性进入模型 tools schema。

完整接入与职责说明见 [产品接入说明](docs/product-integration.md)。

## 渐进式动作

模型只看到一个 `sif_mcp`：

```json
{
  "action": "search",
  "query": "关键词研究"
}
```

推荐调用顺序：

1. `help`：查看服务说明、能力数量与动作含义。
2. `search`：按关键词搜索工具、资源和资源模板，最多返回 20 条轻量摘要。
   搜索支持中英文混合词、常见意图同义词和相关度排序；远端超长说明只用于
   低权重召回，返回结果优先提取“功能”段，并附带必填参数名。
3. `describe`：读取目标工具的完整 schema 或资源模板 URI。
4. `call`：使用精确参数调用远端工具。
5. `read`：读取明确的 resource URI。

运行时不强制状态机。模型已经知道准确工具名和参数时，可以直接 `call`；
Gateway 仍会以 MCP server 的真实 schema 校验和执行。

## SDK

```js
const mcp = new AgentMcp();

await mcp.initialize();

mcp.definition;
mcp.toolDescriptors;

await mcp.listAvailableServers();
await mcp.listRegistrations();
await mcp.register("sif");
await mcp.unregister("sif");
await mcp.setEnabled("sif", true);
await mcp.getStatus("sif");
await mcp.testConnection("sif");
await mcp.diagnostics();
await mcp.dispose();
```

默认注册表只包含：

```json
{
  "schemaVersion": "agent-mcp.registry.v1",
  "registrations": [
    {
      "serverId": "sif",
      "enabled": true,
      "registeredAt": "2026-07-28T00:00:00.000Z",
      "updatedAt": "2026-07-28T00:00:00.000Z"
    }
  ]
}
```

## Gateway 配置

连接配置只存在于服务器：

```text
LLM_GATEWAY_MCP_SERVERS_JSON=[...]
LLM_GATEWAY_SIF_MCP_SECRET=...
```

Streamable HTTP 示例：

```json
[
  {
    "id": "sif",
    "label": "SIF",
    "description": "SIF MCP",
    "enabled": true,
    "transport": {
      "type": "streamable-http",
      "url": "https://mcp.sif.com/mcp",
      "headerEnv": {
        "secret-key": "LLM_GATEWAY_SIF_MCP_SECRET"
      }
    }
  }
]
```

`headerEnv` 的值是服务器环境变量名，不是密钥本身。Gateway 的公开目录、错误、
tool result 与 trace 都会隐藏配置和密钥。

## 本地验证

```powershell
npm ci
npm run smoke:contract
npm run smoke:mcp
npm run smoke:integration
npm run release:local
```

- `smoke:mcp` 启动真实 HTTP Gateway fixture，验证注册表和渐进动作。
- `smoke:integration` 使用正式 `AgentCli`、`AgentTool`、`AgentMcp`、Gateway
  与官方 stdio MCP Server SDK 完成四轮工具循环。
- Gateway 仓库另有真实 Streamable HTTP、stdio、取消、Resources 和 trace 测试。

## 发布

GitHub Actions 的 `Release Brick` 同时支持：

- `artifact_mode=oss`：上传 runtime artifact 并生成 `descriptor.oss.json`。
- `publish_npm=true`：发布 SDK 到 GitHub Packages。

产品消费发布后的 npm SDK；安装器或 release manifest 消费 OSS descriptor。
