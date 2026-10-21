"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { withLinuxInstallers } = require("../lib/linux-installer");

function fixture(t, manifest = { name: "test-app", productName: "Test App" }) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "minitron-linux-test-"));
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify(manifest));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  return projectDir;
}

function beforeRemovePath(config, target) {
  const args = config[target].fpm;
  const index = args.indexOf("--before-remove");
  assert.notEqual(index, -1);
  return args[index + 1];
}

test("adds DEB and RPM lifecycle hooks without changing user scripts or config arrays", (t) => {
  const projectDir = fixture(t);
  const afterInstall = "scripts/after-install.sh";
  const afterRemove = "scripts/after-remove.sh";
  const linuxFpm = ["--vendor", "Example Vendor"];
  const debFpm = ["--deb-priority", "optional"];
  const config = {
    projectDir,
    productName: "Test Product",
    linux: { fpm: linuxFpm },
    deb: { afterInstall, afterRemove, fpm: debFpm },
  };

  const result = withLinuxInstallers(config, {});

  assert.notEqual(result.config, config);
  assert.notEqual(result.config.linux, config.linux);
  assert.equal(result.config.deb.afterInstall, afterInstall);
  assert.equal(result.config.deb.afterRemove, afterRemove);
  assert.deepEqual(config.linux.fpm, ["--vendor", "Example Vendor"]);
  assert.deepEqual(config.deb.fpm, ["--deb-priority", "optional"]);
  assert.deepEqual(result.config.linux.target, ["deb", "rpm"]);
  assert.deepEqual(result.config.deb.fpm.slice(0, 2), debFpm);
  assert.equal(result.config.rpm.fpm[0], "--vendor");
  assert.equal(result.afterPack, null);

  for (const target of ["deb", "rpm"]) {
    const scriptPath = beforeRemovePath(result.config, target);
    assert.equal(fs.existsSync(scriptPath), true);
    assert.equal(scriptPath.endsWith(`${target}-before-remove.sh`), true);
    const script = fs.readFileSync(scriptPath, "utf8");
    assert.match(script, /\.local\/share\/SharedElectron\/installations\.json/);
    assert.match(script, /--runtime-root/);
    assert.match(script, /--stop/);
    assert.match(script, /--uninstall/);
    assert.doesNotMatch(script, /node(?:\.exe)?\s/);
  }
});

test("respects explicit Linux targets and adds lifecycle hooks without overwriting global config", (t) => {
  const projectDir = fixture(t);
  const config = {
    projectDir,
    linux: { target: ["deb", "rpm"], icon: "assets/app.png" },
    afterPack: async () => {},
    extraResources: [{ from: "assets", to: "assets" }],
  };

  const result = withLinuxInstallers(config, { installDir: "/opt/My Application" });

  assert.deepEqual(result.config.linux.target, ["deb", "rpm"]);
  assert.equal(result.config.linux.icon, "assets/app.png");
  assert.equal(result.config.afterPack, config.afterPack);
  assert.equal(result.config.extraResources, config.extraResources);
  const script = fs.readFileSync(beforeRemovePath(result.config, "deb"), "utf8");
  assert.match(script, /MINITRON_INSTALL_DIR='\/opt\/My Application'/);
});

test("rejects AppImage and snap targets instead of claiming full lifecycle support", (t) => {
  const projectDir = fixture(t);
  for (const target of ["AppImage", { target: "snap" }]) {
    assert.throws(
      () => withLinuxInstallers({ projectDir, linux: { target } }, {}),
      /supports only deb and rpm targets/,
    );
  }
});

test("rejects raw custom before-remove FPM hooks rather than replacing them silently", (t) => {
  const projectDir = fixture(t);
  assert.throws(
    () => withLinuxInstallers({ projectDir, deb: { fpm: ["--before-remove", "scripts/custom.sh"] } }, {}),
    /already defines a before-remove script/,
  );
});

test("generated script separates DEB upgrade/remove and RPM upgrade/erase", (t) => {
  const projectDir = fixture(t);
  const { config } = withLinuxInstallers({ projectDir }, { installDir: "/opt/Test App" });
  const deb = fs.readFileSync(beforeRemovePath(config, "deb"), "utf8");
  const rpm = fs.readFileSync(beforeRemovePath(config, "rpm"), "utf8");

  assert.match(deb, /deb:upgrade/);
  assert.match(deb, /deb:remove\|deb:purge/);
  assert.match(rpm, /rpm:0/);
  assert.match(rpm, /MINITRON_UNINSTALL=0/);
  assert.match(deb, /runuser -u/);
  assert.match(deb, /ELECTRON_RUNTIME_ROOT/);
});

test("generated maintenance scripts have valid POSIX shell syntax", (t) => {
  const projectDir = fixture(t);
  const { config } = withLinuxInstallers({ projectDir }, { installDir: "/opt/Test App" });

  for (const target of ["deb", "rpm"]) {
    const scriptPath = beforeRemovePath(config, target);
    const result = spawnSync("sh", ["-n", scriptPath], { encoding: "utf8" });
    if (result.error && result.error.code === "ENOENT") {
      t.skip("POSIX sh is unavailable on this host");
      return;
    }
    assert.equal(result.status, 0, result.stderr || result.error?.message || "sh -n failed");
  }
});
