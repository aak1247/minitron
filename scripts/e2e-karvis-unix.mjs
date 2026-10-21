#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { signManifest } from './publish-release.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeVersion = '28.3.3';
const productName = 'Karvis AI';
const adapterPath = path.join(repo, 'packages/electron-builder/index.js');
const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log('Usage: node scripts/e2e-karvis-unix.mjs --project <Karvis snapshot> --launcher <minitron 0.3> --runtime-zip <Electron 28.3.3 ZIP> [--work <directory>] [--report <file>]');
  process.exit(0);
}
for (const key of ['project', 'launcher', 'runtime-zip']) {
  if (!options[key]) throw new Error(`Missing --${key}`);
}
if (process.platform !== 'linux' && process.platform !== 'darwin') {
  throw new Error('Karvis Unix E2E must run on Linux or macOS');
}
if (process.getuid && process.getuid() === 0) {
  throw new Error('Run this E2E as the normal CI user; only package installation uses sudo');
}
if (!['x64', 'arm64'].includes(process.arch)) throw new Error(`Unsupported Unix architecture: ${process.arch}`);

const projectDir = path.resolve(options.project);
const launcherPath = path.resolve(options.launcher);
const runtimeZip = path.resolve(options['runtime-zip']);
for (const [label, filename] of [
  ['Karvis source snapshot', path.join(projectDir, 'package.json')],
  ['Minitron launcher', launcherPath],
  ['Electron runtime ZIP', runtimeZip],
  ['electron-builder adapter', adapterPath],
]) {
  const stat = await fs.stat(filename).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error(`${label} is missing: ${filename}`);
}

  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${cryptoId()}`;
const work = path.resolve(options.work || path.join(os.tmpdir(), `minitron-karvis-unix-${runId}`));
const reportPath = path.resolve(options.report || path.join(work, 'e2e-report.json'));
const runtimeRoot = path.join(work, 'runtime-cache');
const installedLinuxDir = '/opt/Karvis AI';
const installedMacParent = path.join(work, 'installed', 'mac');
const installedMacApp = path.join(installedMacParent, `${productName}.app`);
const targetAppId = `com.karvis.e2e.${runId.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
const executableName = `karvis-e2e-${runId.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
const packageName = `minitron-karvis-e2e-${runId.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
const runtimePlatform = `${process.platform}-${process.arch}`;
const diagnosticsDir = path.join(work, 'diagnostics');
const markersDir = path.join(work, 'markers');
const logsDir = path.join(work, 'logs');
const peerRoot = path.join(work, 'installed', 'peer');
const peerAppDir = process.platform === 'linux'
  ? path.join(peerRoot, 'linux', 'Karvis AI')
  : path.join(peerRoot, 'mac', `${productName}.app`);
const targetUserData = path.join(work, 'user-data', 'target');
const peerUserData = path.join(work, 'user-data', 'peer');
const targetDiagnostic = path.join(diagnosticsDir, 'target.json');
const peerDiagnostic = path.join(diagnosticsDir, 'peer.json');
const commands = [];
const stages = [];
const ownedProcesses = new Set();
const mountedVolumes = new Set();
const report = {
  runId, platform: process.platform, architecture: process.arch, runtimePlatform,
  runtimeVersion, projectDir, launcherPath, runtimeZip, work, started: new Date().toISOString(),
  packageName, executableName, appId: targetAppId, commands, stages, artifacts: {}, scenarios: [],
};
let server;
let targetManifest;
let peerManifest;
let setManifests;
let sourceSnapshot;
let failure;
let currentScenario;

try {
  await fs.mkdir(work, { recursive: true });
  await Promise.all([fs.mkdir(diagnosticsDir, { recursive: true }), fs.mkdir(markersDir, { recursive: true }), fs.mkdir(logsDir, { recursive: true }), fs.mkdir(peerRoot, { recursive: true })]);
  if (process.platform === 'linux') {
    assert.equal(await exists(installedLinuxDir), false, `Refusing to replace a pre-existing system install: ${installedLinuxDir}`);
    assert(await commandExists('sudo'), 'Linux package E2E requires sudo');
    assert(await commandExists('gio'), 'Linux system-entry launch requires gio');
    assert(await commandExists('dpkg'), 'Linux DEB E2E requires dpkg');
    assert(await commandExists('rpm'), 'Linux RPM E2E requires rpm');
  }

  sourceSnapshot = await snapshotSource(projectDir);
  report.sourceFileCount = sourceSnapshot.size;
  report.sourceHashes = Object.fromEntries(sourceSnapshot);
  const sourcePackage = JSON.parse(await fs.readFile(path.join(projectDir, 'package.json'), 'utf8'));
  const sourceBuild = isRecord(sourcePackage.build) ? sourcePackage.build : {};
  const pngIcon = await resolvePngIcon(projectDir, sourceBuild);
  const assetsDir = path.join(projectDir, 'assets');
  assert(await exists(assetsDir), 'Karvis snapshot must include assets/ for extraResources');
  await verifyBuildInputs(projectDir);
  await verifyLauncher(launcherPath);
  await verifyRuntimeZip(runtimeZip);

  const electronDist = path.join(projectDir, 'node_modules', 'electron', 'dist');
  assert.equal(await readVersion(path.join(electronDist, 'version')), runtimeVersion, 'Karvis node_modules/electron/dist must match Electron 28.3.3');
  report.electronDist = electronDist;
  report.runtimeZipBytes = (await fs.stat(runtimeZip)).size;
  report.launcherBytes = (await fs.stat(launcherPath)).size;
  report.user = { uid: process.getuid?.(), home: os.homedir() };

  const manifestKeys = makeManifestKeys(path.join(work, 'test-signing-key.pem'));
  report.manifestPublicKey = manifestKeys.publicKey;
  const runtimeHash = await hashFile(runtimeZip);
  const runtimeBytes = (await fs.stat(runtimeZip)).size;
  const artifactUrlPath = '/electron-runtime.zip';
  const artifact = { url: '', sha256: runtimeHash, size: runtimeBytes };
  server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/target/manifest.json' || url.pathname === '/peer/manifest.json') {
      const manifest = url.pathname.startsWith('/target/') ? targetManifest : peerManifest;
      if (!manifest) { response.writeHead(503); response.end('manifest not ready'); return; }
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.end(JSON.stringify(manifest));
      return;
    }
    if (url.pathname !== artifactUrlPath) { response.writeHead(404); response.end('not found'); return; }
    try {
      const stat = await fs.stat(runtimeZip);
      let start = 0;
      let end = stat.size - 1;
      if (request.headers.range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
        if (!match || Number(match[1]) >= stat.size) { response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); response.end(); return; }
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
        response.statusCode = 206;
        response.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      }
      response.setHeader('Accept-Ranges', 'bytes');
      response.setHeader('Content-Length', end - start + 1);
      response.setHeader('Content-Type', 'application/zip');
      createReadStream(runtimeZip, { start, end }).on('error', () => response.destroy()).pipe(response);
    } catch { response.writeHead(404); response.end('not found'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const manifestBaseUrl = `http://127.0.0.1:${server.address().port}`;
  artifact.url = `${manifestBaseUrl}${artifactUrlPath}`;
  const makeManifest = (version) => signManifest({
    app_id: targetAppId,
    channel: 'stable',
    runtime: { version: runtimeVersion, platforms: { [runtimePlatform]: artifact } },
    runtimes: [],
    app: { version, asar: artifact, min_stub_version: '0.1.0', release_notes: '' },
  }, manifestKeys.privateKey);
  setManifests = (version) => {
    targetManifest = makeManifest(version);
    peerManifest = makeManifest('2.0.0');
  };
  setManifests('2.0.0');
  report.manifestBaseUrl = manifestBaseUrl;

  await step('compile the encrypted Karvis source snapshot once', async () => {
    const result = await runCommand('npm', ['run', 'build'], { cwd: projectDir, timeout: 15 * 60_000, label: 'karvis-npm-build' });
    report.buildLog = result.logPath;
    assert(await exists(path.join(projectDir, 'dist', 'main', 'index.js')), 'Karvis build did not produce dist/main/index.js');
  });
  const afterBuildSnapshot = await snapshotSource(projectDir);
  assert.deepEqual(diffSnapshots(sourceSnapshot, afterBuildSnapshot), [], 'The E2E build modified the encrypted input source snapshot');

  const version200 = await buildVersion({
    version: '2.0.0', projectDir, sourcePackage, sourceBuild, pngIcon, electronDist,
    manifestUrl: `${manifestBaseUrl}/target/manifest.json`, manifestPublicKey: manifestKeys.publicKey,
    runtimeRoot, targetAppId, executableName, packageName, installedMacParent,
    targetDiagnostic, targetUserData, work,
  });
  const version201 = await buildVersion({
    version: '2.0.1', projectDir, sourcePackage, sourceBuild, pngIcon, electronDist,
    manifestUrl: `${manifestBaseUrl}/target/manifest.json`, manifestPublicKey: manifestKeys.publicKey,
    runtimeRoot, targetAppId, executableName, packageName, installedMacParent,
    targetDiagnostic, targetUserData, work,
  });
  report.artifacts['2.0.0'] = summarizeBuild(version200);
  report.artifacts['2.0.1'] = summarizeBuild(version201);

  await step('prepare a same-product peer installation with isolated state', async () => {
    await fs.mkdir(path.dirname(peerAppDir), { recursive: true });
    if (process.platform === 'linux') {
      await fs.cp(version200.appDir, peerAppDir, { recursive: true, dereference: true, preserveTimestamps: true });
      await writeMinitronConfig(path.join(peerAppDir, 'minitron.toml'), targetAppId, '2.0.0', `${manifestBaseUrl}/peer/manifest.json`, manifestKeys.publicKey);
      assert(await exists(path.join(peerAppDir, 'resources', 'assets')), 'Peer fixture omitted Karvis extraResources/assets');
    } else {
      await runCommand('ditto', [version200.appDir, peerAppDir], { timeout: 3 * 60_000, label: 'copy-mac-peer-app' });
      await patchMacLaunchEnvironment(peerAppDir, runtimeRoot, peerDiagnostic, peerUserData);
      assert(await exists(path.join(peerAppDir, 'Contents', 'Resources', 'assets')), 'Peer fixture omitted Karvis extraResources/assets');
    }
    report.peerAppDir = peerAppDir;
  });

  for (const format of process.platform === 'linux' ? ['deb', 'rpm'] : ['pkg', 'dmg']) {
    const scenario = { format, version: '2.0.0', stages: [], installDir: process.platform === 'linux' ? installedLinuxDir : installedMacApp };
    report.scenarios.push(scenario);
    currentScenario = scenario;
    await runScenario({ format, scenario, version200, version201, peerAppDir, manifestBaseUrl, manifestKeys });
  }

} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack, ...(error.launchEvidence ? { launchEvidence: error.launchEvidence } : {}) };
} finally {
  if (sourceSnapshot) {
    try {
      const changes = diffSnapshots(sourceSnapshot, await snapshotSource(projectDir));
      report.sourceHashChanges = changes;
      report.sourceHashesUnchanged = changes.length === 0;
      if (changes.length && !failure) failure = new Error(`Karvis input source hashes changed: ${changes.join(', ')}`);
    } catch (error) {
      report.sourceHashCheckError = error.message;
      if (!failure) failure = error;
    }
  }
  await cleanupOwnedInstalls().catch(error => { report.cleanupError = error.message; });
  if (server) await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
  for (const processEntry of ownedProcesses) {
    try { processEntry.kill('SIGTERM'); } catch {}
  }
  report.finished = new Date().toISOString();
  try {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    if (!failure) failure = error;
    console.error(`Could not write E2E report: ${error.message}`);
  }
}

