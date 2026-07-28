/**
 * 生成 agent-mcp 的 OSS descriptor 占位文件。
 *
 * 本地验收只验证 descriptor 形状和 object key；真实上传由 publish-artifact
 * 脚本在 GitHub Actions 的密钥环境中完成。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createArtifactFileName,
  createPublishedBrickDescriptor,
  validateArtifactDescriptor
} from "../main/release-foundation.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distDir = path.join(repoRoot, "dist");
const descriptor = JSON.parse(await fs.readFile(path.join(distDir, "descriptor.local.json"), "utf8"));
const fileName = createArtifactFileName(descriptor);
const objectKey = ["bricks", "agent-mcp", descriptor.id, descriptor.version, fileName].join("/");
const output = {
  ...createPublishedBrickDescriptor({
    descriptor,
    ossUpload: {
      objectKey,
      url: `https://oss.example.invalid/${objectKey}`,
      size: descriptor.size,
      sha256: descriptor.sha256,
      status: "placeholder-only"
    }
  }),
  metadata: {
    ...descriptor.metadata,
    ossPlaceholder: true,
    objectKey
  }
};
const validation = validateArtifactDescriptor(output);
if (!validation.ok) throw new Error(`Invalid placeholder descriptor: ${validation.errors.join("; ")}`);
await fs.writeFile(path.join(distDir, "descriptor.oss.placeholder.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log("[publish-artifact-placeholder] descriptor", path.join(distDir, "descriptor.oss.placeholder.json"));
