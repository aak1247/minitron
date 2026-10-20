import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { hashFile } from './publish-release.mjs';

const version = /^version = "([^"]+)"/m.exec(await fs.readFile('shell/Cargo.toml', 'utf8'))[1];
const platform = { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform];
if (!platform || !['x64', 'arm64'].includes(process.arch)) throw new Error('Unsupported release target');
const key = `${platform}-${process.arch}`;
const executable = process.platform === 'win32' ? 'minitron.exe' : 'minitron';
const binary = path.resolve('shell/target/release', executable);
const output = path.resolve('dist/release');
await fs.mkdir(output, { recursive: true });
const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'minitron-release-'));
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
async function directoryBytes(directory) {
  let total = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    total += entry.isDirectory() ? await directoryBytes(file) : (await fs.stat(file)).size;
  }
  return total;
}
try {
  run(process.execPath, ['scripts/build-app.mjs', '--source', 'app', '--launcher', binary,
    '--out', 'dist/example', '--runtime-version', '32.2.0',
    '--manifest-url', 'https://example.invalid/myapp/manifest.json']);
  const runtimeZip = path.resolve(`dist/electron-zips/electron-v32.2.0-${process.platform}-${process.arch}.zip`);
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
  const runtimeSize = spawnSync(python, [...(python === 'py' ? ['-3'] : []), '-c',
    'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(sum(i.file_size for i in z.infolist() if not i.is_dir()))', runtimeZip], { encoding: 'utf8' });
  if (runtimeSize.error || runtimeSize.status !== 0) throw runtimeSize.error || new Error(runtimeSize.stderr);
  await fs.copyFile(binary, path.join(staging, executable));
  if (process.platform !== 'win32') await fs.chmod(path.join(staging, executable), 0o755);
  const archive = `minitron-v${version}-${key}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const destination = path.join(output, archive);
  if (process.platform === 'win32') {
    // Paths are passed through environment variables, not interpolated as code.
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Compress-Archive -LiteralPath $env:MINITRON_RELEASE_BINARY -DestinationPath $env:MINITRON_RELEASE_ARCHIVE -Force'],
    { stdio: 'inherit', env: { ...process.env, MINITRON_RELEASE_BINARY: path.join(staging, executable), MINITRON_RELEASE_ARCHIVE: destination } });
    if (result.error || result.status !== 0) throw result.error || new Error('ZIP creation failed');
  } else {
    run('tar', ['-czf', destination, '-C', staging, executable]);
  }
  const size = {
    platform: key, version, archive, binary: executable,
    binaryBytes: (await fs.stat(binary)).size,
    downloadBytes: (await fs.stat(destination)).size,
    sampleAppBytes: await directoryBytes(path.resolve('dist/example/application')),
    sampleAppUpdateBytes: (await fs.stat(`dist/example/app-1.0.0-${process.platform}-${process.arch}-electron-32.2.0.zip`)).size,
    runtimeDownloadBytes: (await fs.stat(runtimeZip)).size,
    runtimeExtractedBytes: Number(runtimeSize.stdout.trim()),
    sha256: await hashFile(destination),
  };
  await fs.writeFile(path.join(output, `${key}.json`), JSON.stringify(size, null, 2) + '\n');
  console.log(JSON.stringify(size, null, 2));
} finally {
  await fs.rm(staging, { recursive: true, force: true });
}
