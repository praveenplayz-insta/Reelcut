import { fmt, pickClips, groupWords, parseSubs, smooth, interp } from './lib.js';

const $ = id => document.getElementById(id);
const v = $('v'), c = $('c'), x = c.getContext('2d'), W = c.width, H = c.height;
let file = null, dur = 0, audio = null, words = [], groups = [], track = null, busy = false;
let worker = null, jobId = 0, detector = null, ac = null, dst = null, outUrl = null;

const st = m => { $('st').textContent = m; };
function setBusy(b) { busy = b; document.querySelectorAll('.act').forEach(e => { e.disabled = b || !file; }); }
const range = () => [+$('s').value, +$('e').value];
function seek(t) {
  return new Promise((res, rej) => {
    if (Math.abs(v.currentTime - t) < 0.001) { res(); return; }
    const clean = () => { v.removeEventListener('seeked', ok); v.removeEventListener('error', bad); clearTimeout(to); };
    const ok = () => { clean(); res(); }, bad = () => { clean(); rej(new Error('video-error')); };
    const to = setTimeout(bad, 10000);
    v.addEventListener('seeked', ok); v.addEventListener('error', bad); v.currentTime = t;
  });
}
async function guard(fn) {
  if (busy) return;
  setBusy(true);
  try { await fn(); } catch (err) { st(friendly(err)); console.error(err); }
  $('bar').style.display = 'none'; setBusy(false);
}
function friendly(err) {
  const m = String((err && err.message) || err);
  const det = ' Details: ' + m.slice(0, 160);
  if (/video-error|stalled/.test(m)) return 'Your device could not play this video smoothly. Try a shorter clip, a 720p H.264 MP4, or a computer.';
  if (/memory|allocation|decode/i.test(m)) return 'This video is too large for your browser. Trim it to under about 20 minutes and try again.' + det;
  if (/fetch|network|import|load/i.test(m)) return 'Could not load the AI model. Check your internet connection and try again.' + det;
  return 'Something went wrong.' + det;
}

// ---------- drawing ----------
function paint() {
  if (!v.videoWidth) return;
  const sc = Math.max(W / v.videoWidth, H / v.videoHeight), dw = v.videoWidth * sc, dh = v.videoHeight * sc;
  const f = track ? interp(track.t, track.x, v.currentTime) : null;
  const left = f == null ? (dw - W) * $('pos').value / 100 : Math.max(0, Math.min(dw - W, f * dw - W / 2));
  x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
  x.drawImage(v, -left, -(dh - H) / 2, dw, dh);
  if ($('capon').checked) drawCaption();
}
function drawCaption() {
  const t = v.currentTime, g = groups.find(q => t >= q.a && t < q.b);
  if (!g) return;
  let hi = 0; g.w.forEach((q, i) => { if (q.s <= t) hi = i; });
  const up = $('upper').checked, S = W / 540;
  x.font = `800 ${Math.round(44 * S)}px "Bricolage Grotesque",system-ui,sans-serif`;
  x.textAlign = 'left'; x.lineJoin = 'round'; x.lineWidth = 9 * S;
  const sp = x.measureText(' ').width, lines = []; let cur = [], cw = 0;
  g.w.forEach((q, i) => {
    const txt = up ? q.w.toUpperCase() : q.w, ww = x.measureText(txt).width;
    if (cur.length && cw + sp + ww > W - 70 * S) { lines.push({ w: cur, width: cw }); cur = []; cw = 0; }
    cur.push({ txt, i, ww }); cw += (cur.length > 1 ? sp : 0) + ww;
  });
  lines.push({ w: cur, width: cw });
  const lh = 54 * S, y0 = H - 190 * S - (lines.length - 1) * lh;
  lines.forEach((ln, li) => {
    let px = (W - ln.width) / 2; const y = y0 + li * lh;
    ln.w.forEach(o => {
      x.strokeStyle = '#000'; x.strokeText(o.txt, px, y);
      x.fillStyle = o.i === hi ? '#ffe14d' : '#fff'; x.fillText(o.txt, px, y);
      px += o.ww + sp;
    });
  });
}
async function showFrame() { if (!dur || busy) return; await seek(range()[0]); paint(); }

