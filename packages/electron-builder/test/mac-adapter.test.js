"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const asar = require("@electron/asar");
const { afterPack } = require("../lib/after-pack");
const { normalizeInstallLocation } = require("../lib/mac-pkg");

const RUNTIME_VERSION = "28.3.3";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const MAIN_INFO_PLIST = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleIdentifier</key><string>com.fixture.app</string><key>CFBundleName</key><string>Fixture Product</string><key>CFBundleDisplayName</key><string>Fixture Product</string><key>CFBundleIconFile</key><string>icon.icns</string></dict></plist>";

test("afterPack converts a branded .app and preserves bundle identity and app resources", async (t) => {
  const fixture = await makeMacFixture(t, "x64");
  const pkgTarget = {
    name: "pkg",
    options: { scripts: "pkg-scripts", installLocation: "/Applications" },
  };
  const context = makeMacContext(fixture, "x64", [pkgTarget]);

  await afterPack(context, {
    launcherPath: fixture.launcherPath,
    manifestUrl: "https://updates.example.test/manifest.json",
    iconPath: fixture.iconPath,
  }, () => ({ status: 0, stdout: "0.2.0", stderr: "" }));

  assert.equal(fs.readFileSync(fixture.mainInfoPlist, "utf8"), MAIN_INFO_PLIST);
  assert.equal(fs.readFileSync(fixture.brandIconPath, "utf8"), "branded-icon");
  assert.deepEqual(fs.readFileSync(fixture.executablePath), fixture.launcherBytes);
  assert.deepEqual(fs.readFileSync(fixture.electronExecutablePath), fixture.electronExecutableBytes);
  assert.equal(fs.existsSync(fixture.runtimeFrameworkBinary), false);
  assert.equal(fs.existsSync(fixture.helperBundlePath), false);
  assert.equal(fs.existsSync(path.join(fixture.resourcesDir, "runtime.pak")), false);
  assert.equal(fs.readFileSync(path.join(fixture.resourcesDir, "custom.pak"), "utf8"), "app-owned-resource");
  assert.equal(fs.readFileSync(path.join(fixture.resourcesDir, "user-data.bin"), "utf8"), "extra-resource");
  assert.equal(fs.readFileSync(path.join(fixture.customFrameworkPath, "custom.bin"), "utf8"), "user-framework");
  assert.equal(asar.statFile(fixture.archivePath, "native/addon.node").unpacked, true);
  assert.equal(fs.readFileSync(path.join(`${fixture.archivePath}.unpacked`, "native", "addon.node"), "utf8"), "native-addon");
  assert.equal(fs.readFileSync(path.join(fixture.resourcesDir, "minitron-icon.png")).equals(PNG), true);
  assert.equal(fs.readFileSync(fixture.configPath, "utf8"), [
    'app_id = "com.fixture.app"',
    'required_runtime = "28.3.3"',
    'app_version = "1.2.3"',
    'manifest_url = "https://updates.example.test/manifest.json"',
    "allow_localhost_http = false",
    "",
  ].join("\n"));

  const uninstallScriptPath = path.join(fixture.resourcesDir, "minitron-uninstall.command");
  const uninstallScript = fs.readFileSync(uninstallScriptPath, "utf8");
  assert.match(uninstallScript, /--app-dir "\$APP_ROOT" --stop/);
  assert.match(uninstallScript, /--app-dir "\$APP_ROOT" --uninstall/);
  if (process.platform !== "win32") assert.equal((fs.statSync(uninstallScriptPath).mode & 0o111) !== 0, true);

  const generatedScripts = pkgTarget.options.scripts;
  assert.ok(path.isAbsolute(generatedScripts));
  const preinstall = fs.readFileSync(path.join(generatedScripts, "preinstall"), "utf8");
  assert.match(preinstall, /LAUNCHER="\$APP_PATH\/Contents\/MacOS\/"'Fixture'/);
  assert.match(preinstall, /--app-dir "\$APP_PATH" --stop/);
  assert.match(preinstall, /dscl \. -list \/Users UniqueID/);
  assert.match(preinstall, /--app-dir "\$APP_PATH" --runtime-root/);
  assert.match(preinstall, /launchctl asuser "\$USER_ID"/);
  assert.match(preinstall, /ELECTRON_RUNTIME_ROOT="\$RUNTIME_ROOT"/);
  assert.match(preinstall, /done <<EOF\n\$USER_LIST\nEOF/);
  assert.match(preinstall, /\.minitron-user-hook/);
  assert.equal(fs.readFileSync(path.join(generatedScripts, ".minitron-user-hook"), "utf8"), "#!/bin/sh\necho user-preinstall\n");
  assert.equal(fs.readFileSync(path.join(generatedScripts, "postinstall"), "utf8"), "#!/bin/sh\necho user-postinstall\n");
});

