import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publish } from './publish-release.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeVersion = '28.3.3';
const expectedProductName = 'Karvis AI';
const runtimePlatform = 'win32-x64';
const adapterPath = path.join(repo, 'packages/electron-builder/index.js');
const options = parseArguments(process.argv.slice(2));

if (options.help) {
  console.log('Usage: node scripts/e2e-karvis.mjs --project <Karvis project> --launcher <minitron.exe> --runtime-zip <Electron 28.3.3 ZIP> [--observe-ms <milliseconds>] [--skip-baseline]');
  process.exit(0);
}
for (const key of ['project', 'launcher', 'runtime-zip']) {
  if (!options[key]) throw new Error('Missing --' + key);
}
if (process.platform !== 'win32') throw new Error('Karvis NSIS E2E must run on Windows');
if (process.arch !== 'x64') throw new Error('Karvis E2E currently expects a win32-x64 Electron runtime');

const projectDir = path.resolve(options.project);
const launcherPath = path.resolve(options.launcher);
const runtimeZip = path.resolve(options['runtime-zip']);
for (const [label, filename] of [['Karvis project', path.join(projectDir, 'package.json')], ['Minitron launcher', launcherPath], ['Electron runtime ZIP', runtimeZip], ['electron-builder adapter', adapterPath]]) {
  const stat = await fs.stat(filename).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error(label + ' is missing: ' + filename);
}
const rootDist = path.join(repo, 'dist', 'karvis-e2e');
await fs.mkdir(rootDist, { recursive: true });
const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 8);
const work = path.join(rootDist, runId);
await fs.mkdir(work, { recursive: true });
await fs.mkdir(path.join(work, 'logs'), { recursive: true });
await fs.mkdir(path.join(work, 'markers'), { recursive: true });
await fs.mkdir(path.join(work, 'diagnostics'), { recursive: true });
await fs.mkdir(path.join(work, 'user-data'), { recursive: true });

const fileSize = async filename => (await fs.stat(filename)).size;
const exists = filename => fs.stat(filename).then(() => true, () => false);
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const report = {
  runId,
  started: new Date().toISOString(),
  repo,
  projectDir,
  launcherPath,
  runtimeZip,
  runtimeVersion,
  runtimePlatform,
  work,
  results: [],
  commands: [],
  builds: {},
  filesizes: {
    runtimeZipBytes: await fileSize(runtimeZip),
    minitronInstallerBytes: {},
    unpackedAppBytes: {},
    electronBuilderBaselineInstallerBytes: null,
  },
};

const results = report.results;
let commandNumber = 0;
let failure = null;
let server;
let baseUrl;
let currentManifests = { target: null, peer: null };
let originalSnapshot;
let projectAssetsRelativeFile;
let targetInstall;
let peerInstall;
const runtimeRoot = path.join(work, 'runtime-cache');
const artifactsRoot = path.join(work, 'server', 'artifacts');
const targetUserDataDirectory = path.join(work, 'user-data', 'target');
const targetUserDataSentinelPath = path.join(targetUserDataDirectory, 'karvis-e2e-userdata-sentinel.txt');
const targetUserDataSentinelContents = 'Karvis E2E userData sentinel ' + runId + '\n';
const signingKeyPath = path.join(work, 'test-signing.pem');
const manifestPublicKey = makeSigningKeyPair(signingKeyPath);

