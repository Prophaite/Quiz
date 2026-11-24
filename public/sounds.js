/*
 * Boîte à sons de l'animateur.
 * Chaque son est généré par le navigateur (Web Audio), sans aucun fichier. Un fichier déposé
 * dans public/sons/ remplace le son du même nom : public/sons/applaudissements.mp3 (ou .ogg,
 * .m4a, .wav) remplace « Applaudissements ». Le générique (« champion ») n'existe qu'en fichier :
 * public/sons/champion.mp3.
 */
window.Sfx = (() => {
  // id = nom du fichier dans public/sons/ ; file: true = son disponible seulement en fichier
  const LIST = [
    { id: 'champion', icon: '🏆', label: 'Générique Questions pour un champion', file: true },
    { id: 'jingle', icon: '🎬', label: 'Jingle de question' },
    { id: 'bonne', icon: '✅', label: 'Bonne réponse' },
    { id: 'mauvaise', icon: '❌', label: 'Mauvaise réponse' },
    { id: 'applaudissements', icon: '👏', label: 'Applaudissements' },
    { id: 'roulement', icon: '🥁', label: 'Roulement de tambour' },
    { id: 'suspense', icon: '😱', label: 'Suspense' },
    { id: 'tictac', icon: '⏱', label: 'Tic-tac' },
    { id: 'fanfare', icon: '🎺', label: 'Fanfare' },
    { id: 'triste', icon: '📉', label: 'Trombone triste' },
    { id: 'gong', icon: '🔔', label: 'Gong' },
    { id: 'sifflet', icon: '📣', label: 'Coup de sifflet' },
  ];
  const VOLUME = 0.8;

  let ctx = null, master = null, noise = null;
  let files = null; // id → adresse du fichier (public/sons/)
  const live = new Set(); // sons en cours : { gain } (synthèse) ou { audio } (fichier)

  function setup() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = VOLUME;
    master.connect(ctx.createDynamicsCompressor()).connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  /** Fichiers présents dans public/sons/ (une seule fois) */
  async function loadFiles() {
    if (files) return files;
    files = {};
    try {
      const list = await (await fetch('/api/sounds', { cache: 'no-store' })).json();
      for (const name of list) files[name.replace(/\.[^.]+$/, '')] = '/sons/' + encodeURIComponent(name);
    } catch {}
    return files;
  }

  /* ---------- Briques de synthèse ---------- */
  const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // Une note : forme d'onde, enveloppe, filtre passe-bas facultatif, vibrato facultatif
  function tone(out, freq, t, dur, { type = 'sine', vol = 0.3, attack = 0.01, release = 0, cutoff = 0, vibrato = 0, slideTo = 0 } = {}) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    if (vibrato) {
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = 5.5;
      lg.gain.value = freq * vibrato;
      lfo.connect(lg).connect(o.frequency);
      lfo.start(t); lfo.stop(t + dur + 0.1);
    }
    let node = o;
    if (cutoff) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = cutoff;
      node = o.connect(f);
    }
    node.connect(g).connect(out);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    if (release) {
      g.gain.setValueAtTime(vol, t + dur - release);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    } else g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // Un bruit filtré (claquement, caisse claire, cymbale…)
  function hiss(out, t, dur, { vol = 0.3, type = 'bandpass', freq = 2000, q = 1, attack = 0.002 } = {}) {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(out);
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + 0.05);
  }

  // Cuivre : dent de scie filtrée
  const brass = (out, note, t, dur, vol = 0.16) => {
    tone(out, midi(note), t, dur, { type: 'sawtooth', vol, attack: 0.03, release: 0.12, cutoff: 2200 });
    tone(out, midi(note) * 1.004, t, dur, { type: 'sawtooth', vol: vol * 0.6, attack: 0.03, release: 0.12, cutoff: 1600 });
  };

  /* ---------- Les sons : chacun renvoie sa durée (s) ---------- */
  const SYNTH = {
    jingle(out, t) {
      [60, 64, 67, 72, 76].forEach((n, i) => tone(out, midi(n), t + i * 0.07, 0.35, { type: 'triangle', vol: 0.22 }));
      [72, 76, 79, 84].forEach((n) => tone(out, midi(n), t + 0.4, 1.4, { type: 'triangle', vol: 0.12, attack: 0.02 }));
      hiss(out, t + 0.4, 1.2, { vol: 0.08, type: 'highpass', freq: 6000 });
      return 1.9;
    },
    bonne(out, t) {
      tone(out, midi(76), t, 0.5, { type: 'triangle', vol: 0.3 });
      tone(out, midi(84), t + 0.12, 0.9, { type: 'triangle', vol: 0.3 });
      tone(out, midi(91), t + 0.12, 0.9, { vol: 0.12 });
      return 1.1;
    },
    mauvaise(out, t) {
      for (const f of [98, 104]) tone(out, f, t, 0.75, { type: 'sawtooth', vol: 0.22, release: 0.08, cutoff: 900 });
      tone(out, 52, t, 0.75, { type: 'square', vol: 0.1, release: 0.08, cutoff: 400 });
      return 0.9;
    },
    applaudissements(out, t) {
      const dur = 3.6;
      for (let i = 0; i < 260; i++) {
        const at = Math.random() * dur;
        const env = Math.min(1, at / 0.4) * Math.min(1, (dur - at) / 1.2); // monte puis s'éteint
        hiss(out, t + at, 0.03 + Math.random() * 0.04, { vol: 0.25 * env + 0.01, freq: 900 + Math.random() * 2200, q: 1.5 });
      }
      return dur + 0.2;
    },
    roulement(out, t) {
      const dur = 2.6;
      for (let at = 0; at < dur; at += 0.042) {
        hiss(out, t + at, 0.05, { vol: 0.05 + 0.25 * (at / dur), freq: 1800, q: 0.8 });
        tone(out, 180, t + at, 0.05, { type: 'triangle', vol: 0.04 + 0.08 * (at / dur) });
      }
      // Coup final : cymbale + grosse caisse
      hiss(out, t + dur, 2.2, { vol: 0.35, type: 'highpass', freq: 5000, q: 0.5 });
      tone(out, 90, t + dur, 0.5, { vol: 0.5, slideTo: 40 });
      return dur + 2.3;
    },
    suspense(out, t) {
      const dur = 4.5;
      tone(out, midi(38), t, dur, { type: 'sawtooth', vol: 0.12, attack: 0.8, release: 0.5, cutoff: 500 });
      tone(out, midi(39), t, dur, { type: 'sawtooth', vol: 0.08, attack: 0.8, release: 0.5, cutoff: 500 });
      // Cordes qui montent, en trémolo
      for (let at = 0; at < dur - 0.4; at += 0.09) {
        const k = at / dur;
        tone(out, midi(62 + 12 * k), t + at, 0.085, { type: 'sawtooth', vol: 0.03 + 0.07 * k, attack: 0.01, cutoff: 2400 });
      }
      for (let at = 0; at < dur; at += 0.75) tone(out, 60, t + at, 0.35, { vol: 0.35, slideTo: 40 }); // battement de cœur
      return dur + 0.2;
    },
    tictac(out, t) {
      for (let i = 0; i < 10; i++) {
        const hi = i % 2 === 0;
        tone(out, hi ? 2600 : 2000, t + i * 0.5, 0.04, { type: 'square', vol: 0.12, cutoff: 5000 });
        hiss(out, t + i * 0.5, 0.03, { vol: 0.15, freq: hi ? 4000 : 3000, q: 4 });
      }
      for (let i = 0; i < 4; i++) tone(out, 1800, t + 5 + i * 0.12, 0.1, { type: 'square', vol: 0.12, cutoff: 4000 }); // sonnerie
      return 5.6;
    },
    fanfare(out, t) {
      const n = [[67, 0, 0.14], [67, 0.16, 0.14], [67, 0.32, 0.14], [72, 0.48, 0.55], [67, 1.05, 0.25], [72, 1.32, 1.4]];
      for (const [note, at, d] of n) { brass(out, note, t + at, d); brass(out, note - 5, t + at, d, 0.08); }
      [60, 64, 67].forEach((note) => brass(out, note, t + 1.32, 1.4, 0.08));
      hiss(out, t + 1.32, 1.5, { vol: 0.12, type: 'highpass', freq: 6000 });
      return 2.9;
    },
    triste(out, t) {
      const notes = [[63, 0, 0.45], [62, 0.5, 0.45], [61, 1, 0.45], [60, 1.5, 1.6]];
      for (const [note, at, d] of notes) {
        tone(out, midi(note - 12), t + at, d, { type: 'sawtooth', vol: 0.2, attack: 0.05, release: 0.15, cutoff: 900, vibrato: at > 1.2 ? 0.02 : 0 });
      }
      return 3.2;
    },
    gong(out, t) {
      for (const [ratio, vol] of [[1, 0.35], [1.48, 0.2], [2.12, 0.15], [2.73, 0.1], [3.9, 0.06]]) {
        tone(out, 80 * ratio, t, 5, { vol, attack: 0.02, vibrato: 0.004 });
      }
      hiss(out, t, 1.5, { vol: 0.06, freq: 600, q: 0.7 });
      return 5.2;
    },
    sifflet(out, t) {
      for (const [at, d] of [[0, 0.18], [0.28, 0.18], [0.56, 0.9]]) {
        tone(out, 2900, t + at, d, { vol: 0.18, attack: 0.01, release: 0.05, vibrato: 0.03 });
        hiss(out, t + at, d, { vol: 0.04, freq: 2900, q: 8 });
      }
      return 1.6;
    },
  };

  /** Joue un son ; renvoie false si le navigateur attend un clic pour autoriser le son */
  async function play(id) {
    const f = (await loadFiles())[id];
    if (f) {
      const audio = new Audio(f);
      const item = { audio };
      live.add(item);
      audio.onended = () => live.delete(item);
      try { await audio.play(); return true; } catch { live.delete(item); return false; }
    }
    if (!SYNTH[id]) return true; // son en fichier seulement, fichier absent
    setup();
    try { await ctx.resume(); } catch {}
    if (ctx.state !== 'running') return false;
    const gain = ctx.createGain();
    gain.connect(master);
    const item = { gain };
    live.add(item);
    const dur = SYNTH[id](gain, ctx.currentTime + 0.03);
    setTimeout(() => { live.delete(item); gain.disconnect(); }, (dur + 0.5) * 1000);
    return true;
  }

  /** Coupe tous les sons en cours (fondu rapide) */
  function stop() {
    for (const item of live) {
      if (item.audio) {
        const a = item.audio;
        const v0 = a.volume, start = performance.now();
        const tick = () => {
          const k = Math.min(1, (performance.now() - start) / 400);
          a.volume = v0 * (1 - k);
          if (k < 1) requestAnimationFrame(tick); else a.pause();
        };
        tick();
      } else {
        const now = ctx.currentTime;
        item.gain.gain.setValueAtTime(item.gain.gain.value, now);
        item.gain.gain.linearRampToValueAtTime(0, now + 0.3);
        setTimeout(() => item.gain.disconnect(), 400);
      }
    }
    live.clear();
  }

  // Le navigateur n'autorise le son qu'après une action de l'utilisateur sur la page
  async function unlock() {
    setup();
    try { await ctx.resume(); } catch {}
    return ctx.state === 'running';
  }

  return { LIST, play, stop, unlock, loadFiles };
})();
