/* global console */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const dir = 'release';
const extensions = ['.AppImage', '.deb', '.exe', '.dmg'];
const files = (await readdir(dir)).filter((name) => extensions.some((ext) => name.endsWith(ext)));
const lines = [];
for (const name of files.sort()) {
  const hash = createHash('sha256')
    .update(await readFile(join(dir, name)))
    .digest('hex');
  lines.push(`${hash}  ${name}`);
}
await writeFile(join(dir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
console.log(lines.join('\n') || 'No installers found in release/.');
