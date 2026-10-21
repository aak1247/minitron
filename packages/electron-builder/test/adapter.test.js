"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const test = require("node:test");
const asar = require("@electron/asar");
const pickle = require("chromium-pickle-js");
const { withMinitron } = require("../index");
const { afterPack, createAfterPackHook, resolveRuntimeVersion, verifyLauncherVersion } = require("../lib/after-pack");

const RUNTIME_VERSION = "28.3.3";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

test("withMinitron composes config without mutating existing builder hooks or NSIS options", (t) => {
  const projectDir = makeTempDir();
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const userInclude = path.join(projectDir, "user.nsh");
  fs.writeFileSync(userInclude, "!macro customUnInit\n  DetailPrint \"user hook\"\n!macroend\n!insertmacro customUnInit\n");
  const existingAfterPack = async () => {};
  const originalConfig = {
    appId: "com.fixture.app",
    afterPack: existingAfterPack,
    nsis: { include: "user.nsh", oneClick: false },
  };

  const config = withMinitron(originalConfig, {
    projectDir,
    launcherPath: "bin/minitron.exe",
    manifestUrl: "https://updates.example.test/manifest.json",
  });

  assert.notEqual(config, originalConfig);
  assert.notEqual(config.nsis, originalConfig.nsis);
  assert.equal(config.nsis.oneClick, false);
  assert.equal(originalConfig.nsis.include, "user.nsh");
  assert.equal(originalConfig.afterPack, existingAfterPack);
  assert.notEqual(config.afterPack, existingAfterPack);
  const wrapper = fs.readFileSync(config.nsis.include, "utf8");
  assert.match(path.basename(config.nsis.include), /^minitron-includes\.nsh$/);
  const transformedPath = /!include "([^"]+user-0\.nsh)"/i.exec(wrapper)?.[1];
  assert.ok(transformedPath, wrapper);
  const transformed = fs.readFileSync(transformedPath, "utf8");
  assert.match(transformed, /!macro minitronUserUnInit/);
  assert.match(transformed, /!insertmacro minitronUserUnInit/);
  assert.match(wrapper, /installer\.nsh/);
});

test("NSIS include traversal aliases one nested customUnInit and rejects collisions", (t) => {
  const projectDir = makeTempDir();
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const nestedDir = path.join(projectDir, "includes");
  fs.mkdirSync(nestedDir);
  const nested = path.join(nestedDir, "hooks.nsh");
  const root = path.join(projectDir, "root.nsh");
  fs.writeFileSync(root, '!addincludedir "includes"\n!include "hooks.nsh"\n');
  fs.writeFileSync(nested, [
    "!macro customUnInit",
    "  DetailPrint \"nested\"",
    "!macroend",
    "!macro customCheckAppRunning",
    "  DetailPrint \"check app\"",
    "!macroend",
    "!insertmacro customCheckAppRunning",
    "",
  ].join("\n"));
  const installerIncludePath = path.join(projectDir, "installer.nsh");
  fs.writeFileSync(installerIncludePath, "!macro customUnInit\n!macroend\n");
  const config = withMinitron({ nsis: { include: "root.nsh" } }, {
    projectDir,
    launcherPath: "launcher",
    manifestUrl: "https://updates.example.test/manifest.json",
    installerIncludePath,
  });
  const wrapper = fs.readFileSync(config.nsis.include, "utf8");
  const transformedRoot = /!include "([^"]+user-0\.nsh)"/i.exec(wrapper)?.[1];
  assert.ok(transformedRoot, wrapper);
  const rootText = fs.readFileSync(transformedRoot, "utf8");
  const transformedNested = /!include "([^"]+user-1\.nsh)"/i.exec(rootText)?.[1];
  assert.ok(transformedNested, rootText);
  const nestedText = fs.readFileSync(transformedNested, "utf8");
  assert.match(nestedText, /!macro minitronUserUnInit/);
  assert.match(nestedText, /!macro minitronUserCheckAppRunning/);
  assert.match(nestedText, /!insertmacro minitronUserCheckAppRunning/);

  const duplicate = path.join(projectDir, "duplicate.nsh");
  fs.writeFileSync(duplicate, "!macro customUnInit\n!macroend\n");
  assert.throws(() => withMinitron({ nsis: { include: ["root.nsh", "duplicate.nsh"] } }, {
    projectDir,
    launcherPath: "launcher",
    manifestUrl: "https://updates.example.test/manifest.json",
    installerIncludePath,
  }), /define customUnInit more than once/);

  const duplicateCheck = path.join(projectDir, "duplicate-check.nsh");
  fs.writeFileSync(duplicateCheck, "!macro customCheckAppRunning\n!macroend\n");
  assert.throws(() => withMinitron({ nsis: { include: ["root.nsh", "duplicate-check.nsh"] } }, {
    projectDir,
    launcherPath: "launcher",
    manifestUrl: "https://updates.example.test/manifest.json",
    installerIncludePath,
  }), /define customCheckAppRunning more than once/);
});

