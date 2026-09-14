# Context / Handover

## Task
Build a web interface that records sound from the device microphone and tells
the user the note being sung, for singing training (user is a beginner).

## Status: COMPLETE (unverified)
All files are written to the project root. Not yet syntax-checked or tested in
a browser because this session's terminal sandbox was broken (Zed was not
opened inside WSL, so `node` was unavailable). **First thing to do in the new
session: verify, see "Verification" below.**

## Files (all in project root)
| File | Purpose |
|---|---|
| `index.html` | Single-page UI: controls (start mic / record), big note display, cent gauge, target-note trainer, 30 s pitch-history canvas, beginner tips |
| `style.css` | Dark theme, responsive; state classes `.flat` (red) / `.sharp` (orange) / `.in` (green); `.inactive` dims the note display; `.recording` pulses the record button |
| `app.js` | All logic, plain JS, strict mode, zero dependencies |
| `README.md` | Run instructions (`python3 -m http.server 8080` → `http://localhost:8080`) and usage |
| `context.md` | This file |

## Implementation notes (app.js)
- **Mic**: `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } })` (AGC/NS off keeps the voice signal clean for pitch detection). Falls back to a user-facing error if no `mediaDevices` (i.e. page opened via `file://`) or permission denied.
- **Audio graph**: MediaStreamSource → AnalyserNode with `fftSize = 2048`; `getFloatTimeDomainData` into a Float32Array.
- **Pitch detection**: autocorrelation (ACF2+ style): RMS gate (reject < 0.01),
  correlation lags computed only up to `min(SIZE-2, sampleRate/40)` for performance,
  skip past DC lobe → strongest peak → parabolic interpolation → `sampleRate / T`.
  Rejects anything outside 60–1500 Hz as "no valid pitch" (returns -1).
- **Loop**: `requestAnimationFrame`; pitch detection throttled to every ≥ 60 ms
  (~16 detections/s); canvas redrawn every frame.
- **Note naming**: `midi = 69 + 12*log2(f/440)`; names `C C♯ D D♯ E F F♯ G G♯ A A♯ B`, octave = `floor(midi/12) - 1`.
- **Hysteresis**: `lastNearest` keeps the displayed note stable when the pitch is
  within 0.6 semitone of the previous note's boundary (prevents C4/C#4 flicker).
  Reset on silence.
- **Cents/deviation**: train mode → deviation vs. target note; free mode → deviation
  vs. nearest note. In-tune threshold ±5¢ (`IN_TUNE_CENTS`).
- **Gauge needle**: `left = 50 + clamp(dev, -50, 50) + "%"` (±50¢ spans the gauge).
- **Target note**: select filled with midi 36 (C2) … 84 (C6), default 60 (C4);
  `#targetInfo` shows label + Hz (`440 * 2^((m-69)/12)`).
- **History**: array of `{t, midi}` pruned to last 30 s (`HISTORY_MS`); canvas draws
  C-gridlines with labels, dashed green target line (train mode), blue pitch trace;
  DPR-aware sizing; empty-state text "Sing to see your pitch here".
- **Recording**: `MediaRecorder` on the mic stream; mime picked from
  `audio/webm;codecs=opus → audio/webm → audio/mp4 → audio/ogg;codecs=opus`;
  on stop: auto-download `take-YYYY-MM-DD-HH-MM-SS.{webm,m4a,ogg}`, blob URL revoked
  after 60 s. Elapsed time shown in `#recStatus` while recording.
- **Stop mic**: stops any active recording first, stops stream tracks, closes
  AudioContext, resets all UI state.

## Verification (do this first in the new session)
1. `node --check app.js` — syntax check (should pass; was reviewed by hand).
2. Run `python3 -m http.server 8080` in the project dir (or any static server) and
   open `http://localhost:8080` in a browser; the mic requires localhost/https.
3. Manual test: start mic, hum a known note (e.g. C4 / 261.6 Hz with a tuning app or
   speaker), confirm the displayed note, cent deviation, needle position, and the
   history trace. Test record → stop → file downloads.
4. Check console for errors in DevTools.

## Constraints / notes
- No dependencies, no build step — keep it that way.
- `terminal` in the previous session was sandboxed to a Windows/WSL context where
  `node` wasn't reachable; the user reopens the project in the correct WSL sandbox.