// ---------- loading ----------
$('file').onchange = e => {
  file = e.target.files[0]; if (!file) return;
  audio = null; words = []; groups = []; track = null; $('chips').innerHTML = ''; $('out').style.display = 'none';
  v.src = URL.createObjectURL(file); st('Loading video…');
};
v.onloadedmetadata = () => {
  dur = v.duration;
  ['s', 'e'].forEach(i => { $(i).max = dur; $(i).disabled = false; });
  $('s').value = 0; $('e').value = Math.min(dur, +$('len').value); sync();
  setBusy(false);
  st(dur > 1500 ? 'This video is long. Captions may fail in the browser, so trim it first if they do.' : 'Ready. Choose your clip below.');
  showFrame();
};
v.onerror = () => { if (!busy) st('Your browser can’t read that video. Try an MP4.'); };
function sync() {
  let [s, e] = range();
  if (e < s + 1) { e = Math.min(dur, s + 1); $('e').value = e; }
  $('sv').textContent = fmt(s); $('ev').textContent = fmt(e);
}
$('s').oninput = () => { track = null; sync(); }; $('e').oninput = () => { track = null; sync(); };
$('s').onchange = showFrame; $('pos').oninput = () => { track = null; paint(); };
$('capon').onchange = paint; $('upper').onchange = paint;

// ---------- captions (Whisper in a worker) ----------
async function getAudio() {
  if (audio) return audio;
  st('Reading the audio…');
  const AC = window.AudioContext || window.webkitAudioContext, a = new AC();
  const buf = await a.decodeAudioData(await file.arrayBuffer()); a.close();
  const off = new OfflineAudioContext(1, Math.ceil(buf.duration * 16000), 16000);
  const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
  audio = (await off.startRendering()).getChannelData(0);
  return audio;
}
// Line-level timing fallback: spread each line's words evenly across its time span.
function spread(chunks, offset) {
  const out = [];
  chunks.forEach(q => {
    const ws = (q.text || '').trim().split(/\s+/).filter(Boolean), a = offset + q.timestamp[0], b = offset + (q.timestamp[1] ?? q.timestamp[0] + 3);
    ws.forEach((w, k) => out.push({ w, s: a + (b - a) * k / ws.length, e: a + (b - a) * (k + 1) / ws.length }));
  });
  return out;
}
// One audio graph shared by captions and export (a video element can only be connected once).
let srcNode = null;
function audioGraph() {
  if (!ac) {
    const AC = window.AudioContext || window.webkitAudioContext; ac = new AC();
    srcNode = ac.createMediaElementSource(v); dst = ac.createMediaStreamDestination(); srcNode.connect(dst);
  }
  return ac;
}
// Listens to only the chosen clip in real time. Uses very little memory, so it works on phones and long videos.
async function captureAudio(s, e) {
  const a = audioGraph(); await a.resume();
  const sp = a.createScriptProcessor(4096, 2, 1), parts = [];
  sp.onaudioprocess = ev => {
    const L = ev.inputBuffer.getChannelData(0), R = ev.inputBuffer.numberOfChannels > 1 ? ev.inputBuffer.getChannelData(1) : L, m = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) m[i] = (L[i] + R[i]) / 2;
    parts.push(m);
  };
  srcNode.connect(sp); sp.connect(a.destination);
  const stop = () => { try { srcNode.disconnect(sp); sp.disconnect(); } catch (_) { /* already gone */ } sp.onaudioprocess = null; };
  try {
    v.pause(); await seek(s); v.muted = false; await v.play();
    $('bar').style.display = 'block';
    await new Promise((res, rej) => {
      let last = -1, lastAt = performance.now();
      v.addEventListener('error', () => rej(new Error('video-error')), { once: true });
      const iv = setInterval(() => {
        const t = v.currentTime;
        $('bi').style.width = Math.min(100, (t - s) / (e - s) * 100) + '%'; st('Listening to the clip… ' + Math.round(Math.min(100, (t - s) / (e - s) * 100)) + '%');
        if (t >= e || v.ended) { clearInterval(iv); res(); return; }
        if (t !== last) { last = t; lastAt = performance.now(); } else if (performance.now() - lastAt > 8000) { clearInterval(iv); rej(new Error('stalled')); }
      }, 200);
    });
  } finally { v.pause(); stop(); }
  const n = parts.reduce((t, c) => t + c.length, 0), sr = a.sampleRate;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(n / sr * 16000)), 16000), buf = off.createBuffer(1, n, sr);
  let o = 0; const ch = buf.getChannelData(0); parts.forEach(c => { ch.set(c, o); o += c.length; });
  const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
  return (await off.startRendering()).getChannelData(0);
}
function asr(chunk, offset) {
  return new Promise((res, rej) => {
    if (!worker) worker = new Worker('./asr-worker.js', { type: 'module' });
    const id = ++jobId, t0 = Date.now();
    worker.onerror = e => rej(new Error(e.message || 'Could not start the caption worker'));
    worker.onmessage = e => {
      const m = e.data; if (m.id !== id) return;
      if (m.type === 'status') st(m.text);
      else if (m.type === 'progress') { $('bar').style.display = 'block'; $('bi').style.width = (m.p.progress || 0) + '%'; st('Downloading the caption model (first time only)… ' + Math.round(m.p.progress || 0) + '%'); }
      else if (m.type === 'done') {
        $('bar').style.display = 'none';
        if (m.seg) { res(spread(m.chunks, offset)); return; }
        res(m.chunks.map(q => ({ w: (q.text || '').trim(), s: offset + q.timestamp[0], e: offset + (q.timestamp[1] ?? q.timestamp[0] + 0.4) })).filter(q => q.w).map(q => ({ ...q, e: Math.max(q.e, q.s + 0.1) })));
      } else if (m.type === 'error') rej(new Error(m.message));
    };
    const buf = chunk.slice(); worker.postMessage({ id, model: $('model').value, lang: $('lang').value, audio: buf }, [buf.buffer]);
  });
}
function setWords(ws) { words = ws; groups = groupWords(words); paint(); }

