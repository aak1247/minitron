#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const PACK_ASAR = path.join(REPO_ROOT, 'app', 'scripts', 'pack-asar.js');
const APP_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?)+$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

const VALUE_OPTIONS = new Set([
  'source', 'launcher', 'out', 'runtime-version', 'manifest-url', 'app-id',
  'version', 'manifest-public-key',
]);

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      if (options.help) throw new Error('Option --help was specified more than once');
      options.help = true;
      continue;
    }
    if (token === '--allow-localhost-http') {
      if (options['allow-localhost-http']) throw new Error('Option --allow-localhost-http was specified more than once');
      options['allow-localhost-http'] = true;
      continue;
    }
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!VALUE_OPTIONS.has(key)) throw new Error(`Unknown option: ${token}`);
    if (options[key] !== undefined) throw new Error(`Option ${token} was specified more than once`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Option ${token} requires a value`);
    options[key] = value;
    index += 1;
  }

  if (options.help) return options;
  for (const key of ['source', 'launcher', 'out', 'runtime-version', 'manifest-url']) {
    if (!options[key]) throw new Error(`Missing required option --${key}`);
  }
  validateVersion(options['runtime-version'], 'runtime version');
  if (options.version !== undefined) validateVersion(options.version, 'application version');
  return options;
}

export function validateVersion(value, label) {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    throw new Error(`${label} must be an exact x.y.z version; received ${value}`);
  }
}

export function validAppId(value) {
  return typeof value === 'string' && APP_ID_PATTERN.test(value);
}

export function defaultAppId(packageName) {
  if (validAppId(packageName) && packageName.includes('.')) return packageName;
  const scoped = /^@([^/]+)\/([^/]+)$/.exec(packageName);
  const parts = scoped ? [scoped[1], scoped[2]] : ['example', packageName];
  const normalized = parts.map((part) => part
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '') || 'app');
  return `com.${normalized.join('.')}`;
}

function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === 'localhost.') return true;
  const family = isIP(host);
  if (family === 4) return host.startsWith('127.');
  return family === 6 && host === '::1';
}

export function validateManifestUrl(value, allowLocalhostHttp = false) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`--manifest-url must be an absolute HTTP(S) URL: ${value}`);
  }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname) {
    throw new Error('--manifest-url must use HTTPS, or loopback HTTP with --allow-localhost-http');
  }
  if (url.username || url.password) throw new Error('--manifest-url must not contain credentials');
  if (url.hash) throw new Error('--manifest-url must not contain a fragment');
  if (url.protocol === 'http:' && (!allowLocalhostHttp || !isLoopbackHost(url.hostname))) {
    throw new Error('HTTP manifest URLs require --allow-localhost-http and a loopback host');
  }
  return url.href;
}

export function validatePublicKey(value) {
  if (value === undefined) return;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('--manifest-public-key must be a base64-encoded 32-byte Ed25519 public key');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== value) {
    throw new Error('--manifest-public-key must be a base64-encoded 32-byte Ed25519 public key');
  }
}

export function renderConfig({ appId, appVersion, runtimeVersion, manifestUrl, allowLocalhostHttp, manifestPublicKey }) {
  const quote = (value) => JSON.stringify(value);
  const lines = [
    `app_id = ${quote(appId)}`,
    `required_runtime = ${quote(runtimeVersion)}`,
    `app_version = ${quote(appVersion)}`,
    `manifest_url = ${quote(manifestUrl)}`,
    `allow_localhost_http = ${allowLocalhostHttp ? 'true' : 'false'}`,
  ];
  if (manifestPublicKey !== undefined) lines.push(`manifest_public_key = ${quote(manifestPublicKey)}`);
  return `${lines.join('\n')}\n`;
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function pathsOverlap(first, second) {
  return isWithin(first, second) || isWithin(second, first);
}

function canonicalPath(candidate) {
  let current = path.resolve(candidate);
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return path.resolve(fs.realpathSync(current), ...suffix);
}

function validateExistingPath(pathname, label, expectedType) {
  let stat;
  try {
    stat = fs.lstatSync(pathname);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${pathname}`);
  if (expectedType === 'directory' && !stat.isDirectory()) throw new Error(`${label} must be a directory: ${pathname}`);
  if (expectedType === 'file' && !stat.isFile()) throw new Error(`${label} must be a regular file: ${pathname}`);
  return stat;
}

