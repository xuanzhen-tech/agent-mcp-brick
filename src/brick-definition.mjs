/**
 * agent-mcp 的公开积木定义。
 *
 * 本积木管理用户级 MCP 启用状态并提供 AgentTool Provider。真实 MCP 连接和
 * 凭据由 Gateway 管理，积木不承载产品界面或具体服务实现。
 */

import {
  createBrickCapability,
  createBrickDefinition,
  validateBrickDefinition
} from "./main/release-foundation.mjs";

export const brickDefinition = createBrickDefinition({
  id: "agent-mcp",
  name: "Agent MCP",
  version: "0.1.2",
  kind: "capability",
  description: "通用 MCP 服务注册、渐进式能力发现与 AgentTool Provider 积木。",
  entrypoints: [
    {
      name: "AgentMcp",
      type: "api",
      description: "创建 MCP 注册管理对象并作为 AgentTool Provider 注入。"
    }
  ],
  capabilities: [
    createBrickCapability({
      id: "agent-mcp.registry",
      name: "MCP Registry",
      type: "api",
      description: "管理用户级 MCP 服务注册和启用状态。"
    }),
    createBrickCapability({
      id: "agent-mcp.progressive-tools",
      name: "Progressive MCP Tools",
      type: "api",
      description: "以每个服务单一工具渐进发现 Tools 与 Resources。"
    })
  ],
  configSchema: {
    type: "object",
    properties: {}
  },
  runtimeDependencies: [
    { type: "node-runtime", required: true }
  ]
});

const validation = validateBrickDefinition(brickDefinition);
if (!validation.ok) {
  throw new Error(`Invalid agent-mcp brick definition: ${validation.errors.join("; ")}`);
}