$('cap').onclick = () => guard(async () => {
  const [s, e] = range();
  const ws = await asr(await captureAudio(s, e), s);
  if (!ws.length) { st('No speech found in this part of the video.'); return; }
  setWords(words.filter(q => q.e <= s || q.s >= e).concat(ws).sort((p, q) => p.s - q.s));
  await seek(s); paint(); st('Captions are ready. Check the preview.');
});
$('auto').onclick = () => guard(async () => {
  const phone = /Android|iPhone|iPad/i.test(navigator.userAgent);
  if (file.size > (phone ? 60e6 : 300e6) || dur > (phone ? 480 : 1500)) {
    st(phone ? 'This video is too big to scan on a phone. Pick a clip with the sliders, then tap “Write captions for this clip”.' : 'This video is too big to scan in the browser. Pick a clip with the sliders instead.');
    return;
  }
  const a = await getAudio(), ws = await asr(a, 0);
  if (!ws.length) { st('No speech found in this video.'); return; }
  setWords(ws);
  const picks = pickClips(ws, 3, +$('len').value, dur);
  $('chips').innerHTML = '';
  picks.forEach((p, k) => {
    const b = document.createElement('button'); b.className = 'chip'; b.textContent = `Clip ${k + 1}: ${fmt(p[0])} to ${fmt(p[1])}`;
    b.onclick = async () => { $('s').value = p[0]; $('e').value = p[1]; track = null; sync(); await seek(p[0]); paint(); };
    $('chips').appendChild(b);
  });
  st('Tap a clip to use it. Captions are already done for the whole video.');
});
$('srt').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const ws = parseSubs(await f.text());
  if (!ws.length) { st('Could not read captions from that file.'); return; }
  setWords(ws); st('Captions loaded from your file.');
};

// ---------- face tracking (MediaPipe, with backups) ----------
const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21';
let mpError = '';
async function getDetector() {
  if (detector) return detector;
  const { FilesetResolver, FaceDetector } = await import(MP + '/vision_bundle.mjs');
  const fs = await FilesetResolver.forVisionTasks(MP + '/wasm');
  detector = await FaceDetector.createFromOptions(fs, {
    baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite' },
    runningMode: 'IMAGE', minDetectionConfidence: 0.3,
  });
  return detector;
}
// Each detector takes an image source and returns boxes as {x, y, w, h} in that source's pixels.
async function getDetectors() {
  const list = [];
  try {
    const d = await getDetector();
    list.push(async src => (d.detect(src).detections || []).map(q => ({ x: q.boundingBox.originX, y: q.boundingBox.originY, w: q.boundingBox.width, h: q.boundingBox.height })));
  } catch (err) { mpError = String((err && err.message) || err); }
  if ('FaceDetector' in window) {
    try {
      const nd = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 4 });
      list.push(async src => (await nd.detect(src)).map(q => ({ x: q.boundingBox.x, y: q.boundingBox.y, w: q.boundingBox.width, h: q.boundingBox.height })));
    } catch (_) { /* not available */ }
  }
  return list;
}
const crop = document.createElement('canvas');
// Looks for the biggest face. If the whole frame finds nothing (faces look small in wide shots), tries three zoomed crops.
async function findFace(dets) {
  const vw = v.videoWidth, vh = v.videoHeight;
  for (const det of dets) {
    let b = [];
    try { b = await det(v); } catch (_) { /* try next */ }
    if (b.length) return pick(b, 0, 1);
    if (vw > vh * 1.2) {
      const cs = vh, k = cs / Math.min(cs, 640); crop.width = crop.height = Math.min(cs, 640);
      for (const ox of [(vw - cs) / 2, 0, vw - cs]) {
        crop.getContext('2d').drawImage(v, ox, 0, cs, cs, 0, 0, crop.width, crop.height);
        try { b = await det(crop); } catch (_) { b = []; }
        if (b.length) return pick(b, ox, k);
      }
    }
  }
  return null;
}
const pick = (b, ox, k) => { const q = b.sort((p, r) => r.w * r.h - p.w * p.h)[0]; return ox + (q.x + q.w / 2) * k; };