if (failure) {
  console.error(`FAIL Karvis Unix installer E2E: ${failure.stack || failure}`);
  console.error(`Report: ${reportPath}`);
  process.exitCode = 1;
} else {
  console.log(`PASS Karvis ${process.platform} package install, renderer IPC, upgrade, peer survival, uninstall, and runtime GC`);
  console.log(`Report: ${reportPath}`);
}

async function runScenario({ format, scenario, version200, version201, peerAppDir, manifestBaseUrl, manifestKeys }) {
  setManifests('2.0.0');
  const isLinux = process.platform === 'linux';
  const target = isLinux
    ? { appDir: installedLinuxDir, launcher: path.join(installedLinuxDir, executableName), diagnostic: targetDiagnostic, userData: targetUserData }
    : { appDir: installedMacApp, diagnostic: targetDiagnostic, userData: targetUserData };
  const peer = isLinux
    ? { appDir: peerAppDir, launcher: path.join(peerAppDir, executableName), diagnostic: peerDiagnostic, userData: peerUserData }
    : { appDir: peerAppDir, diagnostic: peerDiagnostic, userData: peerUserData };
  if (!isLinux) {
    const executable = await plistValue(path.join(version200.appDir, 'Contents', 'Info.plist'), 'CFBundleExecutable');
    target.launcher = path.join(target.appDir, 'Contents', 'MacOS', executable);
    peer.launcher = path.join(peer.appDir, 'Contents', 'MacOS', await plistValue(path.join(peer.appDir, 'Contents', 'Info.plist'), 'CFBundleExecutable'));
  }
  await step(`${format}: install actual 2.0.0 package`, async () => {
    await installPackage(format, version200, scenario);
    await assertInstalledApp(target, '2.0.0');
  });
  await step(`${format}: launch installed system entry and peer; verify packaged renderer IPC`, async () => {
    await launchInstallation(format, target, true);
    const targetDiagnosticValue = await waitForDiagnostic(target, '2.0.0');
    await validateDiagnostic(targetDiagnosticValue, target, '2.0.0');
    scenario.initialDiagnostic = targetDiagnosticValue;
    scenario.targetProcess = await processIdentity(target);
    await launchInstallation(format, peer, false);
    const peerDiagnosticValue = await waitForDiagnostic(peer, '2.0.0');
    await validateDiagnostic(peerDiagnosticValue, peer, '2.0.0');
    scenario.peerDiagnostic = peerDiagnosticValue;
    scenario.peerIdentityBeforeUpgrade = await processIdentity(peer);
    if (!isLinux) scenario.launchServices = await verifyLaunchServices(target, scenario.targetProcess);
    await assertSamePath(await queryRuntimeRoot(target), runtimeRoot, 'Installed system entry registered a different runtime root');
    assert(await exists(runtimeInstallPath()), 'The shared Electron 28.3.3 runtime was not installed');
  });
  await step(`${format}: upgrade the running target to 2.0.1 while the peer stays alive`, async () => {
    setManifests('2.0.1');
    const oldTargetIdentity = scenario.targetProcess;
    await upgradePackage(format, version201, scenario, target);
    await waitFor(async () => !(await processIdentityAlive(oldTargetIdentity)), `${format} upgrade did not stop the old target process`, 30_000);
    await assertInstalledApp(target, '2.0.1');
    await launchInstallation(format, target, true);
    const upgradedDiagnostic = await waitForDiagnostic(target, '2.0.1');
    await validateDiagnostic(upgradedDiagnostic, target, '2.0.1');
    scenario.upgradedDiagnostic = upgradedDiagnostic;
    scenario.upgradedProcess = await processIdentity(target);
    assert(await processIdentityAlive(scenario.peerIdentityBeforeUpgrade), 'Peer process identity changed during the target package upgrade');
    assert.deepEqual(await processIdentity(peer), scenario.peerIdentityBeforeUpgrade, 'Peer process PID/start-time changed during the target upgrade');
    if (!isLinux) scenario.upgradedLaunchServices = await verifyLaunchServices(target, scenario.upgradedProcess);
  });
  await step(`${format}: uninstall target and verify peer plus shared runtime survive`, async () => {
    await uninstallTarget(format, scenario, target);
    assert.equal(await exists(target.launcher), false, `${format} uninstall left the target launcher behind`);
    assert.equal(await exists(path.join(isLinux ? target.appDir : path.join(target.appDir, 'Contents', 'Resources'), 'app.asar')), false, `${format} uninstall left app.asar behind`);
    await waitFor(async () => !(await processIdentityAlive(scenario.upgradedProcess)), `${format} uninstall left the target process running`, 30_000);
    await assertProcessIdentityUnchanged(peer, scenario.peerIdentityBeforeUpgrade, 'Peer was stopped or replaced by target uninstall');
    assert(await exists(runtimeInstallPath()), 'Target uninstall garbage-collected a runtime still used by the peer');
    scenario.peerAliveAfterTargetUninstall = true;
    scenario.runtimeRetainedByPeer = true;
  });
  await step(`${format}: unregister final peer and verify shared runtime garbage collection`, async () => {
    await stopAndUninstall(peer);
    await waitFor(async () => !(await processIdentityAlive(scenario.peerIdentityBeforeUpgrade)), 'Final peer process did not exit after --stop', 30_000);
    await waitFor(async () => !(await exists(runtimeInstallPath())), 'Runtime remained cached after the final peer unregistered', 30_000);
    scenario.runtimeGarbageCollected = true;
  });
  if (format === 'pkg') {
    const before = await fs.readFile(path.join(markersDir, 'pkg-preinstall.log'), 'utf8');
    const after = await fs.readFile(path.join(markersDir, 'pkg-postinstall.log'), 'utf8');
    assert.match(before, /2\.0\.0/); assert.match(before, /2\.0\.1/);
    assert.match(after, /2\.0\.0/); assert.match(after, /2\.0\.1/);
    scenario.userPkgHooks = { preinstall: before.trim().split(/\r?\n/), postinstall: after.trim().split(/\r?\n/) };
  }
  scenario.completed = true;
  currentScenario = null;
}

