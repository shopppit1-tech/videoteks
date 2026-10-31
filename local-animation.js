import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const LOCAL_IDEA_SEEDS = [
  'Pipo dan teman-temannya menolong bintang kecil kembali ke langit.',
  'Lala menemukan bunga ajaib yang membuat hutan kembali cerah.',
  'Tutu si kura-kura membantu ikan kecil pulang ke sungai.',
  'Tiga sahabat berbagi kue ulang tahun dengan penghuni hutan.',
  'Pipo, Lala, dan Tutu mengejar layang-layang yang terbang tinggi.'
];

export function suggestLocalIdea() {
  return LOCAL_IDEA_SEEDS[Math.floor(Math.random() * LOCAL_IDEA_SEEDS.length)];
}

function chooseMotif(idea) {
  const text = String(idea || '').toLowerCase();
  if (/bintang|star|langit|planet/.test(text)) return { key: 'star', item: 'bintang kecil', place: 'langit' };
  if (/ikan|laut|sungai|kolam|air/.test(text)) return { key: 'fish', item: 'ikan kecil', place: 'sungai' };
  if (/bunga|taman|daun/.test(text)) return { key: 'flower', item: 'bunga bercahaya', place: 'taman' };
  if (/kue|ulang tahun|roti/.test(text)) return { key: 'cake', item: 'kue kecil', place: 'tempat piknik' };
  if (/layang|angin|terbang/.test(text)) return { key: 'kite', item: 'layang-layang', place: 'puncak bukit' };
  if (/bulan|cahaya|lampu|lentera/.test(text)) return { key: 'lantern', item: 'lentera bercahaya', place: 'rumah kecil' };
  return { key: 'crystal', item: 'kristal berkilau', place: 'hutan' };
}

export function createAnimationPlan({ idea, style, aspectRatio }) {
  const cleanIdea = String(idea || '').trim().replace(/\s+/g, ' ').slice(0, 1000);
  const motif = chooseMotif(cleanIdea);
  const title = (cleanIdea.split(/[.!?\n]/)[0] || 'Petualangan Tiga Sahabat').slice(0, 85);
  const narration = `Malam itu, Pipo si panda menemukan ${motif.item} yang tersesat. Ia memanggil Lala si rubah dan Tutu si kura-kura. Bersama, mereka menjaga ${motif.item} itu dan mengantarnya menuju ${motif.place}. Mereka pun tersenyum gembira, karena sahabat selalu saling membantu.`;
  return {
    title,
    idea: cleanIdea,
    style: String(style || '').slice(0, 120),
    aspectRatio,
    motif,
    hook: `Pipo menemukan ${motif.item} yang membutuhkan pertolongan.`,
    payoff: `Ketiga sahabat berhasil mengantar ${motif.item} ke ${motif.place}.`,
    narration,
    scenes: [
      { number: 1, visual_action: `Pipo menemukan ${motif.item} yang bersinar.` },
      { number: 2, visual_action: `Lala dan Tutu membantu menjaga serta mengantar ${motif.item}.` },
      { number: 3, visual_action: `Ketiga sahabat merayakan keberhasilan di ${motif.place}.` }
    ]
  };
}

function starPath(cx, cy, outer, inner, points = 5) {
  const coords = [];
  for (let i = 0; i < points * 2; i++) {
    const angle = -Math.PI / 2 + i * Math.PI / points;
    const radius = i % 2 ? inner : outer;
    coords.push(`${(cx + Math.cos(angle) * radius).toFixed(1)},${(cy + Math.sin(angle) * radius).toFixed(1)}`);
  }
  return `M${coords.join(' L')} Z`;
}