$('face').onclick = () => guard(async () => {
  st('Loading face detection…');
  const dets = await getDetectors();
  if (!dets.length) { st('Face detection could not load on this device. Use the position slider.' + (mpError ? ' Details: ' + mpError.slice(0, 140) : '')); return; }
  const [s, e] = range(), ts = [], xs = [];
  $('bar').style.display = 'block';
  for (let t = s; t <= e + 1e-6; t += 0.5) {
    await seek(Math.min(t, dur - 0.05));
    const cx = await findFace(dets);
    if (cx != null) { ts.push(t); xs.push(cx / v.videoWidth); }
    $('bi').style.width = ((t - s) / (e - s) * 100) + '%'; st('Finding the speaker… ' + Math.round((t - s) / (e - s) * 100) + '%');
  }
  if (!ts.length) { track = null; st('No face found in this clip. It may be too small or turned away. Use the position slider.'); await seek(s); paint(); return; }
  track = smooth(ts, xs); await seek(s); paint();
  st(`The crop now follows the speaker (found in ${ts.length} of ${Math.floor((e - s) / 0.5) + 1} samples).`);
});

// ---------- export ----------
$('go').onclick = () => guard(async () => {
  const mime = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
  if (!mime) { st('This browser can’t record video. Use a recent Chrome, Edge, Safari or Firefox.'); return; }
  const [s, e] = range();
  audioGraph(); await ac.resume();
  const stream = c.captureStream(30); dst.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5e6 }), parts = [];
  rec.ondataavailable = ev => { if (ev.data.size) parts.push(ev.data); };
  const done = new Promise(r => { rec.onstop = r; });
  v.pause(); await seek(s); paint();
  $('bar').style.display = 'block'; st('Exporting in real time. Keep this tab open and visible.');
  rec.start(500); v.muted = false; await v.play();
  try {
    await new Promise((res, rej) => {
      let last = -1, lastAt = performance.now();
      v.addEventListener('error', () => rej(new Error('video-error')), { once: true });
      (function tick() {
        paint(); $('bi').style.width = Math.min(100, (v.currentTime - s) / (e - s) * 100) + '%';
        if (v.currentTime >= e || v.ended) { v.pause(); rec.stop(); res(); return; }
        if (v.currentTime !== last) { last = v.currentTime; lastAt = performance.now(); }
        else if (performance.now() - lastAt > 8000) { rej(new Error('stalled')); return; }
        requestAnimationFrame(tick);
      })();
    });
  } catch (err) {
    v.pause(); try { if (rec.state !== 'inactive') rec.stop(); } catch (_) {}
    throw err;
  }
  await done;
  const ext = mime.includes('mp4') ? 'mp4' : 'webm', blob = new Blob(parts, { type: mime.split(';')[0] });
  if (outUrl) URL.revokeObjectURL(outUrl);
  outUrl = URL.createObjectURL(blob);
  $('rv').src = outUrl; $('dl').href = outUrl; $('dl').download = 'reelcut-clip.' + ext;
  $('info').textContent = `${fmt(e - s)} clip, ${(blob.size / 1048576).toFixed(1)} MB, ${ext.toUpperCase()}`
    + (mime.includes('avc1') ? '' : '. This browser did not use the H.264 format, so some apps may refuse the upload. If that happens, export again in recent desktop Chrome or Safari.');
  $('out').style.display = 'flex'; st('Done.');
  $('out').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
setBusy(false);
if (/Android|iPhone|iPad/i.test(navigator.userAgent)) $('model').value = 'Xenova/whisper-tiny';