async function buildVersion(settings) {
  const version = settings.version;
  const buildRoot = path.join(work, 'builds', version);
  const projectCopy = path.join(buildRoot, 'project');
  const outputDir = path.join(buildRoot, 'output');
  await fs.mkdir(buildRoot, { recursive: true });
  await copyBuildProject(settings.projectDir, projectCopy);
  const packagePath = path.join(projectCopy, 'package.json');
  const pkg = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  pkg.name = packageName;
  pkg.productName = productName;
  pkg.version = version;
  if (!pkg.homepage) pkg.homepage = 'https://example.invalid/karvis-e2e';
  pkg.author = { name: 'Karvis installer E2E', email: 'test@example.invalid' };
  delete pkg.build;
  await fs.writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  const mainPath = path.join(projectCopy, 'dist', 'main', 'index.js');
  await injectDiagnostics(mainPath);
  const builderPackage = JSON.parse(await fs.readFile(path.join(projectCopy, 'node_modules', 'electron-builder', 'package.json'), 'utf8'));
  assert.equal(builderPackage.version, '24.13.3', 'E2E requires electron-builder 24.13.3 from the Karvis snapshot dependencies');
  const electronPackage = JSON.parse(await fs.readFile(path.join(projectCopy, 'node_modules', 'electron', 'package.json'), 'utf8'));
  assert.equal(electronPackage.version, runtimeVersion, 'Karvis snapshot npm ci must install Electron 28.3.3');
  const extraResources = normalizeArray(settings.sourceBuild.extraResources);
  if (!extraResources.some(item => item === 'assets' || (isRecord(item) && item.from === 'assets' && (!item.to || item.to === 'assets')))) {
    extraResources.push({ from: 'assets', to: 'assets', filter: ['**/*'] });
  }
  const scriptsDir = path.join(projectCopy, 'e2e-hooks');
  await fs.mkdir(scriptsDir, { recursive: true });
  const hooks = {};
  if (process.platform === 'linux') {
    hooks.afterInstall = path.join(scriptsDir, `${version}-after-install.sh`);
    hooks.afterRemove = path.join(scriptsDir, `${version}-after-remove.sh`);
    const versionTag = version === '2.0.0' ? 'install-200' : 'install-201';
    await writeHook(hooks.afterInstall, path.join(markersDir, `${versionTag}-after-install.log`), `${version} afterInstall`);
    await writeHook(hooks.afterRemove, path.join(markersDir, `${versionTag}-after-remove.log`), `${version} afterRemove`);
  }
  const buildResources = path.join(projectCopy, 'e2e-build-resources');
  let pkgScripts;
  if (process.platform === 'darwin') {
    pkgScripts = path.join(buildResources, 'pkg-scripts');
    await fs.mkdir(pkgScripts, { recursive: true });
    await writeHook(path.join(pkgScripts, 'preinstall'), path.join(markersDir, 'pkg-preinstall.log'), `${version} user preinstall`);
    await writeHook(path.join(pkgScripts, 'postinstall'), path.join(markersDir, 'pkg-postinstall.log'), `${version} user postinstall`);
  }
  const targetUserDataPath = settings.targetUserData;
  const macEnv = {
    ...(isRecord(settings.sourceBuild.mac?.extendInfo?.LSEnvironment) ? settings.sourceBuild.mac.extendInfo.LSEnvironment : {}),
    ELECTRON_RUNTIME_ROOT: settings.runtimeRoot,
    KARVIS_E2E_DIAGNOSTIC_FILE: settings.targetDiagnostic,
    KARVIS_E2E_USER_DATA: targetUserDataPath,
  };
  const macBase = isRecord(settings.sourceBuild.mac) ? settings.sourceBuild.mac : {};
  const macExtendInfo = isRecord(macBase.extendInfo) ? macBase.extendInfo : {};
  const macConfig = process.platform === 'darwin' ? {
    ...macBase,
    target: ['dmg', 'pkg'],
    identity: null,
    extendInfo: { ...macExtendInfo, LSEnvironment: macEnv },
  } : undefined;
  const pkgConfig = process.platform === 'darwin' ? {
    ...(isRecord(settings.sourceBuild.pkg) ? settings.sourceBuild.pkg : {}),
    installLocation: installedMacParent,
    scripts: path.relative(buildResources, pkgScripts),
  } : undefined;
  const linuxConfig = process.platform === 'linux' ? {
    ...(isRecord(settings.sourceBuild.linux) ? settings.sourceBuild.linux : {}),
    executableName,
    icon: settings.pngIcon,
  } : undefined;
  const buildConfig = {
    ...settings.sourceBuild,
    appId: targetAppId,
    productName,
    electronVersion: runtimeVersion,
    electronDist: settings.electronDist,
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    artifactName: '${name}-${version}-${arch}.${ext}',
    directories: { ...(isRecord(settings.sourceBuild.directories) ? settings.sourceBuild.directories : {}), output: outputDir, buildResources },
    extraResources,
    extraMetadata: { ...(isRecord(settings.sourceBuild.extraMetadata) ? settings.sourceBuild.extraMetadata : {}), main: 'dist/main/index.js' },
    ...(process.platform === 'linux' ? {
      linux: linuxConfig,
      deb: { ...(isRecord(settings.sourceBuild.deb) ? settings.sourceBuild.deb : {}), maintainer: 'Test <test@example.invalid>', ...hooks },
      rpm: { ...(isRecord(settings.sourceBuild.rpm) ? settings.sourceBuild.rpm : {}), ...hooks },
    } : { mac: macConfig, pkg: pkgConfig }),
  };
  if (buildConfig.asar !== true) throw new Error('Minitron E2E requires ASAR packaging');
  const configPath = path.join(projectCopy, 'e2e-electron-builder.config.cjs');
  const configSource = [
    "'use strict';",
    `const { withMinitron } = require(${JSON.stringify(adapterPath)});`,
    `const config = ${JSON.stringify(buildConfig, null, 2)};`,
    `module.exports = withMinitron(config, ${JSON.stringify({
      projectDir: projectCopy,
      launcherPath,
      manifestUrl: settings.manifestUrl,
      allowLocalhostHttp: true,
      manifestPublicKey: settings.manifestPublicKey,
      runtimeVersion,
      iconPath: path.relative(projectCopy, settings.pngIcon),
    }, null, 2)});`,
    '',
  ].join('\n');
  await fs.writeFile(configPath, configSource);
  const cli = path.join(projectCopy, 'node_modules', 'electron-builder', 'cli.js');
  assert(await exists(cli), `electron-builder CLI missing from source snapshot dependencies: ${cli}`);
  const platformArgs = process.platform === 'linux'
    ? ['--linux', 'deb', 'rpm', process.arch === 'arm64' ? '--arm64' : '--x64']
    : ['--mac', 'dmg', 'pkg', process.arch === 'arm64' ? '--arm64' : '--x64'];
  await runCommand(process.execPath, [cli, ...platformArgs, '--config', configPath], {
    cwd: projectCopy,
    timeout: 30 * 60_000,
    label: `electron-builder-${process.platform}-${version}`,
    env: { NODE_PATH: [path.join(projectCopy, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter) },
  });
  const appDir = process.platform === 'linux'
    ? await findLinuxAppDir(outputDir, executableName)
    : await findMacAppDir(outputDir, productName);
  const extension = process.platform === 'linux' ? ['deb', 'rpm'] : ['pkg', 'dmg'];
  const packages = {};
  for (const ext of extension) packages[ext] = await findArtifact(outputDir, ext);
  const appBytes = await directoryBytes(appDir);
  const packageBytes = Object.fromEntries(await Promise.all(Object.entries(packages).map(async ([ext, filename]) => [ext, (await fs.stat(filename)).size])));
  return { version, buildRoot, projectCopy, outputDir, appDir, packages, packageBytes, appBytes, builderVersion: builderPackage.version, packageName: pkg.name, hooks };
}

async function runCommand(executable, args, settings = {}) {
  const label = settings.label || path.basename(executable);
  const logPath = path.join(logsDir, `${String(commands.length + 1).padStart(3, '0')}-${safeName(label)}.log`);
  const record = {
    label, executable, args, cwd: settings.cwd || work, started: new Date().toISOString(), logPath,
    ...(settings.stdoutPath ? { stdoutPath: settings.stdoutPath } : {}),
    ...(settings.stderrPath ? { stderrPath: settings.stderrPath } : {}),
  };
  commands.push(record);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const log = fsSync.createWriteStream(logPath, { flags: 'w' });
  const outputHandles = [];
  let tail = '';
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const env = { ...process.env, ...(settings.env || {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  const captureOutput = settings.captureOutput !== false;
  const fileOutput = Boolean(settings.stdoutPath || settings.stderrPath);
  if (fileOutput) {
    for (const filename of [settings.stdoutPath, settings.stderrPath]) {
      if (!filename) { outputHandles.push(null); continue; }
      await fs.mkdir(path.dirname(filename), { recursive: true });
      outputHandles.push(await fs.open(filename, 'w'));
    }
  }
  const child = spawn(executable, args, {
    cwd: settings.cwd || work,
    env,
    detached: process.platform !== 'win32',
    stdio: captureOutput
      ? ['ignore', 'pipe', 'pipe']
      : fileOutput
        ? ['ignore', outputHandles[0]?.fd ?? 'ignore', outputHandles[1]?.fd ?? 'ignore']
        : 'ignore',
  });
  ownedProcesses.add(child);
  const append = (stream, chunk) => {
    const text = chunk.toString();
    tail = (tail + `${stream}: ${text}`).slice(-18_000);
    if (stream === 'stdout') stdout = (stdout + text).slice(-40_000);
    else stderr = (stderr + text).slice(-40_000);
    log.write(`${stream}: ${text}`);
  };
  if (captureOutput) {
    child.stdout.on('data', chunk => append('stdout', chunk));
    child.stderr.on('data', chunk => append('stderr', chunk));
  }
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {} }, 3000).unref();
  }, settings.timeout || 120_000);
  let close;
  try {
    close = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once(captureOutput ? 'close' : 'exit', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    clearTimeout(timer);
    await new Promise(resolve => log.end(resolve));
    await Promise.all(outputHandles.filter(Boolean).map(handle => handle.close().catch(() => {})));
    ownedProcesses.delete(child);
  }
  record.finished = new Date().toISOString();
  record.exitCode = close.code;
  record.signal = close.signal;
  record.timedOut = timedOut;
  if (timedOut || close.code !== 0) {
    const fileTails = await Promise.all([settings.stdoutPath, settings.stderrPath].filter(Boolean).map(async filename => `${filename}:\n${await readTail(filename) || ''}`));
    throw new Error(`${label} failed${timedOut ? ' by timeout' : ` with exit code ${close.code}`}\n${tail}${fileTails.length ? `\n${fileTails.join('\n')}` : ''}`);
  }
  return { ...record, stdout, stderr, logPath };
}

async function step(name, action) {
  const started = Date.now();
  const record = { name, startedAt: new Date().toISOString() };
  stages.push(record);
  if (currentScenario) currentScenario.stages.push(record);
  try {
    const result = await action();
    record.passed = true;
    record.milliseconds = Date.now() - started;
    console.log(`PASS ${name}`);
    return result;
  } catch (error) {
    record.passed = false;
    record.milliseconds = Date.now() - started;
    record.error = error.stack || String(error);
    throw error;
  }
}

async function installPackage(format, build, scenario) {
  if (process.platform === 'linux') {
    if (format === 'deb') await runCommand('sudo', ['-n', 'apt-get', 'install', '-y', build.packages.deb], { timeout: 5 * 60_000, label: 'apt-install-2.0.0' });
    else await runCommand('sudo', ['-n', 'rpm', '-U', '--replacepkgs', '--nodeps', build.packages.rpm], { timeout: 5 * 60_000, label: 'rpm-install-2.0.0' });
    scenario.packageName = packageName;
    await verifyLinuxPackageVersion(format, '2.0.0');
    await verifyLinuxInstalledHooks('2.0.0');
  } else if (format === 'pkg') {
    await runCommand('sudo', ['-n', 'installer', '-pkg', build.packages.pkg, '-target', '/'], { timeout: 10 * 60_000, label: 'pkg-install-2.0.0' });
    await verifyPkgHook('postinstall', '2.0.0');
  } else {
    await installDmg(build.packages.dmg, scenario.installDir);
  }
}

async function upgradePackage(format, build, scenario, target) {
  if (process.platform === 'linux') {
    if (format === 'deb') await runCommand('sudo', ['-n', 'apt-get', 'install', '-y', build.packages.deb], { timeout: 5 * 60_000, label: 'apt-upgrade-2.0.1' });
    else await runCommand('sudo', ['-n', 'rpm', '-U', '--replacepkgs', '--nodeps', build.packages.rpm], { timeout: 5 * 60_000, label: 'rpm-upgrade-2.0.1' });
    await verifyLinuxPackageVersion(format, '2.0.1');
    await verifyLinuxInstalledHooks('2.0.1');
  } else if (format === 'pkg') {
    await runCommand('sudo', ['-n', 'installer', '-pkg', build.packages.pkg, '-target', '/'], { timeout: 10 * 60_000, label: 'pkg-upgrade-2.0.1' });
    await verifyPkgHook('postinstall', '2.0.1');
    await waitFor(async () => !(await processIdentityAlive(scenario.targetProcess)), 'PKG preinstall did not stop the existing target before replacement', 30_000);
  } else {
    await stopAndReplaceDmg(build.packages.dmg, target);
  }
}

async function uninstallTarget(format, scenario, target) {
  if (process.platform === 'linux') {
    if (format === 'deb') await runCommand('sudo', ['-n', 'dpkg', '--purge', packageName], { timeout: 5 * 60_000, label: 'dpkg-purge-target' });
    else await runCommand('sudo', ['-n', 'rpm', '-e', '--nodeps', packageName], { timeout: 5 * 60_000, label: 'rpm-erase-target' });
    const appAsar = path.join(target.appDir, 'resources', 'app.asar');
    await waitFor(async () => !(await exists(target.launcher)) && !(await exists(appAsar)), 'System package removal left Karvis files under /opt/Karvis AI', 60_000);
  } else {
    const helper = path.join(target.appDir, 'Contents', 'Resources', 'minitron-uninstall.command');
    assert(await exists(helper), 'Minitron-generated macOS uninstall helper is missing');
    const body = await fs.readFile(helper, 'utf8');
    assert.match(body, /--stop/); assert.match(body, /--uninstall/);
    await stateDir(target);
    await runCommand(helper, [], { cwd: target.appDir, env: appEnvironment(target), timeout: 60_000, label: `${format}-generated-uninstall-helper` });
    await waitFor(async () => !(await exists(await stateDir(target))), 'Generated macOS helper did not unregister the target installation', 30_000);
    await runCommand('sudo', ['-n', 'rm', '-rf', '--', target.appDir], { timeout: 60_000, label: `${format}-remove-owned-test-app` });
    if (format === 'pkg') await forgetTestPkgReceipts();
  }
  if (process.platform === 'linux') await verifyLinuxAfterRemoveHooks(format);
}

async function launchInstallation(format, installation, systemEntry) {
  await fs.mkdir(path.dirname(installation.diagnostic), { recursive: true });
  await fs.rm(installation.diagnostic, { force: true });
  await fs.mkdir(installation.userData, { recursive: true });
  await fs.chmod(installation.userData, 0o700);
  if (process.platform === 'linux' && systemEntry) {
    assert.equal(await fs.stat(installation.appDir).then(stat => stat.uid), 0, 'Linux /opt installation must remain root-owned');
    assert.equal(await fs.stat(installation.launcher).then(stat => stat.uid), 0, 'Linux launcher must remain root-owned');
    const desktop = await findDesktopEntry(executableName);
    assert(await fs.readFile(desktop, 'utf8').then(text => text.includes(productName)), 'Installed desktop entry does not identify Karvis AI');
    installation.desktopEntry = desktop;
    const launchPrefix = `${format}-target-${Date.now()}`;
    installation.launchLogs = {
      stdout: path.join(logsDir, `${launchPrefix}.stdout.log`),
      stderr: path.join(logsDir, `${launchPrefix}.stderr.log`),
    };
    await runCommand('gio', ['launch', desktop], {
      env: appEnvironment(installation), timeout: 30_000, label: `gio-launch-${format}`, captureOutput: false,
      stdoutPath: installation.launchLogs.stdout, stderrPath: installation.launchLogs.stderr,
    });
  } else if (process.platform === 'linux') {
    const launchName = installation.diagnostic === peerDiagnostic ? 'peer' : 'target';
    installation.launchAttempt = (installation.launchAttempt || 0) + 1;
    const launchPrefix = `${format}-${launchName}-${installation.launchAttempt}`;
    installation.launchLogs = {
      stdout: path.join(logsDir, `${launchPrefix}.stdout.log`),
      stderr: path.join(logsDir, `${launchPrefix}.stderr.log`),
    };
    await Promise.all(Object.values(installation.launchLogs).map(filename => fs.rm(filename, { force: true })));
    const stdoutFd = fsSync.openSync(installation.launchLogs.stdout, 'w');
    const stderrFd = fsSync.openSync(installation.launchLogs.stderr, 'w');
    const env = { ...process.env, ...appEnvironment(installation) };
    delete env.ELECTRON_RUN_AS_NODE;
    let child;
    try {
      child = spawn(installation.launcher, [], {
        cwd: installation.appDir,
        env,
        detached: true,
        stdio: ['ignore', stdoutFd, stderrFd],
      });
    } finally {
      fsSync.closeSync(stdoutFd);
      fsSync.closeSync(stderrFd);
    }
    ownedProcesses.add(child);
    child.once('exit', (code, signal) => {
      installation.launchExit = { code, signal };
      ownedProcesses.delete(child);
    });
    child.once('error', error => { installation.launchError = error.message; ownedProcesses.delete(child); });
    installation.launchedProcess = child;
    child.unref();
    await wait(250);
    installation.launchStartTime = child.pid ? await processStartStamp(child.pid) : null;
    if (installation.launchError) throw new Error(`Could not launch the peer fixture: ${installation.launchError}`);
  } else {
    await makeMacAppReadOnly(installation.appDir);
    const launchName = installation.diagnostic === peerDiagnostic ? 'peer' : 'target';
    installation.launchAttempt = (installation.launchAttempt || 0) + 1;
    const launchPrefix = `${format}-${launchName}-${installation.launchAttempt}`;
    installation.launchLogs = {
      stdout: path.join(logsDir, `${launchPrefix}.stdout.log`),
      stderr: path.join(logsDir, `${launchPrefix}.stderr.log`),
    };
    await Promise.all(Object.values(installation.launchLogs).map(filename => fs.rm(filename, { force: true })));
    try {
      await runCommand('open', [
        '--stdout', installation.launchLogs.stdout,
        '--stderr', installation.launchLogs.stderr,
        '-n', '-a', installation.appDir,
      ], { env: appEnvironment(installation), timeout: 30_000, label: `open-${format}` });
    } catch (error) {
      error.launchEvidence = {
        appDir: installation.appDir,
        launchLogs: {
          stdout: await readTail(installation.launchLogs.stdout),
          stderr: await readTail(installation.launchLogs.stderr),
        },
        macOpenPreflight: await collectMacOpenPreflight(installation),
      };
      throw error;
    }
  }
}

async function collectMacOpenPreflight(installation) {
  const plist = path.join(installation.appDir, 'Contents', 'Info.plist');
  const executableName = await plistValue(plist, 'CFBundleExecutable').catch(() => null);
  const launcher = executableName && path.join(installation.appDir, 'Contents', 'MacOS', executableName);
  const paths = [
    installation.appDir,
    path.join(installation.appDir, 'Contents'),
    plist,
    path.join(installation.appDir, 'Contents', 'MacOS'),
    launcher,
  ].filter(Boolean);
  const pathAccess = [];
  for (const filename of paths) {
    try {
      const stat = await fs.stat(filename);
      const access = {};
      for (const [name, mode] of [['read', fsSync.constants.R_OK], ['execute', fsSync.constants.X_OK]]) {
        try { await fs.access(filename, mode); access[name] = true; } catch { access[name] = false; }
      }
      pathAccess.push({ path: filename, mode: (stat.mode & 0o777).toString(8), uid: stat.uid, gid: stat.gid, access });
    } catch (error) {
      pathAccess.push({ path: filename, error: error.message });
    }
  }
  const inspect = async (label, executable, args) => {
    try {
      const result = await runCommand(executable, args, { timeout: 15_000, label: `mac-open-preflight-${label}` });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      return { error: error.message };
    }
  };
  const [permissions, binary, plistCheck, signature, appSignatureVerification, launcherSignature] = await Promise.all([
    inspect('permissions', 'ls', ['-ldeO@', ...paths]),
    launcher ? inspect('binary', 'file', [launcher]) : Promise.resolve(null),
    inspect('plist', 'plutil', ['-lint', plist]),
    inspect('signature', 'codesign', ['-dv', '--verbose=2', installation.appDir]),
    inspect('app-signature-verification', '/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', installation.appDir]),
    launcher ? inspect('launcher-signature', '/usr/bin/codesign', ['-dv', launcher]) : Promise.resolve(null),
  ]);
  return {
    uid: process.getuid?.() ?? null,
    executableName,
    pathAccess,
    permissions,
    binary,
    plistCheck,
    signature,
    appSignatureVerification,
    launcherSignature,
  };
}

