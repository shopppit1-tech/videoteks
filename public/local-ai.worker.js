const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/+esm';
const FFMPEG_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js';
const FFMPEG_UTIL_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js';
const FFMPEG_PACKAGE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm';
const FFMPEG_CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
const FRANC_URL = 'https://cdn.jsdelivr.net/npm/franc-min@6.2.0/+esm';
const WHISPER_MODEL = 'onnx-community/whisper-tiny';
const TRANSLATION_MODEL = 'Xenova/m2m100_418M';
const SAMPLE_RATE = 16000;
const M2M_LANGUAGES = new Set(['ar', 'de', 'en', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'ms', 'pt', 'ru', 'th', 'vi', 'zh']);
const FRANC_TO_M2M = {
  ara: 'ar', deu: 'de', eng: 'en', fra: 'fr', hin: 'hi', ind: 'id', jpn: 'ja', kor: 'ko',
  msa: 'ms', por: 'pt', rus: 'ru', spa: 'es', tha: 'th', vie: 'vi', zho: 'zh', cmn: 'zh'
};

let ffmpegPromise;
let whisperPipelines = new Map();
let translatorPipelines = new Map();
let francPromise;
let transformersPromise;

function send(id, type, data = {}) {
  self.postMessage({ id, type, ...data });
}

function report(id, stage, message, progress = null) {
  send(id, 'progress', { stage, message, progress });
}

async function getTransformers() {
  if (!transformersPromise) {
    transformersPromise = import(TRANSFORMERS_URL).then((module) => {
      module.env.allowRemoteModels = true;
      module.env.useBrowserCache = true;
      module.env.backends.onnx.wasm.numThreads = 1;
      module.env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/';
      return module;
    });
  }
  return transformersPromise;
}

async function availableDevices() {
  try {
    if (self.navigator?.gpu && await self.navigator.gpu.requestAdapter()) return ['webgpu', 'wasm'];
  } catch {}
  return ['wasm'];
}

async function getFfmpeg(id) {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      report(id, 'extract', 'Menyiapkan FFmpeg lokal…');
      const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
        import(FFMPEG_URL),
        import(FFMPEG_UTIL_URL)
      ]);
      const ffmpeg = new FFmpeg();
      ffmpeg.on('progress', ({ progress }) => {
        if (Number.isFinite(progress)) report(id, 'extract', 'Mengekstrak audio di perangkat…', Math.round(progress * 100));
      });
      const [coreURL, wasmURL, workerResponse] = await Promise.all([
        toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
        toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
        fetch(`${FFMPEG_PACKAGE_BASE}/worker.js`)
      ]);
      if (!workerResponse.ok) throw new Error(`Gagal mengunduh FFmpeg worker (HTTP ${workerResponse.status}).`);
      const workerSource = (await workerResponse.text())
        .replaceAll('"./const.js"', `"${FFMPEG_PACKAGE_BASE}/const.js"`)
        .replaceAll('"./errors.js"', `"${FFMPEG_PACKAGE_BASE}/errors.js"`);
      const classWorkerURL = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
      try {
        await ffmpeg.load({ coreURL, wasmURL, classWorkerURL });
      } finally {
        URL.revokeObjectURL(classWorkerURL);
      }
      return ffmpeg;
    })().catch((error) => {
      ffmpegPromise = null;
      throw error;
    });
  }
  return ffmpegPromise;
}

async function extractAudio(file, id) {
  if (!file || !file.size) throw new Error('File video kosong atau tidak dapat dibaca.');
  report(id, 'extract', 'Membuka mesin ekstraksi audio lokal…');
  const ffmpeg = await getFfmpeg(id);
  const inputName = 'videoteks-input';
  const outputName = 'videoteks-audio.f32';
  try { await ffmpeg.deleteFile(inputName); } catch {}
  try { await ffmpeg.deleteFile(outputName); } catch {}
  report(id, 'extract', 'Membaca file video di perangkat…');
  await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));
  const result = await ffmpeg.exec([
    '-i', inputName, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE),
    '-f', 'f32le', '-acodec', 'pcm_f32le', outputName
  ]);
  if (result !== 0) throw new Error('Audio tidak dapat diekstrak. Pastikan video memiliki trek audio yang didukung.');
  const bytes = await ffmpeg.readFile(outputName);
  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4 || bytes.byteLength % 4 !== 0) {
    throw new Error('Audio hasil ekstraksi kosong atau rusak.');
  }
  const audio = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  return { audio, duration: audio.length / SAMPLE_RATE };
}

function modelProgress(id, stage, prefix) {
  return (event = {}) => {
    if (event.status === 'progress' && Number.isFinite(event.progress)) {
      report(id, stage, `${prefix} ${event.file || 'model'} (${Math.round(event.progress)}%)`, Math.round(event.progress));
    } else if (event.status === 'initiate') {
      report(id, stage, `${prefix} mengunduh ${event.file || 'model'}…`);
    } else if (event.status === 'done') {
      report(id, stage, `${prefix} selesai memuat ${event.file || 'model'}.`);
    }
  };
}

async function transcriberFor(device, id) {
  if (!whisperPipelines.has(device)) {
    const { pipeline } = await getTransformers();
    const options = {
      dtype: 'q8',
      progress_callback: modelProgress(id, 'asr-model', 'Model pengenal suara lokal')
    };
    if (device === 'webgpu') options.device = 'webgpu';
    const instance = await pipeline('automatic-speech-recognition', WHISPER_MODEL, options);
    whisperPipelines.set(device, instance);
  }
  return whisperPipelines.get(device);
}

