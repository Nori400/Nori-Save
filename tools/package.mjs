import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const table = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
async function filesIn(relative) {
  const absolute = path.join(root, relative);
  const info = await fs.lstat(absolute);
  if (info.isSymbolicLink()) throw new Error(`Packaging refuses a symlink: ${relative}`);
  if (info.isFile()) return [relative.replaceAll('\\', '/')];
  const files = [];
  for (const name of (await fs.readdir(absolute)).sort()) files.push(...await filesIn(path.join(relative, name)));
  return files;
}
async function zip(files, destination, stripPrefix = '') {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const relative of files) {
    const name = Buffer.from(relative.slice(stripPrefix.length), 'utf8');
    const data = await fs.readFile(path.join(root, relative));
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(33, 12); // Deterministic 1980-01-01 timestamp.
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    directory.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  await fs.writeFile(path.join(root, destination), Buffer.concat([...locals, central, end]));
  return { file: destination, entries: files.length, bytes: (await fs.stat(path.join(root, destination))).size };
}

const extension = await filesIn('extension');
// Only these source paths may enter the public archive. Local evidence, browser
// profiles, downloads and installed dependencies are never traversed.
const publicRoots = ['extension', 'tools', 'docs', '.github', '.gitignore', '.gitattributes', 'README.md', 'LICENSE', 'PRIVACY.md', 'SECURITY.md', 'CONTRIBUTING.md', 'package.json', 'package-lock.json'];
const source = [];
for (const relative of publicRoots) source.push(...await filesIn(relative));
if (source.some(name => /(^|\/)(evidence|node_modules|private-fixtures)(\/|$)|\.(m4s|mp4|m4a|webm|zip)$/i.test(name))) throw new Error('Private evidence or media entered the public file list.');
for (const relative of source.filter(name => /\.(js|mjs|json|md|html|css|yml)$/.test(name))) {
  const content = await fs.readFile(path.join(root, relative), 'utf8');
  if (/C:[\\/]Users[\\/][^\\/:\s]+[\\/]|D:[\\/]codex|upsig=[a-f0-9]{16,}|(?:SESSDATA|bili_jct)=[a-z0-9_%]{16,}/i.test(content)) throw new Error(`Private path or credential-like text found in ${relative}`);
}
const results = [await zip(extension, 'Nori-Save-extension.zip', 'extension/'), await zip(source, 'Nori-Save-GitHub-source.zip')];
console.log(JSON.stringify(results, null, 2));