async function waitForDiagnostic(installation, expectedVersion) {
  try {
    await waitFor(async () => {
      if (installation.launchLogs?.stderr) {
        const stderr = await readTail(installation.launchLogs.stderr);
        const fatal = findFatalStartupError(stderr);
        if (fatal) throw new Error(`Fatal application startup output for ${installation.appDir}:\n${fatal}`);
      }
      if (installation.launchExit && (installation.launchExit.code !== 0 || installation.launchExit.signal)) {
        throw new Error(`Launcher exited before writing the renderer diagnostic for ${installation.appDir}: ${JSON.stringify(installation.launchExit)}`);
      }
      try {
        const diagnostic = JSON.parse(await fs.readFile(installation.diagnostic, 'utf8'));
        return diagnostic.pid && diagnostic.renderer && diagnostic.appVersion === expectedVersion;
      } catch { return false; }
    }, `Karvis renderer IPC diagnostic was not written for ${installation.appDir}`, 120_000);
  } catch (error) {
    error.launchEvidence = await collectLaunchFailureEvidence(installation);
    throw error;
  }
  const diagnostic = JSON.parse(await fs.readFile(installation.diagnostic, 'utf8'));
  await waitFor(async () => {
    const record = await readProcessRecord(installation);
    return record && Number(record.childPid) === Number(diagnostic.pid) && record.childStartTime != null;
  }, `Minitron process record did not identify the real Karvis Electron main process for ${installation.appDir}`, 30_000);
  return diagnostic;
}

