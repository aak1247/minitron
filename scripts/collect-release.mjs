import fs from 'node:fs/promises';
import path from 'node:path';
import { hashFile } from './publish-release.mjs';

const directory = path.resolve(process.argv[2] || 'dist/release');
const platforms = ['windows-x64', 'linux-x64', 'macos-x64', 'macos-arm64'];
const sizes = await Promise.all(platforms.map(async key => JSON.parse(await fs.readFile(path.join(directory, `${key}.json`), 'utf8'))));
if (new Set(sizes.map(size => size.version)).size !== 1) throw new Error('Release versions differ');
for (const size of sizes) {
  if (await hashFile(path.join(directory, size.archive)) !== size.sha256) throw new Error(`Archive changed: ${size.archive}`);
}
for (const name of ['install.ps1', 'install.sh']) await fs.copyFile(name, path.join(directory, name));
const adapterPackage = JSON.parse(await fs.readFile(new URL('../packages/electron-builder/package.json', import.meta.url), 'utf8'));
if (adapterPackage.version !== sizes[0].version) throw new Error('Adapter and launcher versions differ');
const adapter = `${adapterPackage.name.replace(/^@/, '').replace('/', '-')}-${adapterPackage.version}.tgz`;
await fs.access(path.join(directory, adapter));
const files = [...sizes.map(size => size.archive), adapter, 'install.ps1', 'install.sh'];
await fs.writeFile(path.join(directory, 'SHA256SUMS'), (await Promise.all(files.map(async name => `${await hashFile(path.join(directory, name))}  ${name}`))).join('\n') + '\n');
await fs.writeFile(path.join(directory, 'sizes.json'), JSON.stringify(sizes, null, 2) + '\n');
const changelog = await fs.readFile('CHANGELOG.md', 'utf8');
const entry = changelog.split(/^## /m).find(section => section.startsWith(sizes[0].version + ' — '));
if (!entry) throw new Error('No changelog entry for release ' + sizes[0].version);
const changes = '## Changes\n\n' + entry.slice(entry.indexOf('\n') + 1).trim();
const mib = bytes => (bytes / 1024 / 1024).toFixed(2);
await fs.writeFile(path.join(directory, 'release-notes.md'), `${changes}\n\n## Install\n\nFrom your Electron project:\n\n\`\`\`sh\nnpm install --save-dev minitron-builder\nnpm run build\nnpx minitron-builder\n\`\`\`\n\nReuses your electron-builder configuration to produce Windows NSIS, Linux DEB/RPM, and macOS DMG/PKG installers with your application's name and icon. The launcher is selected automatically, and no update server is needed for the first launch. The npm package is also included as \`${adapter}\`.\n\nInstaller upgrades stop the previous app; removal unregisters its shared runtime. On macOS, run the included \`Contents/Resources/minitron-uninstall.command\` before deleting the app.\n\nFor manual launcher installation, download the archive for your system or see the [packaging guide](https://github.com/aak1247/minitron/blob/main/docs/usage.md#packaging-an-app).\n\n| Platform | Download | Extracted launcher |\n|---|---:|---:|\n${sizes.map(s => `| ${s.platform} | ${mib(s.downloadBytes)} MiB | ${mib(s.binaryBytes)} MiB |`).join('\n')}\n\nArchives contain only \`minitron\` (\`minitron.exe\` on Windows). Electron is downloaded separately when the exact runtime is absent, then reused across compatible applications. Routine launches open the app directly. See \`SHA256SUMS\` for checksums and \`sizes.json\` for exact byte counts.\n`);
