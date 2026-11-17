// Runs Whisper in a background thread so the page stays responsive.
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6';

let asr = null, current = '';
const post = (id, type, extra = {}) => self.postMessage({ id, type, ...extra });

async function load(id, model) {
  if (asr && current === model) return;
  const progress_callback = p => { if (p.status === 'progress') post(id, 'progress', { p: { file: p.file, progress: p.progress } }); };
  const tries = self.navigator.gpu
    ? [{ device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } }, { device: 'wasm' }]
    : [{ device: 'wasm' }];
  let lastErr;
  for (const opt of tries) {
    try {
      post(id, 'status', { text: opt.device === 'webgpu' ? 'Loading the caption model (GPU)…' : 'Loading the caption model…' });
      asr = await pipeline('automatic-speech-recognition', model, { ...opt, progress_callback });
      current = model;
      return;
    } catch (e) { lastErr = e; asr = null; }
  }
  throw lastErr;
}

self.onmessage = async e => {
  const { id, model, lang, audio } = e.data;
  try {
    await load(id, model);
    post(id, 'status', { text: 'Writing captions. This can take a few minutes…' });
    const out = await asr(audio, {
      return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5,
      language: lang === 'auto' ? null : lang, task: 'transcribe',
    });
    post(id, 'done', { chunks: out.chunks || [] });
  } catch (err) {
    post(id, 'error', { message: String((err && err.message) || err) });
  }
};