try {
  await fs.mkdir(artifactsRoot, { recursive: true });
  originalSnapshot = await snapshotProject(projectDir);
  report.originalFileCount = originalSnapshot.size;
  projectAssetsRelativeFile = await firstRegularFile(path.join(projectDir, 'assets'));
  if (!projectAssetsRelativeFile) throw new Error('Karvis project must contain at least one file in assets/');

  const launchShortcutScript = path.join(work, 'launch-shortcut.ps1');
  const inspectShortcutsScript = path.join(work, 'inspect-shortcuts.ps1');
  const makeUpdateZipScript = path.join(work, 'make-update-zip.ps1');
  const convertIconScript = path.join(work, 'convert-icon.ps1');
  const inspectPeScript = path.join(work, 'inspect-pe.ps1');
  await fs.writeFile(launchShortcutScript, [
    '$ErrorActionPreference = "Stop"',
    '$shortcutPath = $env:KARVIS_E2E_SHORTCUT_PATH',
    'if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { throw "Shortcut not found: $shortcutPath" }',
    '$shell = New-Object -ComObject WScript.Shell',
    '$shortcut = $shell.CreateShortcut($shortcutPath)',
    '$launched = Start-Process -FilePath $shortcutPath -PassThru -WindowStyle Hidden',
    '@{ pid = $launched.Id; targetPath = $shortcut.TargetPath; iconLocation = $shortcut.IconLocation } | ConvertTo-Json -Compress',
  ].join('\r\n') + '\r\n');
  await fs.writeFile(inspectShortcutsScript, [
    '$ErrorActionPreference = "Stop"',
    '$shell = New-Object -ComObject WScript.Shell',
    '$roots = @([System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::DesktopDirectory), [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Programs))',
    '$rows = @()',
    'foreach ($root in $roots) {',
    '  if (Test-Path -LiteralPath $root) {',
    '    foreach ($item in (Get-ChildItem -LiteralPath $root -Filter ($env:KARVIS_E2E_SHORTCUT_NAME + ".lnk") -File -Recurse -ErrorAction SilentlyContinue)) {',
    '      $shortcut = $shell.CreateShortcut($item.FullName)',
    '      $rows += [PSCustomObject]@{ path = $item.FullName; targetPath = $shortcut.TargetPath; iconLocation = $shortcut.IconLocation }',
    '    }',
    '  }',
    '}',
    'ConvertTo-Json -InputObject @($rows) -Compress',
  ].join('\r\n') + '\r\n');
  await fs.writeFile(makeUpdateZipScript, [
    'param([string]$Resources, [string]$Destination)',
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.IO.Compression',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '$archive = [System.IO.Compression.ZipFile]::Open($Destination, [System.IO.Compression.ZipArchiveMode]::Create)',
    'try {',
    '  $asar = Join-Path $Resources "app.asar"',
    '  if (-not (Test-Path -LiteralPath $asar -PathType Leaf)) { throw "Missing resources/app.asar: $asar" }',
    '  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $asar, "app.asar", [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null',
    '  $sidecar = Join-Path $Resources "app.asar.unpacked"',
    '  if (Test-Path -LiteralPath $sidecar -PathType Container) {',
    '    $items = @(Get-ChildItem -LiteralPath $sidecar -Force -Recurse)',
    '    if ($items.Count -eq 0) { $archive.CreateEntry("app.asar.unpacked/") | Out-Null }',
    '    foreach ($item in $items) {',
    '      $relative = $item.FullName.Substring($sidecar.Length).TrimStart([char[]]@(92, 47)).Replace([char]92, [char]47)',
    '      $entryName = "app.asar.unpacked/" + $relative',
    '      if ($item.PSIsContainer) { $archive.CreateEntry($entryName.TrimEnd("/") + "/") | Out-Null }',
    '      else { [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $item.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null }',
    '    }',
    '  } else { $archive.CreateEntry("app.asar.unpacked/") | Out-Null }',
    '} finally { $archive.Dispose() }',
  ].join('\r\n') + '\r\n');
  await fs.writeFile(convertIconScript, [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Drawing',
    '$icon = New-Object System.Drawing.Icon($env:KARVIS_E2E_ICON_SOURCE)',
    '$bitmap = $icon.ToBitmap()',
    'try { $bitmap.Save($env:KARVIS_E2E_ICON_DEST, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose(); $icon.Dispose() }',
  ].join('\r\n') + '\r\n');
  await fs.writeFile(inspectPeScript, [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Drawing',
    'function Get-IconHash([string]$Path) {',
    '  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Path)',
    '  if (-not $icon) { throw "Could not extract the executable icon: $Path" }',
    '  $source = $icon.ToBitmap()',
    '  $bitmap = New-Object -TypeName System.Drawing.Bitmap -ArgumentList @(32, 32, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)',
    '  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
    '  $stream = New-Object System.IO.MemoryStream',
    '  try {',
    '    $graphics.Clear([System.Drawing.Color]::Transparent)',
    '    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '    $graphics.DrawImage($source, 0, 0, 32, 32)',
    '    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)',
    '    $sha = [System.Security.Cryptography.SHA256]::Create()',
    '    try { return [BitConverter]::ToString($sha.ComputeHash($stream.ToArray())).Replace("-", "").ToLowerInvariant() } finally { $sha.Dispose() }',
    '  } finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose(); $source.Dispose(); $icon.Dispose() }',
    '}',
    '$exe = $env:KARVIS_E2E_PE_PATH',
    '$reference = $env:KARVIS_E2E_REFERENCE_LAUNCHER',
    '$info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($exe)',
    '[PSCustomObject]@{',
    '  executable = $exe',
    '  productName = $info.ProductName',
    '  productVersion = $info.ProductVersion',
    '  fileVersion = $info.FileVersion',
    '  embeddedIconSha256 = (Get-IconHash $exe)',
    '  minitronIconSha256 = (Get-IconHash $reference)',
    '} | ConvertTo-Json -Compress',
  ].join('\r\n') + '\r\n');

  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      if (pathname === '/target/manifest.json' || pathname === '/peer/manifest.json') {
        const owner = pathname.startsWith('/target/') ? 'target' : 'peer';
        const manifest = currentManifests[owner];
        if (!manifest) {
          response.writeHead(503);
          response.end('manifest not published yet');
          return;
        }
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify(manifest));
        return;
      }
      if (!pathname.startsWith('/artifacts/')) {
        response.writeHead(404);
        response.end('not found');
        return;
      }
      const relative = pathname.slice('/artifacts/'.length).split('/').filter(part => part && part !== '.' && part !== '..');
      const filename = path.resolve(artifactsRoot, ...relative);
      if (!filename.startsWith(path.resolve(artifactsRoot) + path.sep)) {
        response.writeHead(400);
        response.end('invalid path');
        return;
      }
      const stat = await fs.stat(filename);
      if (!stat.isFile()) throw new Error('not a file');
      let start = 0;
      let end = stat.size - 1;
      if (request.headers.range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
        if (!match || Number(match[1]) >= stat.size) {
          response.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
          response.end();
          return;
        }
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
        response.statusCode = 206;
        response.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + stat.size);
      }
      response.setHeader('Accept-Ranges', 'bytes');
      response.setHeader('Content-Length', end - start + 1);
      createReadStream(filename, { start, end }).on('error', () => response.destroy()).pipe(response);
    } catch {
      if (!response.headersSent) response.writeHead(404);
      response.end('not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  report.manifestBaseUrl = baseUrl;
  report.runtimeCache = runtimeRoot;

  const targetAppId = 'com.karvis.e2e.' + runId.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const peerAppId = targetAppId + '.peer';
  const targetShortcut = 'Karvis E2E ' + runId + ' Target';
  const peerShortcut = 'Karvis E2E ' + runId + ' Peer';
  const targetDirectory = path.join(work, 'installed', 'target app');
  const peerDirectory = path.join(work, 'installed', 'peer app');
  targetInstall = { directory: targetDirectory, appId: targetAppId, shortcutName: targetShortcut };
  peerInstall = { directory: peerDirectory, appId: peerAppId, shortcutName: peerShortcut };

  const target200 = await buildInstaller({
    label: 'target-2.0.0',
    projectDir,
    version: '2.0.0',
    appId: targetAppId,
    shortcutName: targetShortcut,
    manifestUrl: baseUrl + '/target/manifest.json',
    outputRoot: path.join(work, 'builds', 'target-2.0.0'),
    work,
    launcherPath,
    manifestPublicKey,
    convertIconScript,
    customIncludeMarker: path.join(work, 'markers', 'target-uninit.txt'),
    includeTargetUninit: true,
  });
  const target200Zip = await createUpdateArchive(target200, makeUpdateZipScript, work, 'target-2.0.0');
  currentManifests.target = await publishManifest({
    appId: targetAppId,
    version: '2.0.0',
    appZip: target200Zip,
    owner: 'target',
    previousManifest: null,
  });
  report.builds.target200 = summarizeBuild(target200, target200Zip);
  report.filesizes.minitronInstallerBytes.target200 = target200.installerBytes;
  report.filesizes.unpackedAppBytes.target200 = target200.unpackedBytes;

  const target201 = await buildInstaller({
    label: 'target-2.0.1',
    projectDir,
    version: '2.0.1',
    appId: targetAppId,
    shortcutName: targetShortcut,
    manifestUrl: baseUrl + '/target/manifest.json',
    outputRoot: path.join(work, 'builds', 'target-2.0.1'),
    work,
    launcherPath,
    manifestPublicKey,
    convertIconScript,
    customIncludeMarker: path.join(work, 'markers', 'target-uninit.txt'),
    includeTargetUninit: true,
  });
  const target201Zip = await createUpdateArchive(target201, makeUpdateZipScript, work, 'target-2.0.1');
  const target201Manifest = await publishManifest({
    appId: targetAppId,
    version: '2.0.1',
    appZip: target201Zip,
    owner: 'target',
    previousManifest: currentManifests.target,
  });
  report.builds.target201 = summarizeBuild(target201, target201Zip);
  report.filesizes.minitronInstallerBytes.target201 = target201.installerBytes;
  report.filesizes.unpackedAppBytes.target201 = target201.unpackedBytes;

  const peer200 = await buildInstaller({
    label: 'peer-2.0.0',
    projectDir,
    version: '2.0.0',
    appId: peerAppId,
    shortcutName: peerShortcut,
    manifestUrl: baseUrl + '/peer/manifest.json',
    outputRoot: path.join(work, 'builds', 'peer-2.0.0'),
    work,
    launcherPath,
    manifestPublicKey,
    convertIconScript,
    customIncludeMarker: path.join(work, 'markers', 'peer-uninit.txt'),
    includeTargetUninit: true,
  });
  const peer200Zip = await createUpdateArchive(peer200, makeUpdateZipScript, work, 'peer-2.0.0');
  currentManifests.peer = await publishManifest({
    appId: peerAppId,
    version: '2.0.0',
    appZip: peer200Zip,
    owner: 'peer',
    previousManifest: null,
  });
  report.builds.peer200 = summarizeBuild(peer200, peer200Zip);
  report.filesizes.minitronInstallerBytes.peer200 = peer200.installerBytes;
  report.filesizes.unpackedAppBytes.peer200 = peer200.unpackedBytes;
  report.targetManifests = {
    initial: currentManifests.target.app.version,
    upgradeReady: target201Manifest.app.version,
    peer: currentManifests.peer.app.version,
  };

  if (!options['skip-baseline']) {
    const baseline = await buildStandardBaseline(target200, targetAppId, targetShortcut, path.join(work, 'builds', 'electron-builder-baseline'));
    report.builds.electronBuilderBaseline = baseline;
    report.filesizes.electronBuilderBaselineInstallerBytes = baseline.installerBytes;
  }

  const targetUnpackedExe = await findMinitronExecutable(target200.unpackedDir);
  const targetInstalledExeName = path.basename(targetUnpackedExe);
  const peerInstalledExeName = path.basename(await findMinitronExecutable(peer200.unpackedDir));
  assert.equal(targetInstalledExeName, peerInstalledExeName, 'The peer fixture must use the same Karvis AI executable name');
  assert.equal(targetInstalledExeName.toLowerCase(), 'karvis ai.exe', 'Expected the product executable to retain its Karvis AI name');
  targetInstall.executableName = targetInstalledExeName;
  peerInstall.executableName = peerInstalledExeName;
  report.productExecutableName = targetInstalledExeName;

  await step('install actual per-user NSIS installers into isolated directories', async () => {
    await installNsis(target200, targetInstall);
    await installNsis(peer200, peerInstall);
    assert.equal(targetInstall.exePath, path.join(targetDirectory, targetInstalledExeName));
    assert.equal(peerInstall.exePath, path.join(peerDirectory, peerInstalledExeName));
    assert(await exists(path.join(targetDirectory, 'resources', 'assets')), 'Target installer omitted extraResources assets/');
    assert(await exists(path.join(peerDirectory, 'resources', 'assets')), 'Peer installer omitted extraResources assets/');
    assert(await exists(path.join(targetDirectory, 'resources', 'minitron-icon.png')), 'Minitron adapter icon was not installed');
    assert(await exists(path.join(peerDirectory, 'resources', 'minitron-icon.png')), 'Peer Minitron adapter icon was not installed');
    assert(await exists(path.join(work, 'markers', 'target-2.0.0-install.txt')), 'Target customInstall marker is missing');
    assert(await exists(path.join(work, 'markers', 'peer-2.0.0-install.txt')), 'Peer customInstall marker is missing');
    report.peIdentity = {
      target200: await validateExecutableIdentity(inspectPeScript, targetInstall.exePath, '2.0.0', 'target-2.0.0'),
      peer200: await validateExecutableIdentity(inspectPeScript, peerInstall.exePath, '2.0.0', 'peer-2.0.0'),
    };
    const targetShortcuts = await inspectShortcuts(inspectShortcutsScript, targetShortcut);
    const peerShortcuts = await inspectShortcuts(inspectShortcutsScript, peerShortcut);
    assertShortcuts(targetShortcuts, targetShortcut, targetInstall.exePath);
    assertShortcuts(peerShortcuts, peerShortcut, peerInstall.exePath);
    report.shortcuts = { target: targetShortcuts, peer: peerShortcuts };
  });

  const target200DiagnosticPath = path.join(work, 'diagnostics', 'target-2.0.0.json');
  const peer200DiagnosticPath = path.join(work, 'diagnostics', 'peer-2.0.0.json');
  await step('launch both same-name Karvis AI shortcuts and verify packaged renderer plus IPC', async () => {
    await fs.mkdir(targetUserDataDirectory, { recursive: true });
    await fs.writeFile(targetUserDataSentinelPath, targetUserDataSentinelContents, { flag: 'wx' });
    await launchShortcut(launchShortcutScript, targetShortcut, target200DiagnosticPath, targetUserDataDirectory);
    const targetDiagnostic = await waitForDiagnostic(target200DiagnosticPath, targetInstall);
    validateDiagnostic(targetDiagnostic, targetInstall, '2.0.0');
    report.userDataRetention = [await assertTargetUserDataSentinel('initial launch')];
    targetInstall.firstChild = await processIdentityFromRecord(targetInstall);

    await launchShortcut(launchShortcutScript, peerShortcut, peer200DiagnosticPath, path.join(work, 'user-data', 'peer'), 'startmenu');
    const peerDiagnostic = await waitForDiagnostic(peer200DiagnosticPath, peerInstall);
    validateDiagnostic(peerDiagnostic, peerInstall, '2.0.0');
    peerInstall.firstChild = await processIdentityFromRecord(peerInstall);
    await assertProcessIsAlive(targetInstall.firstChild, 'Target Karvis process disappeared before upgrade');
    await assertProcessIsAlive(peerInstall.firstChild, 'Peer Karvis process disappeared immediately after launch');
    assert(await exists(runtimePath(runtimeRoot)), 'Electron 28.3.3 was not downloaded into the isolated shared runtime cache');
    assert(await exists(path.join(runtimeRoot, 'refs.json')), 'Runtime reference registry was not created');
    report.launches = { targetInitial: targetDiagnostic, peerInitial: peerDiagnostic };
  });

  await step('upgrade the running target through NSIS while the same-name peer remains alive', async () => {
    const oldTargetIdentity = targetInstall.firstChild;
    const peerIdentity = peerInstall.firstChild;
    await installNsis(target201, targetInstall);
    await waitFor(async () => !(await processIdentityAlive(oldTargetIdentity)), 'The target Electron child survived its NSIS upgrade', 30_000);
    await assertProcessIsAlive(peerIdentity, 'NSIS upgrade stopped the same-name peer Karvis process');
    assert(await exists(path.join(work, 'markers', 'target-uninit.txt')), 'The composed customUnInit marker did not run during NSIS upgrade');
    assert(await exists(path.join(work, 'markers', 'target-2.0.1-install.txt')), 'The upgraded customInstall marker is missing');
    report.peIdentity.target201 = await validateExecutableIdentity(inspectPeScript, targetInstall.exePath, '2.0.1', 'target-2.0.1');
    report.userDataRetention.push(await assertTargetUserDataSentinel('NSIS upgrade'));
    const upgradedShortcuts = await inspectShortcuts(inspectShortcutsScript, targetShortcut);
    assertShortcuts(upgradedShortcuts, targetShortcut, targetInstall.exePath);
    report.upgrade = {
      stoppedTarget: oldTargetIdentity,
      survivingPeer: peerIdentity,
      installer: target201.installer,
      manifestKeptAt: currentManifests.target.app.version,
    };
  });

  currentManifests.target = target201Manifest;
  const target201DiagnosticPath = path.join(work, 'diagnostics', 'target-2.0.1.json');
  await step('start the upgraded Karvis shortcut and confirm version 2.0.1 over renderer IPC', async () => {
    await launchShortcut(launchShortcutScript, targetShortcut, target201DiagnosticPath, targetUserDataDirectory, 'startmenu');
    const diagnostic = await waitForDiagnostic(target201DiagnosticPath, targetInstall);
    validateDiagnostic(diagnostic, targetInstall, '2.0.1');
    targetInstall.upgradedChild = await processIdentityFromRecord(targetInstall);
    await assertProcessIsAlive(peerInstall.firstChild, 'Peer Karvis process was stopped while launching the upgraded target');
    report.launches.targetUpgraded = diagnostic;
  });

  if (options['observe-ms'] > 0) {
    console.log('OBSERVE: Karvis target 2.0.1 and same-name peer are running for ' + options['observe-ms'] + ' ms');
    await wait(options['observe-ms']);
  }

  await step('uninstall target and prove the peer and shared Electron runtime survive', async () => {
    const targetIdentity = targetInstall.upgradedChild;
    await uninstallNsis(targetInstall);
    await waitFor(async () => !(await processIdentityAlive(targetIdentity)), 'Target Electron child survived NSIS uninstall', 30_000);
    report.userDataRetention.push(await assertTargetUserDataSentinel('NSIS uninstall'));
    assert(await exists(peerDirectory), 'Uninstalling target removed the peer installation directory');
    assert(await exists(peerInstall.exePath), 'Uninstalling target removed the peer launcher');
    await assertProcessIsAlive(peerInstall.firstChild, 'Uninstalling target stopped the same-name peer Karvis process');
    assert(await exists(runtimePath(runtimeRoot)), 'Uninstalling target removed the runtime still referenced by peer');
    assert(!(await inspectShortcuts(inspectShortcutsScript, targetShortcut)).length, 'Target shortcuts remained after uninstall');
    assert(await exists(path.join(work, 'markers', 'target-uninit.txt')), 'The target customUnInit marker did not run during uninstall');
    report.targetUninstalled = true;
  });

  await step('uninstall the final peer and verify shared Electron runtime garbage collection', async () => {
    const peerIdentity = peerInstall.firstChild;
    await uninstallNsis(peerInstall);
    await waitFor(async () => !(await processIdentityAlive(peerIdentity)), 'Peer Electron child survived NSIS uninstall', 30_000);
    await waitFor(() => exists(runtimePath(runtimeRoot)).then(value => !value), 'Electron 28.3.3 remained after the last runtime reference was unregistered', 30_000);
    assert(!(await inspectShortcuts(inspectShortcutsScript, peerShortcut)).length, 'Peer shortcuts remained after uninstall');
    assert(await exists(path.join(work, 'markers', 'peer-uninit.txt')), 'The peer customUnInit marker did not run during uninstall');
    report.peerUninstalled = true;
  });

  report.passed = true;
} catch (error) {
  failure = error;
  report.passed = false;
  report.error = error && error.stack ? error.stack : String(error);
  console.error(report.error);
} finally {
  if (failure) {
    await stopInstallationIfPresent(targetInstall).catch(error => report.cleanupErrors = [...(report.cleanupErrors || []), String(error)]);
    await stopInstallationIfPresent(peerInstall).catch(error => report.cleanupErrors = [...(report.cleanupErrors || []), String(error)]);
    await cleanupOwnedInstallation(targetInstall).catch(error => report.cleanupErrors = [...(report.cleanupErrors || []), String(error)]);
    await cleanupOwnedInstallation(peerInstall).catch(error => report.cleanupErrors = [...(report.cleanupErrors || []), String(error)]);
  }
  if (server) await new Promise(resolve => server.close(resolve));
  if (originalSnapshot) {
    try {
      const finalSnapshot = await snapshotProject(projectDir);
      const difference = diffSnapshots(originalSnapshot, finalSnapshot);
      report.originalProjectUnchanged = difference.length === 0;
      report.originalProjectChanges = difference;
      if (difference.length > 0 && !failure) {
        failure = new Error('Original Karvis project changed during E2E: ' + difference.slice(0, 12).join(', '));
        report.passed = false;
        report.error = failure.stack;
      }
    } catch (error) {
      report.originalProjectUnchanged = false;
      report.originalHashCheckError = String(error);
      if (!failure) {
        failure = error;
        report.passed = false;
        report.error = error.stack || String(error);
      }
    }
  }
  report.finished = new Date().toISOString();
  const reportPath = path.join(work, 'report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log('REPORT ' + reportPath);
  console.log('ARTIFACTS ' + work);
}
if (failure) process.exitCode = 1;
else console.log('PASS Karvis NSIS install, shortcut, renderer IPC, upgrade, peer isolation, and final runtime GC');

function parseArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      parsed.help = true;
      continue;
    }
    if (!argument.startsWith('--')) throw new Error('Unexpected argument: ' + argument);
    const equalAt = argument.indexOf('=');
    const key = argument.slice(2, equalAt < 0 ? undefined : equalAt);
    if (key === 'skip-baseline') {
      parsed[key] = true;
      continue;
    }
    if (equalAt >= 0) {
      parsed[key] = argument.slice(equalAt + 1);
      continue;
    }
    const next = args[index + 1];
    if (key === 'observe-ms' && (!next || next.startsWith('--'))) {
      parsed[key] = 60_000;
      continue;
    }
    if (!next || next.startsWith('--')) throw new Error('Missing value for --' + key);
    parsed[key] = next;
    index += 1;
  }
  parsed['observe-ms'] = parsed['observe-ms'] === undefined ? 0 : Number(parsed['observe-ms']);
  if (!Number.isSafeInteger(parsed['observe-ms']) || parsed['observe-ms'] < 0) throw new Error('--observe-ms must be a non-negative integer');
  return parsed;
}

