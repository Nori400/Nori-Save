import path from 'node:path';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
export function library(name) {
  return process.env.NORI_SAVE_RUNTIME_MODULES ? require(path.join(process.env.NORI_SAVE_RUNTIME_MODULES, name)) : require(name);
}
export const browserExecutable = process.env.NORI_SAVE_QA_BROWSER ||
  (process.platform === 'win32' && existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe') ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined);
export const ffmpeg = process.env.FFMPEG || 'ffmpeg';
export const ffprobe = process.env.FFPROBE || 'ffprobe';