test("withMinitron rejects asar:false and composes the original hook sequentially", async (t) => {
  const projectDir = makeTempDir();
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  assert.throws(() => withMinitron({ asar: false }, {
    projectDir,
    launcherPath: "launcher",
    manifestUrl: "https://updates.example.test/manifest.json",
  }), /requires electron-builder ASAR packaging/);

  const sequence = [];
  const hook = createAfterPackHook(async () => sequence.push("user"), {
    launcherPath: "unused",
    manifestUrl: "https://updates.example.test/manifest.json",
  });
  await assert.rejects(hook({ electronPlatformName: "win32", appOutDir: projectDir }), /resolved packager context/);
  assert.deepEqual(sequence, ["user"]);
});

test("launcher and runtime versions are exact and enforce the minimum launcher", () => {
  assert.equal(verifyLauncherVersion("unused", (_file, args) => {
    assert.deepEqual(args, ["--version"]);
    return { status: 0, stdout: "Minitron 0.2.0\n", stderr: "" };
  }), "0.2.0");
  assert.throws(() => verifyLauncherVersion("unused", () => ({ status: 0, stdout: "0.1.9", stderr: "" })), /0\.2\.0 or newer/);
  assert.throws(() => resolveRuntimeVersion("28.3.2", RUNTIME_VERSION), /does not match resolved Electron runtime/);
  assert.equal(resolveRuntimeVersion(undefined, RUNTIME_VERSION), RUNTIME_VERSION);
});