async function collectLaunchFailureEvidence(installation) {
  const evidence = { appDir: installation.appDir, launcher: installation.launcher || null };
  if (installation.launchLogs) {
    evidence.launchLogs = {
      stdout: await readTail(installation.launchLogs.stdout),
      stderr: await readTail(installation.launchLogs.stderr),
    };
  }
  if (installation.launchExit) evidence.launchExit = installation.launchExit;
  try {
    const directory = await stateDir(installation);
    evidence.stateDir = directory;
    evidence.stateFiles = {};
    for (const filename of ['process.json', 'active.json', 'installed-base.json', 'pending.json', 'transaction.json']) {
      try {
        evidence.stateFiles[filename] = JSON.parse(await fs.readFile(path.join(directory, filename), 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') evidence.stateFiles[filename] = { readError: error.message };
      }
    }
    const record = evidence.stateFiles['process.json'];
    const launchedPid = installation.launchedProcess?.pid && installation.launchStartTime
      && await processStartStamp(installation.launchedProcess.pid) === installation.launchStartTime
      ? installation.launchedProcess.pid
      : null;
    const pids = [...new Set([record?.ownerPid, record?.childPid, launchedPid].map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 0))];
    if (pids.length) {
      try {
        const result = await runCommand('ps', ['-eo', 'pid=,ppid=,stat=,command='], {
          timeout: 15_000,
          label: `diagnostic-processes-${safeName(path.basename(installation.appDir))}`,
        });
        const installPath = path.resolve(installation.appDir);
        const rows = result.stdout.split(/\r?\n/).flatMap(line => {
          const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
          return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), stat: match[3], command: match[4] }] : [];
        });
        const descendants = new Set(pids);
        let changed = true;
        while (changed) {
          changed = false;
          for (const row of rows) if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
            descendants.add(row.pid);
            changed = true;
          }
        }
        evidence.processes = rows
          .filter(row => descendants.has(row.pid) && row.command.includes(installPath))
          .map(row => `${row.pid} ${row.ppid} ${row.stat} ${row.command}`);
      } catch (error) {
        evidence.processesError = error.message;
      }
    }
  } catch (error) {
    evidence.stateError = error.message;
  }
  return evidence;
}