function makeSigningKeyPair(privateKeyPath) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  fssync.writeFileSync(privateKeyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
}

async function snapshotProject(directory) {
  let filenames;
  try {
    const output = execFileSync('git', ['-C', directory, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] });
    filenames = output.toString('utf8').split('\0').filter(Boolean);
  } catch (error) {
    throw new Error('Cannot enumerate non-ignored Karvis files with git ls-files: ' + error.message);
  }
  const snapshot = new Map();
  for (const relative of filenames) {
    const normalized = relative.replaceAll('\\', '/');
    if (normalized.split('/').includes('node_modules')) continue;
    const absolute = path.join(directory, ...normalized.split('/'));
    const stat = await fs.lstat(absolute).catch(() => null);
    if (!stat || stat.isDirectory()) continue;
    snapshot.set(normalized, await hashPath(absolute));
  }
  return snapshot;
}

async function hashPath(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function diffSnapshots(before, after) {
  const changes = [];
  for (const [filename, hash] of before) {
    if (!after.has(filename)) changes.push('removed ' + filename);
    else if (after.get(filename) !== hash) changes.push('modified ' + filename);
  }
  for (const filename of after.keys()) {
    if (!before.has(filename)) changes.push('added ' + filename);
  }
  return changes.sort();
}

async function firstRegularFile(directory) {
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) return path.relative(path.dirname(directory), full);
    }
  }
  return null;
}

