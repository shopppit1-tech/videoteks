import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const AUTO_VOICE = 'Kore';
const AUTO_STYLE = 'ceria dan bersemangat';
const DEFAULT_SUBTITLE_SETTINGS = {
  color: '#ec4899',
  template: 'pill',
  fontSize: 8,
  position: 'bottom',
  fontFamily: 'DejaVu Sans'
};

export function createAutoUploadMediaPipeline(dependencies) {
  const {
    exec,
    geminiRequest,
    responseText,
    jsonPart,
    model,
    inlineAudioMaxBytes,
    geminiKeysInRotation,
    rotateGeminiKeyAfter,
    coolDownGeminiKeyAfterFailure,
    isGeminiRetryableError,
    geminiKeyWaitMessage,
    uploadToGemini,
    deleteGeminiFile,
    toSrt,
    subtitleStyle
  } = dependencies;

  async function cleanup(...files) {
    await Promise.all(files.filter(Boolean).map((file) => fs.rm(file, { force: true }).catch(() => {})));
  }

  async function requestWithKeyRotation(requestModel, body, timeoutMs = 120000) {
    const keys = geminiKeysInRotation();
    if (!keys.length) throw new Error(geminiKeyWaitMessage());
    let lastError = null;
    for (const apiKey of keys) {
      try {
        const result = await geminiRequest(requestModel, body, apiKey, timeoutMs, 1);
        rotateGeminiKeyAfter(apiKey);
        return { result, apiKey };
      } catch (error) {
        lastError = error;
        if (!isGeminiRetryableError(error.status, error.message)) throw error;
        coolDownGeminiKeyAfterFailure(apiKey, error);
      }
    }
    throw lastError || new Error('Semua Gemini API key sedang tidak tersedia.');
  }

  async function createNarrationFromVideo(_videoPath) {
    const prompt = [
      'Buat paket konten YouTube original dalam bahasa Indonesia untuk video motivasi.',
      'Jangan membaca, menyalin, menerjemahkan, atau mengambil narasi dari video sumber. Narasi suara AI harus sepenuhnya berupa motivasi tentang cara kerja kehidupan: proses, kesabaran, kegagalan, kebiasaan, pilihan, disiplin, waktu, dan pertumbuhan diri.',
      'Tulis naskah voice-over yang hangat, kuat, reflektif, dan mudah dipahami. Mulai dengan hook yang menarik, gunakan contoh kehidupan umum tanpa menyebut fakta atau kejadian spesifik yang tidak diberikan, lalu tutup dengan kalimat yang mendorong penonton bertindak. Buat narasi mengalir dan cukup panjang untuk voice-over video pendek, tanpa basa-basi atau pengulangan.',
      'Buat judul YouTube maksimal 100 karakter dan deskripsi YouTube informatif 2–4 paragraf maksimal 5000 karakter yang sesuai dengan narasi motivasi. Buat 5–15 tag relevan tanpa tanda # dengan total maksimal 500 karakter.',
      'Kembalikan JSON valid saja dengan bentuk {"narration":"...","title":"...","description":"...","tags":["..."]}. Jangan gunakan markdown atau penjelasan tambahan.'
    ].join('\n\n');
    const { result } = await requestWithKeyRotation(process.env.GEMINI_MODEL || model, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.65, responseMimeType: 'application/json', maxOutputTokens: 3200 }
    });
    const modelOutput = responseText(result).trim().replace(/^```(?:text|json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let content = null;
    try {
      const parsed = JSON.parse(modelOutput);
      if (parsed && typeof parsed === 'object') content = parsed;
    } catch {
      content = null;
    }
    if (!content) throw new Error('Gemini tidak mengembalikan paket konten JSON yang valid.');
    const narration = String(content.narration || content.script || '').trim();
    const title = String(content.title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
    const description = String(content.description || '').trim().slice(0, 5000);
    const tags = [];
    const seenTags = new Set();
    let tagsLength = 0;
    for (const rawTag of Array.isArray(content.tags) ? content.tags : []) {
      const tag = String(rawTag || '').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
      const key = tag.toLowerCase();
      const nextLength = tagsLength + tag.length + (tags.length ? 1 : 0);
      if (!tag || seenTags.has(key) || nextLength > 500) continue;
      tags.push(tag);
      seenTags.add(key);
      tagsLength = nextLength;
      if (tags.length >= 15) break;
    }
    if (!narration) throw new Error('Gemini tidak mengirim teks narasi motivasi.');
    if (!title || !description) throw new Error('Gemini tidak mengirim judul dan deskripsi.');
    if (narration.length > 5000) throw new Error('Narasi motivasi melebihi batas suara 5.000 karakter.');
    return { narration, metadata: { title, description, tags } };
  }

  async function synthesizeNarration(text, outputPath) {
    const apiKey = String(process.env.GEMINI_TTS_API_KEY || '').trim();
    if (!apiKey) throw new Error('GEMINI_TTS_API_KEY belum diatur di server.');
    const data = await geminiRequest(process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts', {
      contents: [{ role: 'user', parts: [{ text, speech_metadata: { style: AUTO_STYLE } }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { voice: AUTO_VOICE } }
      }
    }, apiKey, 120000, 1);
    const audioData = data?.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData?.data;
    if (!audioData) throw new Error('Gemini tidak mengembalikan audio narasi.');
    await fs.writeFile(outputPath, Buffer.from(audioData, 'base64'));
    const stat = await fs.stat(outputPath);
    if (!stat.size) throw new Error('Audio narasi yang dibuat kosong.');
  }

  async function replaceVideoAudio(videoPath, audioPath, outputPath) {
    const audioProbeResult = await exec('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration:format=duration', '-of', 'json', audioPath]);
    const audioProbe = JSON.parse(audioProbeResult.stdout || '{}');
    const audioDurations = [audioProbe.streams?.[0]?.duration, audioProbe.format?.duration].map(Number).filter((value) => Number.isFinite(value) && value > 0);
    const audioDuration = audioDurations[0];
    if (!audioDuration) throw new Error('Durasi audio suara AI tidak dapat dibaca.');
    const ffmpegArgs = ['-y', '-stream_loop', '-1', '-i', videoPath, '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0', '-map_metadata', '0', '-t', audioDuration.toFixed(3), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];
    await exec('ffmpeg', [...ffmpegArgs, outputPath]);
    const outputStats = await fs.stat(outputPath);
    if (!outputStats.size) throw new Error('Video setelah penggantian audio kosong.');
  }

  async function transcribeForSubtitles(videoPath) {
    const audioPath = path.join(os.tmpdir(), `videoteks-auto-subtitle-${crypto.randomUUID()}.mp3`);
    try {
      await exec('ffmpeg', ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', audioPath]);
      const audioStats = await fs.stat(audioPath);
      if (!audioStats.size) throw new Error('Audio narasi untuk subtitle tidak ditemukan.');
      const useInlineAudio = audioStats.size <= inlineAudioMaxBytes;
      const inlineAudio = useInlineAudio ? await fs.readFile(audioPath, 'base64') : null;
      const prompt = 'Transkripsikan audio ini menjadi subtitle. Kembalikan JSON valid saja dengan bentuk {"segments":[{"start":0.0,"end":2.5,"text":"..."}]}. Gunakan waktu dalam detik, urutkan dari awal sampai akhir, pecah kalimat menjadi segmen pendek yang nyaman dibaca, dan tulis teks persis sesuai ucapan dalam bahasa aslinya. Jangan tambahkan markdown atau komentar.';
      const keys = geminiKeysInRotation();
      if (!keys.length) throw new Error(geminiKeyWaitMessage());
      let lastError = null;
      for (const apiKey of keys) {
        let geminiAudioFile = null;
        try {
          let audioPart;
          if (useInlineAudio) {
            audioPart = { inlineData: { mimeType: 'audio/mpeg', data: inlineAudio } };
          } else {
            geminiAudioFile = await uploadToGemini(audioPath, 'audio/mpeg', apiKey);
            audioPart = { fileData: { fileUri: geminiAudioFile.uri, mimeType: geminiAudioFile.mimeType || 'audio/mpeg' } };
          }
          const result = await geminiRequest(model, {
            contents: [{ parts: [{ text: prompt }, audioPart] }],
            generationConfig: { responseMimeType: 'application/json' }
          }, apiKey, 120000, 1);
          rotateGeminiKeyAfter(apiKey);
          const parsed = jsonPart(responseText(result));
          const segments = (Array.isArray(parsed?.segments) ? parsed.segments : [])
            .map((segment) => {
              const start = Math.max(0, Number(segment.start) || 0);
              const end = Number(segment.end) || (start + 2);
              const text = String(segment.text || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 1000);
              return { start, end, text };
            })
            .filter((segment) => segment.text && Number.isFinite(segment.end) && segment.end > segment.start)
            .slice(0, 3000);
          if (!segments.length) throw new Error('Gemini tidak menghasilkan segmen subtitle dari narasi.');
          return segments;
        } catch (error) {
          lastError = error;
          if (!isGeminiRetryableError(error.status, error.message)) throw error;
          coolDownGeminiKeyAfterFailure(apiKey, error);
        } finally {
          if (geminiAudioFile?.name) await deleteGeminiFile(geminiAudioFile.name, apiKey);
        }
      }
      throw lastError || new Error('Gemini gagal membuat subtitle.');
    } finally {
      await cleanup(audioPath);
    }
  }

  async function renderSubtitles(videoPath, segments, srtPath, outputPath) {
    if (!segments.length) throw new Error('Tidak ada subtitle yang dapat dirender.');
    await fs.writeFile(srtPath, toSrt(segments), 'utf8');
    const style = subtitleStyle(DEFAULT_SUBTITLE_SETTINGS);
    const ffmpegArgs = ['-y', '-i', videoPath, '-vf', `subtitles=${srtPath}:force_style='${style}'`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25'];
    try {
      await exec('ffmpeg', [...ffmpegArgs, '-c:a', 'copy', outputPath]);
    } catch (error) {
      const details = `${error.message}\n${error.stderr || ''}`;
      if (!/could not find tag for codec|not currently supported in container|could not write header|codec .* incompatible with output/i.test(details)) throw error;
      await cleanup(outputPath);
      await exec('ffmpeg', [...ffmpegArgs, '-c:a', 'aac', '-b:a', '128k', outputPath]);
    }
    const outputStats = await fs.stat(outputPath);
    if (!outputStats.size) throw new Error('Video bersubtitle yang dihasilkan kosong.');
  }

  return async function processAutoUploadMediaPipeline(videoPath, onStage = async () => {}) {
    const id = crypto.randomUUID();
    const voiceAudioPath = path.join(os.tmpdir(), `videoteks-auto-${id}-voice.wav`);
    const audioReplacedPath = path.join(os.tmpdir(), `videoteks-auto-${id}-audio.mp4`);
    const subtitlePath = path.join(os.tmpdir(), `videoteks-auto-${id}.srt`);
    const finalVideoPath = path.join(os.tmpdir(), `videoteks-auto-${id}-final.mp4`);
    const cleanupPaths = [voiceAudioPath, audioReplacedPath, subtitlePath, finalVideoPath];
    try {
      await onStage('analyzing');
      const narrationResult = await createNarrationFromVideo(videoPath);
      const narration = narrationResult.narration;
      await onStage('voice');
      await synthesizeNarration(narration, voiceAudioPath);
      await onStage('replacing-audio');
      await replaceVideoAudio(videoPath, voiceAudioPath, audioReplacedPath);
      await onStage('transcribing-subtitles');
      const segments = await transcribeForSubtitles(audioReplacedPath);
      await onStage('rendering-subtitles');
      await renderSubtitles(audioReplacedPath, segments, subtitlePath, finalVideoPath);
      return { finalVideoPath, cleanupPaths, narration, metadata: narrationResult.metadata, segmentCount: segments.length };
    } catch (error) {
      await cleanup(...cleanupPaths);
      throw error;
    }
  };
}
