import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./karvis-snapshot.mjs', import.meta.url));
test('private build snapshot excludes unrelated files and rejects tampered ciphertext', async t => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'minitron-snapshot-'));
  t.after(() => fs.rm(work, { recursive: true, force: true }));
  const project = path.join(work, 'project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  for (const [name, contents] of Object.entries({ 'package.json': '{}', 'package-lock.json': '{}', 'src/main.ts': 'application', '.env': 'secret', '.npmrc': 'token', 'private.md': 'notes' })) {
    await fs.writeFile(path.join(project, name), contents);
  }
  const input = path.join(work, 'source.enc');
  const key = path.join(work, 'key');
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const created = run('create', '--project', project, '--out', input, '--key-file', key);
  assert.equal(created.status, 0, created.stderr);
  const out = path.join(work, 'extracted');
  const extracted = run('extract', '--input', input, '--out', out, '--key-file', key);
  assert.equal(extracted.status, 0, extracted.stderr);
  assert.deepEqual((await fs.readdir(out)).sort(), ['package-lock.json', 'package.json', 'src']);
  assert.equal(await fs.readFile(path.join(out, 'src/main.ts'), 'utf8'), 'application');
  const ciphertext = await fs.readFile(input);
  ciphertext[ciphertext.length - 1] ^= 1;
  await fs.writeFile(input, ciphertext);
  const rejected = run('extract', '--input', input, '--out', path.join(work, 'rejected'), '--key-file', key);
  assert.notEqual(rejected.status, 0);
  await assert.rejects(fs.stat(path.join(work, 'rejected')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(project, '.env'), 'utf8'), 'secret');
});