async function readTail(filename, maxBytes = 24_000) {
  let handle;
  try {
    handle = await fs.open(filename, 'r');
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return `[could not read ${filename}: ${error.message}]`;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function findFatalStartupError(stderr) {
  if (!stderr) return null;
  if (stderr.includes('SHELL_ERROR:')) return stderr;
  const fatalLines = stderr.split(/\r?\n/).filter(line =>
    /dyld(?:\[[^\]]+\])?:\s*(?:Library not loaded:|Symbol not found:|no suitable image found:)/i.test(line)
    || /code signature.*(?:invalid|failed)|(?:invalid|failed).*code signature/i.test(line),
  );
  return fatalLines.length ? stderr : null;
}

async function validateDiagnostic(value, installation, expectedVersion) {
  assert.equal(value.isPackaged, true, 'Karvis renderer was not packaged');
  assert.match(value.appName, /Karvis/i, 'Electron app name is not branded as Karvis');
  assert.equal(value.appVersion, expectedVersion, 'Installed application version is incorrect');
  assert.equal(value.electronVersion, runtimeVersion, 'Application did not run on Electron 28.3.3');
  assert.equal(value.renderer?.ipc, true, 'window.electronAPI.getAppVersion() IPC did not return a value');
  assert.equal(String(value.renderer.appVersion), expectedVersion, 'Renderer IPC returned the wrong app version');
  assert(value.renderer.rootChildren > 0, 'React did not mount the Karvis renderer');
  assert(value.renderer.htmlLength > 0 && value.renderer.bodyText.trim().length > 0, 'Karvis renderer did not paint visible content');
  assert.match(value.renderer.title, /Karvis/i, 'Renderer window title is not Karvis');
  await assertSamePath(value.userData, installation.userData, 'Karvis userData did not use the isolated E2E path');
  const expectedResources = process.platform === 'linux'
    ? path.join(installation.appDir, 'resources')
    : path.join(installation.appDir, 'Contents', 'Resources');
  await assertSamePath(value.resourcesPath, expectedResources, 'Electron resourcesPath did not point to the installed Karvis app');
  assert.equal(value.appId, targetAppId, 'Minitron launcher did not pass the expected app id into Electron');
}

async function assertSamePath(actual, expected, message) {
  const [actualPath, expectedPath] = await Promise.all([fs.realpath(actual), fs.realpath(expected)]);
  assert.equal(actualPath, expectedPath, message);
}

async function assertInstalledApp(installation, expectedVersion) {
  assert(await exists(installation.launcher), `Installed Karvis launcher is missing: ${installation.launcher}`);
  const resources = process.platform === 'linux'
    ? path.join(installation.appDir, 'resources')
    : path.join(installation.appDir, 'Contents', 'Resources');
  assert(await exists(path.join(resources, 'app.asar')), 'Installed application omitted resources/app.asar');
  assert(await exists(path.join(resources, 'assets')), 'Installed application omitted extraResources/assets');
  if (process.platform === 'darwin') {
    const bundleId = await plistValue(path.join(installation.appDir, 'Contents', 'Info.plist'), 'CFBundleIdentifier');
    const bundleName = await plistValue(path.join(installation.appDir, 'Contents', 'Info.plist'), 'CFBundleName');
    const bundleVersion = await plistValue(path.join(installation.appDir, 'Contents', 'Info.plist'), 'CFBundleShortVersionString');
    assert.equal(bundleId, targetAppId, 'Installed macOS bundle identifier is incorrect');
    assert.match(bundleName, /Karvis/i, 'Installed macOS bundle name is not Karvis');
    assert.equal(bundleVersion, expectedVersion, 'Installed macOS bundle version is incorrect');
  }
}

async function processIdentity(installation) {
  const record = await readProcessRecord(installation);
  assert(record && Number(record.childPid) > 0 && record.childStartTime != null, `Missing process identity for ${installation.appDir}`);
  const pid = Number(record.childPid);
  const hostStart = await processStartStamp(pid);
  assert(hostStart, `Could not verify OS process creation time for pid ${pid}`);
  if (process.platform === 'linux') assert.equal(String(hostStart), String(record.childStartTime), 'Linux process.json start time does not match /proc');
  return { pid, childStartTime: String(record.childStartTime), hostStart, ownerPid: Number(record.ownerPid), ownerStartTime: String(record.ownerStartTime) };
}

async function processIdentityAlive(identity) {
  if (!identity || !Number.isInteger(identity.pid)) return false;
  try { process.kill(identity.pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; }
  const actual = await processStartStamp(identity.pid).catch(() => null);
  return actual !== null && String(actual) === String(identity.hostStart);
}

async function assertProcessIdentityUnchanged(installation, expected, message) {
  assert(await processIdentityAlive(expected), message);
  const current = await processIdentity(installation);
  assert.deepEqual(current, expected, message);
}

async function stopAndUninstall(installation) {
  if (!installation.launcher || !await exists(installation.launcher)) return;
  await stateDir(installation);
  await runCommand(installation.launcher, ['--app-dir', installation.appDir, '--stop'], { cwd: installation.appDir, env: appEnvironment(installation), timeout: 45_000, label: `stop-${path.basename(installation.appDir)}` });
  await runCommand(installation.launcher, ['--app-dir', installation.appDir, '--uninstall'], { cwd: installation.appDir, env: appEnvironment(installation), timeout: 45_000, label: `uninstall-${path.basename(installation.appDir)}` });
}

async function queryRuntimeRoot(installation) {
  const result = await runCommand(installation.launcher, ['--app-dir', installation.appDir, '--runtime-root'], { cwd: installation.appDir, env: appEnvironment(installation), timeout: 30_000, label: `runtime-root-${path.basename(installation.appDir)}` });
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
}

async function stateDir(installation) {
  if (installation.stateDir) return installation.stateDir;
  const result = await runCommand(installation.launcher, ['--app-dir', installation.appDir, '--state-dir'], { cwd: installation.appDir, env: appEnvironment(installation), timeout: 30_000, label: `state-dir-${path.basename(installation.appDir)}` });
  const value = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!path.isAbsolute(value)) throw new Error(`Minitron --state-dir returned a non-absolute path: ${value}`);
  installation.stateDir = value;
  return value;
}

async function readProcessRecord(installation) {
  try {
    const source = await fs.readFile(path.join(await stateDir(installation), 'process.json'), 'utf8');
    return JSON.parse(source.replace(/("(?:ownerStartTime|childStartTime)"\s*:\s*)(\d+)/g, '$1"$2"'));
  } catch { return null; }
}

async function processStartStamp(pid) {
  if (process.platform === 'linux') {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
    if (!stat) return null;
    const close = stat.lastIndexOf(')');
    return close < 0 ? null : stat.slice(close + 1).trim().split(/\s+/)[19] || null;
  }
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

async function verifyLaunchServices(installation, identity) {
  const pid = identity.pid;
  const info = await runCommand('lsappinfo', ['info', '-only', 'name', '-only', 'bundleID', `#${pid}`], { timeout: 15_000, label: `lsappinfo-${pid}` });
  assert(info.stdout.includes(targetAppId) && /Karvis/i.test(info.stdout), `LaunchServices does not brand the actual Karvis Electron host PID ${pid} for ${installation.appDir}`);
  return { pid, output: info.stdout.trim() };
}

async function installDmg(dmgPath, appDir) {
  const mountPoint = path.join(work, 'mounted', path.basename(dmgPath, '.dmg'));
  await fs.mkdir(mountPoint, { recursive: true });
  await runCommand('hdiutil', ['attach', '-plist', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath], { timeout: 2 * 60_000, label: 'mount-dmg' });
  mountedVolumes.add(mountPoint);
  try {
    const sourceApp = await findMacAppDir(mountPoint, productName);
    await fs.mkdir(path.dirname(appDir), { recursive: true });
    await runCommand('ditto', [sourceApp, appDir], { timeout: 3 * 60_000, label: 'copy-dmg-app' });
  } finally {
    await runCommand('hdiutil', ['detach', mountPoint], { timeout: 60_000, label: 'detach-dmg' });
    mountedVolumes.delete(mountPoint);
  }
}

async function stopAndReplaceDmg(dmgPath, target) {
  await runCommand(target.launcher, ['--app-dir', target.appDir, '--stop'], { cwd: target.appDir, env: appEnvironment(target), timeout: 45_000, label: 'stop-before-dmg-upgrade' });
  await waitFor(async () => !(await exists(await stateDir(target).then(dir => path.join(dir, 'process.json')))), 'Target process record did not clear before DMG replacement', 30_000);
  await runCommand('sudo', ['-n', 'rm', '-rf', '--', target.appDir], { timeout: 60_000, label: 'remove-owned-app-before-dmg-upgrade' });
  await installDmg(dmgPath, target.appDir);
}

async function findDesktopEntry(exeName) {
  const root = '/usr/share/applications';
  const files = await filesRecursive(root, filename => filename.endsWith('.desktop'));
  for (const filename of files) {
    const source = await fs.readFile(filename, 'utf8').catch(() => '');
    if (source.split(/\r?\n/).some(line => line.startsWith('Exec=') && line.includes(exeName))) return filename;
  }
  const fallback = path.join(root, `${exeName}.desktop`);
  if (await exists(fallback)) return fallback;
  throw new Error(`No installed desktop entry launches ${exeName} under ${root}`);
}

async function verifyLinuxPackageVersion(format, expected) {
  if (format === 'deb') {
    const result = await runCommand('dpkg-query', ['-W', '-f=${Version}', packageName], { label: 'query-deb-version' });
    assert.equal(result.stdout.trim(), expected);
  } else {
    const result = await runCommand('rpm', ['-q', '--qf', '%{VERSION}', packageName], { label: 'query-rpm-version' });
    assert.equal(result.stdout.trim(), expected);
  }
}

async function verifyLinuxInstalledHooks(version) {
  const suffix = version === '2.0.0' ? 'install-200' : 'install-201';
  const marker = path.join(markersDir, `${suffix}-after-install.log`);
  await waitFor(() => exists(marker), `electron-builder afterInstall did not run for ${version}`, 30_000);
  assert.match(await fs.readFile(marker, 'utf8'), new RegExp(version.replaceAll('.', '\\.')));
}

async function verifyLinuxAfterRemoveHooks(format) {
  const markers = await filesRecursive(markersDir, filename => filename.includes('after-remove'));
  assert(markers.some(filename => path.basename(filename).includes('install-201')), `${format} electron-builder afterRemove hook did not run for the installed 2.0.1 package`);
}

async function verifyPkgHook(kind, version) {
  const marker = path.join(markersDir, `pkg-${kind}.log`);
  await waitFor(() => exists(marker), `PKG ${kind} hook did not run`, 30_000);
  assert.match(await fs.readFile(marker, 'utf8'), new RegExp(version.replaceAll('.', '\\.')));
}

async function forgetTestPkgReceipts() {
  const result = await runCommand('pkgutil', ['--pkgs'], { label: 'list-pkg-receipts' });
  const receipts = result.stdout.split(/\r?\n/).filter(line => line.startsWith(targetAppId));
  for (const receipt of receipts) await runCommand('sudo', ['-n', 'pkgutil', '--forget', receipt], { timeout: 30_000, label: 'forget-test-pkg-receipt' });
}

async function patchMacLaunchEnvironment(appDir, root, diagnostic, userData) {
  const plist = path.join(appDir, 'Contents', 'Info.plist');
  const values = { ELECTRON_RUNTIME_ROOT: root, KARVIS_E2E_DIAGNOSTIC_FILE: diagnostic, KARVIS_E2E_USER_DATA: userData };
  await runCommand('/usr/libexec/PlistBuddy', ['-c', 'Add :LSEnvironment dict', plist], { timeout: 15_000, label: 'plist-add-environment' }).catch(() => {});
  for (const [key, value] of Object.entries(values)) {
    const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const command = `Set :LSEnvironment:${key} "${escaped}"`;
    await runCommand('/usr/libexec/PlistBuddy', ['-c', command, plist], { timeout: 15_000, label: `plist-env-set-${key}` }).catch(async () => {
      const add = `Add :LSEnvironment:${key} string "${escaped}"`;
      await runCommand('/usr/libexec/PlistBuddy', ['-c', add, plist], { timeout: 15_000, label: `plist-env-add-${key}` });
    });
  }
}

async function makeMacAppReadOnly(appDir) {
  const plist = path.join(appDir, 'Contents', 'Info.plist');
  const executable = await plistValue(plist, 'CFBundleExecutable');
  const launcher = path.join(appDir, 'Contents', 'MacOS', executable);
  const modeBefore = (await fs.stat(launcher)).mode & 0o111;
  assert(modeBefore !== 0, `macOS launcher lost its executable bits before read-only verification: ${launcher}`);
  await runCommand('sudo', ['-n', 'chmod', '-R', 'a-w', appDir], { timeout: 30_000, label: 'make-mac-app-readonly' });
  const modeAfter = (await fs.stat(launcher)).mode & 0o111;
  assert.equal(modeAfter, modeBefore, `Read-only permissions changed the launcher executable bits: ${launcher}`);
}

async function plistValue(plist, key) {
  const result = await runCommand('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { timeout: 15_000, label: `read-plist-${key}` });
  return result.stdout.trim();
}

function appEnvironment(installation) {
  return {
    ELECTRON_RUNTIME_ROOT: runtimeRoot,
    KARVIS_E2E_DIAGNOSTIC_FILE: installation.diagnostic,
    KARVIS_E2E_USER_DATA: installation.userData,
  };
}

function runtimeInstallPath() {
  return path.join(runtimeRoot, 'versions', runtimePlatform, `v${runtimeVersion}`, 'install.json');
}

async function cleanupOwnedInstalls() {
  if (process.platform === 'linux') {
    const target = { appDir: installedLinuxDir, launcher: path.join(installedLinuxDir, executableName), diagnostic: targetDiagnostic, userData: targetUserData };
    const peer = { appDir: peerAppDir, launcher: path.join(peerAppDir, executableName), diagnostic: peerDiagnostic, userData: peerUserData };
    await stopAndUninstall(peer).catch(() => {});
    if (currentScenario?.format === 'deb') await runCommand('sudo', ['-n', 'dpkg', '--purge', packageName], { timeout: 90_000, label: 'cleanup-deb' }).catch(() => {});
    if (currentScenario?.format === 'rpm') await runCommand('sudo', ['-n', 'rpm', '-e', '--nodeps', packageName], { timeout: 90_000, label: 'cleanup-rpm' }).catch(() => {});
    if (await exists(target.launcher)) await stopAndUninstall(target).catch(() => {});
  } else {
    for (const mount of mountedVolumes) await runCommand('hdiutil', ['detach', mount], { timeout: 30_000, label: 'cleanup-dmg-mount' }).catch(() => {});
    const target = { appDir: installedMacApp, diagnostic: targetDiagnostic, userData: targetUserData };
    const peer = { appDir: peerAppDir, diagnostic: peerDiagnostic, userData: peerUserData };
    if (await exists(path.join(target.appDir, 'Contents', 'Info.plist'))) target.launcher = path.join(target.appDir, 'Contents', 'MacOS', await plistValue(path.join(target.appDir, 'Contents', 'Info.plist'), 'CFBundleExecutable'));
    if (await exists(path.join(peer.appDir, 'Contents', 'Info.plist'))) peer.launcher = path.join(peer.appDir, 'Contents', 'MacOS', await plistValue(path.join(peer.appDir, 'Contents', 'Info.plist'), 'CFBundleExecutable'));
    await stopAndUninstall(peer).catch(() => {});
    await stopAndUninstall(target).catch(() => {});
    for (const directory of [installedMacApp, peer.appDir]) {
      if (path.resolve(directory).startsWith(`${path.resolve(work)}${path.sep}`) && await exists(directory)) {
        await runCommand('sudo', ['-n', 'rm', '-rf', '--', directory], { timeout: 60_000, label: 'cleanup-owned-mac-app' }).catch(() => {});
      }
    }
    if (report.scenarios.some(item => item.format === 'pkg')) await forgetTestPkgReceipts().catch(() => {});
  }
  for (const child of ownedProcesses) {
    try { child.kill('SIGTERM'); } catch {}
  }
}

async function copyBuildProject(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: async filename => {
      const relative = path.relative(source, filename).split(path.sep);
      if (relative.some(segment => ['node_modules', 'dist', '.git'].includes(segment))) return false;
      return true;
    },
  });
  await fs.cp(path.join(source, 'dist'), path.join(destination, 'dist'), { recursive: true, dereference: true });
  const dependencies = await fs.realpath(path.join(source, 'node_modules'));
  await fs.symlink(dependencies, path.join(destination, 'node_modules'), 'dir');
}

async function injectDiagnostics(mainPath) {
  const source = await fs.readFile(mainPath, 'utf8');
  const marker = '/* MINITRON_KARVIS_UNIX_E2E */';
  assert(!source.includes(marker), 'Karvis E2E diagnostics were already injected');
  const canonicalPeerRoot = await fs.realpath(peerRoot);
  const rendererExpression = `(async () => {\n    const until = Date.now() + 10000;\n    while (!(document.getElementById('root')?.childElementCount > 0) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));\n    const api = window.electronAPI || {};\n    const appVersion = typeof api.getAppVersion === 'function' ? await api.getAppVersion() : null;\n    return { ipc: typeof api.getAppVersion === 'function' && appVersion != null, appVersion, title: document.title, bodyText: document.body?.innerText || '', rootChildren: document.getElementById('root')?.childElementCount || 0, htmlLength: document.documentElement?.outerHTML.length || 0 };\n  })()`;
  const prefix = [
    marker,
    '(function karvisUnixE2EDiagnostics() {',
    '  const { app } = require("electron");',
    '  const fs = require("node:fs");',
    '  const path = require("node:path");',
    `  const peerRoot = ${JSON.stringify(canonicalPeerRoot)};`,
    '  let resourceDir = null; try { if (process.env.MINITRON_RESOURCES_DIR) resourceDir = fs.realpathSync(process.env.MINITRON_RESOURCES_DIR); } catch (_) {}',
    '  const isPeer = !!resourceDir && resourceDir.startsWith(peerRoot + path.sep);',
    `  const requestedUserData = process.env.KARVIS_E2E_USER_DATA || (isPeer ? ${JSON.stringify(peerUserData)} : ${JSON.stringify(targetUserData)});`,
    '  if (requestedUserData) { fs.mkdirSync(requestedUserData, { recursive: true }); app.setPath("userData", path.resolve(requestedUserData)); }',
    '  app.on("browser-window-created", (_event, window) => {',
    '    window.webContents.once("did-finish-load", async () => {',
    `      const diagnosticPath = process.env.KARVIS_E2E_DIAGNOSTIC_FILE || (isPeer ? ${JSON.stringify(peerDiagnostic)} : ${JSON.stringify(targetDiagnostic)});`,
    '      let renderer = null; let rendererError = null;',
    `      try { renderer = await window.webContents.executeJavaScript(${JSON.stringify(rendererExpression)}, true); } catch (error) { rendererError = String(error); }`,
    '      const value = { timestamp: new Date().toISOString(), pid: process.pid, electronVersion: process.versions.electron || null, appVersion: app.getVersion(), appName: app.getName(), appId: process.env.MINITRON_APP_ID || null, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, userData: app.getPath("userData"), windowTitle: window.getTitle(), renderer, rendererError };',
    '      try { fs.mkdirSync(path.dirname(diagnosticPath), { recursive: true }); const temp = diagnosticPath + ".tmp"; fs.writeFileSync(temp, JSON.stringify(value, null, 2)); fs.renameSync(temp, diagnosticPath); } catch (_) {}',
    '    });',
    '  });',
    '})();',
    '',
  ].join('\n');
  await fs.writeFile(mainPath, prefix + source);
}

async function writeHook(filename, markerPath, text) {
  const content = `#!/bin/sh\nset -eu\nprintf '%s\\n' ${shellQuote(text)} >> ${shellQuote(markerPath)}\n`;
  await fs.writeFile(filename, content, { mode: 0o755 });
  await fs.chmod(filename, 0o755);
}

async function writeMinitronConfig(filename, appId, appVersion, manifestUrl, publicKey) {
  const contents = [
    `app_id = ${JSON.stringify(appId)}`,
    `required_runtime = ${JSON.stringify(runtimeVersion)}`,
    `app_version = ${JSON.stringify(appVersion)}`,
    `manifest_url = ${JSON.stringify(manifestUrl)}`,
    'allow_localhost_http = true',
    `manifest_public_key = ${JSON.stringify(publicKey)}`,
    '',
  ].join('\n');
  await fs.writeFile(filename, contents);
}

function makeManifestKeys(keyPath) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  return { privateKey, publicKey: raw, pem, keyPath };
}

