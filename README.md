# Sing — Pitch Trainer

A tiny, dependency-free web app for singers in training: it listens to your
microphone, detects the pitch you're producing, and shows you the note and how
far off (in cents) you are. Includes a target-note trainer, a ±50¢ gauge, and a
30-second pitch-history graph. You can also record takes and download them.

## Run it

Any static file server works. The microphone APIs require `localhost` or HTTPS,
so don't open `index.html` via `file://`.

```bash
python3 -m http.server 8080
```

Then open <http://localhost:8080> in Chrome, Edge, or Firefox and allow
microphone access when prompted.

### Running from WSL2 (Windows browser)

If your project lives on the WSL filesystem, the Windows browser may not reach
`localhost:8080` directly. Run this once (admin PowerShell), and again after a
WSL reboot — it maps `localhost:8080` → WSL so the mic keeps working:

```powershell
powershell -ExecutionPolicy Bypass -File .\wsl-localhost-proxy.ps1
```

## Usage

1. **Start microphone** — the big note display lights up as you sing or hum.
2. **Free mode** — uncheck *Train against a target note* to just see which note
   you're closest to, and how many cents flat (red) or sharp (orange) you are.
   Green means within ±5¢.
3. **Trainer mode** — pick a target note (C2–C6, default C4). The gauge and
   cent readout then measure how far you are from that note, and a dashed green
   line marks it on the history graph.
4. **Record** — captures the microphone to a file and downloads
   `take-YYYY-MM-DD-HH-MM-SS.webm` (or `.m4a`/`.ogg` depending on browser).
5. **Stop microphone** — releases the mic and resets everything.

## How it works

- `getUserMedia` with echo cancellation on but noise suppression and
  auto-gain control off, so the voice signal stays clean for pitch detection.
- Pitch detection via autocorrelation (ACF2+ style): RMS gate, strongest peak
  past the DC lobe, parabolic interpolation, 60–1500 Hz range check.
- Note names from `midi = 69 + 12·log2(f/440)`; hysteresis of 0.6 semitone
  keeps the displayed note from flickering between neighbours.

## Files

| File | Purpose |
|---|---|
| `index.html` | Single-page UI |
| `style.css` | Dark theme, responsive, tuning-state colors |
| `app.js` | All logic, plain JS, zero dependencies |
| `README.md` | This file |

No build step, no dependencies — keep it that way.
