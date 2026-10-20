import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, signManifest, verifyManifest, publish } from './publish-release.mjs';

test('canonical signatures are stable and reject tampering and different keys', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const other = generateKeyPairSync('ed25519');
  const m = { z: [{ b: 2, a: '汉字' }], a: true, signature: null };
  const signed = signManifest(m, privateKey);
  assert.equal(canonicalJson({ z: 2, a: 1 }), '{"a":1,"z":2}');
  assert(verifyManifest(signed, publicKey));
  assert(!verifyManifest({ ...signed, a: false }, publicKey));
  assert(!verifyManifest(signed, other.publicKey));
  assert.throws(() => canonicalJson({ value: 1.2 }));
});

test('publishing computes bytes and hashes and retains old runtime versions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ers-publish-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const app = path.join(dir, 'app.zip'), runtime = path.join(dir, 'runtime.zip');
  await fs.writeFile(app, 'application'); await fs.writeFile(runtime, 'runtime');
  const out = path.join(dir, 'source');
  const options = { 'app-id': 'com.test', version: '1.0.0', 'runtime-version': '32.2.0', 'app-zip': app, 'runtime-zip': runtime, 'base-url': 'http://127.0.0.1:1234', out };
  const first = await publish(options);
  assert.equal(first.app.asar.size, 11);
  assert.match(first.runtime.platforms['win32-x64']?.sha256 || first.runtime.platforms[`${process.platform}-${process.arch}`].sha256, /^[0-9a-f]{64}$/);
  const prior = path.join(dir, 'previous.json'); await fs.writeFile(prior, JSON.stringify(first));
  const next = await publish({ ...options, version: '2.0.0', 'runtime-version': '33.3.1', 'previous-manifest': prior });
  assert.equal(next.runtimes[0].version, '32.2.0');
});
