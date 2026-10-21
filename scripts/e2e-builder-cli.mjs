import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageDir = path.join(repo, 'packages', 'electron-builder');
const packageManifestPath = path.join(packageDir, 'package.json');
const packageManifest = JSON.parse(await fs.readFile(packageManifestPath, 'utf8'));
const options = parseArguments(process.argv.slice(2));
const platform = process.platform;
const architecture = process.arch;
const launcherName = platform === 'win32' ? 'minitron.exe' : 'minitron';
const launcherPath = path.resolve(options.launcher || process.env.MINITRON_LAUNCHER || path.join(repo, 'shell', 'target', 'release', launcherName));
const electronZip = path.resolve(options['electron-zip'] || path.join(repo, 'dist', 'electron-zips', `electron-v32.2.0-${platform}-${architecture}.zip`));
const reportPath = path.resolve(options.report || path.join(repo, 'dist', 'e2e-builder-cli-report.json'));
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'minitron-builder-cli-e2e-'));
const fixture = path.join(work, 'fixture');
const report = {
  startedAt: new Date().toISOString(),
  platform: `${platform}-${architecture}`,
  package: { name: packageManifest.name, version: packageManifest.version },
  stages: [],
  workPath: work,
};
let electronDistPath;
let packagedAppOutDir;
let packagedLauncher;

if (platform !== 'win32' && platform !== 'linux' && platform !== 'darwin') {
  throw new Error(`Unsupported native runner platform: ${platform}`);
}
if (architecture !== 'x64' && architecture !== 'arm64') {
  throw new Error(`Unsupported native runner architecture: ${architecture}`);
}

const runtimeRoot = path.join(work, 'runtime-cache');
const childEnvironment = {
  ...process.env,
  ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
  ELECTRON_RUNTIME_ROOT: runtimeRoot,
  MINITRON_LAUNCHER: launcherPath,
  MINITRON_MANIFEST_URL: '',
};
delete childEnvironment.ELECTRON_RUN_AS_NODE;
delete childEnvironment.MINITRON_PUBLIC_KEY;

async function stage(name, operation) {
  const started = Date.now();
  try {
    const details = await operation();
    report.stages.push({ name, status: 'passed', durationMs: Date.now() - started, ...details });
    console.log(`[PASS] ${name}`);
    return details;
  } catch (error) {
    report.stages.push({
      name,
      status: 'failed',
      durationMs: Date.now() - started,
      error: error.message,
      output: error.output,
    });
    throw error;
  }
}

