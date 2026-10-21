import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publish, hashFile, signManifest } from './publish-release.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const options = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2].slice(2), process.argv[3 + i * 2]]));
for (const key of ['runtime-zip', 'runtime-version', 'upgrade-runtime-zip', 'upgrade-runtime-version', 'shell', 'new-shell', 'report']) {
  if (!options[key]) throw new Error(`Missing --${key}`);
}
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'ers-e2e-'));
const runtimePlatform = `${process.platform}-${process.arch}`;
const launcherName = process.platform === 'win32' ? 'minitron.exe' : 'minitron';
const configName = 'minitron.toml';
const source = path.join(work, 'source');
const cache = path.join(work, 'runtime-cache');
const cache2 = path.join(work, 'concurrent-cache');
const appSource = path.join(work, 'app-source');
await fs.mkdir(source, { recursive: true });
await fs.mkdir(appSource, { recursive: true });
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privateKeyPath = path.join(work, 'test-signing.pem');
await fs.writeFile(privateKeyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
let manifest;
let badSignature = false;
let truncateNextRuntime = false;
let rangedRequests = 0;
const requests = [];
const ownedProcesses = new Set();
const processRecords = [];
const results = [];
const report = { started: new Date().toISOString(), work, platform: runtimePlatform, results };

function terminateOwnedTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    // Unix launches are detached into their own process group. This cleans up
    // Electron and helper processes when a test times out or exits early.
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') child.kill('SIGKILL');
  }
}

