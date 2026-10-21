"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runCli, resolveBuilderConfiguration } = require("../lib/cli");
const { Platform } = require("app-builder-lib");

const PUBLIC_KEY = Buffer.alloc(32).toString("base64");

test("loads package build and electron-builder extends with the builder config reader", async (t) => {
  const projectDir = await makeProject(t, {});
  await fsp.writeFile(path.join(projectDir, "base.yml"), [
    "appId: com.example.base",
    "directories:",
    "  output: artifacts",
    "nsis:",
    "  oneClick: false",
    "",
  ].join("\n"));
  await fsp.writeFile(path.join(projectDir, "electron-builder.yml"), [
    "extends: file:./base.yml",
    "productName: Fixture App",
    "win:",
    "  target: nsis",
    "",
  ].join("\n"));

  const config = await resolveBuilderConfiguration({
    projectDir,
    configOption: undefined,
    packageJson: await readProjectPackage(projectDir),
  });
  assert.equal(config.appId, "com.example.base");
  assert.equal(config.productName, "Fixture App");
  assert.equal(config.directories.output, "artifacts");
  assert.equal(config.nsis.oneClick, false);
  assert.equal(config.win.target, "nsis");
});

test("loads ESM config files and ESM parent configs", async (t) => {
  const projectDir = await makeProject(t, {});
  await fsp.writeFile(path.join(projectDir, "parent.mjs"), [
    "export default { appId: 'com.example.esm-parent', directories: { output: 'esm-artifacts' } };",
    "",
  ].join("\n"));
  await fsp.writeFile(path.join(projectDir, "custom.mjs"), [
    "export default { extends: 'file:./parent.mjs', productName: 'ESM Fixture', win: { target: ['nsis'] } };",
    "",
  ].join("\n"));

  const config = await resolveBuilderConfiguration({
    projectDir,
    configOption: "custom.mjs",
    packageJson: await readProjectPackage(projectDir),
  });
  assert.equal(config.appId, "com.example.esm-parent");
  assert.equal(config.productName, "ESM Fixture");
  assert.equal(config.directories.output, "esm-artifacts");

  await fsp.writeFile(path.join(projectDir, "electron-builder.mjs"), [
    "export const appId = 'com.example.esm-default';",
    "export const productName = 'Default ESM Config';",
    "",
  ].join("\n"));
  const defaultConfig = await resolveBuilderConfiguration({
    projectDir,
    configOption: undefined,
    packageJson: await readProjectPackage(projectDir),
  });
  assert.equal(defaultConfig.appId, "com.example.esm-default");
  assert.equal(defaultConfig.productName, "Default ESM Config");
});

test("CLI preserves resolved builder config, applies -c overrides and environment minitron overrides", async (t) => {
  const projectDir = await makeProject(t, {
    minitron: {
      manifestUrl: "https://package.example.test/manifest.json",
      allowLocalhostHttp: true,
      launcherVersion: "0.4.0",
    },
    build: {
      appId: "com.example.fixture",
      productName: "Fixture App",
      directories: { output: "artifacts" },
      asar: true,
      win: { target: ["nsis"] },
      nsis: { oneClick: true },
      extraResources: ["assets/**"],
    },
  });
  let captured;
  let adapterOptions;
  const result = await runCli([
    "--win", "nsis", "--x64",
    "--config.nsis.oneClick=false",
    "--projectDir", projectDir,
  ], {
    builder: freshBuilder(),
    env: {
      MINITRON_LAUNCHER: "C:\\cache\\minitron.exe",
      MINITRON_MANIFEST_URL: "https://env.example.test/manifest.json",
      MINITRON_PUBLIC_KEY: PUBLIC_KEY,
      MINITRON_LAUNCHER_VERSION: "0.4.1",
    },
    withMinitron(config, options) {
      adapterOptions = options;
      return require("../index").withMinitron(config, options);
    },
    async build(options) {
      const configFactory = require(options.config);
      captured = {
        options,
        config: await configFactory({ projectDir: options.projectDir }),
      };
      return ["fixture installer"];
    },
  });

  assert.deepEqual(result, ["fixture installer"]);
  assert.equal(captured.options.projectDir, projectDir);
  assert.equal(captured.options.publish, "never");
  assert.ok(captured.options.config.endsWith("electron-builder.cjs"));
  assert.equal(captured.config.appId, "com.example.fixture");
  assert.equal(captured.config.productName, "Fixture App");
  assert.equal(captured.config.directories.output, "artifacts");
  assert.equal(captured.config.nsis.oneClick, false);
  assert.deepEqual(captured.config.extraResources, [{ filter: ["assets/**"] }]);
  assert.equal(typeof captured.config.afterPack, "function");
  assert.equal(captured.config.extends, null);
  assert.equal(adapterOptions.projectDir, projectDir);
  assert.equal(adapterOptions.launcherPath, "C:\\cache\\minitron.exe");
  assert.equal(adapterOptions.manifestUrl, "https://env.example.test/manifest.json");
  assert.equal(adapterOptions.manifestPublicKey, PUBLIC_KEY);
  assert.equal(adapterOptions.launcherVersion, "0.4.1");
  assert.equal(adapterOptions.allowLocalhostHttp, true);
  assert.deepEqual(captured.options.targets.get(Platform.WINDOWS).get(1), ["nsis"]);
  assert.equal(fs.existsSync(captured.options.config), false, "temporary config is removed after build completes");
});

