"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const asar = require("@electron/asar");
const {
  assertNoElectronRuntimeDependency,
  copyApplicationSources,
  createArtifacts,
  parseArgs,
  resolveApplicationEntries,
} = require("../scripts/pack-asar");

test("pack CLI requires exact release versions and an output directory", () => {
  assert.throws(() => parseArgs([]), /Missing required option --runtime-version/);
  assert.throws(
    () => parseArgs(["--runtime-version", "32", "--version", "1.0.0", "--out", "out"]),
    /exact x\.y\.z version/,
  );
  assert.deepEqual(parseArgs(["--runtime-version", "32.2.0", "--version", "1.0.0", "--out", "out", "--source", "fixture"]), {
    "runtime-version": "32.2.0",
    version: "1.0.0",
    out: "out",
    source: "fixture",
  });
});

test("source staging copies the selected app manifest, lockfile, and app files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ers-source-test-"));
  const source = path.join(root, "source");
  const stage = path.join(root, "stage");
  fs.mkdirSync(path.join(source, "renderer"), { recursive: true });
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(source, "package-lock.json"), JSON.stringify({ name: "fixture", packages: { "": { version: "1.0.0" } } }));
  fs.writeFileSync(path.join(source, "main.js"), "// fixture main\n");
  fs.writeFileSync(path.join(source, "renderer", "index.html"), "<h1>fixture</h1>\n");

  try {
    copyApplicationSources(stage, { name: "fixture", version: "2.0.0", main: "main.js" }, source);
    assert.equal(JSON.parse(fs.readFileSync(path.join(stage, "package.json"), "utf8")).version, "2.0.0");
    assert.equal(JSON.parse(fs.readFileSync(path.join(stage, "package-lock.json"), "utf8")).packages[""].version, "2.0.0");
    assert.equal(fs.readFileSync(path.join(stage, "main.js"), "utf8"), "// fixture main\n");
    assert.equal(fs.readFileSync(path.join(stage, "renderer", "index.html"), "utf8"), "<h1>fixture</h1>\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("source staging includes package.main's top-level directory and explicit packaging files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ers-custom-entry-test-"));
  const source = path.join(root, "source");
  const stage = path.join(root, "stage");
  fs.mkdirSync(path.join(source, "dist", "main"), { recursive: true });
  fs.mkdirSync(path.join(source, "config"), { recursive: true });
  fs.mkdirSync(path.join(source, "renderer"), { recursive: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(source, "package-lock.json"), JSON.stringify({ name: "fixture", packages: { "": { version: "1.0.0" } } }));
  fs.writeFileSync(path.join(source, "dist", "main", "index.js"), "// custom main\n");
  fs.writeFileSync(path.join(source, "dist", "main", "worker.js"), "// included by the main directory\n");
  fs.writeFileSync(path.join(source, "config", "runtime.json"), "{}\n");
  fs.writeFileSync(path.join(source, "renderer", "index.html"), "<h1>fixture</h1>\n");
  const manifest = {
    name: "fixture",
    version: "1.0.0",
    main: "dist/main/index.js",
    runtimePackaging: { files: ["config/runtime.json"] },
  };

  try {
    copyApplicationSources(stage, manifest, source, path.join(root, "release", "resources"));
    assert.equal(fs.readFileSync(path.join(stage, "dist", "main", "index.js"), "utf8"), "// custom main\n");
    assert.equal(fs.readFileSync(path.join(stage, "dist", "main", "worker.js"), "utf8"), "// included by the main directory\n");
    assert.equal(fs.readFileSync(path.join(stage, "config", "runtime.json"), "utf8"), "{}\n");
    assert.equal(fs.readFileSync(path.join(stage, "renderer", "index.html"), "utf8"), "<h1>fixture</h1>\n");
    assert.deepEqual(
      resolveApplicationEntries(manifest, source).entries.map(([entry]) => entry.replaceAll("\\", "/")),
      ["renderer", "dist", "config/runtime.json"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtimePackaging.files rejects unsafe, missing, or output-overlapping entries and validates package.main", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ers-invalid-entry-test-"));
  const source = path.join(root, "source");
  const stage = path.join(root, "stage");
  fs.mkdirSync(path.join(source, "dist"), { recursive: true });
  fs.mkdirSync(path.join(source, "config"), { recursive: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(source, "package-lock.json"), JSON.stringify({ packages: { "": {} } }));
  fs.writeFileSync(path.join(source, "dist", "main.js"), "// main\n");
  fs.writeFileSync(path.join(source, "config", "settings.json"), "{}\n");

  try {
    for (const unsafe of ["../outside", "..\\outside", path.resolve(root, "absolute"), "config/*.json"]) {
      assert.throws(
        () => resolveApplicationEntries({ main: "dist/main.js", runtimePackaging: { files: [unsafe] } }, source),
        /relative path|escape it/,
      );
    }
    assert.throws(
      () => resolveApplicationEntries({ main: "dist/main.js", runtimePackaging: { files: ["config/missing.json"] } }, source),
      /does not exist/,
    );
    assert.throws(
      () => resolveApplicationEntries({ main: "dist/main.js", runtimePackaging: { files: ["config"] } }, source, path.join(source, "config")),
      /overlaps --out/,
    );
    assert.throws(
      () => copyApplicationSources(stage, { main: "dist/missing.js" }, source),
      /package.main was not copied as a file/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("production lockfiles cannot pull Electron runtime into the app", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ers-runtime-dependency-test-"));
  try {
    fs.writeFileSync(
      path.join(root, "package-lock.json"),
      JSON.stringify({ packages: { "": {}, "node_modules/electron": { version: "32.2.0" } } }),
    );
    assert.throws(
      () => assertNoElectronRuntimeDependency({ dependencies: {} }, root),
      /Electron runtime is present in production lockfile/,
    );
    assert.throws(
      () => assertNoElectronRuntimeDependency({ dependencies: { electron: "^32.2.0" } }, root),
      /electron must not be a production dependency/,
    );

    fs.writeFileSync(
      path.join(root, "package-lock.json"),
      JSON.stringify({ dependencies: { electron: { version: "32.2.0" } } }),
    );
    assert.throws(
      () => assertNoElectronRuntimeDependency({ dependencies: {} }, root),
      /Electron runtime is present in production lockfile/,
    );

    fs.writeFileSync(
      path.join(root, "package-lock.json"),
      JSON.stringify({ packages: { "": {}, "node_modules/electron": { version: "32.2.0", dev: true } } }),
    );
    assert.doesNotThrow(() => assertNoElectronRuntimeDependency({ devDependencies: { electron: "^32.2.0" } }, root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native file entries and ffi resources are unpacked and listed in the update ZIP", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ers-pack-test-"));
  const stage = path.join(root, "stage");
  const resources = path.join(root, "release", "resources");
  const zip = path.join(root, "release", "app-1.0.0-win32-x64-electron-32.2.0.zip");
  fs.mkdirSync(path.join(stage, "native"), { recursive: true });
  fs.mkdirSync(path.join(stage, "ffi"), { recursive: true });
  fs.mkdirSync(path.join(stage, "renderer"), { recursive: true });
  fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", main: "main.js" }));
  fs.writeFileSync(path.join(stage, "main.js"), "// main\n");
  fs.writeFileSync(path.join(stage, "native", "binding.node"), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(stage, "native", "helper.dll"), Buffer.from([4, 5, 6]));
  fs.writeFileSync(path.join(stage, "ffi", "config.json"), "{}\n");
  fs.writeFileSync(path.join(stage, "renderer", "index.html"), "<h1>fixture</h1>\n");

  try {
    const result = await createArtifacts(stage, resources, {
      runtimeVersion: "32.2.0",
      appVersion: "1.0.0",
      platform: "win32",
      arch: "x64",
      zipPath: zip,
      manifest: { runtimePackaging: { asarUnpack: ["ffi/**"] } },
    });

    assert.ok(fs.statSync(result.archive).size > 0);
    assert.ok(fs.statSync(result.zip).size > 0);
    assert.equal(asar.statFile(result.archive, "native/binding.node").unpacked, true);
    assert.equal(asar.statFile(result.archive, "native/helper.dll").unpacked, true);
    assert.equal(asar.statFile(result.archive, "ffi/config.json").unpacked, true);
    assert.notEqual(asar.statFile(result.archive, "renderer/index.html").unpacked, true);
    assert.deepEqual(fs.readFileSync(path.join(result.unpacked, "native", "binding.node")), Buffer.from([0, 1, 2, 3]));
    const zipBytes = fs.readFileSync(result.zip);
    for (const zipEntry of [
      "app.asar",
      "app.asar.unpacked/native/binding.node",
      "app.asar.unpacked/native/helper.dll",
      "app.asar.unpacked/ffi/config.json",
    ]) {
      assert.ok(zipBytes.includes(Buffer.from(zipEntry)), `update ZIP is missing ${zipEntry}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