test("afterPack converts a Windows fixture, preserving ASAR unpacked files and user resources", async (t) => {
  const fixture = await makeFixture(t);
  const hookCalls = [];
  const context = makeContext(fixture, "win32");
  const spawn = (executable, args) => {
    assert.equal(executable, fixture.launcherPath);
    assert.deepEqual(args, ["--version"]);
    return { status: 0, stdout: "minitron 0.2.0\n", stderr: "" };
  };

  await afterPack(context, {
    launcherPath: fixture.launcherPath,
    manifestUrl: "http://127.0.0.1:8123/manifest.json",
    allowLocalhostHttp: true,
    manifestPublicKey: Buffer.alloc(32).toString("base64"),
    iconPath: fixture.iconPath,
  }, spawn);
  hookCalls.push("converted");

  const manifest = JSON.parse(asar.extractFile(fixture.archivePath, "package.json").toString("utf8"));
  assert.equal(manifest.main, "__minitron_bootstrap__.cjs");
  assert.equal(manifest.minitronOriginalMain, "dist/main/index.js");
  assert.equal(manifest.productName, "Fixture Product");
  assert.equal(manifest.desktopName, "com.fixture.app.desktop");
  assert.deepEqual(manifest.metadata, {
    retained: "user-metadata",
    minitron: {
      appId: "com.fixture.app",
      executableName: "Fixture.exe",
      iconRelativePath: "minitron-icon.png",
    },
  });
  assert.notEqual(asar.statFile(fixture.archivePath, "__minitron_bootstrap__.cjs").unpacked, true);
  assert.notEqual(asar.statFile(fixture.archivePath, "__minitron_bootstrap__.mjs").unpacked, true);
  const patchedHeader = asar.getRawHeader(fixture.archivePath).header;
  assert.equal(patchedHeader.files.dist.files.main.files["index.js"].executable, true);
  assert.deepEqual(patchedHeader.files.dist.files.main.files["index.js"].integrity, fixture.originalMainIntegrity);
  assert.deepEqual(patchedHeader.files["package.json"].integrity, computeIntegrity(asar.extractFile(fixture.archivePath, "package.json")));
  assert.deepEqual(patchedHeader.files["__minitron_bootstrap__.cjs"].integrity, computeIntegrity(asar.extractFile(fixture.archivePath, "__minitron_bootstrap__.cjs")));
  assert.deepEqual(patchedHeader.files["__minitron_bootstrap__.mjs"].integrity, computeIntegrity(asar.extractFile(fixture.archivePath, "__minitron_bootstrap__.mjs")));
  assert.ok(asar.extractFile(fixture.archivePath, "__minitron_bootstrap__.cjs").includes(Buffer.from("MINITRON_LAUNCHER")));
  assert.equal(asar.statFile(fixture.archivePath, "native/addon.node").unpacked, true);
  assert.equal(asar.extractFile(fixture.archivePath, "native/addon.node").toString("utf8"), "native-addon");
  assert.equal(fs.readFileSync(path.join(`${fixture.archivePath}.unpacked`, "native", "developer-extra.bin"), "utf8"), "untracked-sidecar-extra");
  assert.deepEqual(fs.readFileSync(path.join(fixture.resourcesDir, "minitron-icon.png")), PNG);
  assert.equal(fs.readFileSync(path.join(fixture.appOutDir, "Fixture.exe"), "utf8"), "launcher-binary");
  assert.equal(fs.existsSync(path.join(fixture.appOutDir, "electron.exe")), false);
  assert.equal(fs.existsSync(path.join(fixture.resourcesDir, "runtime.pak")), false);
  assert.equal(fs.readFileSync(path.join(fixture.resourcesDir, "custom.pak"), "utf8"), "application-owned-content");
  assert.equal(fs.readFileSync(path.join(fixture.resourcesDir, "user-data.bin"), "utf8"), "user-resource");
  assert.equal(fs.readFileSync(path.join(fixture.appOutDir, "extra-file.json"), "utf8"), "builder-extra-file");
  assert.equal(fs.readFileSync(path.join(fixture.appOutDir, "minitron.toml"), "utf8"), [
    'app_id = "com.fixture.app"',
    'required_runtime = "28.3.3"',
    'app_version = "1.2.3"',
    'manifest_url = "http://127.0.0.1:8123/manifest.json"',
    "allow_localhost_http = true",
    `manifest_public_key = "${Buffer.alloc(32).toString("base64")}"`,
    "",
  ].join("\n"));
  assert.deepEqual(hookCalls, ["converted"]);
});

test("afterPack selects the ESM wrapper for .mjs and package type module entries", async (t) => {
  for (const appManifest of [
    { main: "dist/main/index.mjs" },
    { main: "dist/main/index.js", type: "module" },
  ]) {
    const fixture = await makeFixture(t, "win32", appManifest);
    await afterPack(makeContext(fixture, "win32"), {
      launcherPath: fixture.launcherPath,
      manifestUrl: "https://updates.example.test/manifest.json",
      iconPath: fixture.iconPath,
    }, () => ({ status: 0, stdout: "0.2.0", stderr: "" }));

    const manifest = JSON.parse(asar.extractFile(fixture.archivePath, "package.json").toString("utf8"));
    assert.equal(manifest.main, "__minitron_bootstrap__.mjs");
    assert.equal(manifest.minitronOriginalMain, appManifest.main);
    assert.notEqual(asar.statFile(fixture.archivePath, "__minitron_bootstrap__.cjs").unpacked, true);
    assert.notEqual(asar.statFile(fixture.archivePath, "__minitron_bootstrap__.mjs").unpacked, true);
  }
});

