import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { library } from './runtime.mjs';
const sharp = library('sharp');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fs.readFile(path.join(root, 'extension/icons/icon.svg'));
for (const size of [16, 32, 48, 128]) await sharp(source).resize(size, size).png().toFile(path.join(root, `extension/icons/icon-${size}.png`));
console.log('Generated extension icons (16, 32, 48, 128).');