async function main() {
  if (options.help) {
    console.log('Usage: node scripts/e2e-builder-cli.mjs [--launcher PATH] [--electron-zip PATH] [--report PATH]');
    return;
  }

  assert.equal(packageManifest.name, 'minitron-builder', 'The packed npm package must use the minitron-builder name');
  await fs.mkdir(fixture, { recursive: true });
  await stage('native launcher is available', async () => {
    const stat = await fs.stat(launcherPath);
    assert(stat.isFile(), `MINITRON_LAUNCHER is not a file: ${launcherPath}`);
    if (platform !== 'win32') assert((stat.mode & 0o111) !== 0, `Launcher is not executable: ${launcherPath}`);
    const result = await runProcess(launcherPath, ['--version'], { cwd: repo, env: childEnvironment, timeoutMs: 10_000 });
    const version = `${result.stdout}\n${result.stderr}`.match(/\b\d+\.\d+\.\d+\b/)?.[0];
    assert(version, `Could not read launcher version from: ${result.stdout} ${result.stderr}`);
    assert(compareVersions(version, '0.4.0') >= 0, `The CLI fixture needs a v0.4.0+ launcher for embedded runtime metadata; found ${version}`);
    report.launcher = { path: launcherPath, version };
    return { launcherVersion: version };
  });

  await stage('verified Electron fixture distribution is ready', async () => {
    const zipStat = await fs.stat(electronZip).catch(() => undefined);
    assert(zipStat?.isFile(), `Expected the CI-verified Electron 32.2.0 archive at ${electronZip}`);
    const extracted = path.join(work, 'electron-32.2.0');
    await fs.mkdir(extracted, { recursive: true });
    await extractZip(electronZip, extracted, childEnvironment);
    electronDistPath = await findElectronDist(extracted, platform);
    const version = (await fs.readFile(path.join(electronDistPath, 'version'), 'utf8')).trim().replace(/^v/, '');
    assert.equal(version, '32.2.0', 'The fixture must build against the pinned Electron runtime');
    report.electron = { version, archiveBytes: zipStat.size, archiveSha256: await sha256(electronZip) };
    return { electronVersion: version, archiveBytes: zipStat.size };
  });

  await stage('minimal Electron app fixture is prepared', async () => {
    assert(electronDistPath, 'Electron distribution path was not found');
    await writeFixture(fixture, electronDistPath, repo, platform);
    const appPackage = JSON.parse(await fs.readFile(path.join(fixture, 'package.json'), 'utf8'));
    assert.equal(appPackage.main, 'dist/main/index.js');
    assert.equal(appPackage.build.appId, 'com.minitron.buildercli.e2e');
    assert.equal(appPackage.build.productName, 'MinitronCliFixture');
    assert.equal(appPackage.minitron, undefined, 'The fixture must not rely on Minitron-specific icon options');
    const platformKey = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux';
    const iconSource = appPackage.build[platformKey].icon;
    assert.equal(typeof iconSource, 'string', 'The native build section must use its standard electron-builder icon setting');
    for (const key of ['win', 'linux', 'mac']) {
      if (key !== platformKey) assert.equal(appPackage.build[key].icon, undefined, `Unexpected ${key} icon would bypass native icon conversion`);
    }
    return { appId: appPackage.build.appId, productName: appPackage.build.productName, iconSource };
  });

  await stage('repository package is packed and installed as an npm tarball', async () => {
    const npmCli = await findNpmCli();
    const packed = await runProcess(process.execPath, [npmCli, 'pack', packageDir, '--json', '--pack-destination', work], {
      cwd: repo,
      env: childEnvironment,
      timeoutMs: 120_000,
    });
    const packInfo = parsePackOutput(packed.stdout)[0];
    assert.equal(packInfo.name, 'minitron-builder');
    assert.equal(packInfo.version, packageManifest.version);
    const tarball = path.join(work, packInfo.filename);
    const tarballStat = await fs.stat(tarball);
    await runProcess(process.execPath, [npmCli, 'install', '--save-dev', tarball, '--no-audit', '--no-fund'], {
      cwd: fixture,
      env: childEnvironment,
      timeoutMs: 600_000,
    });
    const installedManifest = JSON.parse(await fs.readFile(path.join(fixture, 'node_modules', 'minitron-builder', 'package.json'), 'utf8'));
    assert.equal(installedManifest.name, packInfo.name);
    assert.equal(installedManifest.version, packInfo.version);
    const electronBuilder = createRequire(path.join(fixture, 'package.json'))('electron-builder/package.json');
    assert.equal(electronBuilder.version, '24.13.3', 'The installed CLI must resolve the pinned electron-builder version');
    report.package = {
      name: packInfo.name,
      version: packInfo.version,
      tarballBytes: tarballStat.size,
      tarballSha256: await sha256(tarball),
      installedElectronBuilder: electronBuilder.version,
    };
    return { packageVersion: packInfo.version, tarballBytes: tarballStat.size, electronBuilder: electronBuilder.version };
  });

  await stage('fixture app is compiled using its normal build script', async () => {
    await runProcess(process.execPath, [await resolveCliBin(fixture), '--help'], {
      cwd: fixture,
      env: childEnvironment,
      timeoutMs: 20_000,
    });
    await runProcess(process.execPath, [await findNpmCli(), 'run', 'build'], {
      cwd: fixture,
      env: childEnvironment,
      timeoutMs: 30_000,
    });
    assert(await fileExists(path.join(fixture, 'dist', 'main', 'index.js')));
    return { main: 'dist/main/index.js' };
  });

  await stage('npm CLI produces a Minitron app through electron-builder afterPack', async () => {
    const cliArgs = [platform === 'win32' ? '--win' : platform === 'darwin' ? '--mac' : '--linux', '--dir'];
    cliArgs.push(architecture === 'arm64' ? '--arm64' : '--x64');
    const result = await runProcess(process.execPath, [await resolveCliBin(fixture), ...cliArgs], {
      cwd: fixture,
      env: childEnvironment,
      timeoutMs: 900_000,
    });
    const outputDirectory = path.join(fixture, 'cli-output');
    assert(await fileExists(outputDirectory), `electron-builder did not use build.directories.output: ${outputDirectory}`);
    const archives = await findFiles(outputDirectory, (file) => path.basename(file) === 'app.asar');
    assert.equal(archives.length, 1, `Expected one packaged app.asar, found ${archives.length}`);

    const archivePath = archives[0];
    const resourcesDir = path.dirname(archivePath);
    const isMacBundle = platform === 'darwin' && path.basename(resourcesDir) === 'Resources';
    const appOutDir = isMacBundle ? path.resolve(resourcesDir, '..', '..') : path.dirname(resourcesDir);
    const requireFromFixture = createRequire(path.join(fixture, 'package.json'));
    const asar = requireFromFixture('@electron/asar');
    const appManifest = JSON.parse(asar.extractFile(archivePath, 'package.json').toString('utf8'));
    assert.equal(appManifest.productName, 'MinitronCliFixture');
    assert.equal(appManifest.main, '__minitron_bootstrap__.cjs');
    assert.equal(appManifest.minitronOriginalMain, 'dist/main/index.js');
    assert.equal(appManifest.metadata?.minitron?.appId, 'com.minitron.buildercli.e2e');
    assert(asar.extractFile(archivePath, path.join('dist', 'main', 'index.js')).toString('utf8').includes('MINITRON_BUILDER_CLI_FIXTURE'));
    assert(asar.extractFile(archivePath, '__minitron_bootstrap__.cjs').length > 0);
    assert(asar.extractFile(archivePath, '__minitron_bootstrap__.mjs').length > 0);
    const iconBytes = await fs.readFile(path.join(resourcesDir, 'minitron-icon.png'));
    assert.equal(iconBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert(iconBytes.length > 64, 'Converted Minitron PNG icon should contain image data');
    assert.equal(await fs.readFile(path.join(resourcesDir, 'cli-extra', 'sentinel.txt'), 'utf8'), 'extraResources preserved\n');
    assert.equal(await fs.readFile(path.join(resourcesDir, 'app.asar.unpacked', 'dist', 'native', 'unpacked.txt'), 'utf8'), 'asarUnpack preserved\n');

    const executableName = appManifest.metadata?.minitron?.executableName;
    assert.equal(typeof executableName, 'string');
    const launcher = platform === 'darwin'
      ? path.join(appOutDir, 'Contents', 'MacOS', executableName)
      : path.join(appOutDir, executableName);
    assert((await fs.stat(launcher)).isFile(), `Packaged Minitron launcher is missing: ${launcher}`);
    if (platform !== 'win32') assert(((await fs.stat(launcher)).mode & 0o111) !== 0, 'Packaged launcher lost its executable bit');

    const configPath = platform === 'darwin'
      ? path.join(appOutDir, 'Contents', 'MacOS', 'minitron.toml')
      : path.join(appOutDir, 'minitron.toml');
    const config = await fs.readFile(configPath, 'utf8');
    assert(config.includes('app_id = "com.minitron.buildercli.e2e"'));
    assert(config.includes('required_runtime = "32.2.0"'));
    assert(config.includes('manifest_url = ""'), 'No app update server should be required for initial launch');
    const appBytes = await directoryBytes(appOutDir);
    assert(appBytes < 80 * 1024 * 1024, `The app output contains unexpected Electron runtime files (${appBytes} bytes)`);

    packagedAppOutDir = appOutDir;
    packagedLauncher = launcher;
    report.build = {
      command: ['npx', 'minitron-builder', ...cliArgs],
      outputDirectory: 'cli-output',
      appOutDir: path.relative(fixture, appOutDir),
      archiveBytes: (await fs.stat(archivePath)).size,
      appBytes,
      executableName,
      iconBytes: iconBytes.length,
      iconSource: (await readFixturePackage(fixture)).build[platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'].icon,
      electronBuilderOutput: tail(result.stdout, 5000),
    };
    report.packagedApp = { appId: appManifest.metadata.minitron.appId, main: appManifest.main, originalMain: appManifest.minitronOriginalMain };
    return { archiveBytes: report.build.archiveBytes, appBytes, executableName };
  });

  await stage('packaged launcher reports version and no-manifest update state', async () => {
    const launcher = packagedLauncher;
    assert(packagedAppOutDir && launcher, 'Packaged app paths were not recorded');
    const versionResult = await runProcess(launcher, ['--version'], { cwd: packagedAppOutDir, env: childEnvironment, timeoutMs: 10_000 });
    const expectedVersion = report.launcher.version;
    assert(`${versionResult.stdout}\n${versionResult.stderr}`.includes(expectedVersion), 'Packaged launcher version differs from the native release launcher');
    const updateResult = await runProcess(launcher, ['--check-update'], { cwd: packagedAppOutDir, env: childEnvironment, timeoutMs: 20_000 });
    assert.match(updateResult.stdout, /UPDATE_NOT_CONFIGURED/, `Expected the no-manifest status, received: ${updateResult.stdout}`);
    assert.match(updateResult.stdout, /manifest_url is not configured/);
    return { launcherVersion: expectedVersion, updateState: updateResult.stdout.trim() };
  });

  await stage('CLI builds without project icon settings and supplies its default PNG icon', async () => {
    const packagePath = path.join(fixture, 'package.json');
    const appPackage = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    delete appPackage.minitron;
    for (const platformName of ['win', 'linux', 'mac']) delete appPackage.build[platformName].icon;
    appPackage.build.directories.output = 'cli-output-default-icon';
    assert.equal(appPackage.minitron, undefined);
    assert(['win', 'linux', 'mac'].every((name) => appPackage.build[name].icon === undefined));
    for (const filename of ['app.png', 'app.ico', 'app.icns']) {
      await fs.rm(path.join(fixture, 'build', filename), { force: true });
    }
    await fs.writeFile(packagePath, `${JSON.stringify(appPackage, null, 2)}\n`);

    const cliArgs = [platform === 'win32' ? '--win' : platform === 'darwin' ? '--mac' : '--linux', '--dir'];
    cliArgs.push(architecture === 'arm64' ? '--arm64' : '--x64');
    const result = await runProcess(process.execPath, [await resolveCliBin(fixture), ...cliArgs], {
      cwd: fixture,
      env: childEnvironment,
      timeoutMs: 900_000,
    });
    const outputDirectory = path.join(fixture, 'cli-output-default-icon');
    const archives = await findFiles(outputDirectory, (file) => path.basename(file) === 'app.asar');
    assert.equal(archives.length, 1, `Expected one default-icon app.asar, found ${archives.length}`);

    const archivePath = archives[0];
    const resourcesDir = path.dirname(archivePath);
    const isMacBundle = platform === 'darwin' && path.basename(resourcesDir) === 'Resources';
    const appOutDir = isMacBundle ? path.resolve(resourcesDir, '..', '..') : path.dirname(resourcesDir);
    const iconPath = path.join(resourcesDir, 'minitron-icon.png');
    const iconBytes = await fs.readFile(iconPath);
    assert.equal(iconBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert(iconBytes.length > 64, 'Default Minitron PNG icon should contain image data');

    const requireFromFixture = createRequire(path.join(fixture, 'package.json'));
    const asar = requireFromFixture('@electron/asar');
    const packagedManifest = JSON.parse(asar.extractFile(archivePath, 'package.json').toString('utf8'));
    assert.equal(packagedManifest.metadata?.minitron?.appId, 'com.minitron.buildercli.e2e');
    const executableName = packagedManifest.metadata?.minitron?.executableName;
    assert.equal(typeof executableName, 'string');
    const launcher = platform === 'darwin'
      ? path.join(appOutDir, 'Contents', 'MacOS', executableName)
      : path.join(appOutDir, executableName);
    assert((await fs.stat(launcher)).isFile(), `Default-icon build launcher is missing: ${launcher}`);
    const versionResult = await runProcess(launcher, ['--version'], { cwd: appOutDir, env: childEnvironment, timeoutMs: 10_000 });
    assert(`${versionResult.stdout}\n${versionResult.stderr}`.includes(report.launcher.version));
    const updateResult = await runProcess(launcher, ['--check-update'], { cwd: appOutDir, env: childEnvironment, timeoutMs: 20_000 });
    assert.match(updateResult.stdout, /UPDATE_NOT_CONFIGURED/);

    report.defaultIconBuild = {
      command: ['npx', 'minitron-builder', ...cliArgs],
      outputDirectory: 'cli-output-default-icon',
      appOutDir: path.relative(fixture, appOutDir),
      iconBytes: iconBytes.length,
      iconSha256: createHash('sha256').update(iconBytes).digest('hex'),
      executableName,
      electronBuilderOutput: tail(result.stdout, 3000),
      updateState: updateResult.stdout.trim(),
    };
    return { iconBytes: iconBytes.length, executableName, updateState: updateResult.stdout.trim() };
  });
}

try {
  await main();
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack || error.message;
} finally {
  if (report.status === 'passed') {
    try {
      await fs.rm(work, { recursive: true, force: true });
      report.workPath = null;
    } catch (error) {
      report.cleanupWarning = error.message;
    }
  }
  report.finishedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

if (report.status !== 'passed') process.exitCode = 1;

async function writeFixture(directory, electronDist, projectRoot, targetPlatform) {
  await fs.mkdir(path.join(directory, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(directory, 'fixture-assets'), { recursive: true });
  await fs.mkdir(path.join(directory, 'build'), { recursive: true });
  await fs.writeFile(path.join(directory, 'fixture-assets', 'sentinel.txt'), 'extraResources preserved\n');
  const templateIconPath = path.join(packageDir, 'node_modules', 'app-builder-lib', 'templates', 'icons', 'electron-linux', '256x256.png');
  const pngIcon = await fs.readFile(templateIconPath);
  assert.equal(pngIcon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(pngIcon.readUInt32BE(16), 256);
  assert.equal(pngIcon.readUInt32BE(20), 256);
  const buildIcons = { win: {}, mac: {}, linux: { executableName: 'minitron-cli-fixture' } };
  if (targetPlatform === 'win32') {
    await fs.writeFile(path.join(directory, 'build', 'app.ico'), createIcoFromPng(pngIcon));
    buildIcons.win.icon = 'build/app.ico';
  } else if (targetPlatform === 'darwin') {
    const source = path.join(electronDist, 'Electron.app', 'Contents', 'Resources', 'electron.icns');
    await fs.copyFile(source, path.join(directory, 'build', 'app.icns'));
    buildIcons.mac.icon = 'build/app.icns';
  } else {
    await fs.writeFile(path.join(directory, 'build', 'app.png'), pngIcon);
    buildIcons.linux.icon = 'build/app.png';
  }
  await fs.writeFile(path.join(directory, 'package.json'), `${JSON.stringify({
    name: 'minitron-builder-cli-fixture',
    version: '1.0.0',
    description: 'Temporary app for the minitron-builder npm CLI E2E',
    main: 'dist/main/index.js',
    scripts: { build: 'node scripts/build.mjs' },
    devDependencies: { electron: '32.2.0' },
    build: {
      appId: 'com.minitron.buildercli.e2e',
      productName: 'MinitronCliFixture',
      asar: true,
      electronVersion: '32.2.0',
      electronDist,
      directories: { output: 'cli-output' },
      win: buildIcons.win,
      mac: buildIcons.mac,
      linux: buildIcons.linux,
      files: ['dist/**/*', 'package.json'],
      extraResources: [{ from: 'fixture-assets', to: 'cli-extra' }],
      asarUnpack: ['dist/native/**'],
    },
  }, null, 2)}\n`);
  await fs.writeFile(path.join(directory, 'scripts', 'build.mjs'), [
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    "await fs.mkdir('dist/main', { recursive: true });",
    "await fs.mkdir('dist/renderer', { recursive: true });",
    "await fs.mkdir('dist/native', { recursive: true });",
    "await fs.writeFile('dist/main/index.js', \"const { app } = require('electron');\\napp.whenReady().then(() => console.log('MINITRON_BUILDER_CLI_FIXTURE'));\\n\");",
    "await fs.writeFile('dist/renderer/index.html', '<!doctype html><title>Minitron CLI fixture</title>');",
    "await fs.writeFile('dist/native/unpacked.txt', 'asarUnpack preserved\\n');",
  ].join('\n') + '\n');
}

function createIcoFromPng(png) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(0, 6); // 256 pixels wide
  header.writeUInt8(0, 7); // 256 pixels tall
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  return Buffer.concat([header, png]);
}

async function readFixturePackage(directory) {
  return JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
}

async function extractZip(zipPath, destination, env) {
  if (platform === 'win32') {
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    const command = `Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(destination)} -Force`;
    await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: repo,
      env,
      timeoutMs: 120_000,
    });
  } else {
    await runProcess('unzip', ['-q', '-o', zipPath, '-d', destination], { cwd: repo, env, timeoutMs: 120_000 });
  }
}

async function findElectronDist(root, targetPlatform) {
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length > 0) {
    const { directory, depth } = queue.shift();
    const hasVersion = await fileExists(path.join(directory, 'version'));
    const hasRuntime = targetPlatform === 'darwin'
      ? await fileExists(path.join(directory, 'Electron.app', 'Contents', 'MacOS', 'Electron'))
      : await fileExists(path.join(directory, targetPlatform === 'win32' ? 'electron.exe' : 'electron'));
    if (hasVersion && hasRuntime) return directory;
    if (depth >= 4) continue;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
    }
  }
  throw new Error(`Could not locate an extracted Electron ${targetPlatform} distribution below ${root}`);
}

async function resolveCliBin(directory) {
  const installedPackagePath = path.join(directory, 'node_modules', 'minitron-builder', 'package.json');
  const manifest = JSON.parse(await fs.readFile(installedPackagePath, 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['minitron-builder'];
  assert.equal(typeof bin, 'string', 'The installed minitron-builder package must expose its CLI bin');
  const cliPath = path.resolve(path.dirname(installedPackagePath), bin);
  assert(await fileExists(cliPath), `The package CLI entry is missing: ${cliPath}`);
  return cliPath;
}

async function findNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm'),
  ].filter(Boolean);
  for (const candidate of candidates) if (await fileExists(candidate)) return candidate;
  throw new Error(`Cannot find npm CLI entry; tried ${candidates.join(', ')}`);
}

function parsePackOutput(stdout) {
  const start = stdout.indexOf('[');
  assert(start >= 0, `npm pack did not return JSON metadata: ${tail(stdout, 2000)}`);
  return JSON.parse(stdout.slice(start));
}

async function findFiles(root, predicate, depth = 0) {
  assert(depth < 10, `Unexpectedly deep artifact tree below ${root}`);
  const matches = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) matches.push(...await findFiles(file, predicate, depth + 1));
    else if (entry.isFile() && predicate(file)) matches.push(file);
  }
  return matches;
}