async function copyProjectSnapshot(source, destination) {
  const files = await snapshotProject(source);
  await fs.mkdir(destination, { recursive: true });
  for (const relative of files.keys()) {
    const sourcePath = path.join(source, ...relative.split('/'));
    const destinationPath = path.join(destination, ...relative.split('/'));
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.cp(sourcePath, destinationPath, { recursive: true, dereference: false, force: true });
  }
  const assetsSource = path.join(source, 'assets');
  const assetsDestination = path.join(destination, 'assets');
  if (await exists(assetsSource)) await fs.cp(assetsSource, assetsDestination, { recursive: true, dereference: false, force: true });
  const dependencies = path.join(source, 'node_modules');
  const dependencyStat = await fs.stat(dependencies).catch(() => null);
  if (!dependencyStat || !dependencyStat.isDirectory()) throw new Error('Karvis node_modules is required for the isolated build: ' + dependencies);
  const dependencyTarget = await fs.realpath(dependencies);
  await fs.symlink(dependencyTarget, path.join(destination, 'node_modules'), 'junction');
}

async function buildInstaller(settings) {
  const buildRoot = settings.outputRoot;
  const projectCopy = path.join(buildRoot, 'project');
  const outputDir = path.join(buildRoot, 'electron-builder-output');
  const logsDir = path.join(settings.work, 'logs');
  await fs.mkdir(buildRoot, { recursive: true });
  await copyProjectSnapshot(settings.projectDir, projectCopy);
  const packagePath = path.join(projectCopy, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) throw new Error('Karvis package.json must contain an object');
  const originalBuild = packageJson.build && typeof packageJson.build === 'object' && !Array.isArray(packageJson.build) ? packageJson.build : {};
  const productName = packageJson.productName || originalBuild.productName || expectedProductName;
  const packageName = packageJson.name || 'karvis';
  packageJson.version = settings.version;
  delete packageJson.build;
  await fs.writeFile(packagePath, JSON.stringify(packageJson, null, 2) + '\n');

  const nodeModules = path.join(projectCopy, 'node_modules');
  const builderCli = path.join(nodeModules, 'electron-builder', 'cli.js');
  if (!await exists(builderCli)) throw new Error('electron-builder CLI was not found through the node_modules junction: ' + builderCli);
  const builderPackage = JSON.parse(await fs.readFile(path.join(nodeModules, 'electron-builder', 'package.json'), 'utf8'));
  const electronPackagePath = path.join(nodeModules, 'electron', 'package.json');
  const electronPackage = JSON.parse(await fs.readFile(electronPackagePath, 'utf8').catch(() => '{}'));
  if (electronPackage.version && electronPackage.version !== runtimeVersion) {
    throw new Error('Karvis has Electron ' + electronPackage.version + ' installed, expected ' + runtimeVersion);
  }
  if (!electronPackage.version) throw new Error('Karvis node_modules must contain the exact Electron ' + runtimeVersion + ' package');

  const pngIconPath = await resolvePngIcon(projectCopy, originalBuild, settings.convertIconScript);
  const extraResources = normalizeArray(originalBuild.extraResources);
  if (!extraResources.some(entry => entry && typeof entry === 'object' && entry.from === 'assets' && (!entry.to || entry.to === 'assets'))) {
    extraResources.push({ from: 'assets', to: 'assets', filter: ['**/*'] });
  }
  const originalNsis = originalBuild.nsis && typeof originalBuild.nsis === 'object' && !Array.isArray(originalBuild.nsis) ? originalBuild.nsis : {};
  const customIncludePath = path.join(projectCopy, 'karvis-e2e-nsis.nsh');
  const installMarkerPath = path.join(settings.work, 'markers', settings.label + '-install.txt');
  const uninitPath = settings.customIncludeMarker;
  const nsisMarkerName = settings.label;
  await fs.writeFile(customIncludePath, [
    '!macro customInstall',
    '  FileOpen $0 "' + toNsisPath(installMarkerPath) + '" w',
    '  FileWrite $0 "' + nsisMarkerName + '$\\r$\\n"',
    '  FileClose $0',
    '!macroend',
    '',
    '!macro customUnInit',
    '  FileOpen $0 "' + toNsisPath(uninitPath) + '" w',
    '  FileWrite $0 "' + nsisMarkerName + '$\\r$\\n"',
    '  FileClose $0',
    '!macroend',
    '',
  ].join('\r\n'));
  const nsisIncludes = normalizeArray(originalNsis.include).filter(value => typeof value === 'string');
  nsisIncludes.push(customIncludePath);
  const buildConfig = {
    ...originalBuild,
    appId: settings.appId,
    productName,
    electronVersion: runtimeVersion,
    asar: originalBuild.asar === false ? false : true,
    npmRebuild: false,
    nodeGypRebuild: false,
    directories: { ...(originalBuild.directories || {}), output: outputDir },
    extraResources,
    extraMetadata: { ...(originalBuild.extraMetadata || {}), main: 'dist/main/index.js' },
    win: { ...(originalBuild.win || {}), target: ['nsis'] },
    nsis: {
      ...originalNsis,
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: 'always',
      createStartMenuShortcut: true,
      shortcutName: settings.shortcutName,
      runAfterFinish: false,
      include: nsisIncludes,
    },
  };
  if (buildConfig.asar === false) throw new Error('Karvis config disables ASAR, but Minitron requires ASAR packaging');
  const configPath = path.join(projectCopy, 'karvis-e2e.config.cjs');
  const configText = [
    "'use strict';",
    'const { withMinitron } = require(' + JSON.stringify(settings.adapterPath || adapterPath) + ');',
    'const config = ' + JSON.stringify(buildConfig, null, 2) + ';',
    'module.exports = withMinitron(config, ' + JSON.stringify({
      projectDir: projectCopy,
      launcherPath: settings.launcherPath,
      manifestUrl: settings.manifestUrl,
      allowLocalhostHttp: true,
      manifestPublicKey: settings.manifestPublicKey,
      runtimeVersion,
      iconPath: pngIconPath,
    }, null, 2) + ');',
    '',
  ].join('\n');
  await fs.writeFile(configPath, configText);

  const env = { ...process.env, NODE_PATH: [nodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter) };
  delete env.ELECTRON_RUN_AS_NODE;
  const buildScript = packageJson.scripts && packageJson.scripts.build;
  if (typeof buildScript !== 'string' || buildScript.trim() === '') throw new Error('Karvis package.json must define a build script');
  await runCommand(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run build'], {
    cwd: projectCopy,
    env,
    timeout: 15 * 60_000,
    label: settings.label + '-npm-build',
    logsDir,
  });
  const compiledMain = path.join(projectCopy, 'dist', 'main', 'index.js');
  if (!await exists(compiledMain)) throw new Error('Karvis build did not produce dist/main/index.js: ' + compiledMain);
  await injectDiagnostics(compiledMain);
  await runCommand(process.execPath, [builderCli, '--win', 'nsis', '--x64', '--config', configPath], {
    cwd: projectCopy,
    env,
    timeout: 20 * 60_000,
    label: settings.label + '-electron-builder',
    logsDir,
  });
  const unpackedDir = path.join(outputDir, 'win-unpacked');
  if (!await exists(unpackedDir)) throw new Error('electron-builder did not create win-unpacked: ' + unpackedDir);
  const installer = await findInstaller(outputDir);
  const installerBytes = await fileSize(installer);
  const unpackedBytes = await directoryBytes(unpackedDir);
  return {
    label: settings.label,
    version: settings.version,
    appId: settings.appId,
    productName,
    packageName,
    projectCopy,
    outputDir,
    unpackedDir,
    installer,
    installerBytes,
    unpackedBytes,
    configPath,
    originalBuild,
    buildConfig,
    builderVersion: builderPackage.version,
    pngIconPath,
    customIncludePath,
    installMarkerPath,
    uninitMarkerPath: uninitPath,
  };
}

