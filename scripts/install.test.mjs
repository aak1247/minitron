import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseTag = 'v0.1.0';
const binaryContents = Buffer.from('minitron installer fixture binary\n');

function targetForCurrentPlatform() {
  if (process.platform === 'win32' && process.arch === 'x64') {
    return { os: 'windows', arch: 'x64', archiveExtension: 'zip', binaryName: 'minitron.exe' };
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return { os: 'linux', arch: 'x64', archiveExtension: 'tar.gz', binaryName: 'minitron' };
  }
  if (process.platform === 'darwin' && ['x64', 'arm64'].includes(process.arch)) {
    return { os: 'macos', arch: process.arch, archiveExtension: 'tar.gz', binaryName: 'minitron' };
  }
  return null;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeStoredZip(entryName, contents) {
  const name = Buffer.from(entryName);
  const crc = crc32(contents);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0x21, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(contents.length, 18);
  localHeader.writeUInt32LE(contents.length, 22);
  localHeader.writeUInt16LE(name.length, 26);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0x21, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(contents.length, 20);
  centralHeader.writeUInt32LE(contents.length, 24);
  centralHeader.writeUInt16LE(name.length, 28);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);

  const localRecord = Buffer.concat([localHeader, name, contents]);
  const centralRecord = Buffer.concat([centralHeader, name]);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(1, 8);
  endRecord.writeUInt16LE(1, 10);
  endRecord.writeUInt32LE(centralRecord.length, 12);
  endRecord.writeUInt32LE(localRecord.length, 16);
  return Buffer.concat([localRecord, centralRecord, endRecord]);
}

function makeReleaseArchive(tempRoot, target) {
  if (target.archiveExtension === 'zip') {
    return makeStoredZip(target.binaryName, binaryContents);
  }

  const archivePath = join(tempRoot, `minitron-${releaseTag}-${target.os}-${target.arch}.tar.gz`);
  const payloadDirectory = join(tempRoot, 'payload');
  mkdirSync(payloadDirectory, { recursive: true });
  writeFileSync(join(payloadDirectory, target.binaryName), binaryContents);
  execFileSync('tar', ['-czf', archivePath, '-C', payloadDirectory, target.binaryName]);
  return readFileSync(archivePath);
}

function startReleaseFixture(archiveName, archiveContents) {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const route = requestUrl.pathname.split('/')[1];
    const prefix = `/${route}`;

    if (route === 'good' || route === 'bad' || route === 'missing') {
      if (requestUrl.pathname === `${prefix}/latest`) {
        response.writeHead(302, { Location: `${prefix}/tag/${releaseTag}` });
        response.end();
        return;
      }
      if (requestUrl.pathname === `${prefix}/tag/${releaseTag}`) {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end('fixture release');
        return;
      }

      const assetPath = `${prefix}/download/${releaseTag}/${archiveName}`;
      const sumsPath = `${prefix}/download/${releaseTag}/SHA256SUMS`;
      if (requestUrl.pathname === sumsPath) {
        const checksum = sha256(archiveContents);
        const reportedChecksum = route === 'bad'
          ? `${checksum[0] === '0' ? '1' : '0'}${checksum.slice(1)}`
          : checksum;
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end(`${reportedChecksum}  ${archiveName}\n`);
        return;
      }
      if (requestUrl.pathname === assetPath) {
        if (route === 'missing') {
          response.writeHead(404);
          response.end('not found');
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        response.end(archiveContents);
        return;
      }
    }

    response.writeHead(404);
    response.end('not found');
  });

  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not start the local release fixture.'));
        return;
      }
      resolveServer({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function getInstallerRunners(target) {
  if (target.os !== 'windows') return ['sh'];
  const candidates = [
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  ];
  return candidates.filter((executable) => {
    if (!existsSync(executable)) return false;
    const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    return !result.error && result.status === 0;
  });
}

function runInstaller(target, args, runner, workingDirectory = repositoryRoot) {
  let executable;
  let executableArgs;
  if (target.os === 'windows') {
    const installerPath = join(repositoryRoot, 'install.ps1');
    executable = runner;
    executableArgs = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', installerPath,
      ...args.windows,
    ];
  } else {
    executable = runner;
    executableArgs = [join(repositoryRoot, 'install.sh'), ...args.posix];
  }

  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(executable, executableArgs, {
      cwd: workingDirectory,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      rejectProcess(new Error(`${runner} installer exceeded the 30-second test timeout.`));
    }, 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectProcess(error);
    });
    child.once('close', (status, signal) => {
      clearTimeout(timeout);
      resolveProcess({ status, signal, stdout, stderr });
    });
  });
}

function commandArgs(target, installDirectory, baseUrl, includeVersion = false, includeDirectory = true) {
  if (target.os === 'windows') {
    const args = ['-BaseUrl', baseUrl];
    if (includeDirectory) args.unshift('-InstallDir', installDirectory);
    if (includeVersion) args.push('-Version', releaseTag);
    return { windows: args, posix: [] };
  }
  const args = ['--base-url', baseUrl];
  if (includeDirectory) args.unshift('--dir', installDirectory);
  if (includeVersion) args.push('--version', releaseTag);
  return { windows: [], posix: args };
}

