// Pure helpers (no browser APIs) so they can be tested in Node.
export const fmt = t => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');

// Picks the most talkative, hook-like stretches that start and end on sentence boundaries.
export function pickClips(words, n, length, total) {
  const lo = length * 0.6, hi = length * 1.5;
  const ends = [];
  words.forEach((w, i) => { if (/[.!?…。！？]$/.test(w.w)) ends.push(i); });
  const starts = [0, ...ends.map(i => i + 1).filter(i => i < words.length)];
  let cands = [];
  for (const si of starts) {
    for (const ei of ends) {
      if (ei <= si) continue;
      const d = words[ei].e - words[si].s;
      if (d < lo) continue;
      if (d > hi) break;
      const txt = words.slice(si, ei + 1).map(w => w.w).join(' ');
      const rate = (ei - si + 1) / d;
      const score = rate * (1 + 0.25 * (txt.match(/\?/g) || []).length + 0.15 * (txt.match(/!/g) || []).length) + (/\d/.test(txt) ? 0.5 : 0);
      cands.push([score, words[si].s, words[ei].e]);
    }
  }
  if (!cands.length) for (let t = 0; t + lo < total; t += length) cands.push([1, t, Math.min(total, t + length)]);
  cands.sort((a, b) => b[0] - a[0]);
  const chosen = [];
  for (const [, a, b] of cands) {
    if (chosen.every(c => b <= c[0] || a >= c[1])) chosen.push([Math.max(0, a - 0.2), Math.min(total, b + 0.3)]);
    if (chosen.length === n) break;
  }
  return chosen.sort((p, q) => p[0] - q[0]);
}

// Groups words into short caption lines (max 4 words, about 20 characters, or end of sentence).
export function groupWords(words) {
  const groups = []; let cur = [];
  const flush = () => { if (cur.length) { groups.push({ a: cur[0].s, b: cur[cur.length - 1].e + 0.15, w: cur }); cur = []; } };
  for (const w of words) {
    cur.push(w);
    if (cur.length >= 4 || cur.reduce((n, q) => n + q.w.length, 0) >= 20 || /[.!?,;:]$/.test(w.w)) flush();
  }
  flush();
  return groups;
}

// Reads .srt or .vtt text into words, spreading each line's words evenly over its time span.
export function parseSubs(txt) {
  const tm = q => { const m = q.trim().replace(',', '.').split(':').map(parseFloat); return m.length === 3 ? m[0] * 3600 + m[1] * 60 + m[2] : m[0] * 60 + m[1]; };
  const out = []; let prev = [];
  txt.replace(/\r/g, '').split(/\n\n+/).forEach(b => {
    const ls = b.split('\n'), i = ls.findIndex(l => l.includes('-->'));
    if (i < 0) return;
    const [a, z] = ls[i].split('-->');
    const lines = ls.slice(i + 1).map(l => l.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
    const fresh = lines.filter(l => !prev.includes(l)); prev = lines;
    if (!fresh.length) return;
    const s = tm(a), e = tm(z.trim().split(' ')[0]), ws = fresh.join(' ').split(/\s+/);
    ws.forEach((w, k) => out.push({ w, s: s + (e - s) * k / ws.length, e: s + (e - s) * (k + 1) / ws.length }));
  });
  return out;
}

// Smooths face positions (0 to 1 across the frame): median filter, then a forward+backward average (no lag).
export function smooth(ts, xs) {
  const k = 5, h = 2;
  const med = xs.map((_, i) => { const w = []; for (let j = i - h; j <= i + h; j++) w.push(xs[Math.min(xs.length - 1, Math.max(0, j))]); w.sort((a, b) => a - b); return w[h]; });
  const ema = a => { const o = []; let c = a[0]; for (const v of a) { c += (v - c) * 0.35; o.push(c); } return o; };
  const f = ema(med), b = ema(med.slice().reverse()).reverse();
  return { t: ts, x: f.map((v, i) => (v + b[i]) / 2) };
}

export function interp(ts, xs, t) {
  if (!ts.length) return null;
  if (t <= ts[0]) return xs[0];
  for (let i = 1; i < ts.length; i++) if (t <= ts[i]) return xs[i - 1] + (xs[i] - xs[i - 1]) * (t - ts[i - 1]) / (ts[i] - ts[i - 1]);
  return xs[xs.length - 1];
}