function assertArtifactTree(sourcePath) {
  const stat = validateExistingPath(sourcePath, 'pack-asar output', 'directory');
  if (!stat) return;
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    const entryPath = path.join(sourcePath, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not supported in application resources: ${entryPath}`);
    if (entry.isDirectory()) assertArtifactTree(entryPath);
    else if (!entry.isFile()) throw new Error(`Unsupported application resource: ${entryPath}`);
  }
}

function assertApplicationOutputShape(applicationDir, launcherName) {
  const applicationStat = validateExistingPath(applicationDir, 'application output directory', 'directory');
  if (!applicationStat) return;
  const allowedRootEntries = new Set([launcherName, 'minitron.toml', 'resources']);
  for (const entry of fs.readdirSync(applicationDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not supported in application output: ${entry.name}`);
    if (!allowedRootEntries.has(entry.name)) {
      throw new Error(`Unexpected entry in application output: ${entry.name}; use a clean --out directory`);
    }
  }

  const resourcesDir = path.join(applicationDir, 'resources');
  if (!fs.existsSync(resourcesDir)) return;
  validateExistingPath(resourcesDir, 'application resources directory', 'directory');
  const allowedResourceEntries = new Set(['app.asar', 'app.asar.unpacked']);
  for (const entry of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not supported in application resources: ${entry.name}`);
    if (!allowedResourceEntries.has(entry.name)) {
      throw new Error(`Unexpected entry in application resources: ${entry.name}; use a clean --out directory`);
    }
  }
  validateExistingPath(path.join(resourcesDir, 'app.asar'), 'application archive destination', 'file');
  validateExistingPath(path.join(resourcesDir, 'app.asar.unpacked'), 'application unpacked resources destination', 'directory');
}

function runPackAsar({ sourceDir, runtimeVersion, appVersion, resourcesDir, zipPath }) {
  const result = spawnSync(process.execPath, [
    PACK_ASAR,
    '--source', sourceDir,
    '--runtime-version', runtimeVersion,
    '--version', appVersion,
    '--out', resourcesDir,
    '--zip-out', zipPath,
  ], { cwd: REPO_ROOT, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Application ASAR build failed with exit code ${result.status ?? 'unknown'}`);
}

function copyFile(source, destination, label) {
  const destinationStat = validateExistingPath(destination, label, 'file');
  if (destinationStat) fs.rmSync(destination);
  fs.copyFileSync(source, destination);
}

function copyUnpacked(source, destination) {
  const existing = validateExistingPath(destination, 'application unpacked resources', 'directory');
  if (existing) fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true, errorOnExist: true });
}