function pandaSvg(x, y, scale = 1) {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><ellipse cx="0" cy="-43" rx="47" ry="59" fill="#f7f3e9"/><circle cx="-35" cy="-97" r="20" fill="#202638"/><circle cx="35" cy="-97" r="20" fill="#202638"/><circle cx="0" cy="-82" r="48" fill="#fff8ec"/><ellipse cx="-18" cy="-82" rx="11" ry="15" transform="rotate(28 -18 -82)" fill="#202638"/><ellipse cx="18" cy="-82" rx="11" ry="15" transform="rotate(-28 18 -82)" fill="#202638"/><circle cx="-17" cy="-82" r="3.4" fill="#fff"/><circle cx="17" cy="-82" r="3.4" fill="#fff"/><ellipse cx="0" cy="-62" rx="8" ry="6" fill="#2b2630"/><path d="M0 -57 Q-7 -49 -13 -54 M0 -57 Q7 -49 13 -54" fill="none" stroke="#473842" stroke-width="3" stroke-linecap="round"/><path d="M-37 -30 Q0 -17 37 -30 L27 -13 Q0 -3 -27 -13Z" fill="#54b8ff"/><path d="M21 -18 L30 3 L18 0Z" fill="#318ed1"/><ellipse cx="-38" cy="7" rx="15" ry="29" fill="#202638"/><ellipse cx="38" cy="7" rx="15" ry="29" fill="#202638"/><ellipse cx="-20" cy="-1" rx="18" ry="7" fill="#fff8ec"/><ellipse cx="20" cy="-1" rx="18" ry="7" fill="#fff8ec"/></g>`;
}
function foxSvg(x, y, scale = 1) {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><ellipse cx="0" cy="-39" rx="43" ry="56" fill="#ee873e"/><path d="M-34 -108 L-44 -157 L-7 -128Z" fill="#df6c31"/><path d="M34 -108 L44 -157 L7 -128Z" fill="#df6c31"/><path d="M-34 -126 L-38 -145 L-20 -130Z M34 -126 L38 -145 L20 -130Z" fill="#ffc1a0"/><circle cx="0" cy="-84" r="46" fill="#ef8d45"/><path d="M-37 -70 Q0 -38 37 -70 Q28 -28 0 -22 Q-28 -28 -37 -70Z" fill="#fff1da"/><ellipse cx="-16" cy="-84" rx="5" ry="7" fill="#402b2b"/><ellipse cx="16" cy="-84" rx="5" ry="7" fill="#402b2b"/><ellipse cx="0" cy="-65" rx="7" ry="5" fill="#382936"/><path d="M-35 -33 Q0 -20 35 -33 L24 -16 Q0 -7 -24 -16Z" fill="#76d68e"/><path d="M-31 -4 L-53 25 L-13 12Z M29 -5 L51 24 L13 13Z" fill="#ee873e"/><ellipse cx="-29" cy="13" rx="14" ry="25" fill="#ee873e"/><ellipse cx="29" cy="13" rx="14" ry="25" fill="#ee873e"/></g>`;
}
function turtleSvg(x, y, scale = 1) {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><ellipse cx="0" cy="-35" rx="48" ry="35" fill="#b8793d" stroke="#f1bc73" stroke-width="5"/><path d="M-35 -47 Q0 -82 35 -47 M-42 -31 Q0 -57 42 -31 M-25 -8 Q0 -37 25 -8" fill="none" stroke="#89542f" stroke-width="4"/><ellipse cx="-30" cy="-7" rx="14" ry="10" fill="#8bd476"/><ellipse cx="30" cy="-7" rx="14" ry="10" fill="#8bd476"/><ellipse cx="0" cy="-76" rx="31" ry="35" fill="#9be27d"/><circle cx="-11" cy="-81" r="4" fill="#244336"/><circle cx="11" cy="-81" r="4" fill="#244336"/><path d="M-9 -67 Q0 -61 9 -67" fill="none" stroke="#35634a" stroke-width="3" stroke-linecap="round"/><path d="M-29 -53 Q0 -43 29 -53 L21 -38 Q0 -31 -21 -38Z" fill="#ff6b72"/><path d="M18 -42 L27 -24 L14 -27Z" fill="#d94e60"/></g>`;
}

function motifSvg(key, x, y, size, glow = 1) {
  const halo = `<circle cx="${x}" cy="${y}" r="${size * 1.55}" fill="#fff3a3" opacity="${0.16 * glow}"/><circle cx="${x}" cy="${y}" r="${size * 1.05}" fill="#fff5b7" opacity="${0.2 * glow}"/>`;
  if (key === 'star') return `${halo}<path d="${starPath(x, y, size, size * 0.46)}" fill="#ffe77b" stroke="#fff8d5" stroke-width="5"/>`;
  if (key === 'fish') return `${halo}<ellipse cx="${x}" cy="${y}" rx="${size * 1.1}" ry="${size * 0.65}" fill="#ff9c73" stroke="#fff0d5" stroke-width="4"/><path d="M${x - size} ${y} L${x - size * 1.7} ${y - size * 0.55} L${x - size * 1.7} ${y + size * 0.55}Z" fill="#ffbf66"/><circle cx="${x + size * 0.55}" cy="${y - size * 0.1}" r="${size * 0.09}" fill="#26324b"/>`;
  if (key === 'flower') return `${halo}<g fill="#ff96cb" stroke="#ffe7f5" stroke-width="3">${[0,60,120,180,240,300].map(angle => `<ellipse cx="${x}" cy="${y - size * 0.48}" rx="${size * 0.28}" ry="${size * 0.5}" transform="rotate(${angle} ${x} ${y})"/>`).join('')}</g><circle cx="${x}" cy="${y}" r="${size * 0.28}" fill="#ffde67"/>`;
  if (key === 'cake') return `${halo}<path d="M${x - size} ${y - size * 0.15} Q${x} ${y - size * 0.5} ${x + size} ${y - size * 0.15} L${x + size * 0.85} ${y + size * 0.8} L${x - size * 0.85} ${y + size * 0.8}Z" fill="#ffb0ca" stroke="#fff1da" stroke-width="4"/><path d="M${x} ${y - size * 0.4} L${x} ${y - size * 0.8}" stroke="#fff2a0" stroke-width="8"/><path d="${starPath(x, y - size, size * 0.2, size * 0.08)}" fill="#ffe77b"/>`;
  if (key === 'kite') return `${halo}<path d="M${x} ${y - size} L${x + size * 0.78} ${y} L${x} ${y + size} L${x - size * 0.78} ${y}Z" fill="#fa789d" stroke="#fff1da" stroke-width="5"/><path d="M${x} ${y + size} Q${x + size * 0.6} ${y + size * 1.3} ${x - size * 0.1} ${y + size * 1.8}" fill="none" stroke="#fff1da" stroke-width="3"/><path d="M${x} ${y} L${x + size * 0.78} ${y} M${x} ${y} L${x - size * 0.78} ${y} M${x} ${y} L${x} ${y - size}" stroke="#fff1da" stroke-width="3"/>`;
  if (key === 'lantern') return `${halo}<path d="M${x - size * 0.55} ${y - size * 0.75} Q${x} ${y - size * 1.1} ${x + size * 0.55} ${y - size * 0.75} L${x + size * 0.45} ${y + size * 0.65} Q${x} ${y + size} ${x - size * 0.45} ${y + size * 0.65}Z" fill="#ffb84f" stroke="#fff0b2" stroke-width="5"/><path d="M${x} ${y - size * 0.55} L${x} ${y + size * 0.6}" stroke="#fff5d0" stroke-width="6"/>`;
  return `${halo}<path d="M${x} ${y - size} L${x + size * 0.7} ${y - size * 0.2} L${x + size * 0.45} ${y + size} L${x - size * 0.45} ${y + size} L${x - size * 0.7} ${y - size * 0.2}Z" fill="#8deaff" stroke="#e8fdff" stroke-width="5"/><path d="M${x} ${y - size * 0.65} L${x} ${y + size * 0.65}" stroke="#fff" stroke-width="5" opacity=".8"/>`;
}

function buildLocalSvg(plan, sceneIndex, aspectRatio) {
  const portrait = aspectRatio === '9:16';
  const width = portrait ? 720 : 1280;
  const height = portrait ? 1280 : 720;
  const fantasy = /fantasi|dongeng/i.test(plan.style);
  const skyTop = fantasy ? '#24235b' : '#365f96';
  const skyBottom = fantasy ? '#9b7bc3' : '#9bd8e8';
  const groundY = portrait ? 900 : 485;
  const objectX = portrait ? [360, 475, 360][sceneIndex] : [640, 815, 640][sceneIndex];
  const objectY = portrait ? [600, 520, 460][sceneIndex] : [250, 205, 180][sceneIndex];
  const size = portrait ? 74 : 60;
  const charScale = portrait ? 0.9 : 0.68;
  const charY = portrait ? 1115 : 545;
  const charXs = portrait ? [145, 360, 575] : [390, 640, 890];
  const characters = pandaSvg(charXs[0] + sceneIndex * 6, charY, charScale)
    + foxSvg(charXs[1], charY + 5, charScale)
    + turtleSvg(charXs[2] - sceneIndex * 6, charY + 7, charScale);
  const stars = Array.from({ length: 16 }, (_, i) => {
    const x = (i * 137 + 71) % width;
    const y = 48 + ((i * 89 + 31) % Math.max(100, groundY - 120));
    return `<circle cx="${x}" cy="${y}" r="${2 + (i % 3)}" fill="#fff8d8" opacity="${0.35 + (i % 4) * 0.12}"/>`;
  }).join('');
  const hills = `<path d="M0 ${groundY} Q${width * 0.24} ${groundY - 150} ${width * 0.48} ${groundY} T${width} ${groundY - 35} L${width} ${height} L0 ${height}Z" fill="#639b72"/><path d="M0 ${groundY + 80} Q${width * 0.4} ${groundY - 10} ${width * 0.72} ${groundY + 80} T${width} ${groundY + 48} L${width} ${height} L0 ${height}Z" fill="#396c5c"/>`;
  const ground = `<path d="M0 ${groundY + 185} Q${width * 0.5} ${groundY + 115} ${width} ${groundY + 180} L${width} ${height} L0 ${height}Z" fill="#284f49"/>`;
  const glow = sceneIndex === 2 ? 1.55 : 1;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${skyTop}"/><stop offset="1" stop-color="${skyBottom}"/></linearGradient><radialGradient id="sun"><stop stop-color="#fff8c8"/><stop offset="1" stop-color="#ffe69a" stop-opacity="0"/></radialGradient></defs><rect width="${width}" height="${height}" fill="url(#sky)"/><circle cx="${portrait ? 565 : 1060}" cy="${portrait ? 210 : 110}" r="${portrait ? 145 : 110}" fill="url(#sun)"/><circle cx="${portrait ? 565 : 1060}" cy="${portrait ? 210 : 110}" r="${portrait ? 48 : 38}" fill="#fff4c0" opacity=".94"/>${stars}<path d="M${width * 0.12} ${groundY + 60} Q${width * 0.17} ${groundY - 115} ${width * 0.22} ${groundY + 60} M${width * 0.82} ${groundY + 65} Q${width * 0.88} ${groundY - 130} ${width * 0.94} ${groundY + 65}" fill="none" stroke="#416b5c" stroke-width="18" stroke-linecap="round"/>${hills}${ground}<ellipse cx="${objectX}" cy="${objectY}" rx="${size * 2.2}" ry="${size * 1.9}" fill="#fff0ac" opacity="${0.08 * glow}"/>${motifSvg(plan.motif.key, objectX, objectY, size, glow)}${characters}<path d="M${width * 0.08} ${height * 0.91} q20 -55 40 0 q20 -43 40 0 M${width * 0.82} ${height * 0.91} q18 -54 36 0 q18 -40 36 0" fill="none" stroke="#8fce7d" stroke-width="9" stroke-linecap="round" opacity=".8"/></svg>`;
}