async function resolvePngIcon(projectCopy, buildConfig, convertIconScript) {
  const configured = [];
  for (const value of [
    buildConfig.win && buildConfig.win.icon,
    buildConfig.icon,
    buildConfig.linux && buildConfig.linux.icon,
    buildConfig.mac && buildConfig.mac.icon,
  ]) {
    if (typeof value === 'string' && value.trim()) configured.push(path.isAbsolute(value) ? value : path.resolve(projectCopy, value));
  }
  const pngs = [];
  for (const candidate of configured) {
    if (path.extname(candidate).toLowerCase() === '.png' && await isPng(candidate)) return candidate;
    if (path.extname(candidate).toLowerCase() === '.ico' && await exists(candidate)) {
      const destination = path.join(projectCopy, 'karvis-e2e-minitron-icon.png');
      await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', convertIconScript], {
        cwd: projectCopy,
        env: { ...process.env, KARVIS_E2E_ICON_SOURCE: candidate, KARVIS_E2E_ICON_DEST: destination },
        timeout: 30_000,
        label: path.basename(projectCopy) + '-convert-icon',
        logsDir: path.join(work, 'logs'),
      });
      if (await isPng(destination)) return destination;
    }
  }
  const stack = [path.join(projectCopy, 'assets'), path.join(projectCopy, 'build'), path.join(projectCopy, 'resources')];
  while (stack.length) {
    const directory = stack.pop();
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.png' && await isPng(full)) pngs.push(full);
    }
  }
  pngs.sort((left, right) => {
    const priority = value => /karvis|logo|icon/i.test(path.basename(value)) ? 0 : 1;
    return priority(left) - priority(right) || left.localeCompare(right);
  });
  if (pngs.length > 0) return pngs[0];
  throw new Error('Could not find or convert a Karvis PNG icon for the Minitron adapter; configure an existing PNG or ICO icon');
}