test("afterPack converts an arm64 .app and rejects a mismatched launcher architecture", async (t) => {
  const fixture = await makeMacFixture(t, "arm64");
  await afterPack(makeMacContext(fixture, "arm64"), {
    launcherPath: fixture.launcherPath,
    manifestUrl: "https://updates.example.test/manifest.json",
    iconPath: fixture.iconPath,
  }, () => ({ status: 0, stdout: "0.2.0", stderr: "" }));
  assert.deepEqual(fs.readFileSync(fixture.executablePath), fixture.launcherBytes);

  const mismatch = await makeMacFixture(t, "arm64", "x64");
  const before = fs.readFileSync(mismatch.executablePath);
  await assert.rejects(afterPack(makeMacContext(mismatch, "arm64"), {
    launcherPath: mismatch.launcherPath,
    manifestUrl: "https://updates.example.test/manifest.json",
    iconPath: mismatch.iconPath,
  }, () => ({ status: 0, stdout: "0.2.0", stderr: "" })), /does not contain the arm64 architecture/);
  assert.deepEqual(fs.readFileSync(mismatch.executablePath), before);
});

test("afterPack rejects MAS and universal macOS targets explicitly", async (t) => {
  const fixture = await makeMacFixture(t, "x64");
  await assert.rejects(afterPack({ ...makeMacContext(fixture, "x64"), electronPlatformName: "mas" }, {
    launcherPath: fixture.launcherPath,
    manifestUrl: "https://updates.example.test/manifest.json",
    iconPath: fixture.iconPath,
  }, () => ({ status: 0, stdout: "0.2.0", stderr: "" })), /does not support the macOS App Store/);
  await assert.rejects(afterPack(makeMacContext(fixture, "universal"), {
    launcherPath: fixture.launcherPath,
    manifestUrl: "https://updates.example.test/manifest.json",
    iconPath: fixture.iconPath,
  }, () => ({ status: 0, stdout: "0.2.0", stderr: "" })), /does not support electron-builder's universal target/);
});

test("afterPack rejects a stale macOS Electron distribution before modifying app.asar", async (t) => {
  const fixture = await makeMacFixture(t, "x64");
  fs.writeFileSync(path.join(fixture.electronDist, "version"), "27.0.0\n");
  const originalManifest = asar.extractFile(fixture.archivePath, "package.json").toString("utf8");
  await assert.rejects(afterPack(makeMacContext(fixture, "x64"), {
    launcherPath: fixture.launcherPath,
    manifestUrl: "https://updates.example.test/manifest.json",
    iconPath: fixture.iconPath,
  }, () => ({ status: 0, stdout: "0.2.0", stderr: "" })), /resolved 28\.3\.3/);
  assert.equal(asar.extractFile(fixture.archivePath, "package.json").toString("utf8"), originalManifest);
});

test("PKG install locations must be absolute and stay inside their target volume", () => {
  assert.equal(normalizeInstallLocation(undefined), "/Applications");
  assert.equal(normalizeInstallLocation("/opt/apps"), "/opt/apps");
  assert.throws(() => normalizeInstallLocation("Applications"), /must be an absolute path/);
  assert.throws(() => normalizeInstallLocation("/Applications/../tmp"), /must not traverse parent directories/);
});

async function makeMacFixture(t, runtimeArch, launcherArch = runtimeArch) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitron-mac-builder-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, "project");
  const buildResourcesDir = path.join(projectDir, "build");
  const appOutDir = path.join(root, "dist", "mac");
  const outDir = path.join(root, "dist");
  const bundlePath = path.join(appOutDir, "Fixture.app");
  const contentsDir = path.join(bundlePath, "Contents");
  const resourcesDir = path.join(contentsDir, "Resources");
  const macosDir = path.join(contentsDir, "MacOS");
  const electronDist = path.join(root, "electron-dist");
  const electronContents = path.join(electronDist, "Electron.app", "Contents");
  const frameworkDir = path.join(contentsDir, "Frameworks", "Electron Framework.framework", "Versions", "A");
  const runtimeFrameworkBinary = path.join(frameworkDir, "Electron Framework");
  const helperBundlePath = path.join(contentsDir, "Frameworks", "Fixture Product Helper.app");
  const helperContents = path.join(helperBundlePath, "Contents");
  const helperExePath = path.join(helperContents, "MacOS", "Fixture Product Helper");
  const originalMain = "dist/main/index.js";
  const appSourceDir = path.join(root, "app-source");
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(frameworkDir, { recursive: true });
  fs.mkdirSync(path.join(appSourceDir, "dist", "main"), { recursive: true });
  fs.mkdirSync(path.join(appSourceDir, "native"), { recursive: true });
  const pkgScripts = path.join(buildResourcesDir, "pkg-scripts");
  fs.mkdirSync(pkgScripts, { recursive: true });
  fs.writeFileSync(path.join(pkgScripts, "preinstall"), "#!/bin/sh\necho user-preinstall\n");
  fs.writeFileSync(path.join(pkgScripts, "postinstall"), "#!/bin/sh\necho user-postinstall\n");
  fs.mkdirSync(electronContents, { recursive: true });
  const sourceMacosDir = path.join(electronContents, "MacOS");
  const sourceFrameworkDir = path.join(electronContents, "Frameworks", "Electron Framework.framework", "Versions", "A");
  const sourceHelperContents = path.join(electronContents, "Frameworks", "Electron Helper.app", "Contents");
  fs.mkdirSync(sourceMacosDir, { recursive: true });
  fs.mkdirSync(sourceFrameworkDir, { recursive: true });
  fs.mkdirSync(path.join(sourceHelperContents, "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(electronContents, "Resources"), { recursive: true });
  fs.writeFileSync(path.join(electronDist, "version"), `${RUNTIME_VERSION}\n`);

  const sourceExecutableBytes = makeMachO(runtimeArch, "electron");
  const launcherBytes = makeMachO(launcherArch, "minitron");
  const electronExecutablePath = path.join(sourceMacosDir, "Electron");
  fs.writeFileSync(electronExecutablePath, sourceExecutableBytes);
  fs.writeFileSync(path.join(sourceFrameworkDir, "Electron Framework"), "electron-framework-binary");
  fs.writeFileSync(path.join(electronContents, "Info.plist"), "official-electron-info");
  fs.writeFileSync(path.join(electronContents, "Resources", "runtime.pak"), "official-runtime");
  fs.writeFileSync(path.join(electronContents, "Resources", "icon.icns"), "electron-icon");
  const helperSourceInfo = plistXml({
    CFBundleExecutable: "Electron Helper",
    CFBundleDisplayName: "Electron Helper",
    CFBundleIdentifier: "com.electron.helper",
    CFBundleVersion: "1",
    CFBundlePackageType: "APPL",
  });
  const helperPackagedInfo = plistXml({
    CFBundleExecutable: "Fixture Product Helper",
    CFBundleDisplayName: "Fixture Product Helper",
    CFBundleIdentifier: "com.fixture.app.helper",
    CFBundleVersion: "1.2.3",
    CFBundlePackageType: "APPL",
  });
  fs.writeFileSync(path.join(sourceHelperContents, "Info.plist"), helperSourceInfo);
  fs.writeFileSync(path.join(sourceHelperContents, "MacOS", "Electron Helper"), "electron-helper-binary");
  fs.mkdirSync(helperContents, { recursive: true });
  fs.mkdirSync(path.join(helperContents, "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(helperContents, "Info.plist"), helperPackagedInfo);
  fs.writeFileSync(helperExePath, "electron-helper-binary");

  fs.writeFileSync(path.join(appSourceDir, "package.json"), JSON.stringify({
    name: "fixture-app",
    productName: "Fixture Product",
    version: "1.2.3",
    main: originalMain,
  }, null, 2));
  fs.writeFileSync(path.join(appSourceDir, originalMain), "module.exports = 'main';\n");
  fs.writeFileSync(path.join(appSourceDir, "native", "addon.node"), "native-addon");
  const archivePath = path.join(resourcesDir, "app.asar");
  await asar.createPackageWithOptions(appSourceDir, archivePath, { unpack: "**/*.node" });

  const mainInfoPlist = path.join(contentsDir, "Info.plist");
  fs.writeFileSync(mainInfoPlist, MAIN_INFO_PLIST);
  const brandIconPath = path.join(resourcesDir, "icon.icns");
  fs.writeFileSync(brandIconPath, "branded-icon");
  fs.writeFileSync(path.join(contentsDir, "PkgInfo"), "APPLfixture");
  const executablePath = path.join(macosDir, "Fixture");
  fs.writeFileSync(executablePath, sourceExecutableBytes);
  fs.writeFileSync(runtimeFrameworkBinary, "electron-framework-binary");
  fs.writeFileSync(path.join(resourcesDir, "runtime.pak"), "official-runtime");
  fs.writeFileSync(path.join(resourcesDir, "custom.pak"), "app-owned-resource");
  fs.writeFileSync(path.join(resourcesDir, "user-data.bin"), "extra-resource");
  const customFrameworkPath = path.join(contentsDir, "Frameworks", "Custom.framework", "Resources");
  fs.mkdirSync(customFrameworkPath, { recursive: true });
  fs.writeFileSync(path.join(customFrameworkPath, "custom.bin"), "user-framework");

  const launcherPath = path.join(root, "minitron");
  fs.writeFileSync(launcherPath, launcherBytes);
  const iconPath = path.join(projectDir, "assets", "icon.png");
  fs.mkdirSync(path.dirname(iconPath), { recursive: true });
  fs.writeFileSync(iconPath, PNG);
  return {
    root,
    projectDir,
    buildResourcesDir,
    appOutDir,
    outDir,
    bundlePath,
    contentsDir,
    resourcesDir,
    electronDist,
    electronExecutablePath,
    electronExecutableBytes: sourceExecutableBytes,
    launcherPath,
    launcherBytes,
    iconPath,
    executablePath,
    runtimeFrameworkBinary,
    helperBundlePath,
    mainInfoPlist,
    brandIconPath,
    customFrameworkPath,
    archivePath,
    configPath: path.join(macosDir, "minitron.toml"),
  };
}

function makeMacContext(fixture, architecture, targets = []) {
  const architectureValue = architecture === "x64" ? 1 : architecture === "arm64" ? 3 : 4;
  return {
    appOutDir: fixture.appOutDir,
    outDir: fixture.outDir,
    arch: architectureValue,
    targets,
    electronPlatformName: "darwin",
    packager: {
      projectDir: fixture.projectDir,
      config: { electronDist: fixture.electronDist },
      info: {
        buildResourcesDir: fixture.buildResourcesDir,
        framework: { version: RUNTIME_VERSION, distMacOsAppName: "Electron.app" },
      },
      appInfo: {
        id: "com.fixture.app",
        version: "1.2.3",
        productName: "Fixture Product",
        productFilename: "Fixture",
        sanitizedProductName: "Fixture Product",
      },
    },
  };
}

function makeMachO(architecture, label) {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(architecture === "x64" ? 0x01000007 : 0x0100000c, 4);
  bytes.write(label, 8, "utf8");
  return bytes;
}

function plistXml(fields) {
  const items = Object.entries(fields).map(([key, value]) => `<key>${key}</key><string>${value}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${items}</dict></plist>`;
}