async function probeDuration(filePath) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
  const duration = Number(String(stdout || '').trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Durasi narasi tidak dapat dibaca.');
  return duration;
}

export async function renderAnimation(plan, aspectRatio, onProgress = () => {}, outputDirectory) {
  const id = crypto.randomUUID();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videoteks-animasi-lokal-'));
  const assetDir = path.join(outputDirectory, id);
  const output = path.join(outputDirectory, `${id}.mp4`);
  let complete = false;
  try {
    await fs.mkdir(assetDir, { recursive: true });
    const framePaths = [];
    for (const [index] of plan.scenes.entries()) {
      onProgress(`Membuat ilustrasi vektor lokal ${index + 1}/3…`);
      const svgPath = path.join(tempDir, `scene-${index + 1}.svg`);
      const framePath = path.join(assetDir, `scene-${index + 1}.png`);
      await fs.writeFile(svgPath, buildLocalSvg(plan, index, aspectRatio), 'utf8');
      await exec('ffmpeg', ['-v', 'error', '-y', '-i', svgPath, '-frames:v', '1', framePath]);
      const stat = await fs.stat(framePath);
      if (stat.size < 10000) throw new Error('Ilustrasi lokal gagal dirender.');
      framePaths.push(framePath);
    }

    const narrationFile = path.join(tempDir, 'narration.wav');
    onProgress('Membuat narasi Bahasa Indonesia dengan eSpeak NG lokal…');
    await exec('espeak-ng', ['-v', 'id', '-s', '125', '-p', '48', '-a', '170', '-w', narrationFile, plan.narration]);
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
    onProgress('Merakit ilustrasi, gerak kamera, dan narasi menjadi MP4 20 detik…');
    await exec('ffmpeg', args);
    const stat = await fs.stat(output);
    if (stat.size < 10000) throw new Error('MP4 lokal terlalu kecil atau tidak valid.');
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
