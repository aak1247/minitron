"use strict";

const { isIP } = require("node:net");

function validateManifestUrl(value, allowLocalhostHttp = false) {
  if (typeof allowLocalhostHttp !== "boolean") {
    throw new TypeError("options.allowLocalhostHttp must be a boolean when provided");
  }

  if (value === undefined || value === "") return "";
  if (typeof value !== "string") {
    throw new TypeError("options.manifestUrl must be a string when provided");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`options.manifestUrl must be an absolute HTTP(S) URL: ${value}`);
  }
  if (!(["https:", "http:"].includes(url.protocol) && url.hostname)) {
    throw new Error("options.manifestUrl must use HTTPS, or loopback HTTP with allowLocalhostHttp");
  }
  if (url.username || url.password) {
    throw new Error("options.manifestUrl must not contain credentials");
  }
  if (url.hash) {
    throw new Error("options.manifestUrl must not contain a fragment");
  }
  if (url.protocol === "http:" && (!allowLocalhostHttp || !isLoopbackHost(url.hostname))) {
    throw new Error("HTTP manifest URLs require allowLocalhostHttp and a loopback host");
  }
  return url.href;
}

function validateRuntimeDownloadArtifact(value, label = "runtime download artifact") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain an HTTPS url, SHA-256 digest, and positive size`);
  }
  if (typeof value.url !== "string") {
    throw new Error(`${label} url must be an absolute HTTPS URL`);
  }
  let url;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error(`${label} url must be an absolute HTTPS URL: ${value.url}`);
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) {
    throw new Error(`${label} url must use HTTPS without credentials or a fragment`);
  }
  if (typeof value.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(value.sha256)) {
    throw new Error(`${label} sha256 must be a 64-character hexadecimal SHA-256 digest`);
  }
  if (!Number.isSafeInteger(value.size) || value.size <= 0) {
    throw new Error(`${label} size must be a positive safe integer`);
  }
  return { url: url.href, sha256: value.sha256.toLowerCase(), size: value.size };
}

function validatePublicKey(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("options.manifestPublicKey must be a base64-encoded 32-byte Ed25519 public key");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== value) {
    throw new Error("options.manifestPublicKey must be a base64-encoded 32-byte Ed25519 public key");
  }
  return value;
}

function validateStableVersion(value, label) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${label} must be an exact stable x.y.z version; received ${value}`);
  }
  return value;
}

function renderConfig({ appId, appVersion, runtimeVersion, manifestUrl, allowLocalhostHttp, manifestPublicKey, runtimeDownload }) {
  const lines = [
    `app_id = ${quoteToml(appId)}`,
    `required_runtime = ${quoteToml(runtimeVersion)}`,
    `app_version = ${quoteToml(appVersion)}`,
    `manifest_url = ${quoteToml(manifestUrl)}`,
    `allow_localhost_http = ${allowLocalhostHttp ? "true" : "false"}`,
  ];
  if (manifestPublicKey !== undefined) lines.push(`manifest_public_key = ${quoteToml(manifestPublicKey)}`);
  if (runtimeDownload !== undefined) {
    const artifact = validateRuntimeDownloadArtifact(runtimeDownload);
    lines.push(
      "",
      "[runtime_download]",
      `url = ${quoteToml(artifact.url)}`,
      `sha256 = ${quoteToml(artifact.sha256)}`,
      `size = ${artifact.size}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function quoteToml(value) {
  return JSON.stringify(value);
}

function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "localhost.") return true;
  const family = isIP(host);
  return family === 4 ? host.startsWith("127.") : family === 6 && host === "::1";
}

module.exports = {
  renderConfig,
  validateManifestUrl,
  validatePublicKey,
  validateRuntimeDownloadArtifact,
  validateStableVersion,
};
