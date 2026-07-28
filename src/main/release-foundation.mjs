/**
 * release 合同轻量实现。
 *
 * 这个文件让当前积木仓库在 GitHub Actions 中可以独立完成 brick definition、
 * artifact descriptor 和 OSS 发布校验。正常情况下这些能力应来自 baseLine
 * 的 agent-release-foundation 包；当前仓库保留轻量实现，是为了避免远端 runner
 * 依赖本地 file:../baseline 路径。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";

const SUPPORTED_ARTIFACT_TYPES = new Set([
  "bootstrap-installer",
  "desktop-shell",
  "agent-cli",
  "node-runtime",
  "python-runtime",
  "playwright-browsers",
  "tool",
  "skills-index",
  "agent-rule",
  "agent-ecosystem",
  "agent-presentation",
  "agent-mcp",
  "config-bundle",
  "agent-knowledge",
  "agent-scheduler",
  "agent-memory"
]);

const REQUIRED_OSS_ENV_KEYS = Object.freeze([
  "OSS_BUCKET",
  "OSS_ENDPOINT",
  "OSS_REGION",
  "OSS_ACCESS_KEY_ID",
  "OSS_ACCESS_KEY_SECRET",
  "OSS_PUBLIC_BASE_URL"
]);

export function createBrickCapability(input = {}) {
  return removeUndefined({
    id: input.id,
    name: input.name,
    type: input.type,
    description: input.description,
    requires: input.requires,
    optional: input.optional
  });
}

export function createBrickDefinition(input = {}) {
  return removeUndefined({
    id: input.id,
    name: input.name,
    version: input.version,
    kind: input.kind,
    description: input.description,
    entrypoints: input.entrypoints ?? [],
    capabilities: input.capabilities ?? [],
    configSchema: input.configSchema,
    runtimeDependencies: input.runtimeDependencies ?? []
  });
}

export function validateBrickDefinition(definition) {
  const errors = [];
  if (!isObject(definition)) errors.push("brick definition must be an object");
  if (errors.length > 0) return { ok: false, errors };

  requireString(definition.id, "brick.id", errors);
  requireString(definition.name, "brick.name", errors);
  requireString(definition.version, "brick.version", errors);
  if (!["capability", "runtime", "tool", "config"].includes(definition.kind)) {
    errors.push(`brick.kind is unsupported: ${definition.kind}`);
  }
  if (!Array.isArray(definition.entrypoints)) errors.push("brick.entrypoints must be an array");
  if (!Array.isArray(definition.capabilities)) errors.push("brick.capabilities must be an array");
  return { ok: errors.length === 0, errors };
}

export function createArtifactDescriptor(input = {}) {
  const descriptor = removeUndefined({
    id: input.id,
    type: input.type,
    name: input.name,
    version: input.version,
    platform: input.platform,
    url: input.url,
    fileExtension: input.fileExtension,
    size: input.size,
    sha256: input.sha256,
    slot: input.slot,
    install: input.install,
    metadata: input.metadata,
    createdAt: input.createdAt ?? new Date().toISOString()
  });

  return {
    ...descriptor,
    fileName: input.fileName ?? createArtifactFileName(descriptor)
  };
}

export function createArtifactFileName(descriptor = {}) {
  const id = safePathSegment(requireStringValue(descriptor.id, "descriptor.id"));
  const version = safePathSegment(requireStringValue(descriptor.version, "descriptor.version"));
  const sha = requireStringValue(descriptor.sha256, "descriptor.sha256").slice(0, 12);
  const extension = descriptor.fileExtension || ".artifact";
  return `${id}-${version}-${sha}${extension.startsWith(".") ? extension : `.${extension}`}`;
}

export function createPublishedBrickDescriptor({ descriptor, ossUpload } = {}) {
  const { sourceFile: _sourceFile, ...publicDescriptor } = descriptor;
  return {
    ...publicDescriptor,
    url: ossUpload.url,
    size: ossUpload.size,
    sha256: ossUpload.sha256
  };
}

export function validateArtifactDescriptor(descriptor) {
  const errors = [];
  if (!isObject(descriptor)) errors.push("artifact must be an object");
  if (errors.length > 0) return { ok: false, errors };

  requireString(descriptor.id, "artifact.id", errors);
  requireString(descriptor.name, "artifact.name", errors);
  requireString(descriptor.type, "artifact.type", errors);
  requireString(descriptor.version, "artifact.version", errors);
  requireString(descriptor.platform, "artifact.platform", errors);
  requireString(descriptor.url, "artifact.url", errors);
  requireString(descriptor.fileName, "artifact.fileName", errors);
  requireString(descriptor.fileExtension, "artifact.fileExtension", errors);
  if (!SUPPORTED_ARTIFACT_TYPES.has(descriptor.type)) {
    errors.push(`artifact.type is unsupported: ${descriptor.type}`);
  }
  if (!Number.isFinite(descriptor.size) || descriptor.size <= 0) {
    errors.push("artifact.size must be a positive number");
  }
  if (typeof descriptor.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(descriptor.sha256)) {
    errors.push("artifact.sha256 must be a 64 character hex string");
  }
  if ("sourceFile" in descriptor) errors.push("artifact.sourceFile is not allowed in public descriptor");
  return { ok: errors.length === 0, errors };
}

export function createOssConfigFromEnv(env = process.env) {
  const missing = REQUIRED_OSS_ENV_KEYS.filter((key) => typeof env[key] !== "string" || env[key].trim() === "");
  if (missing.length > 0) throw new Error(`Missing OSS environment variables: ${missing.join(", ")}`);

  const endpoint = normalizeEndpoint(env.OSS_ENDPOINT);
  const bucket = env.OSS_BUCKET.trim();
  return {
    bucket,
    endpoint: endpoint.origin,
    endpointHost: endpoint.host.startsWith(`${bucket}.`) ? endpoint.host : `${bucket}.${endpoint.host}`,
    protocol: endpoint.protocol,
    region: env.OSS_REGION.trim(),
    accessKeyId: env.OSS_ACCESS_KEY_ID.trim(),
    accessKeySecret: env.OSS_ACCESS_KEY_SECRET.trim(),
    publicBaseUrl: env.OSS_PUBLIC_BASE_URL.trim().replace(/\/+$/, "")
  };
}

export function createOssObjectKey(input = {}) {
  return [
    safePathSegment(requireStringValue(input.prefix ?? "bricks", "prefix")),
    safePathSegment(requireStringValue(input.namespace, "namespace")),
    safePathSegment(requireStringValue(input.brickId, "brickId")),
    safePathSegment(requireStringValue(input.version, "version")),
    safePathSegment(requireStringValue(input.fileName, "fileName"))
  ].join("/");
}

export async function publishFileToOss(input = {}) {
  const fileBuffer = await fs.readFile(requireStringValue(input.filePath, "filePath"));
  const objectKey = requireStringValue(input.objectKey, "objectKey");
  const sha256 = crypto.createHash("sha256").update(fileBuffer).digest("hex");
  const response = await ossRequest(input.config, {
    method: "PUT",
    objectKey,
    body: fileBuffer,
    contentType: input.contentType ?? "application/octet-stream",
    objectAcl: input.objectAcl ?? "public-read"
  });

  return {
    objectKey,
    url: createOssObjectUrl(input.config, objectKey),
    size: fileBuffer.length,
    sha256,
    etag: response.headers.etag?.replace(/^"|"$/g, ""),
    statusCode: response.statusCode
  };
}

function createOssObjectUrl(config, objectKey) {
  return `${requireStringValue(config?.publicBaseUrl, "config.publicBaseUrl").replace(/\/+$/, "")}/${objectKey
    .replace(/^\/+/, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function ossRequest(config, options) {
  const body = options.body ? Buffer.from(options.body) : Buffer.alloc(0);
  const resourcePath = `/${options.objectKey.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/")}`;
  const contentType = options.contentType ?? "";
  const date = new Date().toUTCString();
  const canonicalizedOssHeaders = options.objectAcl ? `x-oss-object-acl:${String(options.objectAcl).trim()}\n` : "";
  const canonicalResource = `/${requireStringValue(config?.bucket, "config.bucket")}${resourcePath}`;
  const stringToSign = [options.method, "", contentType, date, `${canonicalizedOssHeaders}${canonicalResource}`].join("\n");
  const signature = crypto.createHmac("sha1", requireStringValue(config?.accessKeySecret, "config.accessKeySecret")).update(stringToSign).digest("base64");
  const headers = {
    Date: date,
    Authorization: `OSS ${requireStringValue(config?.accessKeyId, "config.accessKeyId")}:${signature}`,
    "Content-Length": body.length
  };
  if (contentType) headers["Content-Type"] = contentType;
  if (options.objectAcl) headers["x-oss-object-acl"] = options.objectAcl;

  const client = config.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    const request = client.request(
      {
        protocol: config.protocol,
        hostname: requireStringValue(config.endpointHost, "config.endpointHost"),
        method: options.method,
        path: resourcePath,
        headers
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve({ statusCode: response.statusCode, headers: response.headers, body: responseBody });
            return;
          }
          reject(new Error(`OSS ${options.method} ${options.objectKey} failed: ${response.statusCode} ${responseBody.slice(0, 500)}`));
        });
      }
    );
    request.on("error", reject);
    if (body.length > 0) request.write(body);
    request.end();
  });
}

function normalizeEndpoint(value) {
  const raw = requireStringValue(value, "OSS_ENDPOINT");
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  return { origin: url.origin, protocol: url.protocol, host: url.host };
}

function requireString(value, name, errors) {
  if (typeof value !== "string" || value.trim() === "") errors.push(`${name} is required`);
}

function requireStringValue(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

function safePathSegment(value) {
  return String(value).trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
