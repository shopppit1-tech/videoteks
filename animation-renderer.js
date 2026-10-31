import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SVG_TAGS = new Set(['g', 'rect', 'circle', 'ellipse', 'line', 'path', 'polygon', 'polyline']);
const SVG_ATTRIBUTES = new Set([
  'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'fill', 'stroke',
  'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'fill-opacity',
  'stroke-opacity', 'transform', 'd', 'points', 'fill-rule', 'x1', 'y1', 'x2', 'y2'
]);

export function sanitizeGeneratedSvg(input, aspectRatio) {
  const width = aspectRatio === '9:16' ? 720 : 1280;
  const height = aspectRatio === '9:16' ? 1280 : 720;
  let source = String(input || '').trim().replace(/^```(?:svg|xml)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (source.length > 18000 || /<!DOCTYPE|<!ENTITY|<script|foreignObject|href\s*=|url\s*\(|javascript:|data:/i.test(source)) {
    throw new Error('SVG dari Gemini melewati validasi aman. Coba buat ulang.');
  }
  const root = source.match(/^<svg\b[^>]*>([\s\S]*)<\/svg\s*>$/i);
  if (!root) throw new Error('Gemini tidak mengembalikan satu SVG lengkap untuk adegan.');
  source = root[1];
  const tokens = [...source.matchAll(/<[^>]*>/g)];
  if (!tokens.length || source.replace(/<[^>]*>/g, '').trim()) throw new Error('SVG harus berisi bentuk vektor tanpa teks atau markup lain.');
  let cursor = 0;
  const stack = [];
  let body = '';
  for (const token of tokens) {
    if (source.slice(cursor, token.index).trim()) throw new Error('Teks mentah tidak diizinkan di SVG.');
    cursor = token.index + token[0].length;
    const match = token[0].match(/^<(\/)?([A-Za-z][A-Za-z0-9]*)([\s\S]*?)>$/);
    if (!match) throw new Error('Tag SVG tidak valid.');
    const [, closing, tagName, rawAttributes] = match;
    if (!SVG_TAGS.has(tagName)) throw new Error(`Elemen SVG ${tagName} tidak diizinkan.`);
    if (closing) {
      if (rawAttributes.trim() || stack.pop() !== tagName) throw new Error('Struktur SVG tidak seimbang.');
      body += `</${tagName}>`;
      continue;
    }
    const selfClosing = /\/\s*$/.test(rawAttributes);
    const attrsText = rawAttributes.replace(/\/\s*$/, '');
    const attrRegex = /([A-Za-z][A-Za-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let attrMatch;
    let remainder = attrsText;
    let safeAttrs = '';
    while ((attrMatch = attrRegex.exec(attrsText))) {
      const [whole, name, doubleValue, singleValue] = attrMatch;
      const value = doubleValue ?? singleValue ?? '';
      if (!SVG_ATTRIBUTES.has(name) || /[<>&"']|url|javascript|https?:/i.test(value) || value.length > 5000) {
        throw new Error(`Atribut SVG ${name} tidak diizinkan.`);
      }
      safeAttrs += ` ${name}="${value}"`;
      remainder = remainder.replace(whole, '');
    }
    if (remainder.trim()) throw new Error('Atribut SVG tidak terbaca atau tidak aman.');
    body += `<${tagName}${safeAttrs}${selfClosing ? '/>' : '>'}`;
    if (!selfClosing) stack.push(tagName);
  }
  if (source.slice(cursor).trim() || stack.length) throw new Error('SVG adegan tidak lengkap.');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

async function probeDuration(filePath) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
  const duration = Number(String(stdout || '').trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Durasi narasi tidak dapat dibaca.');
  return duration;
}

export async function renderAnimation(plan, aspectRatio, onProgress = () => {}, outputDirectory, narrationGenerator) {
  if (!['9:16', '16:9'].includes(aspectRatio)) throw new Error('Rasio video tidak didukung.');
  if (!Array.isArray(plan?.scenes) || plan.scenes.length !== 3 || plan.scenes.some(scene => !scene.svg)) {
    throw new Error('Gemini harus menghasilkan tiga SVG adegan; renderer tidak memakai gambar pengganti.');
  }
  if (typeof narrationGenerator !== 'function') throw new Error('Gemini TTS belum tersedia; renderer tidak memakai suara pengganti.');
  const id = crypto.randomUUID();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videoteks-animation-'));
  const assetDir = path.join(outputDirectory, id);
  const output = path.join(outputDirectory, `${id}.mp4`);
  let complete = false;
  try {
    await fs.mkdir(assetDir, { recursive: true });
    const framePaths = [];
    for (const [index, scene] of plan.scenes.entries()) {
      onProgress(`Merender ilustrasi SVG Gemini ${index + 1}/3…`);
      const svgPath = path.join(tempDir, `scene-${index + 1}.svg`);
      const framePath = path.join(assetDir, `scene-${index + 1}.png`);
      await fs.writeFile(svgPath, sanitizeGeneratedSvg(scene.svg, aspectRatio), 'utf8');
      await exec('ffmpeg', ['-v', 'error', '-y', '-i', svgPath, '-frames:v', '1', framePath]);
      const stat = await fs.stat(framePath);
      if (stat.size < 10000) throw new Error('SVG Gemini gagal dirender menjadi gambar yang valid.');
      framePaths.push(framePath);
    }

    const narrationFile = path.join(tempDir, 'narration.wav');
    onProgress('Membuat suara narasi dengan Gemini 3.8 Flash TTS…');
    await narrationGenerator(plan.narration, narrationFile);
    const narrationDuration = await probeDuration(narrationFile);
    const tempo = Math.min(2, Math.max(0.5, narrationDuration / 20)).toFixed(4);
    const width = aspectRatio === '9:16' ? 720 : 1280;
    const height = aspectRatio === '9:16' ? 1280 : 720;
    const sceneSeconds = 7;
    const fps = 30;
    const sceneFilters = framePaths.map((_, index) => `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},zoompan=z='min(zoom+0.00045,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps},trim=duration=${sceneSeconds},setpts=PTS-STARTPTS,setsar=1[v${index}]`);
    const filterGraph = [
      ...sceneFilters,
      '[v0][v1]xfade=transition=fade:duration=0.5:offset=6.5[v01]',
      '[v01][v2]xfade=transition=fade:duration=0.5:offset=13.0[vout]',
      `[3:a]aresample=48000,atempo=${tempo},apad=pad_dur=20,atrim=duration=20,asetpts=PTS-STARTPTS[aout]`
    ].join(';');
    const args = ['-y'];
    for (const framePath of framePaths) args.push('-loop', '1', '-framerate', String(fps), '-t', String(sceneSeconds), '-i', framePath);
    args.push('-i', narrationFile, '-filter_complex', filterGraph, '-map', '[vout]', '-map', '[aout]', '-t', '20', '-r', String(fps), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output);
    onProgress('Merakit gambar Gemini, gerak kamera, transisi, dan narasi menjadi MP4 20 detik…');
    await exec('ffmpeg', args);
    const stat = await fs.stat(output);
    if (stat.size < 10000) throw new Error('MP4 terlalu kecil atau tidak valid.');
    complete = true;
    return {
      id,
      videoUrl: `/generated-animations/${id}.mp4`,
      frameUrls: framePaths.map((_, index) => `/generated-animations/${id}/scene-${index + 1}.png`),
      durationSeconds: 20,
      narration: plan.narration
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (!complete) await fs.rm(assetDir, { recursive: true, force: true }).catch(() => {});
    if (!complete) await fs.rm(output, { force: true }).catch(() => {});
  }
}
