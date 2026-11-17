// Runs Whisper in a background thread so the page stays responsive.
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6';

let asr = null, key = '';
const post = (id, type, extra = {}) => self.postMessage({ id, type, ...extra });

async function load(id, model, opt) {
  const k = model + '|' + opt.device;
  if (asr && key === k) return;
  asr = null; key = '';
  const progress_callback = p => { if (p.status === 'progress') post(id, 'progress', { p: { file: p.file, progress: p.progress } }); };
  post(id, 'status', { text: opt.device === 'webgpu' ? 'Loading the caption model (GPU)…' : 'Loading the caption model…' });
  asr = await pipeline('automatic-speech-recognition', model, { ...opt, progress_callback });
  key = k;
}

async function run(id, audio, lang) {
  const base = { chunk_length_s: 30, stride_length_s: 5, language: lang === 'auto' ? null : lang, task: 'transcribe' };
  post(id, 'status', { text: 'Writing captions. This can take a few minutes…' });
  try {
    const out = await asr(audio, { ...base, return_timestamps: 'word' });
    if (out.chunks && out.chunks.length) return { chunks: out.chunks, seg: false };
  } catch (e) { /* fall through to line-level timing */ }
  post(id, 'status', { text: 'Writing captions (simpler timing)…' });
  const out = await asr(audio, { ...base, return_timestamps: true });
  return { chunks: out.chunks || [], seg: true };
}

self.onmessage = async e => {
  const { id, model, lang, audio } = e.data;
  const tries = self.navigator.gpu
    ? [{ device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } }, { device: 'wasm' }]
    : [{ device: 'wasm' }];
  let lastErr;
  for (const opt of tries) {
    try {
      await load(id, model, opt);
      const r = await run(id, audio, lang);
      post(id, 'done', r);
      return;
    } catch (err) {
      lastErr = err; asr = null; key = '';
      post(id, 'status', { text: 'Trying another method…' });
    }
  }
  post(id, 'error', { message: String((lastErr && lastErr.message) || lastErr) });
};
