"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");
const tar = require("tar");
const { request, secureUrl, checksumFor } = require("../lib/download");
const { resolveLauncher } = require("../lib/launcher-download");
const { resolveRuntimeDownload } = require("../lib/electron-download");

const ELECTRON_VERSION = "28.3.3";
const LAUNCHER_VERSION = "0.3.0";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function response(url, body = Buffer.alloc(0), { status = 200, headers = {}, finalUrl = url } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const values = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    url: finalUrl,
    headers: { get: name => values.get(name.toLowerCase()) ?? null },
    body: Readable.from(bytes.length ? [bytes] : []),
  };
}

function checksumFile(filename, bytes) {
  return `${sha256(bytes)} *${filename}\n`;
}

function launcherAsset(platform) {
  const platformName = { win32: "windows", darwin: "macos", linux: "linux" }[platform];
  assert.ok(platformName, `unsupported fixture platform ${platform}`);
  const isWindows = platform === "win32";
  const binary = isWindows ? "minitron.exe" : "minitron";
  return {
    binary,
    platformName,
    filename: `minitron-v${LAUNCHER_VERSION}-${platformName}-${platform === "darwin" ? "arm64" : "x64"}.${isWindows ? "zip" : "tar.gz"}`,
  };
}

function launcherDirectory(cacheDir, platform) {
  return path.join(cacheDir, "launchers", LAUNCHER_VERSION, launcherAsset(platform).platformName + (platform === "darwin" ? "-arm64" : "-x64"));
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// A tiny stored ZIP writer keeps this test independent of optional archive
// generators while exercising the production yauzl extraction path.
function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const bytes = Buffer.from(entry.bytes);
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + bytes.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function tarGzip(files) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "minitron-launcher-archive-"));
  try {
    for (const [name, bytes] of files) {
      await fsp.writeFile(path.join(root, name), bytes);
    }
    const filename = path.join(root, "fixture.tar.gz");
    await tar.c({ cwd: root, file: filename, gzip: true, portable: true }, files.map(([name]) => name));
    return await fsp.readFile(filename);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

function launcherFetcher(platform, archive, requests = []) {
  const { filename } = launcherAsset(platform);
  const checksumUrl = `https://github.com/aak1247/minitron/releases/download/v${LAUNCHER_VERSION}/SHA256SUMS`;
  const archiveUrl = `https://github.com/aak1247/minitron/releases/download/v${LAUNCHER_VERSION}/${filename}`;
  const fetchImpl = async (url, options = {}) => {
    const info = { url: String(url), method: options.method || "GET" };
    requests.push(info);
    if (info.url === checksumUrl) {
      return response(info.url, checksumFile(filename, archive), {
        headers: { "content-length": Buffer.byteLength(checksumFile(filename, archive)) },
      });
    }
    if (info.url === archiveUrl) {
      return response(info.url, archive, { headers: { "content-length": archive.length } });
    }
    throw new Error(`unexpected test request: ${info.url}`);
  };
  return fetchImpl;
}

function tempCache(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "minitron-builder-cache-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("runtime resolver binds the exact official checksum and uses HEAD size", async () => {
  const filename = `electron-v${ELECTRON_VERSION}-win32-x64.zip`;
  const expectedSha = "ab".repeat(32);
  const headSize = 74_321;
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    seen.push({ url: String(url), method: options.method || "GET" });
    if (String(url).endsWith("/SHASUMS256.txt")) {
      return response(String(url), `${"cd".repeat(32)} *electron-v${ELECTRON_VERSION}-win32-x64.zip.old\n${expectedSha} *${filename}\n`);
    }
    if (String(url).endsWith(`/${filename}`) && options.method === "HEAD") {
      return response(String(url), Buffer.alloc(0), { headers: { "content-length": headSize } });
    }
    throw new Error(`unexpected test request: ${url}`);
  };

  const artifact = await resolveRuntimeDownload({
    version: ELECTRON_VERSION,
    platform: "win32",
    arch: "x64",
    fetchImpl,
  });

  assert.deepEqual(artifact, {
    url: `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${filename}`,
    sha256: expectedSha,
    size: headSize,
  });
  assert.deepEqual(seen.map(({ method }) => method), ["GET", "HEAD"]);
});

