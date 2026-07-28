/**
 * 构建 agent-mcp 的可安装 runtime artifact。
 *
 * artifact 只包含 SDK、积木定义和 runtime contract，不包含 MCP 目录响应、
 * 用户注册表、连接配置或任何访问凭据。
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { brickDefinition } from "../brick-definition.mjs";
import { createAgentMcpRuntimeContract } from "../main/runtime-contract.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const distDir = path.join(repoRoot, "dist");
const runtimeDir = path.join(distDir, "runtime");
const artifactFileName = `${brickDefinition.id}-${brickDefinition.version}-win32-x64.zip`;
const artifactPath = path.join(distDir, artifactFileName);
const CRC32_TABLE = createCrc32Table();

console.log("[build-artifact] 1/5 clean dist");
await fs.rm(distDir, { recursive: true, force: true });
await fs.mkdir(runtimeDir, { recursive: true });

console.log("[build-artifact] 2/5 stage runtime files");
await copyFile("src/index.mjs");
await copyFile("src/brick-definition.mjs");
for (const file of await readFiles(path.join(repoRoot, "src", "main"))) {
  await writeRuntimeFile(path.join("src", "main", file.path), file.content);
}
await writeRuntimeJson("package.json", {
  name: "@xuanzhen-tech/agent-mcp-runtime",
  version: brickDefinition.version,
  private: true,
  type: "module",
  exports: "./src/index.mjs"
});
await writeRuntimeJson("brick-definition.snapshot.json", brickDefinition);
await writeRuntimeJson("runtime-contract.json", createAgentMcpRuntimeContract({ platform: "win32-x64" }));

console.log("[build-artifact] 3/5 create zip");
const runtimeFiles = await readFiles(runtimeDir);
const artifactBuffer = createZipBuffer(runtimeFiles);
await fs.writeFile(artifactPath, artifactBuffer);

console.log("[build-artifact] 4/5 write metadata");
const metadata = {
  brickId: brickDefinition.id,
  version: brickDefinition.version,
  artifactType: "agent-mcp",
  platform: "win32-x64",
  artifactFileName,
  artifactPath,
  size: artifactBuffer.byteLength,
  sha256: sha256(artifactBuffer),
  runtimeFiles: runtimeFiles.map((file) => file.path)
};
await fs.writeFile(path.join(distDir, "build-artifact.json"), `${JSON.stringify(metadata, null, 2)}\n`);

console.log("[build-artifact] 5/5 done");
console.log("[build-artifact] artifact", artifactPath);

async function copyFile(relativePath) {
  await writeRuntimeFile(relativePath, await fs.readFile(path.join(repoRoot, ...relativePath.split("/"))));
}

async function writeRuntimeJson(relativePath, value) {
  await writeRuntimeFile(relativePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

async function writeRuntimeFile(relativePath, content) {
  const target = path.join(runtimeDir, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function readFiles(directory, root = directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await readFiles(absolutePath, root));
    } else {
      files.push({
        path: path.relative(root, absolutePath).replaceAll(path.sep, "/"),
        content: await fs.readFile(absolutePath)
      });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function createZipBuffer(files) {
  const localFileRecords = [];
  const centralDirectoryRecords = [];
  let offset = 0;
  for (const file of files) {
    const nameBuffer = Buffer.from(file.path.replaceAll("\\", "/"), "utf8");
    const data = Buffer.from(file.content);
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localFileRecords.push(localHeader, nameBuffer, data);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralDirectoryRecords.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + data.length;
  }
  const centralDirectoryOffset = offset;
  const centralDirectory = Buffer.concat(centralDirectoryRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(centralDirectoryOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localFileRecords, centralDirectory, end]);
}

function createCrc32Table() {
  return new Uint32Array(256).map((_, index) => {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    return crc >>> 0;
  });
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
