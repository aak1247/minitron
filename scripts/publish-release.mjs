import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Manifest numbers must be safe integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('Unsupported manifest value');
}

export function signingBytes(manifest) {
  const { signature, ...unsigned } = manifest;
  return Buffer.from(canonicalJson(unsigned), 'utf8');
}

export function signManifest(manifest, privateKey) {
  return { ...manifest, signature: sign(null, signingBytes(manifest), privateKey).toString('base64') };
}

export function verifyManifest(manifest, publicKey) {
  return typeof manifest.signature === 'string'
    && verify(null, signingBytes(manifest), publicKey, Buffer.from(manifest.signature, 'base64'));
}

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const data of createReadStream(file)) hash.update(data);
  return hash.digest('hex');
}

function argumentsOf(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Expected --option value near ${args[i]}`);
    values[args[i].slice(2)] = args[i + 1];
  }
  return values;
}

export async function publish(options) {
  for (const key of ['app-id', 'version', 'runtime-version', 'app-zip', 'runtime-zip', 'base-url', 'out']) {
    if (!options[key]) throw new Error(`Missing --${key}`);
  }
  for (const value of [options.version, options['runtime-version'], options['shell-version']].filter(Boolean)) {
    if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`Expected exact stable x.y.z version: ${value}`);
  }
  const platform = options.platform || `${process.platform}-${process.arch}`;
  if (!/^(win32-(x64|arm64|ia32)|linux-(x64|arm64|armv7l)|darwin-(x64|arm64))$/.test(platform)) throw new Error(`Unsupported platform ${platform}`);
  const base = new URL(options['base-url']);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) throw new Error('Use HTTPS or a loopback HTTP test source');
  const out = path.resolve(options.out);
  await fs.mkdir(out, { recursive: true });
  async function artifact(source, prefix, extension) {
    const absolute = path.resolve(source);
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size === 0) throw new Error(`Missing or empty artifact ${source}`);
    const sha256 = await hashFile(absolute);
    const name = `${prefix}-${sha256.slice(0, 16)}.${extension}`;
    const destination = path.join(out, name);
    if (absolute !== destination) await fs.copyFile(absolute, destination);
    return { url: `${base.href.replace(/\/$/, '')}/${name}`, sha256, size: stat.size };
  }
  const runtime = {
    version: options['runtime-version'],
    platforms: { [platform]: await artifact(options['runtime-zip'], `electron-v${options['runtime-version']}-${platform}`, 'zip') },
  };
  const catalog = options['previous-manifest'] ? JSON.parse(await fs.readFile(options['previous-manifest'], 'utf8')) : null;
  if (catalog && catalog.app_id !== options['app-id']) throw new Error('Previous manifest belongs to another application');
  const runtimes = [...(catalog?.runtimes || []), ...(catalog?.runtime ? [catalog.runtime] : [])]
    .filter((entry, index, all) => entry.version !== runtime.version && all.findIndex(other => other.version === entry.version) === index);
  let manifest = {
    app_id: options['app-id'], channel: options.channel || 'stable', runtime, runtimes,
    app: {
      version: options.version,
      asar: await artifact(options['app-zip'], `app-${options.version}-${platform}`, 'zip'),
      min_stub_version: options['min-shell-version'] || '0.1.0',
      release_notes: options.notes || '',
    },
    signature: null,
  };
  if (options.shell) {
    if (!options['shell-version']) throw new Error('--shell requires --shell-version');
    manifest.shell = { version: options['shell-version'], platforms: { [platform]: await artifact(options.shell, `shell-${options['shell-version']}-${platform}`, process.platform === 'win32' ? 'exe' : 'bin') } };
  }
  if (options['signing-key']) {
    const privateKey = createPrivateKey(await fs.readFile(options['signing-key']));
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Signing key must be Ed25519');
    manifest = signManifest(manifest, privateKey);
    const rawKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
    await fs.writeFile(path.join(out, 'public-key.txt'), rawKey.toString('base64') + '\n');
  }
  const destination = path.join(out, 'manifest.json');
  await fs.writeFile(destination + '.tmp', JSON.stringify(manifest, null, 2) + '\n');
  await fs.rename(destination + '.tmp', destination);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publish(argumentsOf(process.argv.slice(2))).then(m => console.log(JSON.stringify(m, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
