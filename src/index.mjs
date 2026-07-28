/**
 * agent-mcp 的公开 SDK 出口。
 *
 * 产品仓库只从这里导入 AgentMcp 和稳定合同，不直接依赖注册表或 Gateway
 * 请求实现。
 */

export { brickDefinition } from "./brick-definition.mjs";
export {
  AGENT_MCP_REGISTRY_SCHEMA_VERSION,
  AgentMcp,
  AgentMcpError,
  DEFAULT_AGENT_MCP_GATEWAY_BASE_URL,
  DEFAULT_AGENT_MCP_HOME
} from "./main/agent-mcp.mjs";
export { createAgentMcpRuntimeContract } from "./main/runtime-contract.mjs";