test("afterPack rejects a host Electron distribution for a different target before patching app.asar", async (t) => {
  const fixture = await makeFixture(t);
  const originalManifest = asar.extractFile(fixture.archivePath, "package.json").toString("utf8");
  const context = makeContext(fixture, "linux");
  context.packager.executableName = "fixture";
  await assert.rejects(afterPack(context, {
    launcherPath: fixture.launcherPath,
    manifestUrl: "https://updates.example.test/manifest.json",
    iconPath: fixture.iconPath,
  }, () => ({ status: 0, stdout: "0.2.0", stderr: "" })), /Electron linux runtime executable is missing/);
  assert.equal(asar.extractFile(fixture.archivePath, "package.json").toString("utf8"), originalManifest);
  assert.equal(fs.readFileSync(path.join(fixture.appOutDir, "Fixture.exe"), "utf8"), "electron-branded-binary");
});

test("afterPack preserves the Linux executable name and replaces only the official Linux runtime", async (t) => {
  const fixture = await makeFixture(t, "linux");
  const context = makeContext(fixture, "linux");
  await afterPack(context, {
    launcherPath: fixture.launcherPath,
    manifestUrl: "https://updates.example.test/manifest.json",
    iconPath: fixture.iconPath,
  }, () => ({ status: 0, stdout: "0.2.0", stderr: "" }));

  assert.equal(fs.readFileSync(path.join(fixture.appOutDir, "fixture"), "utf8"), "launcher-binary");
  assert.equal(fs.existsSync(path.join(fixture.appOutDir, "electron")), false);
  const manifest = JSON.parse(asar.extractFile(fixture.archivePath, "package.json").toString("utf8"));
  assert.equal(manifest.metadata.minitron.executableName, "fixture");
  assert.equal(fs.readFileSync(path.join(fixture.resourcesDir, "custom.pak"), "utf8"), "application-owned-content");
});

