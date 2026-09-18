'use strict';

// --- Constants ---
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const IN_TUNE_CENTS = 5;
const HISTORY_MS = 30 * 1000;
const DETECT_INTERVAL_MS = 60;
const RMS_GATE = 0.01;
const MIN_FREQ = 60;
const MAX_FREQ = 1500;
const HYSTERESIS_SEMITONES = 0.6;
// Vertical range of the history graph (C2 gridline down to C6 gridline, plus a bit).
const HISTORY_LO = 34;
const HISTORY_HI = 86;

// --- DOM refs ---
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const recordBtn = document.getElementById('recordBtn');
const recStatus = document.getElementById('recStatus');
const micStatus = document.getElementById('micStatus');
const notePanel = document.getElementById('notePanel');
const noteDisplay = document.getElementById('noteDisplay');
const centsDisplay = document.getElementById('centsDisplay');
const needle = document.getElementById('needle');
const canvas = document.getElementById('history');
const canvasCtx = canvas.getContext('2d');
const targetSelect = document.getElementById('targetSelect');
const targetInfo = document.getElementById('targetInfo');

// Training-run controls
const accuracySelect = document.getElementById('accuracySelect');
const durationSelect = document.getElementById('durationSelect');
const countSelect = document.getElementById('countSelect');
const patternSelect = document.getElementById('patternSelect');
const melodyRow = document.getElementById('melodyRow');
const melodyInput = document.getElementById('melodyInput');
const startRunBtn = document.getElementById('startRunBtn');
const runStatusText = document.getElementById('runStatusText');
const runProgress = document.getElementById('runProgress');
const runProgressFill = document.getElementById('runProgressFill');
const runNotes = document.getElementById('runNotes');

// --- State ---
let audioCtx = null;
let analyser = null;
let micStream = null;
let timeData = null;
let running = false;
let rafId = 0;
let lastDetectTime = 0;
let lastNearest = null; // hysteresis anchor (midi), reset on silence

const history = []; // { t: epoch ms, midi: number }

let recorder = null;
let recChunks = [];
let recTimer = null;
let recStartedAt = 0;

let cssW = 0;
let cssH = 0;

// Training-run state: hold the current note within tolerance for the required
// time, then advance. Transitions are not scored.
const run = {
  active: false,
  done: false,
  notes: [], // array of midi numbers
  index: 0,
  holdStart: null, // epoch ms when the in-range hold began
};

// --- Helpers ---
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function freqToMidi(f) {
  return 69 + 12 * Math.log2(f / 440);
}

function midiToName(m) {
  const i = ((Math.round(m) % 12) + 12) % 12;
  return NOTE_NAMES[i] + (Math.floor(Math.round(m) / 12) - 1);
}

function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function targetMidi() {
  return parseInt(targetSelect.value, 10);
}

// --- Target note selector ---
function populateTargetSelect() {
  for (let m = 36; m <= 84; m++) {
    const opt = document.createElement('option');
    opt.value = String(m);
    opt.textContent = midiToName(m);
    if (m === 60) opt.selected = true;
    targetSelect.appendChild(opt);
  }
  updateTargetInfo();
}

function updateTargetInfo() {
  const m = targetMidi();
  targetInfo.textContent = midiToName(m) + ' · ' + midiToFreq(m).toFixed(1) + ' Hz';
}

// --- Mode helpers ---
function currentMode() {
  const el = document.querySelector('input[name="mode"]:checked');
  return el ? el.value : 'target';
}

function isFreeMode() {
  return currentMode() === 'free';
}

// The effective cent band that counts as "in tune" for the current mode.
function effectiveTolerance() {
  if (currentMode() === 'run') return runToleranceCents();
  return IN_TUNE_CENTS;
}

// The note the user is being measured against (null means "free").
function currentTargetMidi() {
  if (currentMode() === 'run') {
    if (run.notes.length) {
      const i = run.active ? run.index : run.notes.length - 1;
      return run.notes[i];
    }
    return targetMidi(); // sensible fallback before a run starts
  }
  return targetMidi();
}

// --- Training run ---
function runToleranceCents() {
  return parseInt(accuracySelect.value, 10);
}

function runHoldMs() {
  return parseFloat(durationSelect.value) * 1000;
}

