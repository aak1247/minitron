import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Adapter changes can reuse a native build only when every runtime source and
// its complete native acceptance fixtures are identical to a successful run.
const directory = path.resolve(process.argv[2]);
const platform = process.argv[3];
assert(['windows-x64', 'linux-x64', 'macos-x64', 'macos-arm64'].includes(platform));
const run = JSON.parse(await fs.readFile('dist/verified-run.json', 'utf8'));
assert.equal(run.status, 'completed');
assert.equal(run.conclusion, 'success');
assert.equal(run.path, '.github/workflows/release.yml');
assert.match(run.head_sha, /^[a-f0-9]{40}$/);
const unchanged = spawnSync('git', ['diff', '--exit-code', run.head_sha, 'HEAD', '--',
  'shell', 'app', 'scripts/e2e.mjs', 'scripts/e2e-unix.sh', 'scripts/e2e-windows.ps1'],
{ encoding: 'utf8' });
if (unchanged.error || unchanged.status !== 0) {
  throw new Error(`Native sources differ from the tested launcher run: ${unchanged.stderr || unchanged.stdout}`);
}
const metadata = JSON.parse(await fs.readFile(path.join(directory, `${platform}.json`), 'utf8'));
const adapter = JSON.parse(await fs.readFile('packages/electron-builder/package.json', 'utf8'));
assert.equal(metadata.platform, platform);
assert.equal(metadata.version, adapter.version);
const suffix = platform.startsWith('windows-') ? 'zip' : 'tar.gz';
assert.equal(metadata.archive, `minitron-v${adapter.version}-${platform}.${suffix}`);
const archive = await fs.readFile(path.join(directory, metadata.archive));
assert.equal(createHash('sha256').update(archive).digest('hex'), metadata.sha256);
assert.equal(archive.length, metadata.downloadBytes);
console.log(`Verified ${platform} launcher from successful native run ${run.id} (${run.head_sha})`);
