/**
 * 创建 agent-mcp 的本地 artifact descriptor。
 *
 * descriptor 只描述可安装 SDK runtime，不携带远端目录内容、secret 或本地
 * sourceFile，产品仓库可直接将其组合进 release manifest。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createArtifactDescriptor,
  createArtifactFileName,
  validateArtifactDescriptor
} from "../main/release-foundation.mjs";
import { brickDefinition } from "../brick-definition.mjs";
import { DEFAULT_AGENT_MCP_GATEWAY_BASE_URL } from "../main/agent-mcp.mjs";

const ARTIFACT_TYPE = "agent-mcp";
const TARGET_PLATFORM = "win32-x64";
const FILE_EXTENSION = ".zip";
const STABLE_SLOT = "agent-mcp";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const distDir = path.join(repoRoot, "dist");
const buildMetadata = JSON.parse(await fs.readFile(path.join(distDir, "build-artifact.json"), "utf8"));

const descriptor = createArtifactDescriptor({
  id: brickDefinition.id,
  type: ARTIFACT_TYPE,
  name: brickDefinition.name,
  version: brickDefinition.version,
  platform: TARGET_PLATFORM,
  url: pathToFileURL(buildMetadata.artifactPath).href,
  size: buildMetadata.size,
  sha256: buildMetadata.sha256,
  fileExtension: FILE_EXTENSION,
  slot: STABLE_SLOT,
  install: { strategy: "versioned-directory" },
  metadata: {
    brickId: brickDefinition.id,
    brickKind: brickDefinition.kind,
    runtimeContract: "runtime-contract.json",
    command: "sdk-only",
    defaultGatewayBaseUrl: DEFAULT_AGENT_MCP_GATEWAY_BASE_URL,
    registrySchemaVersion: "agent-mcp.registry.v1",
    storesSecrets: false
  }
});

const validation = validateArtifactDescriptor(descriptor);
if (!validation.ok) throw new Error(`Invalid descriptor: ${validation.errors.join("; ")}`);

const output = {
  ...descriptor,
  metadata: {
    ...descriptor.metadata,
    standardFileName: createArtifactFileName(descriptor)
  }
};
await fs.writeFile(path.join(distDir, "descriptor.local.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log("[create-descriptor] descriptor", path.join(distDir, "descriptor.local.json"));