async function isPng(filename) {
  const descriptor = await fs.open(filename, 'r').catch(() => null);
  if (!descriptor) return false;
  try {
    const signature = Buffer.alloc(8);
    const { bytesRead } = await descriptor.read(signature, 0, signature.length, 0);
    return bytesRead === 8 && signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  } finally {
    await descriptor.close();
  }
}

function normalizeArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value.slice() : [value];
}

function toNsisPath(value) {
  return value.replaceAll('/', '\\').replaceAll('"', '');
}

async function injectDiagnostics(mainPath) {
  const source = await fs.readFile(mainPath, 'utf8');
  const marker = '/* KARVIS_E2E_DIAGNOSTICS */';
  if (source.includes(marker)) throw new Error('Diagnostics were already injected into the copied Karvis main process');
  const expression = `(async () => {
    const until = Date.now() + 10000;
    while (!(document.getElementById('root')?.childElementCount > 0) && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const api = window.electronAPI || {};
    const appVersion = typeof api.getAppVersion === 'function' ? await api.getAppVersion() : null;
    return {
      ipc: typeof api.getAppVersion === 'function' && appVersion != null,
      appVersion, title: document.title,
      bodyText: document.body?.innerText || '',
      rootChildren: document.getElementById('root')?.childElementCount || 0,
      htmlLength: document.documentElement?.outerHTML.length || 0,
    };
  })()`;
  const injected = [
    marker,
    '(function karvisE2EDiagnostics() {',
    '  try {',
    "    const { app } = require('electron');",
    "    const fs = require('node:fs');",
    "    const path = require('node:path');",
    "    const requestedUserData = process.env.KARVIS_E2E_USER_DATA;",
    '    if (requestedUserData) {',
    '      fs.mkdirSync(requestedUserData, { recursive: true });',
    "      app.setPath('userData', path.resolve(requestedUserData));",
    '    }',
    '    app.on(\"browser-window-created\", (_event, window) => {',
    '      window.webContents.once(\"did-finish-load\", async () => {',
    '        const diagnosticPath = process.env.KARVIS_E2E_DIAGNOSTIC_FILE;',
    '        if (!diagnosticPath) return;',
    '        let renderer;',
    '        let rendererError = null;',
    '        try { renderer = await window.webContents.executeJavaScript(' + JSON.stringify(expression) + ', true); }',
    '        catch (error) { rendererError = String(error); }',
    '        const value = {',
    '          timestamp: new Date().toISOString(),',
    '          pid: process.pid,',
    '          electronVersion: process.versions.electron || null,',
    '          appVersion: app.getVersion(),',
    '          isPackaged: app.isPackaged,',
    '          resourcesPath: process.resourcesPath,',
    "          userData: app.getPath('userData'),",
    '          renderer,',
    '          rendererError,',
    '        };',
    '        try {',
    '          fs.mkdirSync(path.dirname(diagnosticPath), { recursive: true });',
    '          const temporary = diagnosticPath + \".tmp\";',
    '          fs.writeFileSync(temporary, JSON.stringify(value, null, 2));',
    '          fs.renameSync(temporary, diagnosticPath);',
    '        } catch (_) {}',
    '      });',
    '    });',
    '  } catch (_) {}',
    '})();',
    '',
  ].join('\n');
  await fs.writeFile(mainPath, injected + source);
}

async function runCommand(executable, args, settings = {}) {
  const startedAt = new Date().toISOString();
  if (!String(settings.label).startsWith('check-process-')) console.log('RUN ' + (settings.label || path.basename(executable)));
  const child = spawn(executable, args, {
    cwd: settings.cwd,
    env: { ...(settings.env || process.env), ELECTRON_RUNTIME_ROOT: runtimeRoot },
    windowsHide: settings.windowsHide !== false,
    windowsVerbatimArguments: settings.windowsVerbatimArguments || false,
    argv0: settings.windowsVerbatimArguments ? '"' + executable + '"' : undefined,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const timeout = settings.timeout || 120_000;
  let timedOut = false;
  let timer;
  const result = await new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch {}
    }, timeout);
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  const endedAt = new Date().toISOString();
  const record = {
    label: settings.label || path.basename(executable),
    executable,
    args,
    cwd: settings.cwd || process.cwd(),
    startedAt,
    endedAt,
    exitCode: result.code,
    signal: result.signal,
    timedOut,
  };
  report.commands.push(record);
  const logPath = path.join(settings.logsDir || path.join(work, 'logs'), String(++commandNumber).padStart(3, '0') + '-' + sanitize(record.label) + '.log');
  await fs.writeFile(logPath, 'COMMAND: ' + executable + ' ' + args.join(' ') + '\nCWD: ' + record.cwd + '\nEXIT: ' + result.code + '\nSTDOUT:\n' + stdout + '\nSTDERR:\n' + stderr);
  record.log = logPath;
  if (timedOut) throw new Error('Timed out after ' + timeout + 'ms: ' + executable + ' ' + args.join(' ') + '\n' + tail(stdout + '\n' + stderr));
  if (result.code !== 0) throw new Error('Command failed with exit code ' + result.code + ': ' + executable + ' ' + args.join(' ') + '\n' + tail(stdout + '\n' + stderr));
  return { ...result, stdout, stderr, logPath };
}

function sanitize(value) {
  return String(value).replace(/[^a-z0-9_.-]+/gi, '-').slice(0, 100);
}

function tail(value) {
  return value.length > 14_000 ? value.slice(-14_000) : value;
}

async function findInstaller(outputDir) {
  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  const candidates = entries.filter(entry => entry.isFile() && /\.exe$/i.test(entry.name)).map(entry => path.join(outputDir, entry.name));
  if (candidates.length !== 1) throw new Error('Expected one NSIS setup executable in ' + outputDir + ', found ' + candidates.map(value => path.basename(value)).join(', '));
  return candidates[0];
}

async function findMinitronExecutable(unpackedDir) {
  const entries = await fs.readdir(unpackedDir, { withFileTypes: true });
  const candidates = entries.filter(entry => entry.isFile() && /\.exe$/i.test(entry.name)).map(entry => path.join(unpackedDir, entry.name));
  for (const candidate of candidates) {
    const result = await runCommand(candidate, ['--version'], {
      cwd: unpackedDir,
      timeout: 10_000,
      label: 'probe-' + path.basename(candidate),
      logsDir: path.join(work, 'logs'),
    }).catch(() => null);
    if (result && /^(?:minitron\s+)?v?\d+\.\d+\.\d+$/i.test(result.stdout.trim())) return candidate;
  }
  throw new Error('No Minitron launcher executable was found in ' + unpackedDir);
}

async function directoryBytes(directory) {
  let total = 0;
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile()) total += (await fs.stat(absolute)).size;
    }
  }
  return total;
}

async function createUpdateArchive(build, script, workDir, label) {
  const zipPath = path.join(workDir, 'app-updates', sanitize(label) + '.zip');
  await fs.mkdir(path.dirname(zipPath), { recursive: true });
  await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Resources', path.join(build.unpackedDir, 'resources'), '-Destination', zipPath], {
    cwd: workDir,
    timeout: 5 * 60_000,
    label: 'zip-' + label,
    logsDir: path.join(workDir, 'logs'),
  });
  return zipPath;
}

async function publishManifest(settings) {
  let previousManifestPath;
  if (settings.previousManifest) {
    previousManifestPath = path.join(work, 'previous-' + settings.owner + '-' + settings.version + '.json');
    await fs.writeFile(previousManifestPath, JSON.stringify(settings.previousManifest));
  }
  return publish({
    'app-id': settings.appId,
    version: settings.version,
    'runtime-version': runtimeVersion,
    'app-zip': settings.appZip,
    'runtime-zip': runtimeZip,
    platform: runtimePlatform,
    'base-url': baseUrl + '/artifacts',
    out: artifactsRoot,
    'signing-key': signingKeyPath,
    ...(previousManifestPath ? { 'previous-manifest': previousManifestPath } : {}),
  });
}

