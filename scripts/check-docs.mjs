import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.md'], { cwd: root, encoding: 'utf8' });
if (git.status !== 0) throw new Error(git.stderr || 'Cannot list documentation');
const files = [...new Set(git.stdout.split('\0').filter(Boolean))];
const markdown = new Map();
for (const name of files) markdown.set(path.resolve(root, name), await fs.readFile(path.resolve(root, name), 'utf8'));

function withoutCode(text) {
  return text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
}

function headings(text) {
  const counts = new Map();
  return new Set([...withoutCode(text).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map(([, title]) => {
    const slug = title.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-');
    const count = counts.get(slug) || 0;
    counts.set(slug, count + 1);
    return count ? `${slug}-${count}` : slug;
  }));
}

let checked = 0;
const failures = [];
for (const [filename, text] of markdown) {
  for (const [, raw] of withoutCode(text).matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue;
    const [pathname, fragment] = raw.split('#');
    const target = pathname ? path.resolve(path.dirname(filename), decodeURIComponent(pathname)) : filename;
    checked++;
    try {
      await fs.access(target);
      if (fragment && path.extname(target).toLowerCase() === '.md') {
        const targetText = markdown.get(target) ?? await fs.readFile(target, 'utf8');
        assert(headings(targetText).has(decodeURIComponent(fragment)), 'heading does not exist');
      }
    } catch (error) {
      failures.push(`${path.relative(root, filename)}: ${raw}: ${error.message}`);
    }
  }
  for (const [, snippet] of text.matchAll(/^```json\s*\n([\s\S]*?)^```/gm)) {
    try { JSON.parse(snippet); } catch (error) { failures.push(`${path.relative(root, filename)}: invalid JSON example: ${error.message}`); }
  }
}

const pkg = JSON.parse(await fs.readFile(path.join(root, 'packages/electron-builder/package.json'), 'utf8'));
const lock = JSON.parse(await fs.readFile(path.join(root, 'packages/electron-builder/package-lock.json'), 'utf8'));
const cargo = await fs.readFile(path.join(root, 'shell/Cargo.toml'), 'utf8');
assert.equal(/^version = "([^"]+)"/m.exec(cargo)?.[1], pkg.version, 'launcher and npm versions differ');
assert.equal(lock.version, pkg.version, 'npm lockfile version differs');
assert.equal(lock.packages[''].version, pkg.version, 'npm root lockfile version differs');
assert((await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8')).includes(`## ${pkg.version} — `), 'current changelog entry missing');

if (failures.length) throw new Error(failures.join('\n'));
console.log(`Checked ${files.length} Markdown files, ${checked} local links, JSON examples and release version ${pkg.version}.`);
