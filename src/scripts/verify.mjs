/**
 * 验证 agent-mcp 的构建产物和 descriptor。
 *
 * 这里检查 artifact 元数据、发布 descriptor 与 runtime contract，防止把远端
 * 目录数据、secret、本地 sourceFile 或错误 artifact type 带入发布产物。
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateArtifactDescriptor, validateBrickDefinition } from "../main/release-foundation.mjs";
import { brickDefinition } from "../brick-definition.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distDir = path.join(repoRoot, "dist");

assert.equal(validateBrickDefinition(brickDefinition).ok, true);
const build = JSON.parse(await fs.readFile(path.join(distDir, "build-artifact.json"), "utf8"));
assert.equal(build.artifactType, "agent-mcp");
assert.equal(build.platform, "win32-x64");
const artifact = await fs.readFile(build.artifactPath);
assert.equal(crypto.createHash("sha256").update(artifact).digest("hex"), build.sha256);
assert.equal(build.runtimeFiles.includes("src/main/agent-mcp.mjs"), true);
for (const forbiddenPath of [".env", "node_modules", "skills/", "threads/", "scripts/"]) {
  assert.equal(build.runtimeFiles.some((file) => file.includes(forbiddenPath)), false, `artifact must not contain ${forbiddenPath}`);
}

for (const fileName of ["descriptor.local.json", "descriptor.oss.json", "descriptor.oss.placeholder.json"]) {
  const filePath = path.join(distDir, fileName);
  let descriptor;
  try {
    descriptor = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  const validation = validateArtifactDescriptor(descriptor);
  assert.equal(validation.ok, true, validation.errors.join("; "));
  assert.equal(descriptor.type, "agent-mcp");
  assert.equal(descriptor.slot, "agent-mcp");
  assert.equal("sourceFile" in descriptor, false);
  assert.equal(JSON.stringify(descriptor).includes("secret"), false);
  if (fileName !== "descriptor.local.json") {
    assert.equal(String(descriptor.url).startsWith("file://"), false);
  }
}

const runtimeContract = JSON.parse(await fs.readFile(path.join(distDir, "runtime", "runtime-contract.json"), "utf8"));
assert.equal(runtimeContract.schemaVersion, "agent-mcp.runtime.v1");
assert.equal(runtimeContract.artifactType, "agent-mcp");
assert.equal(runtimeContract.entrypoint, "sdk-only");
assert.equal(runtimeContract.runtimeDependencies.required.some((item) => item.type === "node-runtime"), true);

console.log("[verify] ok");
