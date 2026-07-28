/**
 * agent-mcp runtime artifact 的公开合同。
 *
 * 合同只描述 SDK 入口、本地注册表和 Gateway Broker 依赖，不包含具体 MCP
 * endpoint、stdio command 或凭据。
 */
import { brickDefinition } from "../brick-definition.mjs";

export function createAgentMcpRuntimeContract(input = {}) {
  return {
    schemaVersion: "agent-mcp.runtime.v1",
    brickId: brickDefinition.id,
    version: brickDefinition.version,
    kind: brickDefinition.kind,
    artifactType: "agent-mcp",
    platform: input.platform ?? "win32-x64",
    entrypoint: "sdk-only",
    registry: {
      schemaVersion: "agent-mcp.registry.v1",
      defaultRelativePath: ".agent-cli/mcp/registry.json",
      storesSecrets: false
    },
    providerContract: {
      type: "agent-tool-provider",
      dynamicDescriptors: true,
      methods: ["getToolDescriptors", "execute", "getToolAvailability", "diagnostics", "dispose"]
    },
    runtimeDependencies: {
      required: [{ type: "node-runtime" }],
      optional: []
    }
  };
}