function getOutput(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function assertCommandSucceeded(result, scenario) {
  if (result.error) throw new Error(`${scenario}: ${result.error.message}`);
  assert.equal(result.status, 0, `${scenario} failed:\n${getOutput(result)}`);
}

function assertCommandFailed(result, scenario, expectedMessage) {
  if (result.error) throw new Error(`${scenario}: ${result.error.message}`);
  assert.notEqual(result.status, 0, `${scenario} unexpectedly succeeded.`);
  assert.match(getOutput(result), expectedMessage, `${scenario} did not report the expected failure:\n${getOutput(result)}`);
}

async function runInstallerTests(t) {
  const target = targetForCurrentPlatform();
  if (!target) {
    t.skip(`No installer target is published for ${process.platform}/${process.arch}.`);
    return;
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'minitron-installer-test-'));
  let fixture;
  try {
    const archiveName = `minitron-${releaseTag}-${target.os}-${target.arch}.${target.archiveExtension}`;
    const archiveContents = makeReleaseArchive(tempRoot, target);
    fixture = await startReleaseFixture(archiveName, archiveContents);

    const runners = getInstallerRunners(target);
    assert.ok(runners.length > 0, 'No Windows PowerShell host is available to test install.ps1.');
    for (const runner of runners) {
      const runnerLabel = basename(runner);
      const runnerSlug = runnerLabel.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
      const successDirectory = join(tempRoot, `${runnerSlug} application with spaces`);
      mkdirSync(join(successDirectory, 'resources'), { recursive: true });
      writeFileSync(join(successDirectory, target.binaryName), 'previous binary');
      writeFileSync(join(successDirectory, 'minitron.toml'), 'user config stays\n');
      writeFileSync(join(successDirectory, 'resources', 'marker.txt'), 'user resource stays\n');

      const successResult = await runInstaller(target, commandArgs(target, successDirectory, `${fixture.baseUrl}/good`), runner);
      assertCommandSucceeded(successResult, `${runnerLabel}: installing the latest release`);
      assert.deepEqual(readFileSync(join(successDirectory, target.binaryName)), binaryContents);
      assert.equal(readFileSync(join(successDirectory, 'minitron.toml'), 'utf8'), 'user config stays\n');
      assert.equal(readFileSync(join(successDirectory, 'resources', 'marker.txt'), 'utf8'), 'user resource stays\n');
      assert.deepEqual(readdirSync(successDirectory).sort(), ['minitron.toml', target.binaryName, 'resources'].sort());
      assert.match(getOutput(successResult), /Installed minitron to:/);

      const defaultDirectory = join(tempRoot, `${runnerSlug} default directory`);
      mkdirSync(defaultDirectory);
      writeFileSync(join(defaultDirectory, 'minitron.toml'), 'default directory config stays\n');
      const defaultResult = await runInstaller(
        target,
        commandArgs(target, defaultDirectory, `${fixture.baseUrl}/good`, false, false),
        runner,
        defaultDirectory,
      );
      assertCommandSucceeded(defaultResult, `${runnerLabel}: installing into the current directory by default`);
      assert.deepEqual(readFileSync(join(defaultDirectory, target.binaryName)), binaryContents);
      assert.equal(readFileSync(join(defaultDirectory, 'minitron.toml'), 'utf8'), 'default directory config stays\n');

      const checksumDirectory = join(tempRoot, `${runnerSlug} checksum failure`);
      mkdirSync(checksumDirectory);
      writeFileSync(join(checksumDirectory, target.binaryName), 'binary before checksum failure');
      writeFileSync(join(checksumDirectory, 'minitron.toml'), 'config before checksum failure\n');
      const checksumResult = await runInstaller(target, commandArgs(target, checksumDirectory, `${fixture.baseUrl}/bad`, true), runner);
      assertCommandFailed(checksumResult, `${runnerLabel}: rejecting a checksum mismatch`, /SHA-256 verification failed/i);
      assert.equal(readFileSync(join(checksumDirectory, target.binaryName), 'utf8'), 'binary before checksum failure');
      assert.equal(readFileSync(join(checksumDirectory, 'minitron.toml'), 'utf8'), 'config before checksum failure\n');

      const downloadDirectory = join(tempRoot, `${runnerSlug} download failure`);
      mkdirSync(downloadDirectory);
      writeFileSync(join(downloadDirectory, target.binaryName), 'binary before download failure');
      writeFileSync(join(downloadDirectory, 'minitron.toml'), 'config before download failure\n');
      const downloadResult = await runInstaller(target, commandArgs(target, downloadDirectory, `${fixture.baseUrl}/missing`, true), runner);
      assertCommandFailed(downloadResult, `${runnerLabel}: rejecting a failed download`, /Could not download/i);
      assert.equal(readFileSync(join(downloadDirectory, target.binaryName), 'utf8'), 'binary before download failure');
      assert.equal(readFileSync(join(downloadDirectory, 'minitron.toml'), 'utf8'), 'config before download failure\n');
    }

    t.diagnostic(`Covered ${target.os}/${target.arch} (${getInstallerRunners(target).map((runner) => basename(runner)).join(', ')}): latest install, current-directory default, download failure, checksum failure, and existing-file preservation.`);
  } finally {
    if (fixture) {
      fixture.server.closeAllConnections?.();
      await new Promise((resolveClose) => fixture.server.close(resolveClose));
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

test('native installer installs verified releases and preserves application files on failure', runInstallerTests);