const NOTE_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function nameToMidi(token) {
  const m = /^([A-Ga-g])([\u266f#b\u266d]?)(\d)$/.exec(token.trim());
  if (!m) return null;
  let acc = 0;
  if (m[2] === '\u266f' || m[2] === '#') acc = 1;
  else if (m[2] === 'b' || m[2] === '\u266d') acc = -1;
  return 12 * (parseInt(m[3], 10) + 1) + NOTE_BASE[m[1].toUpperCase()] + acc;
}

function parseMelody(text) {
  const out = [];
  for (const tok of text.trim().split(/[\s,;]+/).filter(Boolean)) {
    const m = nameToMidi(tok);
    if (m != null) out.push(m);
  }
  return out;
}

// Generate a comfortable C3..C5 sequence following the chosen pattern.
function generateNotes(pattern, count) {
  const LO = 48, HI = 72;
  const step = Math.max(1, Math.round((HI - LO) / Math.max(1, count - 1)));
  const notes = [];

  if (pattern === 'up') {
    for (let i = 0; i < count; i++) notes.push(clamp(LO + i * step, LO, HI));
  } else if (pattern === 'down') {
    for (let i = 0; i < count; i++) notes.push(clamp(HI - i * step, LO, HI));
  } else if (pattern === 'wave') {
    let v = LO, dir = 1;
    for (let i = 0; i < count; i++) {
      notes.push(clamp(Math.round(v), LO, HI));
      v += dir * step;
      if (v > HI) { v = HI; dir = -1; }
      else if (v < LO) { v = LO; dir = 1; }
    }
  } else { // random walk
    let v = 60; // start on C4
    for (let i = 0; i < count; i++) {
      notes.push(clamp(Math.round(v), LO, HI));
      v += (Math.floor(Math.random() * 5) + 1) * (Math.random() < 0.5 ? -1 : 1);
    }
  }
  return notes;
}

function renderRunNotes() {
  runNotes.innerHTML = '';
  run.notes.forEach((m) => {
    const span = document.createElement('span');
    span.className = 'note-chip';
    span.textContent = midiToName(m);
    runNotes.appendChild(span);
  });
}

function startRun() {
  const pattern = patternSelect.value;
  let notes;
  if (pattern === 'custom') {
    notes = parseMelody(melodyInput.value);
    if (!notes.length) {
      runStatusText.textContent = 'Enter at least one note (e.g. C4) to start.';
      return;
    }
  } else {
    notes = generateNotes(pattern, parseInt(countSelect.value, 10));
  }

  run.active = true;
  run.done = false;
  run.notes = notes;
  run.index = 0;
  run.holdStart = null;
  startRunBtn.textContent = 'Restart run';
  runProgress.hidden = false;
  runNotes.hidden = false;
  renderRunNotes();
  updateRunUI();
}

function resetRun() {
  run.active = false;
  run.done = false;
  run.notes = [];
  run.index = 0;
  run.holdStart = null;
  startRunBtn.textContent = 'Start run';
  runStatusText.textContent = '';
  runProgressFill.style.width = '0%';
  runProgress.hidden = true;
  runNotes.hidden = true;
  runNotes.innerHTML = '';
}

// Hold-to-advance: in range, accumulate; out of range, reset. No transition score.
function advanceRun(midi, now) {
  const target = run.notes[run.index];
  const inRange = Math.abs((midi - target) * 100) <= runToleranceCents();

  if (!inRange) {
    run.holdStart = null;
    return;
  }

  if (run.holdStart == null) {
    run.holdStart = now;
  } else if (now - run.holdStart >= runHoldMs()) {
    run.holdStart = null;
    run.index++;
    if (run.index >= run.notes.length) {
      run.active = false;
      run.done = true;
    }
  }
}

function updateRunUI() {
  if (currentMode() !== 'run') return;
  if (!run.active && !run.done) return;

  if (run.done) {
    runStatusText.textContent = 'Run complete! \u{1F389}';
    runProgressFill.style.width = '100%';
  } else {
    const remaining = runHoldMs();
    const elapsed = run.holdStart != null ? Date.now() - run.holdStart : 0;
    runStatusText.textContent = 'Note ' + (run.index + 1) + ' / ' + run.notes.length;
    runProgressFill.style.width = Math.round(clamp(elapsed / remaining, 0, 1) * 100) + '%';
  }

  const chips = runNotes.children;
  for (let i = 0; i < chips.length; i++) {
    chips[i].classList.toggle('current', i === run.index && !run.done);
    chips[i].classList.toggle('done', run.done || i < run.index);
  }
}

function onModeChange() {
  const mode = currentMode();
  document.querySelectorAll('.mode-body').forEach((b) => {
    b.hidden = b.getAttribute('data-body') !== mode;
  });
  if (mode !== 'run') resetRun();
  updateRunUI();
}

// --- Pitch detection (autocorrelation, ACF2+ style) ---
function detectPitch() {
  analyser.getFloatTimeDomainData(timeData);
  const SIZE = timeData.length;
  const sampleRate = audioCtx.sampleRate;

  // RMS gate: ignore silence.
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += timeData[i] * timeData[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < RMS_GATE) return -1;

  // Only lags that could correspond to <= 1500 Hz… capped at sampleRate/40.
  const maxLag = Math.min(SIZE - 2, Math.floor(sampleRate / 40));

  const r = new Float32Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < SIZE - lag; i++) {
      sum += timeData[i] * timeData[i + lag];
    }
    r[lag] = sum;
  }

  // Skip past the DC lobe (correlation still high near lag 0).
  let start = 1;
  while (start < maxLag && r[start] > 0.5 * r[0]) start++;
  if (start >= maxLag) return -1;

  // Strongest peak from there on.
  let bestLag = -1;
  let bestVal = -Infinity;
  for (let lag = start; lag <= maxLag; lag++) {
    if (r[lag] > bestVal) {
      bestVal = r[lag];
      bestLag = lag;
    }
  }
  if (bestLag < 2 || bestVal <= 0) return -1;

  // Parabolic interpolation around the peak for sub-sample precision.
  const x1 = r[bestLag - 1];
  const x2 = r[bestLag];
  const x3 = r[bestLag + 1];
  let shift = 0;
  const denom = x1 - 2 * x2 + x3;
  if (denom !== 0) shift = 0.5 * (x1 - x3) / denom;

  const freq = sampleRate / (bestLag + shift);
  if (freq < MIN_FREQ || freq > MAX_FREQ) return -1;
  return freq;
}

