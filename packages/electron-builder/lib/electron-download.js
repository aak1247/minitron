"use strict";

const { validateStableVersion } = require("./validation");
const { request, readLimited, checksumFor, target } = require("./download");
const pending = new Map();

async function resolveRuntimeDownload({ version, platform, arch, fetchImpl }) {
  validateStableVersion(version, "Electron version");
  target(platform, arch);
  const key = `${version}/${platform}/${arch}`;
  if (!fetchImpl && pending.has(key)) return pending.get(key);
  const task = resolve({ version, platform, arch, fetchImpl });
  if (!fetchImpl) {
    pending.set(key, task);
    task.catch(() => pending.delete(key));
  }
  return task;
}

async function resolve({ version, platform, arch, fetchImpl }) {
  const filename = `electron-v${version}-${platform}-${arch}.zip`;
  const base = `https://github.com/electron/electron/releases/download/v${version}`;
  const checksums = await readLimited(await request(`${base}/SHASUMS256.txt`, { fetchImpl }), 4 * 1024 * 1024);
  const sha256 = checksumFor(checksums.toString("utf8"), filename);
  const url = `${base}/${filename}`;
  const response = await request(url, { fetchImpl, method: "HEAD" });
  let size = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(size) || size <= 0) {
    const metadata = JSON.parse((await readLimited(await request(
      `https://api.github.com/repos/electron/electron/releases/tags/v${version}`, { fetchImpl },
    ), 4 * 1024 * 1024)).toString("utf8"));
    const matches = (metadata.assets || []).filter(asset => asset.name === filename);
    if (matches.length !== 1) throw new Error(`Official Electron release is missing ${filename}`);
    size = matches[0].size;
  }
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`Invalid official archive size for ${filename}`);
  return { url, sha256, size };
}

module.exports = { resolveRuntimeDownload };
