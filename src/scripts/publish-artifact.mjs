/**
 * 上传 agent-mcp runtime artifact 到 OSS。
 *
 * 这个脚本只从环境变量读取 OSS 凭据，不把访问密钥、MCP 目录响应或用户数据
 * 写入 artifact descriptor。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createArtifactFileName,
  createOssConfigFromEnv,
  createOssObjectKey,
  createPublishedBrickDescriptor,
  publishFileToOss,
  validateArtifactDescriptor
} from "../main/release-foundation.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distDir = path.join(repoRoot, "dist");
await loadDotEnv(path.join(repoRoot, ".env"));
const descriptor = JSON.parse(await fs.readFile(path.join(distDir, "descriptor.local.json"), "utf8"));
const build = JSON.parse(await fs.readFile(path.join(distDir, "build-artifact.json"), "utf8"));
const objectKey = createOssObjectKey({
  prefix: process.env.OSS_OBJECT_PREFIX || "bricks",
  namespace: process.env.BRICK_NAMESPACE || "agent-mcp",
  brickId: descriptor.id,
  version: descriptor.version,
  fileName: createArtifactFileName(descriptor)
});
const upload = await publishFileToOss({
  config: createOssConfigFromEnv(process.env),
  filePath: build.artifactPath,
  objectKey,
  contentType: "application/zip"
});
const output = {
  ...createPublishedBrickDescriptor({ descriptor, ossUpload: upload }),
  metadata: {
    ...descriptor.metadata,
    objectKey,
    publishedBy: "agent-mcp-brick"
  }
};
const validation = validateArtifactDescriptor(output);
if (!validation.ok) throw new Error(`Invalid OSS descriptor: ${validation.errors.join("; ")}`);
await fs.writeFile(path.join(distDir, "descriptor.oss.json"), `${JSON.stringify(output, null, 2)}\n`);
await fs.writeFile(path.join(distDir, "oss-objects.json"), `${JSON.stringify({ objects: [objectKey] }, null, 2)}\n`);
console.log("[publish-artifact] descriptor", path.join(distDir, "descriptor.oss.json"));

async function loadDotEnv(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index < 0) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim();
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