function summarizeBuild(build, updateZip) {
  return {
    version: build.version,
    appId: build.appId,
    productName: build.productName,
    builderVersion: build.builderVersion,
    installer: build.installer,
    installerBytes: build.installerBytes,
    unpackedDir: build.unpackedDir,
    unpackedBytes: build.unpackedBytes,
    appUpdateZip: updateZip,
    appUpdateZipBytes: fssync.statSync(updateZip).size,
    iconPath: build.pngIconPath,
  };
}

async function buildStandardBaseline(reference, appId, shortcutName, outputRoot) {
  const config = {
    ...reference.buildConfig,
    appId,
    productName: reference.productName,
    directories: { ...(reference.buildConfig.directories || {}), output: outputRoot },
    nsis: {
      ...reference.buildConfig.nsis,
      include: normalizeArray(reference.originalBuild.nsis && reference.originalBuild.nsis.include),
      shortcutName,
    },
  };
  delete config.nsis.include;
  if (reference.originalBuild.nsis?.include) config.nsis.include = reference.originalBuild.nsis.include;
  const configPath = path.join(reference.projectCopy, 'karvis-e2e-baseline.config.cjs');
  await fs.writeFile(configPath, "'use strict';\nmodule.exports = " + JSON.stringify(config, null, 2) + ';\n');
  const nodeModules = path.join(reference.projectCopy, 'node_modules');
  const builderCli = path.join(nodeModules, 'electron-builder', 'cli.js');
  const env = { ...process.env, NODE_PATH: [nodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter) };
  delete env.ELECTRON_RUN_AS_NODE;
  await runCommand(process.execPath, [builderCli, '--win', 'nsis', '--x64', '--config', configPath], {
    cwd: reference.projectCopy,
    env,
    timeout: 20 * 60_000,
    label: 'electron-builder-standard-baseline',
    logsDir: path.join(work, 'logs'),
  });
  const installer = await findInstaller(outputRoot);
  return {
    installer,
    installerBytes: await fileSize(installer),
    outputDir: outputRoot,
    appId,
    shortcutName,
    note: 'Standard electron-builder NSIS package built from the same copied Karvis source without the Minitron afterPack adapter.',
  };
}

async function step(name, action) {
  const start = Date.now();
  try {
    const value = await action();
    results.push({ name, passed: true, milliseconds: Date.now() - start });
    console.log('PASS ' + name);
    return value;
  } catch (error) {
    results.push({ name, passed: false, milliseconds: Date.now() - start, error: error.stack || String(error) });
    throw error;
  }
}

function toInstallPath(value) {
  return path.resolve(value);
}

async function installNsis(build, installation) {
  await fs.mkdir(path.dirname(installation.directory), { recursive: true });
  installation.directory = toInstallPath(installation.directory);
  // electron-builder's StdUtils parser needs quotes around a /D value that
  // contains spaces, even though plain NSIS documents an unquoted final /D.
  await runCommand(build.installer, ['/S', '/currentuser', '/D="' + installation.directory + '"'], {
    cwd: path.dirname(build.installer),
    timeout: 5 * 60_000,
    windowsVerbatimArguments: true,
    windowsHide: false,
    label: 'install-' + build.label,
    logsDir: path.join(work, 'logs'),
  });
  installation.exePath = path.join(installation.directory, path.basename(await findMinitronExecutable(build.unpackedDir)));
  await waitFor(async () => await exists(path.join(installation.directory, 'resources', 'app.asar')) && await exists(installation.exePath), 'NSIS install did not populate ' + installation.directory, 60_000);
}

async function validateExecutableIdentity(script, executablePath, expectedVersion, label) {
  const result = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    cwd: work,
    env: {
      ...process.env,
      KARVIS_E2E_PE_PATH: executablePath,
      KARVIS_E2E_REFERENCE_LAUNCHER: launcherPath,
    },
    timeout: 30_000,
    label: 'inspect-pe-' + label,
    logsDir: path.join(work, 'logs'),
  });
  const jsonLine = result.stdout.split(/\r?\n/).reverse().find(value => value.trim().startsWith('{'));
  assert(jsonLine, 'PowerShell PE inspection returned no JSON for ' + executablePath);
  const identity = JSON.parse(jsonLine);
  assert.equal(identity.productName, expectedProductName, 'PE ProductName did not match Karvis for ' + label);
  assert.equal(normalizePeVersion(identity.productVersion), expectedVersion, 'PE ProductVersion did not match ' + expectedVersion + ' for ' + label);
  assert.equal(normalizePeVersion(identity.fileVersion), expectedVersion, 'PE FileVersion did not match ' + expectedVersion + ' for ' + label);
  assert.match(identity.embeddedIconSha256 || '', /^[a-f0-9]{64}$/i, 'Could not hash the embedded application icon for ' + label);
  assert.match(identity.minitronIconSha256 || '', /^[a-f0-9]{64}$/i, 'Could not hash the original Minitron launcher icon for ' + label);
  assert.notEqual(identity.embeddedIconSha256, identity.minitronIconSha256, 'The installed Karvis executable still embeds the original Minitron icon for ' + label);
  return identity;
}

function normalizePeVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+\.\d+\.\d+)(?:\.\d+)?(?:\s.*)?$/.exec(value.trim());
  return match ? match[1] : null;
}

async function assertTargetUserDataSentinel(stage) {
  const actual = await fs.readFile(targetUserDataSentinelPath, 'utf8');
  assert.equal(actual, targetUserDataSentinelContents, 'Karvis target userData sentinel was removed or changed during ' + stage);
  return {
    stage,
    path: targetUserDataSentinelPath,
    sha256: createHash('sha256').update(actual).digest('hex'),
  };
}

async function inspectShortcuts(script, shortcutName) {
  const result = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    cwd: work,
    env: { ...process.env, KARVIS_E2E_SHORTCUT_NAME: shortcutName },
    timeout: 30_000,
    label: 'inspect-shortcuts-' + shortcutName,
    logsDir: path.join(work, 'logs'),
  });
  const line = result.stdout.split(/\r?\n/).reverse().find(value => value.trim().startsWith('[') || value.trim().startsWith('{')) || '[]';
  const parsed = JSON.parse(line);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function assertShortcuts(shortcuts, shortcutName, expectedTarget) {
  assert.equal(shortcuts.length, 2, 'Expected one Desktop and one Start Menu shortcut for ' + shortcutName + ', found ' + shortcuts.length);
  const targets = new Set();
  for (const shortcut of shortcuts) {
    assert.equal(path.win32.normalize(shortcut.targetPath).toLowerCase(), path.win32.normalize(expectedTarget).toLowerCase(), 'Shortcut target is not the installed Karvis launcher: ' + JSON.stringify(shortcut));
    assert(shortcut.path.toLowerCase().includes('desktop') || shortcut.path.toLowerCase().includes('start menu'), 'Shortcut was not found under Desktop or Start Menu: ' + shortcut.path);
    const icon = typeof shortcut.iconLocation === 'string' ? shortcut.iconLocation.trim() : '';
    const iconPath = icon ? icon.replace(/,\s*\d+\s*$/, '') : shortcut.targetPath;
    assert(iconPath, 'Shortcut icon location was empty');
    assert(fssync.existsSync(iconPath), 'Shortcut icon file is missing: ' + iconPath);
    targets.add(shortcut.path.toLowerCase());
  }
  assert.equal(targets.size, 2);
}

