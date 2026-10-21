import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { hashFile } from './publish-release.mjs';

const destination = path.resolve(process.argv[2] || 'dist/electron-zips');
await fs.mkdir(destination, { recursive: true });
const versions = process.argv[3]?.split(',') || ['32.2.0', '33.3.1'];
for (const version of versions) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid Electron version: ${version}`);
  const base = `https://github.com/electron/electron/releases/download/v${version}`;
  const name = `electron-v${version}-${process.platform}-${process.arch}.zip`;
  const checksumResponse = await fetch(`${base}/SHASUMS256.txt`);
  if (!checksumResponse.ok) throw new Error(`Checksums: HTTP ${checksumResponse.status}`);
  const entry = (await checksumResponse.text()).split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .find(parts => parts[1]?.replace(/^\*/, '') === name);
  if (!entry || !/^[0-9a-f]{64}$/i.test(entry[0])) throw new Error(`No official checksum for ${name}`);
  const archive = path.join(destination, name);
  const response = await fetch(`${base}/${name}`);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
  if (await hashFile(archive) !== entry[0].toLowerCase()) throw new Error(`Checksum mismatch: ${name}`);
  console.log(`Verified ${name}`);
}