function normalizeSegments(output, duration) {
  const chunks = Array.isArray(output?.chunks) ? output.chunks : [];
  const segments = chunks.map((chunk) => {
    const timestamp = Array.isArray(chunk.timestamp) ? chunk.timestamp : [];
    const start = timestamp[0] == null ? NaN : Number(timestamp[0]);
    const end = timestamp[1] == null ? NaN : Number(timestamp[1]);
    return {
      start: Number.isFinite(start) ? Math.max(0, start) : 0,
      end: Number.isFinite(end) ? Math.max(Number.isFinite(start) ? start : 0, end) : duration,
      text: String(chunk.text || '').trim()
    };
  }).filter((segment) => segment.text);
  if (segments.length) return segments;
  const text = String(output?.text || '').trim();
  return text ? [{ start: 0, end: duration, text }] : [];
}

async function transcribe(file, id) {
  report(id, 'extract', 'Video tetap di perangkat. Mengekstrak audio secara lokal…');
  const { audio, duration } = await extractAudio(file, id);
  if (!audio.length) throw new Error('Tidak ditemukan audio pada video.');
  report(id, 'asr-model', 'Menyiapkan model pengenal ucapan lokal…');
  const devices = await availableDevices();
  let lastError;
  for (const device of devices) {
    try {
      const transcriber = await transcriberFor(device, id);
      report(id, 'asr', 'Mengenali ucapan di perangkat…');
      const output = await transcriber(audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true
      });
      const segments = normalizeSegments(output, duration);
      if (!segments.length) throw new Error('Ucapan tidak berhasil dikenali. Coba video lain atau periksa audionya.');
      return { segments, duration, model: WHISPER_MODEL, execution: device };
    } catch (error) {
      lastError = error;
      if (device !== 'webgpu') throw error;
      whisperPipelines.delete(device);
      report(id, 'asr-model', 'GPU browser tidak cocok; mencoba mode lokal CPU…');
    }
  }
  throw lastError || new Error('Transkripsi lokal gagal.');
}

function toM2mLanguage(language) {
  if (M2M_LANGUAGES.has(language)) return language;
  throw new Error('Bahasa sumber belum didukung model lokal. Pilih bahasa ucapan secara manual, lalu coba lagi.');
}

async function detectSourceLanguage(text) {
  if (!francPromise) francPromise = import(FRANC_URL).then((module) => module.franc || module.default?.franc || module.default);
  const franc = await francPromise;
  const detected = franc(text, { minLength: 10 });
  return FRANC_TO_M2M[detected] || '';
}

async function getTranslator(id, device) {
  if (!translatorPipelines.has(device)) {
    const translatorPromise = (async () => {
      const { pipeline } = await getTransformers();
      const options = {
        dtype: 'q8',
        progress_callback: modelProgress(id, 'translate-model', 'Model penerjemah lokal')
      };
      if (device === 'webgpu') options.device = 'webgpu';
      return pipeline('translation', TRANSLATION_MODEL, options);
    })();
    translatorPipelines.set(device, translatorPromise);
    translatorPromise.catch(() => translatorPipelines.delete(device));
  }
  return translatorPipelines.get(device);
}

async function translate(segments, requestedSource, target, id) {
  if (!Array.isArray(segments) || !segments.length) throw new Error('Belum ada segmen subtitle untuk diterjemahkan.');
  const targetCode = toM2mLanguage(String(target || '').trim());
  const sourceText = segments.map((segment) => String(segment.text || '').trim()).filter(Boolean).join(' ');
  if (!sourceText) throw new Error('Teks subtitle masih kosong.');
  const sourceCode = requestedSource === 'auto'
    ? toM2mLanguage(await detectSourceLanguage(sourceText))
    : toM2mLanguage(String(requestedSource || '').trim());
  if (sourceCode === targetCode) {
    return { segments, sourceLanguage: sourceCode, targetLanguage: targetCode, unchanged: true };
  }
  const devices = await availableDevices();
  let lastError;
  for (const device of devices) {
    try {
      const translator = await getTranslator(id, device);
      const output = [];
      const batchSize = 4;
      for (let offset = 0; offset < segments.length; offset += batchSize) {
        const batch = segments.slice(offset, offset + batchSize);
        report(id, 'translate', `Menerjemahkan segmen ${Math.min(offset + batch.length, segments.length)} dari ${segments.length} di perangkat…`, Math.round((offset / segments.length) * 100));
        const texts = batch.map((segment) => String(segment.text || '').trim());
        const translated = await translator(texts, { src_lang: sourceCode, tgt_lang: targetCode, max_new_tokens: 128 });
        if (!Array.isArray(translated) || translated.length !== batch.length) {
          throw new Error('Model lokal tidak mengembalikan jumlah segmen yang sesuai.');
        }
        output.push(...batch.map((segment, index) => ({ ...segment, text: String(translated[index]?.translation_text || '').trim() || segment.text })));
      }
      return { segments: output, sourceLanguage: sourceCode, targetLanguage: targetCode, unchanged: false };
    } catch (error) {
      lastError = error;
      if (device !== 'webgpu') throw error;
      translatorPipelines.delete(device);
      report(id, 'translate-model', 'GPU browser tidak cocok; mencoba penerjemah lokal CPU…');
    }
  }
  throw lastError || new Error('Terjemahan lokal gagal.');
}

self.addEventListener('message', async (event) => {
  const { id, type, payload = {} } = event.data || {};
  if (!id) return;
  try {
    let result;
    if (type === 'transcribe') result = await transcribe(payload.file, id);
    else if (type === 'translate') result = await translate(payload.segments, payload.sourceLanguage, payload.targetLanguage, id);
    else throw new Error('Perintah pemrosesan lokal tidak dikenal.');
    send(id, 'result', { result });
  } catch (error) {
    send(id, 'error', { error: error?.message || 'Pemrosesan lokal gagal.' });
  }
});