async function verifyBuildInputs(directory) {
  const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  assert(isRecord(pkg.scripts) && typeof pkg.scripts.build === 'string' && pkg.scripts.build.trim(), 'Karvis package.json must define npm run build');
  const dependencies = await fs.stat(path.join(directory, 'node_modules')).catch(() => null);
  assert(dependencies?.isDirectory(), 'CI must run npm ci in the decrypted Karvis source snapshot before this E2E');
  assert(isRecord(pkg.build) || isRecord(pkg.directories), 'Karvis package.json must include its electron-builder config');
}

async function verifyLauncher(filename) {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return;
  const stat = await fs.stat(filename);
  assert(stat.mode & 0o111, 'Minitron launcher must be executable');
  const version = await runCommand(filename, ['--version'], { timeout: 10_000, label: 'launcher-version' });
  assert.match(version.stdout.trim(), /(?:minitron\s+)?v?0\.3\.\d+/i, 'E2E requires the Minitron 0.3 launcher');
}

async function verifyRuntimeZip(filename) {
  const stat = await fs.stat(filename);
  assert(stat.size > 1024 * 1024, 'Electron runtime ZIP looks too small to be an official runtime');
  const names = path.basename(filename).toLowerCase();
  assert(names.includes('28.3.3'), 'Runtime ZIP filename must identify Electron 28.3.3');
}

