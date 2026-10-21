"use strict";

const crypto = require("node:crypto");

function secureUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("Download URLs must use HTTPS without credentials or fragments");
  }
  return url.href;
}

async function request(url, options = {}) {
  const { fetchImpl = globalThis.fetch, ...init } = options;
  const response = await fetchImpl(secureUrl(url), {
    signal: AbortSignal.timeout(120_000),
    ...init,
    headers: { "User-Agent": "minitron-builder", ...init.headers },
  });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} (${url})`);
  if (response.url) secureUrl(response.url);
  return response;
}

async function readLimited(response, limit) {
  const length = Number(response.headers.get("content-length"));
  if (length > limit) throw new Error("Download exceeds its size limit");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("Download exceeds its size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function checksumFor(text, filename) {
  const matches = text.split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim()))
    .filter(match => match && match[2] === filename);
  if (matches.length !== 1) throw new Error(`Expected one SHA-256 checksum for ${filename}`);
  return matches[0][1].toLowerCase();
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function target(platform, arch) {
  const names = { win32: "windows", linux: "linux", darwin: "macos" };
  if (!names[platform] || !["x64", "arm64"].includes(arch)
      || (platform !== "darwin" && arch !== "x64")) {
    throw new Error(`Unsupported Minitron target: ${platform}-${arch}`);
  }
  return `${names[platform]}-${arch}`;
}

module.exports = { secureUrl, request, readLimited, checksumFor, sha256, target };