// Nearest note with hysteresis: stick to the previous note while the pitch
// is within HYSTERESIS_SEMITONES of it (prevents C4/C#4 flicker).
function nearestNoteWithHysteresis(midi) {
  const rounded = Math.round(midi);
  if (lastNearest !== null && Math.abs(midi - lastNearest) <= HYSTERESIS_SEMITONES) {
    return lastNearest;
  }
  lastNearest = rounded;
  return rounded;
}

function pruneHistory() {
  const cutoff = Date.now() - HISTORY_MS;
  while (history.length && history[0].t < cutoff) history.shift();
}

// --- Main loop ---
function tick(now) {
  if (!running) return;
  if (now - lastDetectTime >= DETECT_INTERVAL_MS) {
    lastDetectTime = now;
    processFrame();
  }
  drawHistory();
  rafId = requestAnimationFrame(tick);
}

function processFrame() {
  const freq = detectPitch();

  if (freq < 0) {
    // Silence: reset hysteresis, gauge, and any in-progress hold.
    lastNearest = null;
    if (run.active) run.holdStart = null;
    notePanel.classList.remove('in', 'flat', 'sharp');
    noteDisplay.textContent = '—';
    centsDisplay.textContent = '±0 ¢';
    needle.style.left = '50%';
    updateRunUI();
    return;
  }

  const midi = freqToMidi(freq);
  const ref = isFreeMode() ? nearestNoteWithHysteresis(midi) : currentTargetMidi();
  const devCents = (midi - ref) * 100;
  const roundedCents = Math.round(devCents);
  const tolerance = effectiveTolerance();

  noteDisplay.textContent = midiToName(ref);
  centsDisplay.textContent =
    (roundedCents > 0 ? '+' : '') + roundedCents + ' ¢';

  notePanel.classList.remove('in', 'flat', 'sharp');
  notePanel.classList.add(
    Math.abs(roundedCents) <= tolerance ? 'in' : devCents < 0 ? 'flat' : 'sharp'
  );
  needle.style.left = (50 + clamp(devCents, -50, 50)) + '%';

  if (run.active) advanceRun(midi, Date.now());

  history.push({ t: Date.now(), midi });
  pruneHistory();
  updateRunUI();
}

