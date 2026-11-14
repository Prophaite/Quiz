/*
 * Musique d'attente de l'écran de projection.
 * Par défaut : un petit morceau original généré par le navigateur (Web Audio),
 * sans aucun fichier. Si un fichier public/musique-attente.mp3 (ou .ogg / .m4a / .wav)
 * existe, c'est lui qui est joué en boucle à la place.
 */
window.WaitMusic = (() => {
  const VOLUME = 0.75;
  const BPM = 92;
  const STEP = 60 / BPM / 4; // durée d'une double-croche
  const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // Grille d'accords (fa majeur) : Fa maj7 · Ré m7 · Si♭ maj7 · Do 7
  const CHORDS = [
    { bass: 41, notes: [53, 57, 60, 64] },
    { bass: 38, notes: [50, 53, 57, 60] },
    { bass: 34, notes: [46, 50, 53, 57] },
    { bass: 36, notes: [48, 52, 55, 58] },
  ];
  // Mélodie (pentatonique de fa) : [pas, note, durée en pas] pour chacune des 4 mesures
  const MELODY = [
    [[0, 72, 2], [2, 69, 2], [4, 72, 2], [6, 74, 4], [12, 72, 4]],
    [[0, 69, 4], [4, 67, 2], [6, 65, 2], [8, 69, 6]],
    [[0, 65, 2], [2, 67, 2], [4, 69, 2], [6, 70, 4], [12, 69, 4]],
    [[0, 67, 6], [8, 64, 2], [10, 65, 2], [12, 67, 4]],
  ];
  const ARP = [0, 1, 2, 3, 2, 1, 2, 3]; // motif d'arpège sur les croches

  let ctx = null, master = null, echo = null, noise = null;
  let timer = null, nextTime = 0, step = 0;
  let playing = false;
  let fileAudio = null, fileChecked = false;

  function setup() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);
    // Écho léger pour les arpèges et la mélodie
    echo = ctx.createDelay();
    echo.delayTime.value = STEP * 3;
    const fb = ctx.createGain(); fb.gain.value = 0.28;
    const wet = ctx.createGain(); wet.gain.value = 0.22;
    echo.connect(fb).connect(echo);
    echo.connect(wet).connect(master);
    // Bruit blanc pour le charleston
    noise = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  function tone(freq, t, dur, { type = 'sine', vol = 0.2, attack = 0.01, cutoff = 0, toEcho = false } = {}) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    let node = o;
    if (cutoff) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = cutoff;
      node = o.connect(f);
    }
    node.connect(g);
    g.connect(master);
    if (toEcho) g.connect(echo);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function hat(t, vol) {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    s.connect(f).connect(g).connect(master);
    s.start(t); s.stop(t + 0.06);
  }

  function kick(t) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g).connect(master);
    o.start(t); o.stop(t + 0.3);
  }

  // Joue la double-croche n°`step` (boucle de 16 mesures)
  function playStep(t) {
    const s = step % 16;
    const bar = Math.floor(step / 16) % 16;
    const chord = CHORDS[bar % 4];
    if (s === 0) chord.notes.forEach((n) => tone(midi(n), t, STEP * 16, { type: 'triangle', vol: 0.035, attack: 0.4, cutoff: 1100 }));
    if (s === 0 || s === 8 || s === 14) tone(midi(chord.bass), t, STEP * (s === 14 ? 2 : 6), { type: 'triangle', vol: 0.22, cutoff: 600 });
    if (bar >= 2 && (s === 0 || s === 8)) kick(t);
    if (bar >= 2 && s % 4 === 2) hat(t, 0.05);
    if (s % 2 === 0) {
      const n = chord.notes[ARP[(s / 2) % ARP.length]] + 12;
      tone(midi(n), t, STEP * 3, { vol: 0.05, toEcho: true });
    }
    if ((bar >= 4 && bar < 8) || bar >= 12) {
      for (const [at, note, len] of MELODY[bar % 4]) {
        if (at === s) tone(midi(note), t, STEP * len, { type: 'triangle', vol: 0.09, attack: 0.02, toEcho: true });
      }
    }
  }

  function schedule() {
    while (nextTime < ctx.currentTime + 0.15) {
      playStep(nextTime);
      nextTime += STEP;
      step++;
    }
  }

  async function findFile() {
    if (fileChecked) return fileAudio;
    fileChecked = true;
    for (const name of ['musique-attente.mp3', 'musique-attente.ogg', 'musique-attente.m4a', 'musique-attente.wav']) {
      try {
        const r = await fetch('/' + name, { method: 'HEAD', cache: 'no-store' });
        if (r.ok) {
          fileAudio = new Audio('/' + name);
          fileAudio.loop = true;
          fileAudio.volume = 0;
          return fileAudio;
        }
      } catch {}
    }
    return null;
  }

  function fade(to, seconds, done) {
    if (fileAudio) {
      const from = fileAudio.volume, start = performance.now();
      const tick = () => {
        const k = Math.min(1, (performance.now() - start) / (seconds * 1000));
        fileAudio.volume = from + (to - from) * k;
        if (k < 1) requestAnimationFrame(tick); else done && done();
      };
      tick();
      return;
    }
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(to, now + seconds);
    if (done) setTimeout(done, seconds * 1000 + 50);
  }

  /** Démarre (ou reprend) la musique. Renvoie false si le navigateur attend un clic. */
  async function start() {
    if (playing) return !blocked();
    playing = true;
    const file = await findFile();
    if (!playing) return false;
    if (file) {
      try { await file.play(); } catch { return false; }
      fade(1, 1.5);
      return true;
    }
    setup();
    try { await ctx.resume(); } catch {}
    nextTime = ctx.currentTime + 0.1;
    step = 0;
    clearInterval(timer);
    timer = setInterval(schedule, 25);
    fade(VOLUME, 1.5);
    return !blocked();
  }

  /** Arrête la musique en fondu. */
  function stop(seconds = 1.2) {
    if (!playing) return;
    playing = false;
    if (fileAudio) return fade(0, seconds, () => { if (!playing) fileAudio.pause(); });
    if (!ctx) return;
    fade(0, seconds, () => { if (!playing) clearInterval(timer); });
  }

  // Le navigateur n'autorise le son qu'après une action de l'utilisateur
  const blocked = () => (fileAudio ? fileAudio.paused && playing : ctx ? ctx.state !== 'running' : true);
  async function unlock() {
    if (fileAudio && playing && fileAudio.paused) {
      try { await fileAudio.play(); fade(1, 1.5); } catch {}
    }
    if (ctx) { try { await ctx.resume(); } catch {} }
    return !blocked();
  }

  return { start, stop, unlock, blocked, get playing() { return playing; } };
})();