test("runtime resolver falls back to the exact GitHub asset size when HEAD omits it", async () => {
  const filename = `electron-v${ELECTRON_VERSION}-darwin-arm64.zip`;
  const expectedSha = "ef".repeat(32);
  const apiSize = 98_765;
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    const info = { url: String(url), method: options.method || "GET" };
    seen.push(info);
    if (info.url.endsWith("/SHASUMS256.txt")) {
      return response(info.url, `${expectedSha}  ${filename}\n`);
    }
    if (info.url.endsWith(`/${filename}`) && info.method === "HEAD") {
      return response(info.url);
    }
    if (info.url === `https://api.github.com/repos/electron/electron/releases/tags/v${ELECTRON_VERSION}`) {
      return response(info.url, JSON.stringify({
        assets: [
          { name: "electron-v28.3.3-darwin-x64.zip", size: 1 },
          { name: filename, size: apiSize },
        ],
      }));
    }
    throw new Error(`unexpected test request: ${info.url}`);
  };

  const artifact = await resolveRuntimeDownload({
    version: ELECTRON_VERSION,
    platform: "darwin",
    arch: "arm64",
    fetchImpl,
  });
  assert.equal(artifact.sha256, expectedSha);
  assert.equal(artifact.size, apiSize);
  assert.equal(seen.at(-1).url, `https://api.github.com/repos/electron/electron/releases/tags/v${ELECTRON_VERSION}`);
});

test("download URL and checksum validation reject unsafe or ambiguous inputs", async () => {
  assert.throws(() => secureUrl("http://cdn.example.invalid/runtime.zip"), /HTTPS/);
  assert.throws(() => secureUrl("https://user:pass@cdn.example.invalid/runtime.zip"), /HTTPS/);
  assert.throws(() => secureUrl("https://cdn.example.invalid/runtime.zip#fragment"), /HTTPS/);
  assert.throws(() => checksumFor(`${"g".repeat(64)}  runtime.zip\n`, "runtime.zip"), /one SHA-256 checksum/);
  assert.throws(() => checksumFor(`${"a".repeat(64)}  runtime.zip\n${"b".repeat(64)}  runtime.zip\n`, "runtime.zip"), /one SHA-256 checksum/);

  let called = false;
  await assert.rejects(request("http://cdn.example.invalid/runtime.zip", {
    fetchImpl: async () => { called = true; return response("http://cdn.example.invalid/runtime.zip"); },
  }), /HTTPS/);
  assert.equal(called, false, "an HTTP URL must be rejected before invoking fetch");

  await assert.rejects(request("https://cdn.example.invalid/runtime.zip", {
    fetchImpl: async url => response(url, Buffer.alloc(0), { finalUrl: "http://attacker.example.invalid/runtime.zip" }),
  }), /HTTPS/);
});

test("runtime and launcher resolvers reject unsupported targets before fetching", async () => {
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    throw new Error("network must not be reached for an unsupported target");
  };

  await assert.rejects(resolveRuntimeDownload({
    version: ELECTRON_VERSION,
    platform: "freebsd",
    arch: "x64",
    fetchImpl,
  }), /Unsupported Minitron target/);
  await assert.rejects(resolveLauncher({
    projectDir: os.tmpdir(),
    platform: "freebsd",
    arch: "x64",
    launcherVersion: LAUNCHER_VERSION,
    cacheDir: os.tmpdir(),
    fetchImpl,
  }), /Unsupported Minitron target/);
  assert.equal(fetchCount, 0);
});

