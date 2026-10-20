// Capture GUI-subsystem launcher output with an explicit process lifetime.
// PowerShell can otherwise close a GUI executable's output pipe before it exits.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const executable = path.resolve(process.argv[2] || 'shell/target/release/minitron.exe');
for (const [language, expected] of [
  ['en', /Usage:/],
  ['zh', /用法/],
  ['de-DE', /Usage:/],
  ['auto', /Usage:|用法/],
]) {
  const result = spawnSync(executable, ['--help'], {
    env: { ...process.env, MINITRON_LANG: language },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, expected, `Unexpected ${language} help: ${result.stdout}`);
  assert(!result.stdout.includes('\uFFFD'), 'Help output contains invalid UTF-8');
  console.log(`PASS launcher help: ${language}`);
}
