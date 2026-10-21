import fs from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const [operation, ...argv] = process.argv.slice(2);
const options = Object.fromEntries(Array.from({ length: argv.length / 2 }, (_, i) => [argv[i * 2].replace(/^--/, ''), argv[i * 2 + 1]]));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const keyText = options['key-file'] ? (await fs.readFile(options['key-file'], 'utf8').catch(error => {
  if (operation === 'create' && error.code === 'ENOENT') return '';
  throw error;
})).trim() : process.env.MINITRON_KARVIS_SNAPSHOT_KEY;
if (keyText && !/^[0-9a-f]{64}$/i.test(keyText)) throw new Error('Snapshot key must be 32 bytes encoded as hex');
let key = keyText ? Buffer.from(keyText, 'hex') : null;

if (operation === 'create') {
  if (!options.project || !options.out || !options['key-file']) throw new Error('create requires --project, --out and --key-file');
  if (!key) {
    key = randomBytes(32);
    await fs.mkdir(path.dirname(path.resolve(options['key-file'])), { recursive: true });
    await fs.writeFile(options['key-file'], key.toString('hex'), { mode: 0o600, flag: 'wx' });
  }
  const project = path.resolve(options.project);
  const files = [];
  const rootFiles = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.main.json', 'vite.config.ts', 'vite.config.js', 'postcss.config.js', 'postcss.config.cjs', 'tailwind.config.js', 'tailwind.config.cjs'];
  async function capture(relative, optional = false) {
    const filename = path.join(project, relative);
    const stat = await fs.lstat(filename).catch(() => null);
    if (!stat && optional) return;
    if (!stat) throw new Error(`Missing snapshot input: ${relative}`);
    if (stat.isSymbolicLink()) throw new Error(`Snapshot inputs cannot be symbolic links: ${relative}`);
    if (stat.isDirectory()) {
      for (const entry of (await fs.readdir(filename)).sort()) await capture(path.join(relative, entry));
    } else if (stat.isFile()) {
      const contents = await fs.readFile(filename);
      files.push({ path: relative.replaceAll('\\', '/'), mode: stat.mode & 0o777, sha256: digest(contents), data: contents.toString('base64') });
    }
  }
  for (const name of rootFiles) await capture(name, !['package.json', 'package-lock.json'].includes(name));
  for (const name of ['src', 'assets', 'renderer']) await capture(name, true);
  const snapshot = { schema: 1, files };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const payload = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(snapshot)))), cipher.final()]);
  await fs.mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
  await fs.writeFile(options.out, Buffer.concat([Buffer.from('MKS1'), iv, cipher.getAuthTag(), payload]));
  for (const file of files) {
    if (digest(await fs.readFile(path.join(project, file.path))) !== file.sha256) throw new Error(`Source changed during capture: ${file.path}`);
  }
  console.log(`Encrypted ${files.length} build input files; original files unchanged.`);
} else if (operation === 'extract') {
  if (!key || !options.input || !options.out) throw new Error('extract requires --input, --out and a snapshot key');
  const contents = await fs.readFile(options.input);
  if (contents.subarray(0, 4).toString() !== 'MKS1') throw new Error('Invalid snapshot format');
  const decipher = createDecipheriv('aes-256-gcm', key, contents.subarray(4, 16));
  decipher.setAuthTag(contents.subarray(16, 32));
  const snapshot = JSON.parse(gunzipSync(Buffer.concat([decipher.update(contents.subarray(32)), decipher.final()]), { maxOutputLength: 64 * 1024 * 1024 }));
  if (snapshot.schema !== 1 || !Array.isArray(snapshot.files) || snapshot.files.length > 5000) throw new Error('Unsupported snapshot');
  const output = path.resolve(options.out);
  await fs.mkdir(output, { recursive: true });
  if ((await fs.readdir(output)).length) throw new Error('Snapshot destination must be empty');
  const seen = new Set();
  for (const file of snapshot.files) {
    const relative = String(file.path);
    const target = path.resolve(output, relative);
    if (!target.startsWith(output + path.sep) || relative.includes('\\') || relative.split('/').includes('..') || seen.has(target)) throw new Error('Unsafe snapshot member');
    seen.add(target);
    const bytes = Buffer.from(file.data, 'base64');
    if (digest(bytes) !== file.sha256) throw new Error('Snapshot member checksum mismatch');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: 'wx', mode: file.mode & 0o777 });
  }
  console.log(`Extracted ${snapshot.files.length} authenticated build input files.`);
} else {
  throw new Error('Usage: karvis-snapshot.mjs create|extract --project/--input PATH --out PATH --key-file PATH');
}