for (const target of [
  { platform: "win32", arch: "x64", format: "zip" },
  { platform: "darwin", arch: "arm64", format: "tar.gz" },
  { platform: "linux", arch: "x64", format: "tar.gz" },
]) {
  test(`launcher ${target.format} is verified, extracted, cached, and repaired after tampering (${target.platform}-${target.arch})`, async t => {
    const cacheDir = tempCache(t);
    const { binary } = launcherAsset(target.platform);
    const payload = Buffer.from(`verified launcher bytes for ${target.platform}-${target.arch}`);
    const archive = target.format === "zip"
      ? storedZip([{ name: binary, bytes: payload }])
      : await tarGzip([[binary, payload]]);
    const requests = [];
    const fetchImpl = launcherFetcher(target.platform, archive, requests);
    const options = {
      projectDir: os.tmpdir(),
      platform: target.platform,
      arch: target.arch,
      launcherVersion: LAUNCHER_VERSION,
      cacheDir,
      fetchImpl,
    };

    const launcher = await resolveLauncher(options);
    assert.ok(path.isAbsolute(launcher));
    assert.deepEqual(await fsp.readFile(launcher), payload);
    assert.deepEqual(requests.map(({ method }) => method), ["GET", "GET"]);
    const metadataPath = path.join(launcherDirectory(cacheDir, target.platform), "verified.json");
    const metadata = JSON.parse(await fsp.readFile(metadataPath, "utf8"));
    assert.equal(metadata.archiveSha256, sha256(archive));
    assert.equal(metadata.binarySha256, sha256(payload));

    const countAfterFirstInstall = requests.length;
    assert.equal(await resolveLauncher(options), launcher, "a valid cache should not redownload");
    assert.equal(requests.length, countAfterFirstInstall);

    await fsp.writeFile(launcher, Buffer.from("tampered cache bytes"));
    const repairedLauncher = await resolveLauncher(options);
    assert.ok(path.isAbsolute(repairedLauncher));
    assert.notEqual(repairedLauncher, launcher, "repair publishes a new immutable executable path");
    assert.deepEqual(await fsp.readFile(repairedLauncher), payload, "a cache hash mismatch must be repaired from the verified archive");
    assert.equal(requests.length, countAfterFirstInstall + 2);
  });
}

for (const target of [
  { platform: "win32", arch: "x64", format: "zip" },
  { platform: "darwin", arch: "arm64", format: "tar.gz" },
]) {
  test(`launcher rejects archives with extra entries before publishing a cached executable (${target.format})`, async t => {
    const cacheDir = tempCache(t);
    const { binary } = launcherAsset(target.platform);
    const archive = target.format === "zip"
      ? storedZip([
        { name: binary, bytes: Buffer.from("would-be-executable") },
        { name: "unexpected.txt", bytes: Buffer.from("untrusted extra entry") },
      ])
      : await tarGzip([
        [binary, Buffer.from("would-be-executable")],
        ["unexpected.txt", Buffer.from("untrusted extra entry")],
      ]);
    const fetchImpl = launcherFetcher(target.platform, archive);

    await assert.rejects(resolveLauncher({
      projectDir: os.tmpdir(),
      platform: target.platform,
      arch: target.arch,
      launcherVersion: LAUNCHER_VERSION,
      cacheDir,
      fetchImpl,
    }), /exactly its native executable/);

    assert.equal(fs.existsSync(path.join(launcherDirectory(cacheDir, target.platform), "verified.json")), false,
      "a rejected archive must not publish a cache index");
  });
}

test("launcher rejects a downloaded archive whose SHA-256 differs from the official checksum", async t => {
  const cacheDir = tempCache(t);
  const { binary, filename } = launcherAsset("win32");
  const archive = storedZip([{ name: binary, bytes: Buffer.from("untrusted executable") }]);
  const checksumUrl = `https://github.com/aak1247/minitron/releases/download/v${LAUNCHER_VERSION}/SHA256SUMS`;
  const archiveUrl = `https://github.com/aak1247/minitron/releases/download/v${LAUNCHER_VERSION}/${filename}`;
  const fetchImpl = async url => {
    if (String(url) === checksumUrl) {
      return response(String(url), `${"00".repeat(32)} *${filename}\n`);
    }
    if (String(url) === archiveUrl) {
      return response(String(url), archive, { headers: { "content-length": archive.length } });
    }
    throw new Error(`unexpected test request: ${url}`);
  };

  await assert.rejects(resolveLauncher({
    projectDir: os.tmpdir(),
    platform: "win32",
    arch: "x64",
    launcherVersion: LAUNCHER_VERSION,
    cacheDir,
    fetchImpl,
  }), /Launcher archive SHA-256 mismatch/);
  assert.equal(fs.existsSync(path.join(launcherDirectory(cacheDir, "win32"), "verified.json")), false);
});