async function directoryBytes(root) {
  let size = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) size += await directoryBytes(file);
    else if (entry.isFile()) size += (await fs.stat(file)).size;
  }
  return size;
}

async function fileExists(file) {
  return fs.access(file).then(() => true, () => false);
}

async function sha256(file) {
  const hash = createHash('sha256');
  const contents = await fs.readFile(file);
  return hash.update(contents).digest('hex');
}

function parseArguments(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 1) {
    const argument = args[i];
    if (argument === '--help' || argument === '-h') {
      result.help = true;
      continue;
    }
    if (!['--launcher', '--electron-zip', '--report'].includes(argument) || !args[i + 1]) {
      throw new Error(`Unknown or incomplete option: ${argument}`);
    }
    result[argument.slice(2)] = args[++i];
  }
  return result;
}

function tail(value, maxLength) {
  const text = String(value || '');
  return text.length <= maxLength ? text : text.slice(-maxLength);
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function runProcess(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const capture = (current, chunk) => tail(`${current}${chunk}`, 120_000);
    child.stdout.on('data', (chunk) => { stdout = capture(stdout, chunk.toString()); });
    child.stderr.on('data', (chunk) => { stderr = capture(stderr, chunk.toString()); });
    const timer = setTimeout(() => {
      timedOut = true;
      killOwnedProcessTree(child);
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const result = { command, args, code, signal, stdout, stderr };
      if (timedOut) {
        const error = new Error(`Timed out after ${timeoutMs} ms: ${command} ${args.join(' ')}`);
        error.output = tail(`${stdout}\n${stderr}`, 12_000);
        reject(error);
      } else if (code !== 0) {
        const error = new Error(`Command exited with code ${code}: ${command} ${args.join(' ')}`);
        error.output = tail(`${stdout}\n${stderr}`, 12_000);
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}

function killOwnedProcessTree(child) {
  if (!child.pid) return;
  if (platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') child.kill('SIGKILL');
  }
}