async function makeFixture(t, platform = "win32", manifestOverrides = {}) {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, "project");
  const appOutDir = path.join(root, "dist", "win-unpacked");
  const resourcesDir = path.join(appOutDir, "resources");
  const appSourceDir = path.join(root, "app-source");
  const electronDist = path.join(root, "electron-dist");
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.mkdirSync(path.join(appSourceDir, "native"), { recursive: true });
  fs.mkdirSync(electronDist, { recursive: true });
  fs.mkdirSync(path.join(electronDist, "resources"), { recursive: true });
  const originalMain = manifestOverrides.main || "dist/main/index.js";
  const originalMainPath = path.join(appSourceDir, ...originalMain.split("/"));
  fs.mkdirSync(path.dirname(originalMainPath), { recursive: true });
  const appManifest = {
    name: "fixture-app",
    version: "1.2.3",
    productName: "Old Product Name",
    main: originalMain,
    desktopName: "com.fixture.app.desktop",
    metadata: { retained: "user-metadata" },
    ...manifestOverrides,
  };
  fs.writeFileSync(path.join(appSourceDir, "package.json"), JSON.stringify({
    ...appManifest,
  }, null, 2));
  const isModule = path.extname(originalMain).toLowerCase() === ".mjs" || manifestOverrides.type === "module";
  fs.writeFileSync(originalMainPath, isModule ? "export const fixtureMain = true;\n" : "module.exports = 'original-main';\n");
  fs.writeFileSync(path.join(appSourceDir, "native", "addon.node"), "native-addon");
  const archivePath = path.join(resourcesDir, "app.asar");
  await asar.createPackageWithOptions(appSourceDir, archivePath, { unpack: "**/*.node" });
  const originalHeader = asar.getRawHeader(archivePath).header;
  const originalMainEntry = findHeaderEntry(originalHeader, originalMain);
  assert.ok(originalMainEntry);
  const originalMainIntegrity = structuredClone(originalMainEntry.integrity);
  originalMainEntry.executable = true;
  rewriteFixtureHeader(archivePath, originalHeader);
  fs.mkdirSync(path.join(`${archivePath}.unpacked`, "native"), { recursive: true });
  fs.writeFileSync(path.join(`${archivePath}.unpacked`, "native", "developer-extra.bin"), "untracked-sidecar-extra");

  const launcherPath = path.join(root, "minitron.exe");
  fs.writeFileSync(launcherPath, "launcher-binary");
  const iconPath = path.join(projectDir, "assets", "icon.png");
  fs.mkdirSync(path.dirname(iconPath), { recursive: true });
  fs.writeFileSync(iconPath, PNG);
  const runtimeBinaryName = platform === "win32" ? "electron.exe" : "electron";
  const appExecutableName = platform === "win32" ? "Fixture.exe" : "fixture";
  fs.writeFileSync(path.join(appOutDir, appExecutableName), "electron-branded-binary");
  fs.writeFileSync(path.join(appOutDir, runtimeBinaryName), "electron-runtime-binary");
  fs.writeFileSync(path.join(appOutDir, "extra-file.json"), "builder-extra-file");
  fs.writeFileSync(path.join(resourcesDir, "user-data.bin"), "user-resource");
  fs.writeFileSync(path.join(resourcesDir, "custom.pak"), "application-owned-content");

  fs.writeFileSync(path.join(electronDist, "version"), `${RUNTIME_VERSION}\n`);
  fs.writeFileSync(path.join(electronDist, runtimeBinaryName), "electron-runtime-binary");
  fs.writeFileSync(path.join(electronDist, "resources", "runtime.pak"), "official-runtime-content");
  fs.writeFileSync(path.join(resourcesDir, "runtime.pak"), "official-runtime-content");
  fs.writeFileSync(path.join(electronDist, "resources", "custom.pak"), "official-runtime-content");
  return { root, projectDir, appOutDir, resourcesDir, archivePath, electronDist, launcherPath, iconPath, appExecutableName, originalMainIntegrity };
}

function rewriteFixtureHeader(archivePath, header) {
  const original = fs.readFileSync(archivePath);
  const rawHeader = asar.getRawHeader(archivePath);
  const headerPickle = pickle.createEmpty();
  headerPickle.writeString(JSON.stringify(header));
  const headerBuffer = headerPickle.toBuffer();
  const sizePickle = pickle.createEmpty();
  sizePickle.writeUInt32(headerBuffer.length);
  fs.writeFileSync(archivePath, Buffer.concat([
    sizePickle.toBuffer(),
    headerBuffer,
    original.subarray(8 + rawHeader.headerSize),
  ]));
  asar.uncache(archivePath);
}

function computeIntegrity(contents) {
  const blockSize = 4 * 1024 * 1024;
  const blocks = [];
  for (let offset = 0; offset < contents.length; offset += blockSize) {
    blocks.push(crypto.createHash("sha256").update(contents.subarray(offset, offset + blockSize)).digest("hex"));
  }
  return {
    algorithm: "SHA256",
    hash: crypto.createHash("sha256").update(contents).digest("hex"),
    blockSize,
    blocks,
  };
}

function findHeaderEntry(header, relativePath) {
  let current = header;
  for (const segment of relativePath.split("/")) {
    current = current && current.files && current.files[segment];
    if (!current) return undefined;
  }
  return current;
}

function makeContext(fixture, platform) {
  return {
    appOutDir: fixture.appOutDir,
    electronPlatformName: platform,
    packager: {
      projectDir: fixture.projectDir,
      executableName: "fixture",
      config: { electronDist: fixture.electronDist },
      info: { framework: { version: RUNTIME_VERSION } },
      appInfo: {
        id: "com.fixture.app",
        version: "1.2.3",
        productName: "Fixture Product",
        productFilename: "Fixture",
      },
    },
  };
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "minitron-builder-test-"));
}
