import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildApplication,
  defaultAppId,
  parseArgs,
  renderConfig,
  validAppId,
  validateManifestUrl,
  validatePublicKey,
} from './build-app.mjs';

test('build CLI requires a prebuilt launcher, app source, output, runtime, and manifest URL', () => {
  assert.throws(() => parseArgs([]), /Missing required option --source/);
  const options = parseArgs([
    '--source', './fixture-app',
    '--launcher', './minitron',
    '--out', './dist',
    '--runtime-version', '32.2.0',
    '--manifest-url', 'https://example.com/manifest.json',
    '--allow-localhost-http',
  ]);
  assert.equal(options['runtime-version'], '32.2.0');
  assert.equal(options['allow-localhost-http'], true);
  assert.throws(() => parseArgs([
    '--source', 'app', '--launcher', 'minitron', '--out', 'dist',
    '--runtime-version', '32', '--manifest-url', 'https://example.com/manifest.json',
  ]), /exact x\.y\.z version/);
});

test('application ID defaults follow package names and custom IDs are validated', () => {
  assert.equal(defaultAppId('myapp'), 'com.example.myapp');
  assert.equal(defaultAppId('@acme/desktop-tool'), 'com.acme.desktop-tool');
  assert.equal(defaultAppId('org.example.myapp'), 'org.example.myapp');
  assert.equal(validAppId('../outside'), false);
});

test('manifest URLs allow HTTPS and explicitly enabled loopback HTTP only', () => {
  assert.equal(validateManifestUrl('https://updates.example.com/manifest.json'), 'https://updates.example.com/manifest.json');
  assert.equal(validateManifestUrl('http://127.0.0.1:8787/manifest.json', true), 'http://127.0.0.1:8787/manifest.json');
  assert.equal(validateManifestUrl('http://[::1]:8787/manifest.json', true), 'http://[::1]:8787/manifest.json');
  assert.throws(() => validateManifestUrl('http://updates.example.com/manifest.json', true), /loopback host/);
  assert.throws(() => validateManifestUrl('http://localhost/manifest.json'), /loopback host/);
});

test('configuration TOML quotes values and validates an Ed25519 public key', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  validatePublicKey(key);
  assert.throws(() => validatePublicKey('not-base64'), /32-byte Ed25519/);
  assert.equal(renderConfig({
    appId: 'com.acme.myapp',
    appVersion: '1.2.3',
    runtimeVersion: '32.2.0',
    manifestUrl: 'https://example.com/manifest.json?q="quoted"',
    allowLocalhostHttp: false,
    manifestPublicKey: key,
  }), [
    'app_id = "com.acme.myapp"',
    'required_runtime = "32.2.0"',
    'app_version = "1.2.3"',
    'manifest_url = "https://example.com/manifest.json?q=\\"quoted\\""',
    'allow_localhost_http = false',
    `manifest_public_key = "${key}"`,
    '',
  ].join('\n'));
});