async function launchShortcut(script, shortcutName, diagnosticPath, userDataPath, shortcutKind = 'desktop') {
  await fs.rm(diagnosticPath, { force: true });
  const shortcuts = await inspectShortcuts(path.join(work, 'inspect-shortcuts.ps1'), shortcutName);
  assert.equal(shortcuts.length, 2, 'Cannot launch missing shortcut ' + shortcutName);
  const needle = shortcutKind === 'startmenu' ? 'start menu' : 'desktop';
  const shortcutPath = shortcuts.find(item => item.path.toLowerCase().includes(needle))?.path;
  assert(shortcutPath, 'Could not find ' + shortcutKind + ' shortcut for ' + shortcutName);
  await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    cwd: work,
    env: {
      ...process.env,
      ELECTRON_RUNTIME_ROOT: runtimeRoot,
      KARVIS_E2E_DIAGNOSTIC_FILE: diagnosticPath,
      KARVIS_E2E_USER_DATA: userDataPath,
      KARVIS_E2E_SHORTCUT_PATH: shortcutPath,
    },
    timeout: 30_000,
    label: 'start-shortcut-' + shortcutName,
    logsDir: path.join(work, 'logs'),
  });
}

async function waitForDiagnostic(diagnosticPath, installation) {
  await waitFor(async () => {
    if (!await exists(diagnosticPath)) return false;
    try {
      const diagnostic = JSON.parse(await fs.readFile(diagnosticPath, 'utf8'));
      return diagnostic && diagnostic.pid && diagnostic.renderer;
    } catch {
      return false;
    }
  }, 'Karvis renderer diagnostic was not written: ' + diagnosticPath, 120_000);
  const diagnostic = JSON.parse(await fs.readFile(diagnosticPath, 'utf8'));
  await waitFor(async () => {
    const record = await readProcessRecord(installation);
    return record && record.childPid === diagnostic.pid && record.childStartTime != null;
  }, 'Installation process record did not match the Electron main process for ' + installation.directory, 30_000);
  return diagnostic;
}

function validateDiagnostic(diagnostic, installation, expectedVersion) {
  assert.equal(diagnostic.isPackaged, true, 'Karvis renderer was not packaged');
  assert.equal(diagnostic.appVersion, expectedVersion, 'Installed package version did not match the requested NSIS build');
  assert.equal(diagnostic.renderer && diagnostic.renderer.ipc, true, 'window.electronAPI.getAppVersion() failed');
  assert.equal(String(diagnostic.renderer.appVersion), expectedVersion, 'Renderer IPC returned the wrong Karvis version');
  assert.equal(typeof diagnostic.renderer.title, 'string');
  assert(diagnostic.renderer.htmlLength > 0, 'Renderer DOM was empty');
  assert(diagnostic.renderer.rootChildren > 0, 'React did not mount the actual Karvis application');
  assert(diagnostic.renderer.bodyText.trim().length > 0, 'Karvis did not render visible application text');
  assert.equal(path.win32.normalize(diagnostic.resourcesPath).toLowerCase(), path.win32.normalize(path.join(installation.directory, 'resources')).toLowerCase(), 'Electron resourcesPath did not point into the isolated installation');
  assert.equal(path.win32.normalize(diagnostic.userData).toLowerCase(), path.win32.normalize(path.join(work, 'user-data', installation === targetInstall ? 'target' : 'peer')).toLowerCase(), 'Karvis used a non-isolated userData directory');
}

async function readProcessRecord(installation) {
  const filename = path.join(installation.directory, 'updates', 'process.json');
  try {
    const source = await fs.readFile(filename, 'utf8');
    return JSON.parse(source.replace(/("(?:ownerStartTime|childStartTime)"\s*:\s*)(\d+)/g, '$1"$2"'));
  } catch {
    return null;
  }
}

async function processIdentityAlive(identity) {
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0) return false;
  const result = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '$p = Get-Process -Id ' + identity.pid + ' -ErrorAction SilentlyContinue; if ($null -eq $p) { exit 2 }; [Console]::WriteLine($p.StartTime.ToUniversalTime().ToFileTimeUtc())'], {
    cwd: work,
    timeout: 15_000,
    label: 'check-process-' + identity.pid,
    logsDir: path.join(work, 'logs'),
  }).catch(() => null);
  if (!result) return false;
  const actualStartTime = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!actualStartTime) return false;
  if (identity.startTime != null) return actualStartTime === String(identity.startTime);
  return false;
}

async function assertProcessIsAlive(identity, message) {
  assert(await processIdentityAlive(identity), message);
}

async function processIdentityFromRecord(installation) {
  const record = await readProcessRecord(installation);
  if (!record || !record.childPid || !record.childStartTime) throw new Error('Missing live installation process identity for ' + installation.directory);
  return { pid: Number(record.childPid), startTime: String(record.childStartTime) };
}

async function waitFor(predicate, message, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await predicate()) return;
    await wait(200);
  }
  throw new Error(message);
}

function runtimePath(root) {
  return path.join(root, 'versions', runtimePlatform, 'v' + runtimeVersion, 'install.json');
}

async function uninstallNsis(installation) {
  const uninstallers = [];
  for (const entry of await fs.readdir(installation.directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && /uninstall.*\.exe/i.test(entry.name)) uninstallers.push(path.join(installation.directory, entry.name));
  }
  if (uninstallers.length !== 1) {
    const fallback = path.join(installation.directory, 'Uninstall Karvis AI.exe');
    if (await exists(fallback)) uninstallers.splice(0, uninstallers.length, fallback);
  }
  if (uninstallers.length !== 1) throw new Error('Could not locate a unique Karvis NSIS uninstaller under ' + installation.directory);
  const uninstaller = uninstallers[0];
  const installedExePath = installation.exePath || (installation.executableName && path.join(installation.directory, installation.executableName));
  await runCommand(uninstaller, ['/S'], {
    cwd: installation.directory,
    timeout: 5 * 60_000,
    windowsHide: false,
    label: 'uninstall-' + path.basename(installation.directory),
    logsDir: path.join(work, 'logs'),
  });
  await waitFor(async () => !(await exists(uninstaller)) && !(installedExePath && await exists(installedExePath)), 'NSIS uninstaller did not remove its installed files: ' + uninstaller, 90_000);
}

async function stopInstallationIfPresent(installation) {
  if (!installation || !installation.directory || !installation.exePath || !await exists(installation.exePath)) return;
  await runCommand(installation.exePath, ['--app-dir', installation.directory, '--stop'], {
    cwd: installation.directory,
    timeout: 30_000,
    label: 'cleanup-stop-' + path.basename(installation.directory),
    logsDir: path.join(work, 'logs'),
  });
}

async function cleanupOwnedInstallation(installation) {
  if (!installation || typeof installation.directory !== 'string') return;
  const ownedRoot = path.resolve(work, 'installed') + path.sep;
  const directory = path.resolve(installation.directory);
  if (!directory.toLowerCase().startsWith(ownedRoot.toLowerCase())) {
    throw new Error('Refusing failure cleanup outside this test run installation directory: ' + directory);
  }
  if (!await exists(directory)) return;
  const executableName = installation.executableName || report.productExecutableName;
  const cleanupTarget = {
    ...installation,
    exePath: installation.exePath || (executableName && path.join(directory, executableName)),
  };
  const hasUninstaller = (await fs.readdir(directory, { withFileTypes: true }).catch(() => []))
    .some(entry => entry.isFile() && /uninstall.*\.exe/i.test(entry.name));
  if (!hasUninstaller && !(await exists(cleanupTarget.exePath || ''))) return;
  await uninstallNsis(cleanupTarget);
  report.failureCleanup = [...(report.failureCleanup || []), directory];
}