// --- History canvas ---
function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  cssW = rect.width;
  cssH = rect.height;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  canvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawHistory() {
  const w = cssW;
  const h = cssH;
  if (!w || !h) return;
  const now = Date.now();

  canvasCtx.clearRect(0, 0, w, h);

  const yOf = (m) => h - ((m - HISTORY_LO) / (HISTORY_HI - HISTORY_LO)) * h;

  // C gridlines with labels.
  canvasCtx.font = '11px system-ui, sans-serif';
  canvasCtx.lineWidth = 1;
  for (let m = 36; m <= 84; m += 12) {
    const y = yOf(m);
    canvasCtx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    canvasCtx.beginPath();
    canvasCtx.moveTo(0, y);
    canvasCtx.lineTo(w, y);
    canvasCtx.stroke();
    canvasCtx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    canvasCtx.fillText(midiToName(m), 4, y - 3);
  }

  if (!history.length) {
    canvasCtx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    canvasCtx.textAlign = 'center';
    canvasCtx.fillText('Sing to see your pitch here', w / 2, h / 2);
    canvasCtx.textAlign = 'left';
    return;
  }

  // Dashed green target line in target/run modes.
  if (!isFreeMode()) {
    const y = yOf(currentTargetMidi());
    canvasCtx.strokeStyle = 'rgba(52, 199, 123, 0.8)';
    canvasCtx.setLineDash([6, 4]);
    canvasCtx.beginPath();
    canvasCtx.moveTo(0, y);
    canvasCtx.lineTo(w, y);
    canvasCtx.stroke();
    canvasCtx.setLineDash([]);
  }

  // Pitch trace.
  canvasCtx.strokeStyle = '#4f9cff';
  canvasCtx.lineWidth = 2;
  canvasCtx.lineJoin = 'round';
  canvasCtx.beginPath();
  let started = false;
  const cutoff = now - HISTORY_MS;
  for (const p of history) {
    if (p.t < cutoff) continue;
    const x = w * (1 - (now - p.t) / HISTORY_MS);
    const y = yOf(clamp(p.midi, HISTORY_LO, HISTORY_HI));
    if (!started) {
      canvasCtx.moveTo(x, y);
      started = true;
    } else {
      canvasCtx.lineTo(x, y);
    }
  }
  canvasCtx.stroke();
}

// --- Microphone ---
async function startMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    micStatus.textContent =
      'Microphone access is unavailable. Serve this page over http(s) or localhost (not file://) and reload.';
    return;
  }

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch (err) {
    micStream = null;
    micStatus.textContent = 'Could not access the microphone: ' + err.message;
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(micStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  timeData = new Float32Array(analyser.fftSize);

  running = true;
  lastDetectTime = 0;
  notePanel.classList.remove('inactive');
  startBtn.disabled = true;
  stopBtn.disabled = false;
  recordBtn.disabled = false;
  micStatus.textContent = 'Listening… sing or hum to see your pitch.';

  sizeCanvas();
  rafId = requestAnimationFrame(tick);
}

function stopMic() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  if (recTimer) {
    clearInterval(recTimer);
    recTimer = null;
  }

  running = false;
  if (rafId) cancelAnimationFrame(rafId);

  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  analyser = null;
  timeData = null;

  history.length = 0;
  lastNearest = null;
  resetRun();
  noteDisplay.textContent = '—';
  centsDisplay.textContent = '±0 ¢';
  needle.style.left = '50%';
  notePanel.classList.add('inactive');
  notePanel.classList.remove('in', 'flat', 'sharp');

  startBtn.disabled = false;
  stopBtn.disabled = true;
  recordBtn.disabled = true;
  recordBtn.classList.remove('recording');
  recordBtn.textContent = 'Record';
  recStatus.textContent = '';
  micStatus.textContent = 'Microphone stopped.';
}

// --- Recording ---
function timestampSlug() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    '-' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds())
  );
}

function startRecording() {
  if (!micStream) return;
  if (typeof MediaRecorder === 'undefined') {
    recStatus.textContent = 'Recording is not supported in this browser.';
    return;
  }

  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  const mime = candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  recChunks = [];

  recorder = new MediaRecorder(micStream, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) recChunks.push(e.data);
  };
  recorder.onstop = () => {
    const type = mime || 'audio/webm';
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    const blob = new Blob(recChunks, { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'take-' + timestampSlug() + '.' + ext;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    recStatus.textContent = 'Saved ✓';
    recorder = null;
  };
  recorder.start(1000);

  recStartedAt = Date.now();
  recordBtn.classList.add('recording');
  recordBtn.textContent = 'Stop recording';
  recStatus.textContent = '● 0:00';
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recStartedAt) / 1000);
    recStatus.textContent =
      '● ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }, 250);
}

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  if (recTimer) {
    clearInterval(recTimer);
    recTimer = null;
  }
  recordBtn.classList.remove('recording');
  recordBtn.textContent = 'Record';
}

// --- Wiring ---
startBtn.addEventListener('click', startMic);
stopBtn.addEventListener('click', stopMic);
recordBtn.addEventListener('click', () => {
  if (recorder) stopRecording();
  else startRecording();
});
targetSelect.addEventListener('change', updateTargetInfo);

document.querySelectorAll('input[name="mode"]').forEach((r) =>
  r.addEventListener('change', onModeChange)
);
patternSelect.addEventListener('change', () => {
  melodyRow.hidden = patternSelect.value !== 'custom';
});
startRunBtn.addEventListener('click', startRun);
window.addEventListener('resize', sizeCanvas);

populateTargetSelect();
sizeCanvas();
drawHistory();
onModeChange();
