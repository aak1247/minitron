"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { createWriteStream } = require("node:fs");
const { validateStableVersion } = require("./validation");
const { request, readLimited, checksumFor, sha256, target } = require("./download");
const pending = new Map();
const LIMIT = 64 * 1024 * 1024;

async function resolveLauncher(options) {
  const { projectDir = process.cwd(), platform, arch, launcherPath, fetchImpl } = options;
  if (launcherPath !== undefined) {
    const filename = path.resolve(projectDir, launcherPath);
    if (!(await fs.stat(filename)).isFile()) throw new Error(`Launcher is not a regular file: ${filename}`);
    return filename;
  }
  const version = String(options.launcherVersion || require("../package.json").version).replace(/^v/, "");
  validateStableVersion(version, "Minitron launcher version");
  const platformName = target(platform, arch);
  const cache = path.resolve(options.cacheDir || process.env.MINITRON_CACHE_DIR || path.join(os.homedir(), ".cache", "minitron-builder"));
  const directory = path.join(cache, "launchers", version, platformName);
  const key = `${directory}/${platform}`;
  if (!fetchImpl && pending.has(key)) return pending.get(key);
  const task = install({ directory, version, platformName, platform, fetchImpl });
  if (!fetchImpl) {
    pending.set(key, task);
    task.finally(() => pending.delete(key)).catch(() => {});
  }
  return task;
}

async function install({ directory, version, platformName, platform, fetchImpl }) {
  const binary = platform === "win32" ? "minitron.exe" : "minitron";
  const cached = await validCache(directory, binary);
  if (cached) return cached;
  const filename = `minitron-v${version}-${platformName}.${platform === "win32" ? "zip" : "tar.gz"}`;
  const base = `https://github.com/aak1247/minitron/releases/download/v${version}`;
  const checksums = await readLimited(await request(`${base}/SHA256SUMS`, { fetchImpl }), 1024 * 1024);
  const expected = checksumFor(checksums.toString("utf8"), filename);
  console.log(`minitron-builder: downloading launcher ${version} (${platformName})`);
  const bytes = await readLimited(await request(`${base}/${filename}`, { fetchImpl }), LIMIT);
  if (sha256(bytes) !== expected) throw new Error(`Launcher archive SHA-256 mismatch: ${filename}`);
  await fs.mkdir(path.dirname(directory), { recursive: true });
  const staging = await fs.mkdtemp(path.join(path.dirname(directory), ".download-"));
  try {
    const archive = path.join(staging, platform === "win32" ? "archive.zip" : "archive.tar.gz");
    await fs.writeFile(archive, bytes, { flag: "wx" });
    const extraction = path.join(staging, "files");
    await fs.mkdir(extraction);
    if (platform === "win32") await extractZip(archive, extraction, binary);
    else await extractTar(archive, extraction, binary);
    const executable = path.join(extraction, binary);
    const stat = await fs.lstat(executable);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > LIMIT) throw new Error("Invalid launcher archive contents");
    if (platform !== "win32") await fs.chmod(executable, 0o755);
    const metadata = { archiveSha256: expected, binarySha256: sha256(await fs.readFile(executable)) };
    const existing = await validCache(directory, binary, metadata.binarySha256);
    if (existing) return existing;
    // Each publication is immutable. Parallel builds can safely keep using an
    // older path while another writer atomically updates the small cache index.
    await fs.mkdir(directory, { recursive: true });
    const name = `${metadata.binarySha256}-${randomUUID()}`;
    const installed = path.join(directory, name);
    await fs.rename(extraction, installed);
    const index = path.join(directory, `.verified-${randomUUID()}.json`);
    try {
      await fs.writeFile(index, JSON.stringify({ ...metadata, directory: name }), { flag: "wx" });
      await fs.rename(index, path.join(directory, "verified.json"));
    } finally {
      await fs.rm(index, { force: true });
    }
    return path.join(installed, binary);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function validCache(directory, binary, expectedHash) {
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(directory, "verified.json"), "utf8"));
    if (!/^[a-f0-9]{64}$/.test(metadata.binarySha256) || (expectedHash && metadata.binarySha256 !== expectedHash)) return false;
    if (typeof metadata.directory !== "string" || !/^[a-f0-9]{64}-[a-f0-9-]{36}$/.test(metadata.directory)
        || !metadata.directory.startsWith(metadata.binarySha256 + "-")) return false;
    const installed = path.join(directory, metadata.directory);
    if (!(await fs.lstat(installed)).isDirectory()) return false;
    const executable = path.join(installed, binary);
    const stat = await fs.lstat(executable);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= LIMIT
      && sha256(await fs.readFile(executable)) === metadata.binarySha256 ? executable : false;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code) || error instanceof SyntaxError) return false;
    throw error;
  }
}

async function extractTar(archive, directory, binary) {
  let found = false;
  let invalid = false;
  await require("tar").x({ file: archive, cwd: directory, strict: true, preservePaths: false,
    filter(filename, entry) {
      if ([".", "./"].includes(filename) && entry.type === "Directory") return false;
      if (![binary, `./${binary}`].includes(filename) || entry.type !== "File" || entry.size > LIMIT || found) {
        invalid = true;
        return false;
      }
      found = true;
      return true;
    },
  });
  if (!found || invalid) throw new Error("Launcher archive must contain exactly its native executable");
}

async function extractZip(archive, directory, binary) {
  const yauzl = require("yauzl");
  await new Promise((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      let found = false;
      const fail = error => { zip.close(); reject(error); };
      zip.on("error", fail);
      zip.on("end", () => found ? resolve() : reject(new Error("Launcher ZIP has no executable")));
      zip.on("entry", entry => {
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (found || entry.fileName !== binary || (mode && mode !== 0o100000) || entry.uncompressedSize > LIMIT) {
          fail(new Error("Launcher ZIP must contain exactly its native executable"));
          return;
        }
        found = true;
        zip.openReadStream(entry, (error, stream) => {
          if (error) return fail(error);
          pipeline(stream, createWriteStream(path.join(directory, binary), { flags: "wx" }))
            .then(() => zip.readEntry(), fail);
        });
      });
      zip.readEntry();
    });
  });
}

module.exports = { resolveLauncher };
