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
 * Switching view: a big cinematic whoosh, about a second and a half long, in four layers
 * over a shared bus with an echo tail.
 *   - rushing air: noise swept through a band-pass filter, panned across the stage
 *   - a sub-bass swell that rises into the Galaxy and drops away going back down
 *   - a shimmer that climbs (Galaxy) or falls (Sandbox) alongside it
 *   - an arrival: a bright bloom of notes opening up in the Galaxy, a low thump
 *     settling into the Sandbox
 * Everything is scaled by the master volume and a compressor keeps the layers in check.
 */
export function sfxSwitch(toGalaxy: boolean) {
  const a = audio();
  if (!a || volume <= 0) return;
  const dur = 1.5;
  const t0 = a.currentTime;
  const up = toGalaxy;

  // shared bus: compressor -> out, plus a feedback echo that gives the whoosh a tail
  const bus = a.createGain();
  bus.gain.value = volume;
  const comp = a.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.ratio.value = 5;
  const echo = a.createDelay(1);
  echo.delayTime.value = 0.23;
  const feedback = a.createGain();
  feedback.gain.value = 0.4;
  const wet = a.createGain();
  wet.gain.value = 0.5;
  bus.connect(comp).connect(a.destination);
  comp.connect(echo);
  echo.connect(feedback).connect(echo);
  echo.connect(wet).connect(a.destination);

  const env = (g: GainNode, peak: number, peakAt: number, end: number, start = 0) => {
    g.gain.setValueAtTime(0.0001, t0 + start);
    g.gain.exponentialRampToValueAtTime(peak, t0 + peakAt);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + end);
  };

  // --- rushing air ---
  const buf = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const air = a.createBufferSource();
  air.buffer = buf;
  const band = a.createBiquadFilter();
  band.type = "bandpass";
  band.Q.value = 1.6;
  band.frequency.setValueAtTime(up ? 220 : 3400, t0);
  band.frequency.exponentialRampToValueAtTime(up ? 3600 : 200, t0 + dur * 0.9);
  const airGain = a.createGain();
  env(airGain, 0.42, dur * (up ? 0.62 : 0.3), dur);
  const pan = a.createStereoPanner();
  pan.pan.setValueAtTime(up ? -0.9 : 0.9, t0);
  pan.pan.linearRampToValueAtTime(up ? 0.9 : -0.9, t0 + dur);
  air.connect(band).connect(airGain).connect(pan).connect(bus);
  air.start(t0);

  // --- the voice of the layers beneath and above the air ---
  const voice = (
    type: OscillatorType,
    from: number,
    to: number,
    peak: number,
    peakAt: number,
    detune = 0,
  ) => {
    const o = a.createOscillator();
    o.type = type;
    o.detune.value = detune;
    o.frequency.setValueAtTime(from, t0);
    o.frequency.exponentialRampToValueAtTime(to, t0 + dur * 0.9);
    const g = a.createGain();
    env(g, peak, peakAt, dur);
    o.connect(g).connect(bus);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  };
  // sub-bass swell (a triangle, so small speakers still hear its harmonics)
  voice("triangle", up ? 60 : 200, up ? 210 : 45, 0.3, dur * (up ? 0.7 : 0.25));
  // shimmer, doubled and slightly detuned so it glistens
  voice("sine", up ? 330 : 1400, up ? 1500 : 220, 0.08, dur * 0.55, -6);
  voice("sine", up ? 330 : 1400, up ? 1500 : 220, 0.08, dur * 0.55, 6);

  // --- the arrival ---
  if (up) {
    // a bloom of notes opening up as the camera settles above the system
    const at = dur * 0.6;
    [220, 330, 440, 660].forEach((f, i) => {
      const o = a.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      const g = a.createGain();
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(0.075 - i * 0.008, t0 + at + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 1.4);
      o.connect(g).connect(bus);
      o.start(t0 + at);
      o.stop(t0 + at + 1.45);
    });
  } else {
    // a low thump as the view settles back into the tank
    const at = dur * 0.5;
    const o = a.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(120, t0 + at);
    o.frequency.exponentialRampToValueAtTime(40, t0 + at + 0.4);
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, t0 + at);
    g.gain.exponentialRampToValueAtTime(0.5, t0 + at + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.7);
    o.connect(g).connect(bus);
    o.start(t0 + at);
    o.stop(t0 + at + 0.75);
  }

  // let the echo ring out, then release the nodes
  window.setTimeout(() => {
    bus.disconnect();
    comp.disconnect();
    echo.disconnect();
    feedback.disconnect();
    wet.disconnect();
  }, (dur + 3.5) * 1000);
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

// ---------------------------------------------------------------------------
// cursor whoosh
// ---------------------------------------------------------------------------

const WHOOSH_LEVEL = 0.5; // peak loudness relative to the master volume

type Whoosh = { gain: GainNode; filter: BiquadFilterNode; last: number };
let whoosh: Whoosh | null = null;

/** One looping noise voice, silent until the cursor is moving through points. */
function buildWhoosh(a: AudioContext): Whoosh {
  const buf = a.createBuffer(1, a.sampleRate * 2, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const filter = a.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 400;
  filter.Q.value = 0.9;
  const gain = a.createGain();
  gain.gain.value = 0;
  src.connect(filter).connect(gain).connect(a.destination);
  src.start();
  return { gain, filter, last: 0 };
}

/**
 * Drive the cursor whoosh. Call every frame while the cursor moves through points.
 *   level  0..1  how loud: the caller folds in how fast the cursor moves and how
 *                tightly the points are squeezed together
 *   pitch  0..1  brighter for a faster pass
 * Pass level 0 when the cursor leaves the points. Does nothing until the user has
 * interacted once (browsers keep audio locked until then).
 */
export function setWhoosh(level: number, pitch = 0.5) {
  if (!ctx || ctx.state !== "running") return;
  if (!whoosh) {
    if (level <= 0.001) return;
    whoosh = buildWhoosh(ctx);
  }
  const target = Math.max(0, Math.min(1, level)) * volume * WHOOSH_LEVEL;
  // nothing to do while already silent
  if (target === 0 && whoosh.last === 0) return;
  whoosh.last = target;
  const t = ctx.currentTime;
  // quick to swell, slower to die away, so a flick leaves a short tail
  whoosh.gain.gain.setTargetAtTime(target, t, target > 0 ? 0.04 : 0.12);
  whoosh.filter.frequency.setTargetAtTime(250 + 1500 * Math.max(0, Math.min(1, pitch)), t, 0.06);
}