test('fixture build stages only the mock launcher and app ASAR resources, plus an app-only ZIP', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minitron-build-app-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source-app');
  const launcher = path.join(root, 'prebuilt-minitron');
  const out = path.join(root, 'release');
  fs.mkdirSync(path.join(source, 'src'), { recursive: true });
  fs.mkdirSync(path.join(source, 'node_modules', 'electron'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
    name: '@acme/desktop-tool', version: '2.3.4', main: 'src/main.js',
  }));
  fs.writeFileSync(path.join(source, 'package-lock.json'), JSON.stringify({ name: '@acme/desktop-tool', packages: { '': { version: '2.3.4' } } }));
  fs.writeFileSync(path.join(source, 'src', 'main.js'), '// fixture entry\n');
  fs.writeFileSync(path.join(source, 'node_modules', 'electron', 'electron'), 'runtime must not be copied');
  fs.writeFileSync(launcher, Buffer.from('mock native launcher'));

  const staleResources = path.join(out, 'application', 'resources');
  fs.mkdirSync(path.join(staleResources, 'app.asar.unpacked'), { recursive: true });
  fs.writeFileSync(path.join(staleResources, 'app.asar'), 'stale archive');
  fs.writeFileSync(path.join(staleResources, 'app.asar.unpacked', 'obsolete.bin'), 'stale unpacked data');

  let packagerArgs;
  const result = await buildApplication(buildOptions({ source, launcher, out }), {
    runPackager: async (args) => {
      packagerArgs = args;
      fs.mkdirSync(path.join(args.resourcesDir, 'app.asar.unpacked', 'native'), { recursive: true });
      fs.writeFileSync(path.join(args.resourcesDir, 'app.asar'), 'fixture app ASAR');
      fs.writeFileSync(path.join(args.resourcesDir, 'app.asar.unpacked', 'native', 'binding.node'), Buffer.from([1, 2, 3]));
      fs.writeFileSync(args.zipPath, 'fixture app-only update ZIP');
    },
  });

  assert.equal(packagerArgs.appVersion, '2.3.4');
  assert.equal(packagerArgs.runtimeVersion, '32.2.0');
  assert.equal(result.appId, 'com.acme.desktop-tool');
  assert.equal(result.zip, packagerArgs.zipPath);
  const appFiles = listFiles(result.application).sort();
  const launcherName = process.platform === 'win32' ? 'minitron.exe' : 'minitron';
  assert.deepEqual(appFiles, [
    launcherName,
    'minitron.toml',
    'resources/app.asar',
    'resources/app.asar.unpacked/native/binding.node',
  ].sort());
  assert.deepEqual(fs.readFileSync(path.join(result.application, launcherName)), Buffer.from('mock native launcher'));
  assert.equal(fs.readFileSync(path.join(result.application, 'resources', 'app.asar'), 'utf8'), 'fixture app ASAR');
  assert.deepEqual(
    fs.readFileSync(path.join(result.application, 'resources', 'app.asar.unpacked', 'native', 'binding.node')),
    Buffer.from([1, 2, 3]),
  );
  assert.equal(fs.existsSync(path.join(result.application, 'resources', 'app.asar.unpacked', 'obsolete.bin')), false);
  assert.equal(fs.readFileSync(result.zip, 'utf8'), 'fixture app-only update ZIP');
  assert.equal(fs.readFileSync(path.join(result.application, 'minitron.toml'), 'utf8').includes('app_id = "com.acme.desktop-tool"'), true);
  assert.equal(fs.existsSync(path.join(result.application, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(result.application, 'electron')), false);
  assert.equal(fs.existsSync(path.join(result.application, path.basename(result.zip))), false);

  fs.writeFileSync(path.join(result.application, 'electron.exe'), 'stale runtime must not be retained');
  let rebuilt = false;
  await assert.rejects(buildApplication(buildOptions({ source, launcher, out }), {
    runPackager: async () => { rebuilt = true; },
  }), /Unexpected entry in application output: electron\.exe/);
  assert.equal(rebuilt, false);
});

test('invalid app IDs fail before invoking the packager', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minitron-build-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'fixture-app', version: '1.0.0' }));
  fs.writeFileSync(path.join(source, 'package-lock.json'), '{}');
  const launcher = path.join(root, 'minitron');
  fs.writeFileSync(launcher, 'mock launcher');
  let invoked = false;
  await assert.rejects(buildApplication(buildOptions({
    source, launcher, out: path.join(root, 'release'), 'app-id': 'bad/id',
  }), { runPackager: async () => { invoked = true; } }), /reverse-DNS/);
  assert.equal(invoked, false);
});

function buildOptions(overrides = {}) {
  return {
    source: './app',
    launcher: './minitron',
    out: './dist',
    'runtime-version': '32.2.0',
    'manifest-url': 'https://updates.example.com/manifest.json',
    ...overrides,
  };
}

function listFiles(root, relative = '') {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name);
    return entry.isDirectory() ? listFiles(root, child) : [child.replaceAll(path.sep, '/')];
  });
}