async function resolvePngIcon(project, build) {
  const candidates = [build.icon, build.linux?.icon, build.mac?.icon, build.win?.icon, 'icon.png', 'assets/icon.png', 'assets/karvis.png'];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const filename = path.isAbsolute(candidate) ? candidate : path.resolve(project, candidate);
    if (filename.toLowerCase().endsWith('.png') && await isPng(filename)) return filename;
  }
  for (const filename of await filesRecursive(path.join(project, 'assets'), name => name.toLowerCase().endsWith('.png'))) {
    if (await isPng(filename)) return filename;
  }
  throw new Error('Karvis snapshot must contain a PNG icon for Minitron resources');
}

async function isPng(filename) {
  try { const file = await fs.open(filename, 'r'); const buffer = Buffer.alloc(8); await file.read(buffer, 0, 8, 0); await file.close(); return buffer.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); } catch { return false; }
}

async function findLinuxAppDir(root, exeName) {
  const directories = await dirsRecursive(root);
  for (const directory of directories) if (await exists(path.join(directory, 'resources', 'app.asar')) && await exists(path.join(directory, exeName))) return directory;
  throw new Error(`electron-builder did not produce a Linux app directory containing ${exeName} and resources/app.asar`);
}

async function findMacAppDir(root, name) {
  const directories = await dirsRecursive(root);
  const match = directories.find(directory => path.basename(directory) === `${name}.app` && fssyncExists(path.join(directory, 'Contents', 'Resources', 'app.asar')));
  if (!match) throw new Error(`Could not find ${name}.app with Contents/Resources/app.asar under ${root}`);
  return match;
}

async function findArtifact(root, extension) {
  const files = await filesRecursive(root, filename => filename.toLowerCase().endsWith(`.${extension}`));
  if (files.length !== 1) throw new Error(`Expected one .${extension} artifact under ${root}, found ${files.length}: ${files.join(', ')}`);
  return files[0];
}

function summarizeBuild(build) {
  return { version: build.version, appDir: build.appDir, packages: build.packages, packageBytes: build.packageBytes, appBytes: build.appBytes, builderVersion: build.builderVersion, packageName: build.packageName };
}

async function findFirstFile(root, predicate) { return (await filesRecursive(root, predicate))[0] || null; }
async function filesRecursive(root, predicate = () => true) {
  const result = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile() && predicate(filename)) result.push(filename);
    }
  }
  await visit(root); return result.sort();
}
async function dirsRecursive(root) {
  const result = [root];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) { const nested = path.join(directory, entry.name); result.push(nested); await visit(nested); }
  }
  await visit(root); return result;
}

async function snapshotSource(root) {
  const files = new Map();
  async function visit(directory, relative = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relative ? path.join(relative, entry.name) : entry.name;
      if (['node_modules', 'dist', '.git', '.cache', 'coverage'].includes(entry.name)) continue;
      const full = path.join(directory, entry.name);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) files.set(rel.replaceAll(path.sep, '/'), createHash('sha256').update(`symlink:${await fs.readlink(full)}`).digest('hex'));
      else if (stat.isDirectory()) await visit(full, rel);
      else if (stat.isFile()) files.set(rel.replaceAll(path.sep, '/'), await hashFile(full));
    }
  }
  await visit(root);
  return files;
}

function diffSnapshots(before, after) {
  const changes = [];
  for (const [filename, hash] of before) if (!after.has(filename)) changes.push(`removed ${filename}`); else if (after.get(filename) !== hash) changes.push(`modified ${filename}`);
  for (const filename of after.keys()) if (!before.has(filename)) changes.push(`added ${filename}`);
  return changes.sort();
}

async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function directoryBytes(directory) {
  let size = 0;
  for (const filename of await filesRecursive(directory)) size += (await fs.stat(filename)).size;
  return size;
}

async function readVersion(filename) { return (await fs.readFile(filename, 'utf8')).trim().replace(/^v/, ''); }
async function exists(filename) { return fs.stat(filename).then(() => true, () => false); }
async function wait(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
async function waitFor(predicate, message, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await wait(200); }
  throw new Error(message);
}
async function commandExists(name) { return new Promise(resolve => { const child = spawn('sh', ['-c', `command -v ${shellQuote(name)} >/dev/null 2>&1`], { stdio: 'ignore' }); child.once('close', code => resolve(code === 0)); child.once('error', () => resolve(false)); }); }
function normalizeArray(value) { if (value == null) return []; return Array.isArray(value) ? [...value] : [value]; }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function safeName(value) { return String(value).replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 80); }
function shellQuote(value) { return `'${String(value).replaceAll("'", `"'"'`)}'`; }
function cryptoId() { return randomUUID().replaceAll('-', '').slice(0, 8); }
function fssyncExists(filename) { return fsSync.existsSync(filename); }
function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { parsed.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (parsed[key] !== undefined) throw new Error(`Option --${key} was specified more than once`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Option --${key} requires a value`);
    parsed[key] = value;
  }
  return parsed;
}