const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    requests.push(pathname);
    if (pathname.endsWith('manifest.json')) {
      let body = pathname === '/other-manifest.json' ? signManifest({ ...manifest, app_id: 'com.example.other' }, privateKey) : manifest;
      if (badSignature) body = { ...body, app_id: 'tampered.app' };
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); return;
    }
    const name = path.basename(decodeURIComponent(pathname));
    const target = path.join(source, name);
    const stat = await fs.stat(target);
    let start = 0;
    if (req.headers.range) {
      rangedRequests++;
      const match = /^bytes=(\d+)-$/.exec(req.headers.range);
      if (!match || Number(match[1]) >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
      start = Number(match[1]);
      res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${stat.size - 1}/${stat.size}`);
    }
    res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Length', stat.size - start);
    if (truncateNextRuntime && pathname.startsWith('/electron-v')) {
      truncateNextRuntime = false;
      const partial = createReadStream(target, { start: 0, end: 1024 * 1024 - 1 });
      partial.on('end', () => setTimeout(() => res.destroy(), 50));
      partial.pipe(res, { end: false }); return;
    }
    const stream = createReadStream(target, { start }); stream.on('error', () => res.destroy()); stream.pipe(res);
  } catch { res.statusCode = 404; res.end('not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = file => fs.stat(file).then(() => true, () => false);

function launch(executable, args = [], extra = {}, timeout = 120_000) {
  const env = { ...process.env, ELECTRON_RUNTIME_ROOT: cache, MYAPP_SMOKE: '1', ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, args, { env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  ownedProcesses.add(child);
  const record = { executable, args, stdout: '', stderr: '', code: null };
  processRecords.push(record);
  child.stdout.on('data', data => record.stdout += data);
  child.stderr.on('data', data => record.stderr += data);
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { terminateOwnedTree(child); reject(new Error(`Timed out: ${executable} ${args.join(' ')}\nSTDOUT:\n${record.stdout.slice(-3000)}\nSTDERR:\n${record.stderr.slice(-3000)}`)); }, timeout);
    child.on('error', error => { clearTimeout(timer); ownedProcesses.delete(child); reject(error); });
    child.on('exit', (code, signal) => { clearTimeout(timer); ownedProcesses.delete(child); record.code = code; record.signal = signal; resolve(record); });
  });
  return { child, record, done };
}
async function run(executable, args = [], env = {}, expected = 0, timeout) {
  const result = await launch(executable, args, env, timeout).done;
  assert.equal(result.code, expected, JSON.stringify(result).slice(-7000));
  return result;
}
function smoke(result, expectedDefaultApp = true) {
  const line = result.stdout.split(/\r?\n/).find(line => line.startsWith('SMOKE:'));
  assert(line, `Missing real UI smoke result: ${JSON.stringify(result).slice(-3000)}`);
  const value = JSON.parse(line.slice(6));
  assert.equal(value.ipc, true); assert.equal(value.defaultApp, expectedDefaultApp);
  return value;
}
async function waitFor(predicate, message, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await delay(100); }
  throw new Error(message);
}
async function check(name, action) {
  const started = Date.now();
  try { await action(); results.push({ name, passed: true, milliseconds: Date.now() - started }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, milliseconds: Date.now() - started, error: error.stack }); throw error; }
}
async function buildApplication(version) {
  await fs.mkdir(path.join(appSource, 'ffi'), { recursive: true });
  await fs.writeFile(path.join(appSource, 'ffi/version.txt'), version);
  const out = path.join(work, `resources-${version}`);
  const zip = path.join(work, `app-${version}.zip`);
  const result = await run(process.execPath, [path.join(repo, 'app/scripts/pack-asar.js'), '--source', appSource, '--runtime-version', options['runtime-version'], '--version', version, '--out', out, '--zip-out', zip], {}, 0, 180_000);
  await fs.writeFile(path.join(work, `pack-${version}.log`), result.stdout + result.stderr);
  return { out, zip };
}
async function publishVersion(version, artifacts, runtimeVersion = options['runtime-version'], runtimeZip = options['runtime-zip'], extra = {}) {
  const previous = path.join(work, 'previous-manifest.json');
  if (manifest) await fs.writeFile(previous, JSON.stringify(manifest));
  manifest = await publish({
    'app-id': 'com.example.myapp', version, 'runtime-version': runtimeVersion,
    'app-zip': artifacts.zip, 'runtime-zip': runtimeZip, platform: runtimePlatform, 'base-url': baseUrl, out: source,
    'signing-key': privateKeyPath, ...(manifest ? { 'previous-manifest': previous } : {}), ...extra,
  });
}
async function install(name, artifacts, appId = 'com.example.myapp', manifestPath = '/manifest.json') {
  const directory = path.join(work, name);
  await fs.mkdir(directory, { recursive: true });
  const executable = path.join(directory, launcherName);
  await fs.copyFile(options.shell, executable);
  if (process.platform !== 'win32') await fs.chmod(executable, 0o755);
  await fs.cp(artifacts.out, path.join(directory, 'resources'), { recursive: true });
  await fs.writeFile(path.join(directory, configName), `app_id = ${JSON.stringify(appId)}\nrequired_runtime = ${JSON.stringify(options['runtime-version'])}\napp_version = "1.0.0"\nmanifest_url = ${JSON.stringify(baseUrl + manifestPath)}\nallow_localhost_http = true\nmanifest_public_key = ${JSON.stringify(publicKeyBase64)}\n`);
  const updates = process.platform === 'win32' ? path.join(directory, 'updates')
    : (await run(executable, ['--state-dir'])).stdout.trim();
  assert(path.isAbsolute(updates), 'launcher must report an absolute state directory');
  return { directory, executable, updates, pending: path.join(updates, 'pending.json'), active: path.join(updates, 'active.json') };
}
const runtimePath = (root, version) => path.join(root, 'versions', runtimePlatform, `v${version}`);
const requestCount = version => requests.filter(url => url.startsWith(`/electron-v${version}-`)).length;
let appA, appB, appC;
try {
  await check('prepare pure application fixtures and signed local update source', async () => {
    for (const entry of ['main.js', 'preload.js', 'renderer', 'package.json', 'package-lock.json']) {
      await fs.cp(path.join(repo, 'app', entry), path.join(appSource, entry), { recursive: true });
    }
    const baseline = await buildApplication('1.0.0'); report.baseline = baseline;
    await publishVersion('1.0.0', baseline);
    appA = await install('app-A', baseline); appB = await install('app-B', baseline);
    appC = await install('app-C', baseline, 'com.example.other', '/other-manifest.json');
    const files = await fs.readdir(appA.directory, { recursive: true });
    assert(!files.some(file => /(^|[\\/])electron\.exe$/.test(file)));
  });
  await check('tampered signed manifest fails before runtime installation', async () => {
    const invalid = await install('invalid-signature', report.baseline);
    badSignature = true;
    const result = await run(invalid.executable, ['--headless', '--no-update'], {}, 1);
    badSignature = false;
    assert.match(result.stderr, /signature|verify|verification/i);
    assert.equal(await exists(path.join(runtimePath(cache, options['runtime-version']), 'install.json')), false);
  });
  await check('Slint first-install UI downloads exact runtime and launches real page, preload and IPC', async () => {
    const value = smoke(await run(appA.executable, ['--no-update']));
    assert.equal(value.electron, options['runtime-version']); assert.equal(value.appVersion, '1.0.0');
    assert.equal(requestCount(options['runtime-version']), 1);
    assert(await exists(path.join(runtimePath(cache, options['runtime-version']), 'install.json')));
  });
  await check('offline repeated launch performs no network request', async () => {
    const before = requests.length, started = Date.now();
    smoke(await run(appA.executable, ['--offline']));
    assert.equal(requests.length, before);
    report.offlineStartupMilliseconds = Date.now() - started;
  });
  if (process.platform === 'darwin') {
    await check('branded macOS bundle launches its renderer with shared frameworks and private helpers', async () => {
      const bundle = path.join(work, 'myapp.app');
      const contents = path.join(bundle, 'Contents');
      const macos = path.join(contents, 'MacOS');
      const executable = path.join(macos, 'myapp');
      await fs.mkdir(macos, { recursive: true });
      await fs.copyFile(options.shell, executable);
      await fs.chmod(executable, 0o755);
      await fs.copyFile(path.join(appA.directory, configName), path.join(macos, configName));
      await fs.cp(report.baseline.out, path.join(contents, 'Resources'), { recursive: true });
      await fs.writeFile(path.join(contents, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>myapp</string><key>CFBundleName</key><string>myapp</string><key>CFBundleIdentifier</key><string>com.example.myapp</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1.0.0</string><key>CFBundleShortVersionString</key><string>1.0.0</string></dict></plist>');
      const before = (await fs.readdir(bundle, { recursive: true })).sort();
      const requestsBefore = requests.length;
      const value = smoke(await run(executable, ['--offline'], { ELECTRON_ENABLE_LOGGING: '1' }), false);
      assert.equal(value.appVersion, '1.0.0');
      assert.equal(value.electron, options['runtime-version']);
      assert.equal(requests.length, requestsBefore);
      assert.deepEqual((await fs.readdir(bundle, { recursive: true })).sort(), before, 'launch must not write state into the installed bundle');
      const updates = (await run(executable, ['--state-dir'])).stdout.trim();
      const hosts = await fs.readdir(path.join(updates, 'mac-hosts'), { recursive: true });
      assert(hosts.some(name => name.endsWith('myapp Helper.app/Contents/Info.plist')));
      const frameworkName = hosts.find(name => name.endsWith('myapp.app/Contents/Frameworks/Electron Framework.framework'));
      assert(frameworkName);
      const hostFramework = path.join(updates, 'mac-hosts', frameworkName);
      assert((await fs.lstat(hostFramework)).isDirectory(), 'the Electron framework must have a host-local directory');
      const [hostFile, sharedFile] = await Promise.all([
        fs.stat(path.join(hostFramework, 'Electron Framework'), { bigint: true }),
        fs.stat(path.join(runtimePath(cache, options['runtime-version']), 'Electron.app/Contents/Frameworks/Electron Framework.framework/Electron Framework'), { bigint: true }),
      ]);
      assert.equal(hostFile.dev, sharedFile.dev);
      assert.equal(hostFile.ino, sharedFile.ino, 'framework files must share storage with the runtime');
      const hostExecutable = path.join(path.dirname(path.dirname(hostFramework)), 'MacOS/myapp');
      const firstHost = await fs.stat(hostExecutable, { bigint: true });
      assert.equal(smoke(await run(executable, ['--offline']), false).appVersion, '1.0.0');
      const reusedHost = await fs.stat(hostExecutable, { bigint: true });
      assert.equal(reusedHost.ino, firstHost.ino, 'repeated launch must reuse the signed host');
      assert.equal(reusedHost.birthtimeNs, firstHost.birthtimeNs, 'repeated launch must not recreate the signed host');
      await run(executable, ['--uninstall']);
      assert.equal(await exists(updates), false, 'uninstall must remove the private host state');
      assert(await exists(runtimePath(cache, options['runtime-version'])), 'other installations must retain the shared runtime');
    });
  }
  await check('real native addon loads from unpacked resources in exact shared Electron', async () => {
    if (!options['native-asar']) {
      const nativeSource = path.join(work, 'native-source');
      await fs.mkdir(nativeSource, { recursive: true });
      for (const entry of ['main.js', 'preload.js', 'renderer']) await fs.cp(path.join(repo, 'app', entry), path.join(nativeSource, entry), { recursive: true });
      for (const entry of ['package.json', 'package-lock.json']) await fs.copyFile(path.join(repo, 'scripts/fixtures/native', entry), path.join(nativeSource, entry));
      const mainPath = path.join(nativeSource, 'main.js');
      const main = await fs.readFile(mainPath, 'utf8');
      const probe = `const nativeBinding = require('bufferutil');\nconst input = Buffer.from('electron-native-fixture');\nconst key = Buffer.from([1,2,3,4]);\nconst masked = Buffer.alloc(input.length);\nnativeBinding.mask(input,key,masked,0,input.length);\nnativeBinding.unmask(masked,key);\nconst nativeProbe = {isNative:nativeBinding.mask.toString().includes('[native code]'),roundTrip:input.equals(masked)};\n`;
      await fs.writeFile(mainPath, probe + main.replace('ipc: true,', 'ipc: true, nativeProbe,'));
      const nativeOut = path.join(work, 'native-resources');
      const packed = await run(process.execPath, [path.join(repo, 'app/scripts/pack-asar.js'), '--source', nativeSource, '--runtime-version', options['runtime-version'], '--version', '1.0.0', '--out', nativeOut], {}, 0, 300_000);
      await fs.writeFile(path.join(work, 'native-pack.log'), packed.stdout + packed.stderr);
      options['native-asar'] = path.join(nativeOut, 'app.asar');
    }
    const native = await install('native-app', report.baseline);
    await fs.copyFile(options['native-asar'], path.join(native.directory, 'resources/app.asar'));
    await fs.cp(options['native-asar'] + '.unpacked', path.join(native.directory, 'resources/app.asar.unpacked'), { recursive: true });
    const value = smoke(await run(native.executable, ['--offline']));
    assert.equal(value.electron, options['runtime-version']);
    assert.equal(value.nativeProbe.isNative, true); assert.equal(value.nativeProbe.roundTrip, true);
    await run(native.executable, ['--uninstall']);
  });
  await check('two installs of same app id and another app share one runtime', async () => {
    smoke(await run(appB.executable, ['--headless', '--no-update']));
    smoke(await run(appC.executable, ['--headless', '--no-update']));
    assert.equal(requestCount(options['runtime-version']), 1);
    const refs = JSON.parse(await fs.readFile(path.join(cache, 'refs.json'), 'utf8'));
    assert.equal(Object.values(refs.map)[0].length, 3);
  });
  await check('uninstalling one application preserves other installations', async () => {
    await run(appA.executable, ['--uninstall']);
    assert(await exists(runtimePath(cache, options['runtime-version'])));
    smoke(await run(appB.executable, ['--offline']));
  });
  const next = await buildApplication('1.1.0');
  await publishVersion('1.1.0', next);
  await check('background update only stages while current release keeps running', async () => {
    const beforeHash = await hashFile(path.join(appB.directory, 'resources/app.asar'));
    const running = launch(appB.executable, ['--headless'], { ERS_SMOKE_HOLD_MS: '5000' });
    await waitFor(() => exists(appB.pending), 'background update did not become pending');
    assert.equal(await hashFile(path.join(appB.directory, 'resources/app.asar')), beforeHash);
    assert.equal(await exists(appB.active), false);
    assert.equal(smoke(await running.done).appVersion, '1.0.0');
  });
  await check('next offline startup activates full asar and unpacked release', async () => {
    const value = smoke(await run(appB.executable, ['--offline']));
    assert.equal(value.appVersion, '1.1.0');
    const state = JSON.parse(await fs.readFile(appB.active, 'utf8'));
    assert.equal(state.active.app_version, '1.1.0');
    assert.equal(await fs.readFile(path.join(state.active.resources_dir, 'app.asar.unpacked/ffi/version.txt'), 'utf8'), '1.1.0');
  });
  const failed = await buildApplication('1.2.0');
  await publishVersion('1.2.0', failed);
  await check('failed upgraded application propagates exit code and rolls back complete release', async () => {
    await run(appB.executable, ['--check-update']);
    await run(appB.executable, ['--offline'], { MYAPP_FAIL_START: '1' }, 42);
    const state = JSON.parse(await fs.readFile(appB.active, 'utf8'));
    assert.equal(state.active.app_version, '1.1.0');
    assert.equal(await fs.readFile(path.join(state.active.resources_dir, 'app.asar.unpacked/ffi/version.txt'), 'utf8'), '1.1.0');
    assert.equal(smoke(await run(appB.executable, ['--offline'])).appVersion, '1.1.0');
  });
  await check('invalid application artifact hash leaves active release intact', async () => {
    const valid = manifest;
    manifest = signManifest({ ...manifest, app: { ...manifest.app, asar: { ...manifest.app.asar, sha256: '0'.repeat(64) } } }, privateKey);
    const result = await run(appB.executable, ['--check-update'], {}, 1);
    assert.match(result.stderr, /hash|sha256|SHA256/i);
    assert.equal(JSON.parse(await fs.readFile(appB.active, 'utf8')).active.app_version, '1.1.0');
    manifest = valid;
  });
  const runtimeUpgrade = await buildApplication('2.0.0');
  await publishVersion('2.0.0', runtimeUpgrade, options['upgrade-runtime-version'], options['upgrade-runtime-zip']);
  await check('runtime upgrade installs precise second version and preserves rollback runtime', async () => {
    await run(appB.executable, ['--check-update']);
    const value = smoke(await run(appB.executable, ['--offline']));
    assert.equal(value.appVersion, '2.0.0'); assert.equal(value.electron, options['upgrade-runtime-version']);
    assert(await exists(runtimePath(cache, options['runtime-version'])));
    assert(await exists(runtimePath(cache, options['upgrade-runtime-version'])));
  });
  await check('concurrent first installs serialize runtime download and refs', async () => {
    const d = await install('app-D', report.baseline), e = await install('app-E', report.baseline);
    const before = requestCount(options['runtime-version']);
    await Promise.all([d, e].map(app => run(app.executable, ['--headless', '--no-update'], { ELECTRON_RUNTIME_ROOT: cache2 }).then(smoke)));
    assert.equal(requestCount(options['runtime-version']) - before, 1);
    const refs = JSON.parse(await fs.readFile(path.join(cache2, 'refs.json'), 'utf8'));
    assert.equal(Object.values(refs.map)[0].length, 2);
    await run(d.executable, ['--uninstall'], { ELECTRON_RUNTIME_ROOT: cache2 });
    assert(await exists(runtimePath(cache2, options['runtime-version'])));
    await run(e.executable, ['--uninstall'], { ELECTRON_RUNTIME_ROOT: cache2 });
    assert.equal(await exists(runtimePath(cache2, options['runtime-version'])), false);
  });
  await check('live Electron lease protects runtime after launcher is killed and deferred GC retries', async () => {
    const orphan = await install('app-orphan', report.baseline);
    const running = launch(orphan.executable, ['--headless', '--no-update'], { ELECTRON_RUNTIME_ROOT: cache2, ERS_SMOKE_HOLD_MS: '6000' });
    await waitFor(() => running.record.stdout.includes('SMOKE:'), 'orphan fixture did not reach real UI readiness');
    // Kill only the launcher; the detached Electron child must keep its lease alive until it exits.
    running.child.kill(); await running.done;
    await run(orphan.executable, ['--uninstall'], { ELECTRON_RUNTIME_ROOT: cache2 });
    assert(await exists(runtimePath(cache2, options['runtime-version'])));
    await waitFor(async () => {
      await run(orphan.executable, ['--uninstall'], { ELECTRON_RUNTIME_ROOT: cache2 });
      return !await exists(runtimePath(cache2, options['runtime-version']));
    }, 'deferred runtime GC did not complete after the real Electron process exited', 45_000);
  });
  await check('corrupt registry is reported without deleting a valid runtime', async () => {
    const registry = path.join(cache, 'refs.json');
    const original = await fs.readFile(registry);
    await fs.writeFile(registry, '{broken');
    const result = await run(appC.executable, ['--uninstall'], {}, 1);
    assert.match(result.stderr, /parse|reference|registry/i);
    assert(await exists(runtimePath(cache, options['runtime-version'])));
    await fs.writeFile(registry, original);
  });
  await check('interrupted runtime download resumes verified partial bytes on retry', async () => {
    const interrupted = await install('app-interrupted', report.baseline);
    const isolated = path.join(work, 'interrupted-cache');
    truncateNextRuntime = true;
    const first = await run(interrupted.executable, ['--headless', '--no-update'], { ELECTRON_RUNTIME_ROOT: isolated }, 1);
    assert.match(first.stderr, /read|incomplete|response|body/i);
    assert.equal(await exists(path.join(runtimePath(isolated, options['runtime-version']), 'install.json')), false);
    const before = rangedRequests;
    smoke(await run(interrupted.executable, ['--headless', '--no-update'], { ELECTRON_RUNTIME_ROOT: isolated }));
    assert(rangedRequests > before, 'retry did not issue a Range request');
    await run(interrupted.executable, ['--uninstall'], { ELECTRON_RUNTIME_ROOT: isolated });
  });
  await check('interrupted activation recovers previous complete release on next startup', async () => {
    const interrupted = await install('app-recovery', report.baseline);
    await run(interrupted.executable, ['--check-update']);
    assert.equal(smoke(await run(interrupted.executable, ['--offline'])).appVersion, '2.0.0');
    const transactionPath = path.join(interrupted.updates, 'transaction.json');
    const tx = JSON.parse(await fs.readFile(transactionPath, 'utf8'));
    tx.phase = 'awaiting_health'; tx.attempt_pid = 2147483647; tx.attempt_start_time = null; tx.exit_code = null;
    await fs.rm(tx.ready_file, { force: true });
    await fs.writeFile(transactionPath, JSON.stringify(tx));
    assert.equal(smoke(await run(interrupted.executable, ['--offline'])).appVersion, '1.0.0');
    assert.equal(JSON.parse(await fs.readFile(interrupted.active, 'utf8')).active.runtime_key.version, options['runtime-version']);
    await run(interrupted.executable, ['--uninstall']);
  });
  await check('independent copier installs a genuine newer launcher and restarts it', async () => {
    const expectedVersion = (await run(options['new-shell'], ['--version'])).stdout.trim();
    const oldVersion = (await run(appB.executable, ['--version'])).stdout.trim();
    assert.notEqual(expectedVersion, oldVersion);
    await publishVersion('2.0.0', runtimeUpgrade, options['upgrade-runtime-version'], options['upgrade-runtime-zip'], { shell: options.shell, 'shell-version': expectedVersion, 'min-shell-version': expectedVersion });
    const invalid = await run(appB.executable, ['--check-update'], {}, 1);
    assert.match(invalid.stderr, /shell version does not match|version check/i);
    assert.equal((await run(appB.executable, ['--version'])).stdout.trim(), oldVersion);
    await publishVersion('2.0.0', runtimeUpgrade, options['upgrade-runtime-version'], options['upgrade-runtime-zip'], { shell: options['new-shell'], 'shell-version': expectedVersion, 'min-shell-version': expectedVersion });
    const restartedSmoke = path.join(work, 'restarted-smoke.json');
    await run(appB.executable, ['--check-update'], { ERS_SMOKE_RESULT_FILE: restartedSmoke });
    const expectedHash = await hashFile(options['new-shell']);
    await waitFor(async () => { try { return await hashFile(appB.executable) === expectedHash; } catch { return false; } }, 'copier did not install the new launcher', 60_000);
    assert.equal((await run(appB.executable, ['--version'])).stdout.trim(), expectedVersion);
    await waitFor(async () => {
      const files = await fs.readdir(path.join(appB.updates, 'staging'));
      return !files.some(file => file.endsWith('.ticket.json'));
    }, 'copier did not finish restart handoff');
    await waitFor(() => exists(restartedSmoke), 'updated launcher did not restart a healthy application', 90_000);
    const restarted = JSON.parse(await fs.readFile(restartedSmoke, 'utf8'));
    assert.equal(restarted.appVersion, '2.0.0'); assert.equal(restarted.ipc, true);
    assert.equal(restarted.electron, options['upgrade-runtime-version']);
  });
  await check('final uninstall removes only runtimes whose final references are gone', async () => {
    await waitFor(async () => {
      const result = await launch(appB.executable, ['--uninstall']).done;
      if (result.code === 0) return true;
      if (result.stderr.includes('already running')) return false;
      throw new Error(result.stderr);
    }, 'restarted app did not release its installation', 90_000);
    assert.equal(await exists(runtimePath(cache, options['upgrade-runtime-version'])), false);
    assert(await exists(runtimePath(cache, options['runtime-version'])));
    await run(appC.executable, ['--uninstall']);
    assert.equal(await exists(runtimePath(cache, options['runtime-version'])), false);
  });
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack; console.error(error.stack); process.exitCode = 1;
} finally {
  for (const child of ownedProcesses) terminateOwnedTree(child);
  await new Promise(resolve => server.close(resolve));
  report.finished = new Date().toISOString(); report.requests = requests;
  if (!report.passed) {
    report.processes = processRecords.map(record => ({ ...record, stdout: record.stdout.slice(-16000), stderr: record.stderr.slice(-16000) }));
    if (process.platform === 'darwin') {
      report.crashes = [];
      for (const directory of [path.join(os.homedir(), 'Library/Logs/DiagnosticReports'), '/Library/Logs/DiagnosticReports']) {
        for (const name of await fs.readdir(directory).catch(() => [])) {
          if (!/\.(ips|crash)$/.test(name)) continue;
          const filename = path.join(directory, name);
          const metadata = await fs.stat(filename).catch(() => null);
          if (!metadata?.isFile() || metadata.mtimeMs < Date.parse(report.started) || metadata.size > 2 * 1024 * 1024) continue;
          const contents = await fs.readFile(filename, 'utf8').catch(() => '');
          if (contents.includes(path.basename(work))) report.crashes.push({ name, contents: contents.slice(0, 60000) });
          if (report.crashes.length >= 8) break;
        }
      }
    }
    report.runtimeFiles = [];
    for (const relative of await fs.readdir(cache, { recursive: true }).catch(() => [])) {
      const metadata = await fs.stat(path.join(cache, relative)).catch(() => null);
      if (metadata?.isFile()) report.runtimeFiles.push({ path: relative, bytes: metadata.size });
    }
  }
  await fs.mkdir(path.dirname(path.resolve(options.report)), { recursive: true });
  await fs.writeFile(options.report, JSON.stringify(report, null, 2));
  console.log(`REPORT ${path.resolve(options.report)}`);
  console.log(`FIXTURES ${work}`);
}
