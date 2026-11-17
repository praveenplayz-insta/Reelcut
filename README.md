# Reelcut Web (free, runs in the visitor's browser)

A static website: upload a video, get auto captions (Whisper) and a face-following crop (MediaPipe), export a vertical 9:16 clip. Nothing is uploaded to a server, so hosting is free and there is nothing to maintain.

## Files

- `index.html` the page and styling
- `app.js` the tool (loading, preview, captions, face tracking, export)
- `lib.js` helper logic (clip picking, caption grouping, smoothing)
- `asr-worker.js` runs Whisper in the background so the page stays responsive

## Try it on your computer

Browsers block some features on `file://`, so serve it:

```
python -m http.server 8000
```

Open http://localhost:8000 in Chrome or Edge.

## Put it online for free

Pick one. All give you an https address.

- **Cloudflare Pages:** dash.cloudflare.com > Workers & Pages > Create > Pages > Upload assets. Drag this whole folder in.
- **Netlify:** app.netlify.com/drop. Drag this folder onto the page.
- **GitHub Pages:** put these files in a repository, then Settings > Pages > deploy from the main branch.

Then connect your own domain in the host's settings if you want one.

## What gets downloaded in the visitor's browser

- Whisper model from Hugging Face through Transformers.js (tiny 40 MB, base 75 MB, small 250 MB), once, then cached
- MediaPipe face detector (about 1 MB), once, then cached
- The libraries come from the jsDelivr CDN, with versions pinned in `asr-worker.js` and `app.js`

If you want it to keep working even if a CDN is down, download those files and host them yourself.

## Limits

- Export runs in real time: a 30-second clip takes about 30 seconds, and the tab must stay open and visible.
- Videos over about 20 minutes can run out of browser memory while reading the audio. Trim them first.
- Whisper in a browser is slower and a bit less accurate than the desktop tool. It is fastest in Chrome or Edge with WebGPU.
- The export format depends on the browser. Recent desktop Chrome and Safari make H.264 MP4, which TikTok, Reels and Shorts accept. Others may make a format some apps reject.
- Face tracking follows the largest face in the frame. It does not switch between several speakers.
- Clip suggestions are a heuristic (dense speech, questions, numbers). Users should review them.

## Before you launch

- Add a short Terms and Privacy page. State that videos are processed on the user's device and not uploaded, and that users must only use videos they have the right to edit.
- Don't add YouTube link downloading. It breaks YouTube's rules and tends to stop working.
- Test on a phone and on a slow laptop and decide what warnings to show.

## Testing status

Tested in a real headless Chromium with stand-in versions of the AI models: loading a video, captions, speaker tracking, the preview and an MP4 export all worked. The real Whisper and MediaPipe model downloads could not be tested where this was built, so run one real video after you deploy and check the captions and tracking.