test("default targets preserve configured targets and use installer defaults only when absent", async (t) => {
  const projectDir = await makeProject(t, {
    build: {
      appId: "com.example.defaults",
      productName: "Defaults",
      asar: true,
      win: { target: ["nsis"] },
      mac: {},
      linux: {},
    },
  });
  let effectiveConfig;
  await runCli(["--mac", "--projectDir", projectDir], {
    builder: freshBuilder(),
    build: async (options) => {
      effectiveConfig = await require(options.config)({});
      return [];
    },
  });
  assert.deepEqual(effectiveConfig.win.target, ["nsis"]);
  assert.deepEqual(effectiveConfig.mac.target, ["dmg", "pkg"]);
  assert.deepEqual(effectiveConfig.linux.target, ["deb", "rpm"]);
});

test("CLI accepts builder --dir and explicit publish mode, and rejects prepackaged input", async (t) => {
  const projectDir = await makeProject(t, {
    build: { appId: "com.example.dir", productName: "Dir", asar: true },
  });
  let captured;
  await runCli(["--win", "--x64", "--dir", "--projectDir", projectDir, "--publish", "always"], {
    builder: freshBuilder(),
    build: async (options) => {
      captured = options;
      return [];
    },
  });
  assert.equal(captured.publish, "always");
  assert.deepEqual(captured.targets.get(Platform.WINDOWS).get(1), ["dir"]);

  let buildCalled = false;
  await assert.rejects(runCli(["--prepackaged", "release/app", "--projectDir", projectDir], {
    builder: freshBuilder(),
    build: async () => { buildCalled = true; },
  }), /skips Minitron's afterPack conversion/);
  assert.equal(buildCalled, false);
});

test("CLI rejects unsupported installer targets before invoking electron-builder", async (t) => {
  const projectDir = await makeProject(t, {
    build: { appId: "com.example.linux", productName: "Linux", asar: true },
  });
  let buildCalled = false;
  await assert.rejects(runCli(["--linux", "appimage", "--projectDir", projectDir], {
    builder: freshBuilder(),
    build: async () => { buildCalled = true; },
  }), /does not support linux target "appimage"/);
  assert.equal(buildCalled, false);
});

test("--help and --version return before reading project config or building", async () => {
  let readPackageCalled = false;
  let buildCalled = false;
  const dependencies = {
    readProjectPackage: async () => { readPackageCalled = true; throw new Error("must not read project"); },
    build: async () => { buildCalled = true; },
  };
  const help = await runCli(["--help"], { ...dependencies, builder: freshBuilder() });
  assert.equal(help.handled, true);
  const version = await runCli(["--version"], { ...dependencies, builder: freshBuilder() });
  assert.equal(version.handled, true);
  assert.equal(readPackageCalled, false);
  assert.equal(buildCalled, false);
});

async function makeProject(t, metadata) {
  const projectDir = await fsp.mkdtemp(path.join(os.tmpdir(), "minitron-builder-cli-test-"));
  t.after(() => fsp.rm(projectDir, { recursive: true, force: true }));
  await fsp.writeFile(path.join(projectDir, "package.json"), JSON.stringify({
    name: "fixture-app",
    version: "1.2.3",
    author: { name: "Fixture Maintainer", email: "maintainer@example.test" },
    ...metadata,
  }, null, 2));
  return projectDir;
}

async function readProjectPackage(projectDir) {
  return JSON.parse(await fsp.readFile(path.join(projectDir, "package.json"), "utf8"));
}

function freshBuilder() {
  const filename = require.resolve("electron-builder/out/builder");
  const yargsFilename = require.resolve("yargs", { paths: [path.dirname(filename)] });
  delete require.cache[yargsFilename];
  delete require.cache[filename];
  return require(filename);
}