function samePath(first, second) {
  const a = canonicalPath(first);
  const b = canonicalPath(second);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function buildApplication(options, { runPackager = runPackAsar } = {}) {
  const sourceDir = path.resolve(options.source);
  const launcherPath = path.resolve(options.launcher);
  const outDir = path.resolve(options.out);
  const sourceStat = validateExistingPath(sourceDir, '--source', 'directory');
  if (!sourceStat) throw new Error(`--source must be an existing directory: ${sourceDir}`);
  if (pathsOverlap(canonicalPath(sourceDir), canonicalPath(outDir))) {
    throw new Error('--out must be outside the --source directory and must not contain the --source directory');
  }

  const launcherStat = validateExistingPath(launcherPath, '--launcher', 'file');
  if (!launcherStat || launcherStat.size === 0) throw new Error(`--launcher must be a non-empty file: ${launcherPath}`);
  const manifestPath = path.join(sourceDir, 'package.json');
  const manifestStat = validateExistingPath(manifestPath, 'package.json', 'file');
  if (!manifestStat) throw new Error(`package.json is required in --source directory: ${sourceDir}`);
  let appManifest;
  try {
    appManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read application package.json: ${error.message}`);
  }
  if (!appManifest || typeof appManifest !== 'object' || Array.isArray(appManifest)) {
    throw new Error('Application package.json must contain a JSON object');
  }
  if (typeof appManifest.name !== 'string' || !appManifest.name.trim()) {
    throw new Error('Application package.json must have a non-empty name');
  }
  const appVersion = options.version || appManifest.version;
  validateVersion(appVersion, 'application version');
  const runtimeVersion = options['runtime-version'];
  validateVersion(runtimeVersion, 'runtime version');
  const appId = options['app-id'] || defaultAppId(appManifest.name);
  if (!validAppId(appId)) throw new Error(`--app-id must be a reverse-DNS identifier such as com.example.myapp: ${appId}`);
  const manifestUrl = validateManifestUrl(options['manifest-url'], Boolean(options['allow-localhost-http']));
  const manifestPublicKey = options['manifest-public-key'];
  validatePublicKey(manifestPublicKey);

  const lockPath = path.join(sourceDir, 'package-lock.json');
  if (!validateExistingPath(lockPath, 'package-lock.json', 'file')) {
    throw new Error(`package-lock.json is required in --source directory: ${sourceDir}`);
  }

  const applicationDir = path.join(outDir, 'application');
  const resourcesDir = path.join(outDir, 'resources');
  const zipPath = path.join(outDir, `app-${appVersion}-${process.platform}-${process.arch}-electron-${runtimeVersion}.zip`);
  const launcherName = process.platform === 'win32' ? 'minitron.exe' : 'minitron';
  const launcherDestination = path.join(applicationDir, launcherName);
  const archiveSource = path.join(resourcesDir, 'app.asar');
  const unpackedSource = path.join(resourcesDir, 'app.asar.unpacked');

  if (samePath(launcherPath, archiveSource) || samePath(launcherPath, zipPath)) {
    throw new Error('--launcher must not be one of the generated application artifacts');
  }
  if (fs.existsSync(outDir) && !fs.lstatSync(outDir).isDirectory()) throw new Error(`--out must be a directory: ${outDir}`);
  fs.mkdirSync(outDir, { recursive: true });
  validateExistingPath(applicationDir, 'application output directory', 'directory');
  validateExistingPath(resourcesDir, 'resources output directory', 'directory');
  validateExistingPath(archiveSource, 'app.asar output', 'file');
  validateExistingPath(unpackedSource, 'app.asar.unpacked output', 'directory');
  validateExistingPath(zipPath, 'application update ZIP output', 'file');
  assertApplicationOutputShape(applicationDir, launcherName);

  await runPackager({ sourceDir, runtimeVersion, appVersion, resourcesDir, zipPath });

  const archiveStat = validateExistingPath(archiveSource, 'app.asar output', 'file');
  if (!archiveStat || archiveStat.size === 0) throw new Error(`pack-asar did not produce a non-empty app.asar: ${archiveSource}`);
  const zipStat = validateExistingPath(zipPath, 'application update ZIP output', 'file');
  if (!zipStat || zipStat.size === 0) throw new Error(`pack-asar did not produce a non-empty application update ZIP: ${zipPath}`);
  if (fs.existsSync(unpackedSource)) assertArtifactTree(unpackedSource);

  fs.mkdirSync(applicationDir, { recursive: true });
  const applicationResources = path.join(applicationDir, 'resources');
  validateExistingPath(applicationResources, 'application resources directory', 'directory');
  fs.mkdirSync(applicationResources, { recursive: true });
  validateExistingPath(launcherDestination, 'application launcher destination', 'file');
  if (!samePath(launcherPath, launcherDestination)) copyFile(launcherPath, launcherDestination, 'application launcher destination');
  if (process.platform !== 'win32') fs.chmodSync(launcherDestination, launcherStat.mode & 0o777);
  copyFile(archiveSource, path.join(applicationResources, 'app.asar'), 'application archive destination');
  const applicationUnpacked = path.join(applicationResources, 'app.asar.unpacked');
  validateExistingPath(applicationUnpacked, 'application unpacked resources destination', 'directory');
  if (fs.existsSync(unpackedSource)) copyUnpacked(unpackedSource, applicationUnpacked);
  else if (fs.existsSync(applicationUnpacked)) fs.rmSync(applicationUnpacked, { recursive: true, force: true });
  const configPath = path.join(applicationDir, 'minitron.toml');
  validateExistingPath(configPath, 'application configuration destination', 'file');
  fs.writeFileSync(path.join(applicationDir, 'minitron.toml'), renderConfig({
    appId,
    appVersion,
    runtimeVersion,
    manifestUrl,
    allowLocalhostHttp: Boolean(options['allow-localhost-http']),
    manifestPublicKey,
  }), { encoding: 'utf8' });
  assertApplicationOutputShape(applicationDir, launcherName);

  return {
    application: applicationDir,
    resources: resourcesDir,
    zip: zipPath,
    appVersion,
    runtimeVersion,
    appId,
    platform: process.platform,
    arch: process.arch,
  };
}

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Error(`Node.js 22.12.0 or newer is required; found ${process.versions.node}`);
  }
}

export function showHelp() {
  console.log('Usage: node scripts/build-app.mjs --source <app> --launcher <prebuilt-minitron> --out <directory> --runtime-version <x.y.z> --manifest-url <url> [--app-id <reverse-dns-id>] [--version <x.y.z>] [--manifest-public-key <base64>] [--allow-localhost-http]');
  console.log('Builds application ASAR resources with app/scripts/pack-asar.js, then stages only minitron, minitron.toml, app.asar, and app.asar.unpacked. The app-only update ZIP is written beside application/.');
}

async function main(argv = process.argv.slice(2)) {
  assertNodeVersion();
  const options = parseArgs(argv);
  if (options.help) {
    showHelp();
    return;
  }
  const result = await buildApplication(options);
  console.log(`BUILD_APP_RESULT:${JSON.stringify(result)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
