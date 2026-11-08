/**
 * All sound in one place — no audio assets, just Web Audio.
 *
 *  - short UI blips (send / receive / warp),
 *  - a slow generative "astronomy lofi" ambient bed with a whoosh that pans
 *    around, for atmosphere,
 *  - one master `volume` (0..1), surfaced in Settings.
 *
 * The context is created lazily on the first (user-gesture) call, which browsers
 * require; everything is a no-op on the server or at volume 0.
 */

let ctx: AudioContext | null = null;
let volume = 0.35; // 0..1 master volume
let ambientGain: GainNode | null = null;
let ambientStarted = false;

const AMBIENT_LEVEL = 0.5; // the ambient bed sits at half the master, so blips cut through

export function setVolume(v: number) {
  volume = Math.max(0, Math.min(1, v));
  if (ambientGain && ctx) ambientGain.gain.setTargetAtTime(volume * AMBIENT_LEVEL, ctx.currentTime, 0.15);
}
export function getVolume() {
  return volume;
}

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** One soft tone: quick attack, gentle exponential decay, scaled by volume. */
function tone(freq: number, dur: number, gain: number, type: OscillatorType = "sine", at = 0) {
  const a = audio();
  if (!a || volume <= 0) return;
  const t0 = a.currentTime + at;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain * volume, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** A sweep tone for the warp in/out. */
function sweep(from: number, to: number, dur: number, peak: number) {
  const a = audio();
  if (!a || volume <= 0) return;
  const t0 = a.currentTime;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(from, t0);
  osc.frequency.exponentialRampToValueAtTime(to, t0 + dur * 0.7);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak * volume, t0 + 0.08);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

/** Sending a message to Pluto: a small upward blip. */
export function sfxSend() {
  tone(520, 0.1, 0.05, "triangle");
  tone(780, 0.09, 0.035, "sine", 0.04);
}

/** Pluto replies: a soft two-note chime. */
export function sfxReceive() {
  tone(660, 0.16, 0.05, "sine");
  tone(880, 0.2, 0.045, "sine", 0.08);
}

/** Warping into a hypothetical: a low swell up to a shimmer. */
export function sfxWarp() {
  sweep(220, 660, 0.5, 0.06);
}

/** Back to reality: the warp in reverse, settling down. */
export function sfxUnwarp() {
  sweep(560, 240, 0.4, 0.05);
}

/**
 * Start the ambient bed: a slow detuned pad under a moving lowpass, plus a
 * band-passed noise "whoosh" that pans slowly from ear to ear (the wooshing-
 * around). Safe to call repeatedly — it only builds once. Call on a user gesture.
 */
export function startAmbient() {
  const a = audio();
  if (!a || ambientStarted) return;
  ambientStarted = true;

  ambientGain = a.createGain();
  ambientGain.gain.value = volume * AMBIENT_LEVEL;
  ambientGain.connect(a.destination);

  // --- pad: a soft minor chord through a slowly sweeping lowpass ---
  const filter = a.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 600;
  filter.Q.value = 2;
  filter.connect(ambientGain);

  const filtLfo = a.createOscillator();
  const filtDepth = a.createGain();
  filtLfo.frequency.value = 0.045;
  filtDepth.gain.value = 260;
  filtLfo.connect(filtDepth).connect(filter.frequency);
  filtLfo.start();

  for (const f of [110, 164.81, 220, 277.18]) {
    const o = a.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = f;
    o.detune.value = Math.random() * 8 - 4;
    const g = a.createGain();
    g.gain.value = 0.05;
    o.connect(g).connect(filter);
    o.start();
  }

  // --- whoosh: band-passed noise, panned by a slow LFO, swelling in and out ---
  const buf = a.createBuffer(1, a.sampleRate * 2, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const noise = a.createBufferSource();
  noise.buffer = buf;
  noise.loop = true;

  const nf = a.createBiquadFilter();
  nf.type = "bandpass";
  nf.frequency.value = 480;
  nf.Q.value = 0.7;

  const ng = a.createGain();
  ng.gain.value = 0.045;

  const panner = a.createStereoPanner();
  const panLfo = a.createOscillator();
  const panDepth = a.createGain();
  panLfo.frequency.value = 0.06; // one slow sweep every ~16s
  panDepth.gain.value = 0.85;
  panLfo.connect(panDepth).connect(panner.pan);
  panLfo.start();

  const swell = a.createOscillator();
  const swellDepth = a.createGain();
  swell.frequency.value = 0.05;
  swellDepth.gain.value = 0.03;
  swell.connect(swellDepth).connect(ng.gain);
  swell.start();

  noise.connect(nf).connect(ng).connect(panner).connect(ambientGain);
  noise.start();
}
