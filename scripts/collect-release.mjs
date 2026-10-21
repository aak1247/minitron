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
const mib = bytes => (bytes / 1024 / 1024).toFixed(2);
await fs.writeFile(path.join(directory, 'release-notes.md'), `Small Electron app packages with a shared runtime.\n\nThe electron-builder adapter is included as \`${adapter}\`; install it with npm from this release. Package Windows NSIS, Linux DEB/RPM, and macOS DMG/PKG with your application's name and icon. Installer upgrades stop the previous app; removal unregisters its shared runtime. On macOS, run the included \`Contents/Resources/minitron-uninstall.command\` before deleting the app.\n\nDownload the archive for your system, or use [the installation scripts](https://github.com/aak1247/minitron#install).\n\n| Platform | Download | Extracted launcher |\n|---|---:|---:|\n${sizes.map(s => `| ${s.platform} | ${mib(s.downloadBytes)} MiB | ${mib(s.binaryBytes)} MiB |`).join('\n')}\n\nArchives contain only \`minitron\` (\`minitron.exe\` on Windows). Electron is downloaded separately on the first app launch and shared between apps using the same version. See \`SHA256SUMS\` for checksums and \`sizes.json\` for exact byte counts.\n`);
