'use strict';
/*
 * Quiz Live — serveur sans dépendance (Node.js 18+ uniquement).
 * Temps réel via Server-Sent Events, actions via requêtes POST JSON.
 */
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QR = require('./qr');
const QSlider = require('./public/slider-range.js'); // plage du curseur des questions « Valeur à trouver »

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'quizzes.json');

/* ------------------------------------------------------------------ */
/* Adresse réseau : les téléphones doivent pouvoir joindre ce PC        */
/* ------------------------------------------------------------------ */
function lanAddress() {
  const candidates = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) candidates.push({ name, address: i.address });
    }
  }
  const score = (c) => {
    let s = 0;
    // Point d'accès sans fil mobile de Windows : les téléphones connectés au Wi-Fi du PC y sont
    if (/^192\.168\.137\./.test(c.address)) s += 10;
    if (/^192\.168\./.test(c.address)) s += 3;
    else if (/^10\./.test(c.address)) s += 2;
    else if (/^172\.(1[6-9]|2\d|3[01])\./.test(c.address)) s += 1;
    if (/^169\.254\./.test(c.address)) s -= 20;
    if (/virtual|vmware|vbox|hyper-v|wsl|docker|vethernet|loopback|tailscale|zerotier/i.test(c.name)) s -= 10;
    return s;
  };
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0]?.address || 'localhost';
}
const LAN_URL = `http://${lanAddress()}:${PORT}`;

/* ------------------------------------------------------------------ */
/* Mode Internet : tunnel Cloudflare gratuit (sans compte)              */
/* Les téléphones se connectent de n'importe où (4G, autre Wi-Fi…)      */
/* ------------------------------------------------------------------ */
const INTERNET = process.argv.includes('--internet') || /^(1|true|oui|yes)$/i.test(process.env.INTERNET || '');
let publicUrl = (process.env.PUBLIC_URL || LAN_URL).replace(/\/$/, '');
const tunnel = { mode: process.env.PUBLIC_URL ? 'custom' : INTERNET ? 'starting' : 'lan', error: '' };

/*
 * Vérifie qu'une adresse de tunnel répond vraiment depuis Internet, et que c'est
 * bien CE serveur qui répond (identifiant aléatoire propre à ce lancement).
 * La résolution DNS passe par des résolveurs publics quand c'est possible, pour
 * ne pas rester bloqué sur un « nom inconnu » mis en cache par Windows.
 */
const INSTANCE_ID = crypto.randomBytes(8).toString('hex');
function probeOnce(url) {
  const https = require('https');
  const dns = require('dns');
  const resolver = new dns.Resolver({ timeout: 2000, tries: 1 });
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  const lookup = (host, opts, cb) => {
    resolver.resolve4(host, (err, addrs) => {
      if (!err && addrs.length) return opts.all ? cb(null, addrs.map((a) => ({ address: a, family: 4 }))) : cb(null, addrs[0], 4);
      dns.lookup(host, opts, cb); // réseau qui bloque les DNS publics : résolveur du système
    });
  };
  return new Promise((resolve) => {
    const req = https.get(`${url}/api/ping?t=${Date.now()}`, { lookup, timeout: 5000, headers: { 'Cache-Control': 'no-cache' } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(res.statusCode === 200 && body.includes(INSTANCE_ID)));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}
async function waitUntilReachable(url, maxMs = 90000) {
  const start = Date.now();
  let okInARow = 0;
  while (Date.now() - start < maxMs) {
    if (await probeOnce(url)) {
      // Deux réponses d'affilée : l'adresse est stable
      if (++okInARow >= 2) return true;
      await new Promise((r) => setTimeout(r, 1000));
    } else {
      okInARow = 0;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return false;
}

// Traduit la sortie de cloudflared en une explication compréhensible.
function explainTunnelFailure(log, code, wasStarting) {
  const t = log.toLowerCase();
  if (/api\.trycloudflare\.com/.test(t) && /(no such host|lookup|0\.0\.0\.0|connection refused|i\/o timeout|dial tcp|certificate|x509)/.test(t)) {
    return 'le réseau bloque le service de tunnel Cloudflare (trycloudflare.com) : utilisez un autre réseau (partage de connexion du téléphone, box perso) ou le mode Wi-Fi local';
  }
  if (/429|too many requests|rate limit/.test(t)) {
    return 'Cloudflare refuse temporairement de nouveaux tunnels (trop de demandes) : réessayez dans quelques minutes';
  }
  if (/failed to request quick tunnel/.test(t)) {
    return 'impossible d’obtenir une adresse Internet auprès de Cloudflare (réseau filtré ou service indisponible)';
  }
  if (/(7844|quic|edge).*(timeout|refused|failed)|failed to dial|unable to reach the origin|no free edge/.test(t)) {
    return 'la connexion aux serveurs Cloudflare a échoué (pare-feu ou proxy du réseau)';
  }
  return wasStarting
    ? `le tunnel n’a pas pu démarrer (code ${code})`
    : `le tunnel s’est arrêté (code ${code}) : la connexion Internet a peut-être été coupée`;
}

function startTunnel() {
  const { spawn } = require('child_process');
  // Emplacements habituels (dossier de l'app, installation winget/MSI), sinon le PATH
  const candidates = [
    process.env.CLOUDFLARED,
    path.join(__dirname, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'cloudflared', 'cloudflared.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'cloudflared', 'cloudflared.exe'),
  ].filter(Boolean);
  const bin = candidates.find((c) => fs.existsSync(c)) || 'cloudflared';
  console.log('  Ouverture du tunnel Internet…');
  const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { windowsHide: true });
  const refreshAll = () => { for (const room of rooms.values()) broadcast(room); };
  let log = ''; // dernières lignes de cloudflared, pour expliquer un échec
  let announced = '';
  const onData = (buf) => {
    log = (log + buf.toString()).slice(-4000);
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf.toString());
    if (m && announced !== m[0]) {
      announced = m[0];
      // L'adresse annoncée ne répond pas tout de suite partout : on attend qu'elle
      // fonctionne vraiment avant de la mettre dans le QR code.
      tunnel.mode = 'starting';
      tunnel.error = '';
      console.log(`  Adresse Internet    : ${announced} (vérification…)`);
      waitUntilReachable(announced).then((ok) => {
        if (announced !== m[0] || tunnel.mode === 'error') return;
        publicUrl = m[0];
        tunnel.mode = 'internet';
        console.log(ok
          ? '  ✔ Adresse Internet prête : les joueurs peuvent scanner le QR code depuis n’importe quel réseau.'
          : '  ⚠ L’adresse Internet ne répond pas encore depuis ce PC ; elle est quand même utilisée (réessayez sur le téléphone dans quelques secondes).');
        refreshAll();
      });
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => {
    tunnel.mode = 'error';
    tunnel.error = e.code === 'ENOENT' ? 'cloudflared n’est pas installé (voir README)' : e.message;
    console.log(`  ⚠ Tunnel Internet impossible : ${tunnel.error}`);
    console.log('    Les joueurs devront être sur le même Wi-Fi que ce PC.');
  });
  child.on('exit', (code) => {
    if (tunnel.mode !== 'internet' && tunnel.mode !== 'starting') return;
    const wasStarting = tunnel.mode === 'starting';
    tunnel.mode = 'error';
    tunnel.error = explainTunnelFailure(log, code, wasStarting);
    publicUrl = LAN_URL;
    console.log(`  ⚠ ${tunnel.error}`);
    const last = log.trim().split(/\r?\n/).filter((l) => /ERR|error|failed/i.test(l)).slice(-3);
    if (last.length) console.log('    Détail cloudflared :\n      ' + last.join('\n      '));
    console.log('    Retour au réseau local : les joueurs doivent être sur le même Wi-Fi que ce PC.');
    refreshAll();
  });
  const stop = () => { try { child.kill(); } catch {} };
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stop(); process.exit(0); });
}

/* ------------------------------------------------------------------ */
/* Accès à la gestion                                                   */
/* Sur ce PC (localhost) : libre. Depuis ailleurs : mot de passe        */
/* ADMIN_PASSWORD obligatoire, sinon refusé.                            */
/* Mode hébergé (PUBLIC_URL défini, ex. derrière un serveur web avec    */
/* nom de domaine) : le mot de passe est TOUJOURS exigé, même depuis    */
/* localhost, car un proxy mal configuré ferait passer chaque visiteur  */
/* pour « local ». HOSTED=0 désactive ce comportement.                  */
/* ------------------------------------------------------------------ */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const HOSTED = process.env.HOSTED !== undefined
  ? /^(1|true|oui|yes)$/i.test(process.env.HOSTED)
  : !!process.env.PUBLIC_URL;
const HOST = process.env.HOST || '0.0.0.0';

function isDirectLocal(req) {
  const a = req.socket.remoteAddress || '';
  const loopback = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  // Les requêtes qui passent par le tunnel arrivent aussi de localhost, mais avec ces en-têtes
  const proxied = req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-forwarded-for'];
  return loopback && !proxied;
}
function isAdmin(req) {
  if (!HOSTED && isDirectLocal(req)) return true;
  if (!ADMIN_PASSWORD) return false;
  const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(hash(req.headers['x-admin-password'] || ''), hash(ADMIN_PASSWORD));
}

/* ------------------------------------------------------------------ */
/* Stockage des quiz (fichier JSON)                                     */
/* ------------------------------------------------------------------ */
const uid = () => crypto.randomBytes(6).toString('hex');
const num = (v, min, max, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

function cleanQuestion(q = {}) {
  const type = ['choice', 'text', 'number', 'map'].includes(q.type) ? q.type : 'choice';
  const out = {
    id: typeof q.id === 'string' && q.id ? q.id.slice(0, 40) : uid(),
    type,
    text: String(q.text ?? '').slice(0, 500),
    image: String(q.image ?? '').slice(0, 2000),
    points: Math.round(num(q.points, 0, 100000, 100)),
    time: Math.round(num(q.time, 0, 600, 30)),
    // Question piège : aucune bonne réponse, seuls ceux qui NE répondent PAS marquent les points
    trap: !!q.trap,
  };
  if (type === 'choice') {
    out.choices = (Array.isArray(q.choices) ? q.choices : [])
      .slice(0, 6)
      .map((c) => ({ text: String(c?.text ?? '').slice(0, 200), correct: !!c?.correct }));
    // multi : le joueur coche plusieurs cases et doit trouver toutes les bonnes réponses.
    // partial : points au prorata (bonnes cochées − mauvaises cochées) au lieu de « tout ou rien ».
    out.multi = !!q.multi;
    out.partial = out.multi && !!q.partial;
  } else if (type === 'text') {
    const list = Array.isArray(q.answers) ? q.answers : String(q.answers ?? '').split('|');
    out.answers = list.map((s) => String(s).trim().slice(0, 100)).filter(Boolean).slice(0, 30);
    out.fuzzy = q.fuzzy !== false;
  } else if (type === 'map') {
    // Carte : le joueur pose un repère ; points selon la distance (km) au point à trouver
    out.lat = num(q.lat, -85, 85, 46.6);
    out.lng = num(q.lng, -180, 180, 2.4);
    out.label = String(q.label ?? '').slice(0, 100); // réponse affichée (ex. « Lyon »)
    out.tolerance = num(q.tolerance, 0, 20000, 25); // rayon (km) donnant tous les points
    out.maxKm = Math.max(out.tolerance + 1, num(q.maxKm, 1, 20000, 300)); // au-delà : 0 point (mode dégressif)
    out.mode = q.mode === 'closest' ? 'closest' : 'gradual';
    const v = q.view || {};
    out.view = { lat: num(v.lat, -85, 85, 46.6), lng: num(v.lng, -180, 180, 2.4), zoom: Math.round(num(v.zoom, 1, 18, 5)) };
  } else {
    out.value = num(q.value, -1e15, 1e15, 0);
    out.tolerance = Math.abs(num(q.tolerance, -1e15, 1e15, 0));
    out.mode = q.mode === 'closest' ? 'closest' : 'tolerance';
    out.unit = String(q.unit ?? '').slice(0, 30);
    // Bornes du curseur fixées à la main (vide = calcul automatique selon la valeur)
    const bound = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : num(x, -1e15, 1e15, 0));
    out.sliderMin = bound(q.sliderMin);
    out.sliderMax = bound(q.sliderMax);
  }
  return out;
}

function cleanQuiz(q = {}) {
  return {
    id: typeof q.id === 'string' && q.id ? q.id.slice(0, 40) : uid(),
    title: String(q.title ?? 'Quiz sans titre').slice(0, 120) || 'Quiz sans titre',
    questions: (Array.isArray(q.questions) ? q.questions : []).slice(0, 200).map(cleanQuestion),
    updatedAt: Date.now(),
  };
}

function sampleQuiz() {
  return cleanQuiz({
    title: 'Quiz de démonstration',
    questions: [
      {
        type: 'choice', text: 'Quelle est la capitale de l’Australie ?', points: 100, time: 20,
        choices: [{ text: 'Sydney' }, { text: 'Canberra', correct: true }, { text: 'Melbourne' }, { text: 'Perth' }],
      },
      { type: 'text', text: 'Qui a peint « La Joconde » ?', points: 200, time: 30, answers: ['Léonard de Vinci', 'Leonardo da Vinci', 'De Vinci', 'Vinci'] },
      { type: 'number', text: 'En quelle année l’homme a-t-il marché sur la Lune pour la première fois ?', points: 150, time: 25, value: 1969, tolerance: 0, mode: 'closest' },
      {
        type: 'choice', text: 'Le Soleil est une étoile.', points: 50, time: 10,
        choices: [{ text: 'Vrai', correct: true }, { text: 'Faux' }],
      },
      { type: 'number', text: 'Combien mesure la tour Eiffel (en mètres, antennes comprises) ?', points: 200, time: 30, value: 330, tolerance: 15, mode: 'tolerance', unit: 'm' },
      { type: 'map', text: 'Où se trouve Lyon ?', points: 200, time: 30, lat: 45.764, lng: 4.8357, label: 'Lyon', tolerance: 20, maxKm: 250, mode: 'gradual', view: { lat: 46.6, lng: 2.4, zoom: 5 } },
    ],
  });
}

/*
 * Fichiers de données (quiz, tournois) lus et écrits prudemment :
 * - lecture : un fichier illisible (arrêt brutal, conflit OneDrive…) n'est JAMAIS écrasé ;
 *   il est mis de côté et on essaie la sauvegarde .bak ;
 * - écriture atomique : fichier temporaire puis renommage, la version précédente
 *   (valide) étant gardée dans <fichier>.bak.
 */
function readList(file, clean) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8')); // lève une erreur si absent ou abîmé
  if (!Array.isArray(data)) throw new Error('contenu inattendu (pas une liste)');
  return data.map(clean);
}
// Renvoie { list, restored } ou null (premier lancement, ou rien de récupérable)
function loadList(file, clean, what) {
  const bak = file + '.bak';
  if (!fs.existsSync(file) && !fs.existsSync(bak)) return null;
  let mainError = null;
  if (fs.existsSync(file)) {
    try {
      return { list: readList(file, clean), restored: false };
    } catch (e) {
      mainError = e;
    }
  }
  if (mainError) {
    const aside = file.replace(/.json$/, `.abime-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    try { fs.copyFileSync(file, aside); } catch {}
    console.log(`  ⚠ ${path.basename(file)} est illisible (${mainError.message}).`);
    console.log(`    Copie conservée : ${path.basename(aside)}`);
  }
  try {
    const list = readList(bak, clean);
    console.log(`  ✔ ${what} récupérés depuis la sauvegarde ${path.basename(bak)}.`);
    return { list, restored: true };
  } catch {
    if (mainError) console.log(`    Aucune sauvegarde utilisable : vos anciens ${what.toLowerCase()} sont toujours dans la copie ci-dessus.`);
    return null;
  }
}
function saveList(file, list, clean) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const content = JSON.stringify(list, null, 2);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  try {
    if (fs.existsSync(file)) {
      try { readList(file, clean); fs.copyFileSync(file, file + '.bak'); } catch {} // seulement si valide
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    // Fichier verrouillé (ex. OneDrive en cours de synchro) : écriture directe en dernier recours
    try { fs.writeFileSync(file, content); } finally { try { fs.unlinkSync(tmp); } catch {} }
  }
}
const persist = () => saveList(DATA_FILE, quizzes, cleanQuiz);
const loadedQuizzes = loadList(DATA_FILE, cleanQuiz, 'Quiz');
let quizzes = loadedQuizzes?.list;
if (!quizzes) {
  quizzes = [sampleQuiz()];
  persist();
} else if (loadedQuizzes.restored) {
  persist(); // restauré depuis la sauvegarde : on réécrit un fichier principal propre
}

/* ------------------------------------------------------------------ */
/* Tournois : une suite d'étapes (modules), les N premiers de chaque    */
/* étape sont qualifiés pour la suivante.                               */
/*   quiz   : un quiz classique, sur les téléphones                     */
/*   themes : chaque équipe choisit un thème (un quiz) ; l'animateur    */
/*            gère tout (duo / carré / cash)                           */
/*   images : une image à reconnaître, de plus en plus nette à chaque   */
/*            bonne réponse ; la 1re équipe à N images gagne            */
/* Le contenu vient des quiz existants (référencés par leur id).        */
/* ------------------------------------------------------------------ */
const TOURN_FILE = path.join(DATA_DIR, 'tournaments.json');
const STAGE_TYPES = ['quiz', 'themes', 'images'];
const STAGE_LABELS = { quiz: 'Quiz', themes: 'Thèmes', images: 'Images' };
const refId = (v) => (typeof v === 'string' ? v.slice(0, 40) : '');

function cleanStage(s = {}) {
  const type = STAGE_TYPES.includes(s.type) ? s.type : 'quiz';
  const out = { type, qualify: Math.round(num(s.qualify, 1, 300, 4)) };
  if (type === 'quiz') {
    out.quizId = refId(s.quizId);
  } else if (type === 'themes') {
    out.themeIds = [...new Set((Array.isArray(s.themeIds) ? s.themeIds : []).map(refId).filter(Boolean))].slice(0, 40);
    out.perTeam = Math.round(num(s.perTeam, 1, 50, 3));
    const pts = s.points || {};
    out.points = {
      duo: Math.round(num(pts.duo, 0, 100000, 25)),
      carre: Math.round(num(pts.carre, 0, 100000, 50)),
      cash: Math.round(num(pts.cash, 0, 100000, 100)),
    };
  } else {
    out.imageQuizId = refId(s.imageQuizId); // quiz dont les questions « Mot / nom » portent les images
    out.questionQuizId = refId(s.questionQuizId); // questions posées pour rendre l'image plus nette
    out.wins = Math.round(num(s.wins, 1, 20, 3));
    out.levels = Math.round(num(s.levels, 1, 20, 5));
    out.effect = s.effect === 'small' ? 'small' : 'blur';
  }
  return out;
}
function cleanTournament(t = {}) {
  return {
    id: typeof t.id === 'string' && t.id ? t.id.slice(0, 40) : uid(),
    title: String(t.title ?? 'Tournoi sans titre').slice(0, 120) || 'Tournoi sans titre',
    stages: (Array.isArray(t.stages) ? t.stages : []).slice(0, 10).map(cleanStage),
    updatedAt: Date.now(),
  };
}
const persistTournaments = () => saveList(TOURN_FILE, tournaments, cleanTournament);
const loadedTournaments = loadList(TOURN_FILE, cleanTournament, 'Tournois');
let tournaments = loadedTournaments?.list || [];
if (loadedTournaments?.restored) persistTournaments();

/* Copie figée du contenu d'un tournoi au lancement du salon (les quiz peuvent ensuite être modifiés sans effet) */
function resolveTournament(t) {
  const find = (id) => quizzes.find((q) => q.id === id);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  if (!t.stages.length) fail('Ce tournoi ne contient aucune étape');
  const stages = t.stages.map((s, i) => {
    const label = `Étape ${i + 1} (${STAGE_LABELS[s.type]})`;
    if (s.type === 'quiz') {
      const q = find(s.quizId);
      if (!q?.questions.length) fail(`${label} : quiz introuvable ou vide`);
      return { ...s, quiz: clone(q) };
    }
    if (s.type === 'themes') {
      const themes = s.themeIds.map(find).filter((q) => q?.questions.length);
      if (!themes.length) fail(`${label} : aucun thème (quiz non vide) choisi`);
      return { ...s, themes: themes.map((q) => ({ title: q.title, questions: clone(q.questions) })) };
    }
    const images = (find(s.imageQuizId)?.questions || []).filter((q) => q.type === 'text' && q.image && q.answers.length);
    if (!images.length) fail(`${label} : le quiz d’images doit contenir des questions « Mot / nom » avec une image et une réponse`);
    const qq = find(s.questionQuizId);
    if (!qq?.questions.length) fail(`${label} : quiz de questions introuvable ou vide`);
    return { ...s, images: clone(images), quiz: clone(qq) };
  });
  return { id: t.id, title: t.title, stages };
}

/* ------------------------------------------------------------------ */
/* Correction des réponses                                              */
/* ------------------------------------------------------------------ */
function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(le|la|les|l|un|une|des|du|the) /, '')
    .replace(/\s+/g, ' ');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function textMatches(key, q) {
  if (!key) return false;
  return q.answers.some((acc) => {
    const k = normalize(acc);
    if (!k) return false;
    if (k === key) return true;
    if (!q.fuzzy || k.length < 4) return false;
    return levenshtein(key, k) <= (k.length >= 10 ? 2 : 1);
  });
}

// Distance à vol d'oiseau (km) entre deux points { lat, lng }
function haversine(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const fmtKm = (d) => (d < 1 ? 'moins d’1 km' : `${Math.round(d).toLocaleString('fr-FR')} km`);

const fmt = (n) =>
  Number.isFinite(n) ? n.toLocaleString('fr-FR', { maximumFractionDigits: 6, useGrouping: Math.abs(n) >= 10000 }) : String(n);
function correctAnswerText(q) {
  if (q.trap) return 'Aucune : il ne fallait pas répondre !';
  if (q.type === 'choice') return q.choices.filter((c) => c.correct).map((c) => c.text).join(' / ') || '—';
  if (q.type === 'text') return q.answers[0] || '—';
  if (q.type === 'map') return q.label || `${q.lat.toFixed(3)}, ${q.lng.toFixed(3)}`;
  return `${fmt(q.value)}${q.unit ? ' ' + q.unit : ''}`;
}
// Texte lisible d'une réponse de joueur (index, liste d'index, texte ou nombre).
function answerText(q, a) {
  if (!a) return null;
  if (q?.type === 'map') return a.diff != null ? `📍 à ${fmtKm(a.diff)}` : `📍 ${a.value.lat.toFixed(3)}, ${a.value.lng.toFixed(3)}`;
  if (q?.type !== 'choice') return a.value;
  const idx = Array.isArray(a.value) ? a.value : [a.value];
  return idx.map((i) => q.choices[i]?.text ?? '?').join(' + ');
}

/* ------------------------------------------------------------------ */
/* Salons                                                               */
/* ------------------------------------------------------------------ */
const rooms = new Map();

function newCode() {
  let c;
  do c = String(Math.floor(1000 + Math.random() * 9000));
  while (rooms.has(c));
  return c;
}

function resetScores(room) {
  clearTimeout(room.timer);
  room.state = 'lobby';
  room.qIndex = -1;
  room.answers = new Map();
  room.prevRanks = new Map();
  room.offersFor = undefined;
  room.stealFor = undefined;
  room.steal = null;
  room.cheated = new Set();
  for (const p of room.players.values()) {
    p.history = {};
    p.bonus = 0;
    Object.assign(p, { cheats: 0, busted: false, offer: false, cheatNext: false, tempted: false, wipes: {}, wipeAt: new Set() });
    Object.assign(p, { imLevel: 0, imCorrect: 0, imWins: 0, qualified: false }); // tournoi
  }
}

// tour : tournoi déjà résolu (resolveTournament) ; sinon partie de quiz simple
function createRoom(quiz, settings = {}, tour = null) {
  const room = {
    code: newCode(),
    token: uid() + uid(),
    quiz: tour ? { id: '', title: tour.title, questions: [] } : JSON.parse(JSON.stringify(quiz)),
    tour, // tournoi : étapes, contenu figé
    stageIndex: -1,
    order: [], // ordre de classement de l'étape précédente (ids), pour l'ordre de passage aux thèmes
    th: null, // état du module Thèmes
    im: null, // état du module Images
    settings: { autoClose: settings.autoClose !== false, speed: settings.speed !== false, steal: settings.steal !== false, allowDev: true, luck: false },
    players: new Map(),
    streams: new Set(),
    waiters: new Set(), // requêtes /api/poll en attente
    kicked: new Set(),
    version: 0,
    state: 'lobby', // lobby | question | closed | reveal | leaderboard | end
    qIndex: -1,
    answers: new Map(),
    textOverrides: new Map(),
    playerOverrides: new Map(),
    startedAt: 0,
    deadline: 0,
    timer: null,
    prevRanks: new Map(),
    lastActive: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

const currentQ = (room) => room.quiz.questions[room.qIndex];

function totalScore(room, p, publicOnly) {
  let s = p.bonus;
  const hidden = (i) => publicOnly && Number(i) === room.qIndex && (room.state === 'question' || room.state === 'closed');
  for (const [i, pts] of Object.entries(p.history)) if (!hidden(i)) s += pts;
  // Remises à zéro du tricheur démasqué (montant négatif fixé à la fin de la question) :
  // secrètes pour les joueurs jusqu'au classement final, visibles tout de suite par l'animateur.
  if (!publicOnly || room.state === 'end') for (const [i, pts] of Object.entries(p.wipes || {})) if (!hidden(i)) s += pts;
  return s;
}

// Tricheur pris sur la question en cours : son score total retombe à 0 (points de cette question compris)
function applyWipes(room) {
  const i = room.qIndex;
  for (const p of room.players.values()) {
    if (!p.wipeAt?.has(i)) continue;
    p.wipes ||= {};
    delete p.wipes[i];
    p.wipes[i] = -totalScore(room, p, false);
  }
}

// Tournoi : étape en cours, et joueurs encore en lice (les éliminés regardent seulement)
const stage = (room) => (room.tour && room.stageIndex >= 0 ? room.tour.stages[room.stageIndex] : null);
const stageType = (room) => stage(room)?.type || 'quiz';
const activePlayers = (room) => [...room.players.values()].filter((p) => !p.out);

function ranking(room, publicOnly = true) {
  // Étape Images : on compte les images trouvées, puis les bonnes réponses pour départager
  const img = stageType(room) === 'images';
  const list = activePlayers(room).map((p) => ({
    id: p.id,
    name: p.name,
    connected: playerConnected(p),
    score: img ? p.imWins || 0 : totalScore(room, p, publicOnly),
    tie: img ? p.imCorrect || 0 : 0,
    last: !img && room.qIndex >= 0 ? p.history[room.qIndex] ?? 0 : 0,
  }));
  list.sort((a, b) => b.score - a.score || b.tie - a.tie || a.name.localeCompare(b.name));
  let rank = 0;
  list.forEach((e, i) => {
    if (i === 0 || e.score !== list[i - 1].score || e.tie !== list[i - 1].tie) rank = i + 1;
    e.rank = rank;
    const prev = room.prevRanks.get(e.id);
    e.move = prev ? prev - rank : 0;
  });
  return list;
}

function scoreQuestion(room) {
  const q = currentQ(room);
  if (!q) return;
  const answers = [...room.answers.entries()].filter(([pid]) => room.players.has(pid));

  if (q.type === 'choice') {
    const goodCount = q.choices.filter((c) => c.correct).length;
    for (const [, a] of answers) {
      if (Array.isArray(a.value)) {
        const hits = a.value.filter((i) => q.choices[i]?.correct).length;
        const wrong = a.value.length - hits;
        a.correct = hits === goodCount && wrong === 0;
        a.ratio = a.correct ? 1 : q.partial && goodCount ? Math.max(0, (hits - wrong) / goodCount) : 0;
      } else {
        a.correct = !!q.choices[a.value]?.correct;
      }
    }
  } else if (q.type === 'text') {
    for (const [, a] of answers) {
      a.key = normalize(a.value);
      a.correct = room.textOverrides.has(a.key) ? room.textOverrides.get(a.key) : textMatches(a.key, q);
    }
  } else if (q.type === 'map') {
    for (const [, a] of answers) a.diff = haversine(a.value, q);
    const min = answers.length ? Math.min(...answers.map(([, a]) => a.diff)) : Infinity;
    for (const [, a] of answers) {
      a.correct = a.diff <= q.tolerance || (q.mode === 'closest' && a.diff === min);
      // Dégressif : tous les points dans le rayon, puis de moins en moins jusqu'à 0 à la distance max
      a.ratio = a.correct ? 1 : q.mode === 'gradual' ? Math.max(0, 1 - (a.diff - q.tolerance) / (q.maxKm - q.tolerance)) : 0;
    }
  } else {
    for (const [, a] of answers) a.diff = Math.abs(a.value - q.value);
    const min = answers.length ? Math.min(...answers.map(([, a]) => a.diff)) : Infinity;
    for (const [, a] of answers) a.correct = a.diff <= q.tolerance + 1e-9 || (q.mode === 'closest' && a.diff === min);
  }

  if (q.trap) {
    // Toute réponse est perdante (sauf correction manuelle de l'animateur) ; ne pas répondre rapporte les points
    for (const [pid, a] of answers) {
      a.correct = room.playerOverrides.get(pid) === true;
      a.partial = false;
      a.points = a.correct ? q.points : 0;
    }
    for (const p of room.players.values()) {
      const a = room.answers.get(p.id);
      p.history[room.qIndex] = a ? a.points : q.points;
    }
    applyWipes(room);
    return;
  }

  for (const [pid, a] of answers) {
    a.r = a.correct ? 1 : a.ratio || 0;
    if (room.playerOverrides.has(pid)) {
      a.correct = room.playerOverrides.get(pid);
      a.r = a.correct ? 1 : 0;
    }
  }
  // Question chronométrée (si « Points selon la rapidité » est activé) : le premier qui répond (bien ou en partie) a tous les points,
  // puis c'est dégressif selon le retard sur lui, jusqu'à 50 % à la fin du temps.
  const scoring = answers.filter(([, a]) => a.r > 0);
  const firstAt = scoring.length ? Math.min(...scoring.map(([, a]) => a.at)) : 0;
  const end = room.deadline || 0;
  for (const [, a] of answers) {
    let speed = 1;
    if (room.settings.speed !== false && q.time > 0 && end > firstAt && a.at > firstAt) {
      speed = 1 - 0.5 * Math.min(1, (a.at - firstAt) / (end - firstAt));
    }
    a.points = a.r > 0 ? Math.round(q.points * a.r * speed) : 0;
    a.partial = !a.correct && a.points > 0;
  }
  for (const p of room.players.values()) {
    p.history[room.qIndex] = room.answers.get(p.id)?.points ?? 0;
  }
  applyWipes(room);
}

function startQuestion(room, index) {
  if (!(index >= 0 && index < room.quiz.questions.length)) return;
  clearTimeout(room.timer);
  room.prevRanks = room.qIndex < 0 ? new Map() : new Map(ranking(room).map((e) => [e.id, e.rank]));
  room.qIndex = index;
  room.state = 'question';
  room.answers = new Map();
  room.textOverrides = new Map();
  room.playerOverrides = new Map();
  for (const p of room.players.values()) {
    delete p.history[index];
    if (p.wipes) delete p.wipes[index];
    p.wipeAt?.delete(index);
  }
  const q = currentQ(room);
  room.startedAt = Date.now();
  room.deadline = q.time > 0 ? room.startedAt + q.time * 1000 : 0;
  if (room.deadline) room.timer = setTimeout(() => closeQuestion(room, true), q.time * 1000 + 250);
  room.steal = null;
  room.cheated = new Set();
  for (const p of room.players.values()) {
    if (p.cheatNext && room.settings.luck) applyCheat(room, p, q);
    p.offer = false;
    p.cheatNext = false;
  }
  if (room.cheated.size) maybeAutoClose(room);
}

/* ------------------------------------------------------------------ */
/* Tentation de triche (« push your luck »)                             */
/* Entre deux questions, certains joueurs se voient proposer de tricher */
/* à la suivante : la bonne réponse est envoyée pour eux, mais chaque   */
/* triche peut faire TOUT perdre. Le risque grimpe à chaque fois et la  */
/* sanction n'est révélée qu'au classement final.                      */
/* ------------------------------------------------------------------ */
// Risque de tout perdre à la prochaine triche : 2 % la première fois, puis +3/N par triche
// (N = nombre de questions) : il grimpe vite dans un quiz court, plus lentement dans un long.
const cheatRisk = (room, p) => (p.busted ? 1 : Math.min(0.95, 0.02 + p.cheats * (3 / Math.max(3, room.quiz.questions.length))));
// Nouvelles propositions : environ 4 par partie, quelle que soit sa longueur, et jamais à tout le monde
// (1 joueur à la fois, 2 à partir de 20 joueurs…). Ceux qui ont déjà triché sont redemandés à chaque manche.
const offerRoundChance = (room) => Math.min(0.6, 4 / Math.max(1, room.quiz.questions.length - 1));
const offersPerRound = (room) => Math.max(1, Math.floor(activePlayers(room).length / 10));
// Sur toute la partie, au plus 1 joueur sur 6 (au moins 1) reçoit une proposition
const maxTempted = (room) => Math.max(1, Math.floor(activePlayers(room).length / 6));
const RISK_LABELS = [[0.05, 'minuscule'], [0.35, 'réel'], [0.6, 'élevé'], [0.8, 'très élevé'], [1, 'énorme']];
const riskLabel = (r) => RISK_LABELS.find(([max]) => r <= max)[1];

// Réponse envoyée automatiquement pour un tricheur (undefined : question piège, il ne faut rien envoyer)
function cheatValue(q) {
  if (q.trap) return undefined;
  if (q.type === 'choice') {
    const good = q.choices.map((c, i) => (c.correct ? i : -1)).filter((i) => i >= 0);
    return q.multi ? good : good[0];
  }
  if (q.type === 'text') return q.answers[0];
  if (q.type === 'map') return { lat: q.lat, lng: q.lng };
  return q.value;
}

function applyCheat(room, p, q) {
  const value = cheatValue(q);
  const sendable = value !== undefined && !(Array.isArray(value) && !value.length);
  if (sendable) room.answers.set(p.id, { value, at: room.startedAt });
  // Pris (tirage au sort, ou à coup sûr s'il est déjà démasqué) : ses points retomberont à 0 après cette question
  if (p.busted || Math.random() < cheatRisk(room, p)) {
    p.busted = true;
    (p.wipeAt ||= new Set()).add(room.qIndex);
  }
  p.cheats++;
  room.cheated.add(p.id);
}

/* ------------------------------------------------------------------ */
/* Vol de points : le seul joueur à avoir bien répondu peut voler un   */
/* peu de points à un joueur de son choix (30 % de son score, au plus  */
/* la moitié des points de la question).                               */
/* ------------------------------------------------------------------ */
function makeSteal(room) {
  if (room.settings.steal === false || room.stealFor === room.qIndex) return;
  room.stealFor = room.qIndex;
  room.steal = null;
  const q = currentQ(room);
  if (!q || q.trap || room.players.size < 2) return;
  const good = [...room.answers.entries()].filter(([pid, a]) => room.players.has(pid) && a.correct);
  if (good.length !== 1) return;
  room.steal = { qIndex: room.qIndex, thiefId: good[0][0], amount: Math.max(1, Math.round(q.points / 2)), victimId: null, taken: 0 };
}
// Ce qu'on prend à une victime : « un peu » = 30 % de son score, sans dépasser la moitié de la question
const stealTake = (st, score) => (score > 0 ? Math.min(st.amount, Math.max(1, Math.round(score * 0.3))) : 0);
// Joueurs qu'on peut voler (ceux qui ont des points), avec ce qu'on leur prendrait
function stealTargets(room) {
  const st = room.steal;
  if (!st || st.victimId) return [];
  return ranking(room)
    .filter((e) => e.id !== st.thiefId && e.score > 0)
    .map((e) => ({ name: e.name, score: e.score, take: stealTake(st, e.score) }));
}
function playerSteal(body) {
  const { room, p } = playerOf(body);
  const st = room.steal;
  if (!st || st.thiefId !== p.id || st.victimId || !['reveal', 'leaderboard'].includes(room.state)) fail('Plus de vol possible');
  const victim = activePlayers(room).find((x) => x.name === body.target && x.id !== p.id);
  if (!victim) fail('Joueur introuvable');
  const take = stealTake(st, totalScore(room, victim, true));
  if (take <= 0) fail('Ce joueur n’a pas de points');
  victim.bonus -= take;
  p.bonus += take;
  Object.assign(st, { victimId: victim.id, taken: take });
  broadcast(room);
  return { ok: true, taken: take };
}
// Vol de la question en cours, en clair, pour les écrans
const stealInfo = (room) => {
  const st = room.steal;
  if (!st || !st.victimId || st.qIndex !== room.qIndex) return null;
  return { thief: room.players.get(st.thiefId)?.name ?? '?', victim: room.players.get(st.victimId)?.name ?? '?', amount: st.taken };
};

// Propositions pour la prochaine question (une seule fois par question)
function makeOffers(room) {
  if (!room.settings.luck || room.offersFor === room.qIndex) return;
  room.offersFor = room.qIndex;
  if (room.qIndex + 1 >= room.quiz.questions.length) return; // plus de question après
  const players = activePlayers(room);
  // Le ou les premiers du classement ne sont jamais tentés
  const leaders = new Set(ranking(room, false).filter((e) => e.rank === 1).map((e) => e.id));
  for (const p of players) {
    p.offer = p.cheats > 0 && !leaders.has(p.id); // après une première triche : à chaque manche
    p.cheatNext = false;
  }
  if (Math.random() >= offerRoundChance(room)) return;
  // Tirage au sort parmi ceux qui n'ont jamais été tentés, dans la limite de « peu de joueurs » par partie
  const tempted = players.filter((p) => p.tempted).length;
  const fresh = players.filter((p) => !p.tempted && !leaders.has(p.id));
  for (let i = 0; i < offersPerRound(room) && fresh.length && tempted + i < maxTempted(room); i++) {
    const p = fresh.splice(Math.floor(Math.random() * fresh.length), 1)[0];
    p.offer = true;
    p.tempted = true;
  }
}

function playerCheat(body) {
  const { room, p } = playerOf(body);
  if (!room.settings.luck || !p.offer || !['reveal', 'leaderboard'].includes(room.state)) fail('Plus de proposition en cours');
  p.offer = false;
  p.cheatNext = !!body.accept;
  broadcast(room, p);
  return { ok: true, accepted: p.cheatNext };
}

// Fermeture automatique quand tous les joueurs connectés ont répondu. Un tricheur compte
// comme ayant répondu, même sur une question piège où sa « réponse » est de ne rien envoyer.
function maybeAutoClose(room) {
  if (!room.settings.autoClose || room.state !== 'question') return false;
  const active = activePlayers(room).filter(playerConnected);
  if (!active.length || !active.every((x) => room.answers.has(x.id) || room.cheated?.has(x.id))) return false;
  closeQuestion(room, true);
  return true;
}

// Un téléphone vient de se déconnecter : s'il n'est pas revenu après le délai de grâce, on le
// considère parti et, si tous ceux qui restent ont répondu, on passe à la réponse.
const GRACE = 6500; // un téléphone qui se met en veille un instant n'est pas considéré parti
function recheckAfterLeave(room, p) {
  setTimeout(() => {
    if (!rooms.has(room.code) || (p && room.players.has(p.id) && playerConnected(p))) return;
    if (!maybeAutoClose(room)) broadcast(room); // l'animateur voit le joueur déconnecté
  }, GRACE).unref();
}

function closeQuestion(room, notify) {
  if (room.state !== 'question') return;
  clearTimeout(room.timer);
  room.state = 'closed';
  scoreQuestion(room);
  if (notify) broadcast(room);
}

/* ------------------------------------------------------------------ */
/* Tournoi : enchaînement des étapes                                    */
/* lobby → stageIntro → (module) → stageEnd (qualifiés) → stageIntro …  */
/* → end (podium de la dernière étape)                                  */
/* ------------------------------------------------------------------ */
const emptyQuiz = (room) => ({ id: '', title: room.tour.title, questions: [] });

function startStage(room, i) {
  room.stageIndex = i;
  resetScores(room); // les scores repartent de zéro à chaque étape
  room.quiz = stage(room).quiz || emptyQuiz(room);
  room.th = null;
  room.im = null;
  room.state = 'stageIntro';
}

function beginStage(room) {
  const st = stage(room);
  if (st.type === 'quiz') return startQuestion(room, 0);
  if (st.type === 'themes') {
    // Ordre de passage : classement de l'étape précédente (1er en premier), sinon ordre d'arrivée
    const active = activePlayers(room);
    const order = room.order.filter((id) => active.some((p) => p.id === id));
    for (const p of active) if (!order.includes(p.id)) order.push(p.id);
    room.th = { order, turn: 0, phase: 'pick', taken: {}, theme: -1, qNum: 0, mode: null, shown: null, given: null, correct: null };
    room.state = 'themes';
    return;
  }
  room.im = { img: 0, qCounter: 0, appliedFor: -1, guesses: new Map(), guessOpen: 0, found: [], winner: null, over: false };
  startImQuestion(room);
}

// Fin d'étape : les N premiers sont pré-cochés « qualifiés » (l'animateur peut corriger)
function endStage(room) {
  closeQuestion(room);
  clearTimeout(room.timer);
  room.prevRanks = new Map();
  if (room.stageIndex >= room.tour.stages.length - 1) {
    room.state = 'end';
    return;
  }
  const st = stage(room);
  for (const e of ranking(room, false)) room.players.get(e.id).qualified = e.rank <= st.qualify;
  room.state = 'stageEnd';
}

function nextStage(room) {
  const board = ranking(room, false);
  if (!board.some((e) => room.players.get(e.id)?.qualified)) fail('Aucune équipe qualifiée : cochez au moins une équipe');
  room.order = board.filter((e) => room.players.get(e.id).qualified).map((e) => e.id);
  for (const p of activePlayers(room)) if (!p.qualified) p.out = true;
  startStage(room, room.stageIndex + 1);
}

function resetTournament(room) {
  for (const p of room.players.values()) p.out = false;
  room.order = [];
  room.stageIndex = -1;
  room.th = null;
  room.im = null;
  room.quiz = emptyQuiz(room);
  resetScores(room);
}

/* ---------- Module Thèmes (géré par l'animateur) ---------- */
// Phases : pick (l'équipe choisit un thème) → question (énoncé seul) → options (duo / carré / cash
// choisi, réponses affichées) → result → question suivante… → équipe suivante … → done
const thTeam = (room) => room.players.get(room.th?.order[room.th.turn]);
function thQuestions(room) {
  const st = stage(room);
  return room.th.theme >= 0 ? st.themes[room.th.theme].questions.slice(0, st.perTeam) : [];
}
const canChoose = (q) => q?.type === 'choice' && q.choices.length >= 2 && q.choices.some((c) => c.correct);
const goodChoice = (q) => q.choices.findIndex((c) => c.correct);
function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}
function thSetQuestion(room) {
  Object.assign(room.th, { phase: 'question', mode: null, shown: null, given: null, correct: null, cashText: null });
}
function thNextTeam(room) {
  const th = room.th;
  th.turn++;
  const gone = (id) => { const p = room.players.get(id); return !p || p.out; }; // équipe exclue entre-temps
  while (th.turn < th.order.length && gone(th.order[th.turn])) th.turn++;
  Object.assign(th, { theme: -1, qNum: 0, mode: null, shown: null, given: null, correct: null, cashText: null });
  th.phase = th.turn < th.order.length ? 'pick' : 'done';
}

function thAction(room, action, payload) {
  const th = room.th;
  const st = stage(room);
  const team = thTeam(room);
  const q = thQuestions(room)[th.qNum];
  switch (action) {
    case 'thPick': {
      if (th.phase !== 'pick' || !team) fail('Ce n’est pas le moment de choisir un thème');
      const i = Number(payload.theme);
      if (!st.themes[i]) fail('Thème introuvable');
      if (th.taken[i] != null) fail('Ce thème a déjà été choisi');
      th.taken[i] = team.id;
      th.theme = i;
      th.qNum = 0;
      thSetQuestion(room);
      return true;
    }
    case 'thMode': {
      if (th.phase !== 'question' || !q) fail('Pas de question en cours');
      const mode = payload.mode;
      if (!['duo', 'carre', 'cash'].includes(mode)) fail('Choix inconnu');
      if (mode !== 'cash' && !canChoose(q)) fail('Cette question n’a pas de choix de réponses : seulement Cash');
      th.mode = mode;
      if (mode === 'cash') th.shown = [];
      else {
        // La bonne réponse + 1 (duo) ou 3 (carré) mauvaises tirées au hasard, dans l'ordre d'origine
        const wrong = shuffle(q.choices.map((_, i) => i).filter((i) => !q.choices[i].correct));
        th.shown = [goodChoice(q), ...wrong.slice(0, mode === 'duo' ? 1 : 3)].sort((a, b) => a - b);
      }
      th.phase = 'options';
      return true;
    }
    case 'thAnswer': {
      // Réponse de l'équipe : sur son téléphone, ou à l'oral et saisie par l'animateur
      // (l'animateur peut corriger tant qu'on n'est pas passé à la suite)
      if (!['options', 'result'].includes(th.phase) || !q || !team) fail('Pas de réponse attendue');
      if (payload.text != null && th.mode === 'cash') {
        // Cash tapé sur le téléphone : comparé à la bonne réponse, avec une petite tolérance de frappe
        const text = String(payload.text).trim().slice(0, 100);
        if (!text) fail('Réponse vide');
        const accepted = q.type === 'choice' ? q.choices.filter((c) => c.correct).map((c) => c.text) : [];
        th.cashText = text;
        th.given = null;
        th.correct = textMatches(normalize(text), { answers: [...accepted, ...(q.answers || [])], fuzzy: true });
      } else if (payload.choice != null && th.mode !== 'cash') {
        const c = Number(payload.choice);
        if (!th.shown.includes(c)) fail('Réponse non proposée');
        th.given = c;
        th.correct = !!q.choices[c].correct;
      } else {
        th.given = null;
        th.correct = !!payload.correct;
      }
      team.history[`th${th.theme}_${th.qNum}`] = th.correct ? st.points[th.mode] : 0;
      th.phase = 'result';
      return true;
    }
    case 'thNext':
      if (th.phase === 'result') {
        if (th.qNum + 1 < thQuestions(room).length) {
          th.qNum++;
          thSetQuestion(room);
        } else thNextTeam(room);
      } else if (th.phase === 'pick') thNextTeam(room); // passer le tour de cette équipe
      return true;
    case 'next':
    case 'goto':
    case 'leaderboard':
    case 'reveal':
    case 'close':
      return true; // sans objet dans ce module
  }
  return false;
}

/* ---------- Module Images ---------- */
// Une seule image pour tout le monde. Chaque bonne réponse à une question rend l'image plus
// nette sur le téléphone de l'équipe. Entre deux questions (phase « guess »), les équipes
// proposent un nom (téléphone ou oral) et l'animateur attribue l'image.
const imImage = (room) => stage(room).images[room.im.img];

function startImQuestion(room) {
  const im = room.im;
  im.guesses = new Map();
  im.qCounter++;
  // Quand toutes les questions ont été posées, on recommence au début
  startQuestion(room, (im.qCounter - 1) % room.quiz.questions.length);
}

// Une bonne réponse = un cran de netteté (une seule fois par question)
function applyImLevels(room) {
  const im = room.im;
  if (im.appliedFor === im.qCounter) return;
  im.appliedFor = im.qCounter;
  const st = stage(room);
  for (const [pid, a] of room.answers) {
    const p = room.players.get(pid);
    if (!p || p.out || !(a.correct || a.points > 0)) continue;
    p.imCorrect = (p.imCorrect || 0) + 1;
    p.imLevel = Math.min(st.levels, (p.imLevel || 0) + 1);
  }
}

// Moments de l'étape Images où l'image est en jeu (elle peut être attribuée)
const IM_PLAY_STATES = ['question', 'closed', 'reveal', 'guess'];
function imAwardTo(room, p) {
  const im = room.im;
  // Attribuée pendant une question : on ferme les réponses ; « Annuler » y ramène, réponses fermées
  if (room.state === 'question') closeQuestion(room);
  im.backTo = room.state;
  im.winner = p.id;
  p.imWins = (p.imWins || 0) + 1;
  im.found.push({ img: im.img, by: p.id });
  im.over = p.imWins >= stage(room).wins;
  room.state = 'imFound';
}

function imAction(room, action, payload) {
  const im = room.im;
  const st = stage(room);
  switch (action) {
    case 'imGuess':
      if (!['question', 'closed', 'reveal'].includes(room.state)) fail('Pas de question en cours');
      closeQuestion(room);
      applyImLevels(room);
      im.guesses = new Map();
      im.guessOpen = Date.now();
      room.state = 'guess';
      return true;
    case 'next': // question suivante, même image
      if (room.state === 'guess') startImQuestion(room);
      return true;
    case 'imAward': {
      // À tout moment de l'étape (pendant une question, après, ou pendant les propositions) :
      // une équipe a trouvé à l'oral, ou l'animateur valide une proposition jugée fausse
      if (!IM_PLAY_STATES.includes(room.state)) fail('Pas d’image en jeu');
      const p = room.players.get(payload.playerId);
      if (!p || p.out) fail('Équipe introuvable');
      imAwardTo(room, p);
      return true;
    }
    case 'imSkip': // personne ne trouve : on dévoile et on passe à l'image suivante
      if (room.state !== 'guess') fail('Les propositions ne sont pas ouvertes');
      im.winner = null;
      im.found.push({ img: im.img, by: null });
      room.state = 'imFound';
      return true;
    case 'imUndo': {
      // Erreur de l'animateur : on annule l'attribution et on revient aux propositions
      if (room.state !== 'imFound') fail('Rien à annuler');
      const p = im.winner && room.players.get(im.winner);
      if (p) p.imWins = Math.max(0, (p.imWins || 0) - 1);
      im.found.pop();
      im.winner = null;
      im.over = false;
      room.state = im.backTo || 'guess';
      return true;
    }
    case 'imNextImage':
      if (room.state !== 'imFound') fail('Image pas encore trouvée');
      if (im.over || im.img + 1 >= st.images.length) {
        endStage(room);
        return true;
      }
      im.img++;
      im.winner = null;
      for (const p of activePlayers(room)) p.imLevel = 0;
      startImQuestion(room);
      return true;
    case 'goto':
    case 'leaderboard':
      return true; // sans objet dans ce module
  }
  return false;
}

function playerGuess(body) {
  const { room, p } = playerOf(body);
  if (stageType(room) !== 'images' || room.state !== 'guess') fail('Pas de proposition pour le moment');
  if (p.out) fail('Tu es éliminé');
  if (room.im.guesses.has(p.id)) fail('Tu as déjà proposé une réponse');
  if (body.pass) room.im.guesses.set(p.id, { pass: true, at: Date.now() });
  else {
    const text = String(body.text ?? '').trim().slice(0, 100);
    if (!text) fail('Réponse vide');
    const ok = textMatches(normalize(text), imImage(room));
    room.im.guesses.set(p.id, { text, at: Date.now(), ok });
    // Proposition juste : la plus rapide gagne l'image tout de suite (l'animateur peut annuler)
    if (ok) {
      imAwardTo(room, p);
      broadcast(room);
      return { ok: true, won: true };
    }
  }
  broadcast(room, p);
  return { ok: true };
}

// Étape Thèmes : l'équipe dont c'est le tour choisit son thème, Duo / Carré / Cash et répond
const PLAYER_TH_ACTIONS = { pick: 'thPick', mode: 'thMode', answer: 'thAnswer' };
function playerTheme(body) {
  const { room, p } = playerOf(body);
  if (stageType(room) !== 'themes' || room.state !== 'themes' || !room.th) fail('Pas d’étape Thèmes en cours');
  if (p.out) fail('Tu es éliminé');
  if (thTeam(room)?.id !== p.id) fail('Ce n’est pas ton tour');
  const action = PLAYER_TH_ACTIONS[body.action];
  if (!action) fail('Action inconnue');
  // Une fois la réponse donnée, seul l'animateur peut la corriger
  if (action === 'thAnswer' && room.th.phase !== 'options') fail('Réponse déjà donnée');
  // Seulement ce que l'équipe a le droit d'envoyer (jamais « correct » directement)
  const payload = { theme: body.theme, mode: body.mode };
  if (action === 'thAnswer') {
    if (room.th.mode === 'cash') payload.text = String(body.text ?? '');
    else if (body.choice == null) fail('Choisis une réponse');
    else payload.choice = body.choice;
  }
  thAction(room, action, payload);
  broadcast(room);
  return { ok: true };
}

// Actions de l'animateur propres au tournoi ; renvoie true si l'action a été traitée
function tourAction(room, action, payload) {
  const type = stageType(room);
  switch (action) {
    case 'reset':
      resetTournament(room);
      return true;
    case 'reloadQuiz':
      fail('Impossible pendant un tournoi');
      break;
    case 'stageStart':
      if (room.state !== 'stageIntro') fail('L’étape a déjà commencé');
      beginStage(room);
      return true;
    case 'stageNext':
      if (room.state !== 'stageEnd') fail('L’étape n’est pas terminée');
      nextStage(room);
      return true;
    case 'qualify': {
      if (room.state !== 'stageEnd') fail('Possible seulement en fin d’étape');
      const p = room.players.get(payload.playerId);
      if (p && !p.out) p.qualified = !!payload.on;
      return true;
    }
    case 'end': // « Terminer l'étape »
      if (!['lobby', 'end', 'stageEnd'].includes(room.state)) endStage(room);
      return true;
  }
  if (room.state === 'lobby') {
    if (action === 'next') startStage(room, 0);
    return action === 'next';
  }
  if (type === 'themes' && room.th) return thAction(room, action, payload);
  if (type === 'images' && room.im) return imAction(room, action, payload);
  // Étape Quiz : après la dernière question, fin de l'étape (classement + qualifiés)
  if (type === 'quiz' && action === 'next' && room.qIndex + 1 >= room.quiz.questions.length) {
    endStage(room);
    return true;
  }
  return false;
}

/* ---------- Vues du tournoi ---------- */
function tourInfo(room) {
  if (!room.tour) return null;
  return {
    title: room.tour.title,
    stage: room.stageIndex,
    type: stageType(room),
    last: room.stageIndex >= room.tour.stages.length - 1,
    stages: room.tour.stages.map((s) => ({ type: s.type, label: STAGE_LABELS[s.type], qualify: s.qualify })),
  };
}

function themesView(room, host) {
  const th = room.th;
  if (!th) return null;
  const st = stage(room);
  const team = thTeam(room);
  const qs = thQuestions(room);
  const q = qs[th.qNum];
  const showQ = !!q && ['question', 'options', 'result'].includes(th.phase);
  const result = th.phase === 'result';
  const answer = showQ && (result || host);
  return {
    phase: th.phase,
    themes: st.themes.map((t, i) => ({
      title: t.title,
      count: Math.min(st.perTeam, t.questions.length),
      takenBy: th.taken[i] != null ? room.players.get(th.taken[i])?.name ?? '—' : null,
    })),
    order: th.order.map((id, i) => ({ name: room.players.get(id)?.name ?? '—', done: i < th.turn, current: i === th.turn && th.phase !== 'done' })),
    team: team && th.phase !== 'done' ? team.name : null,
    teamId: host ? team?.id ?? null : undefined,
    scores: ranking(room).map((e) => ({ name: e.name, score: e.score, rank: e.rank })),
    theme: th.theme >= 0 ? st.themes[th.theme].title : null,
    qNum: th.qNum,
    qCount: qs.length,
    points: st.points,
    question: showQ ? { text: q.text, image: q.image, choicesOk: canChoose(q) } : null,
    mode: showQ ? th.mode : null,
    shown: showQ && th.shown ? th.shown.map((i) => ({ i, text: q.choices[i].text })) : null,
    given: th.given,
    cashText: showQ ? th.cashText : null,
    correct: result ? th.correct : null,
    gained: result ? (th.correct ? st.points[th.mode] : 0) : null,
    answer: answer ? correctAnswerText(q) : null,
    goodIndex: answer && q.type === 'choice' ? goodChoice(q) : null,
  };
}

// role : host (image nette + propositions), display (netteté la plus basse), player (sa netteté)
function imagesView(room, role, p) {
  const im = room.im;
  if (!im) return null;
  const st = stage(room);
  const img = imImage(room);
  const active = activePlayers(room);
  const found = room.state === 'imFound';
  const minLevel = active.length ? Math.min(...active.map((x) => x.imLevel || 0)) : 0;
  const v = {
    index: im.img,
    total: st.images.length,
    levels: st.levels,
    effect: st.effect,
    wins: st.wins,
    // L'image passe par le serveur : l'adresse d'origine (souvent parlante) reste cachée
    src: `/api/stage-image?code=${room.code}&n=${im.img}`,
    level: found || role === 'host' ? st.levels : role === 'player' ? p.imLevel || 0 : minLevel,
    teams: ranking(room).map((e) => {
      const x = room.players.get(e.id);
      return { name: e.name, rank: e.rank, correct: x.imCorrect || 0, wins: x.imWins || 0, guessed: im.guesses.has(e.id), level: role === 'host' ? x.imLevel || 0 : undefined };
    }),
    guessCount: im.guesses.size,
    found: found ? { answer: img.answers[0], by: im.winner ? room.players.get(im.winner)?.name ?? '?' : null, over: im.over } : null,
  };
  if (role === 'host') {
    v.answers = img.answers;
    v.guesses = [...im.guesses]
      .map(([pid, g]) => ({ playerId: pid, name: room.players.get(pid)?.name ?? '?', text: g.text ?? '', pass: !!g.pass, ok: !!g.ok, ms: g.at - im.guessOpen }))
      .sort((a, b) => a.ms - b.ms);
  }
  if (role === 'player') {
    const g = im.guesses.get(p.id);
    v.guessed = !!g;
    v.myGuess = g && !g.pass ? g.text : null;
    v.myWins = p.imWins || 0;
    v.myCorrect = p.imCorrect || 0;
  }
  return v;
}

/* ------------------------------------------------------------------ */
/* Vues envoyées à chaque type de client                                */
/* ------------------------------------------------------------------ */
function publicQuestion(room, withImage) {
  const q = currentQ(room);
  if (!q) return null;
  return {
    index: room.qIndex,
    total: room.quiz.questions.length,
    type: q.type,
    text: q.text,
    image: withImage ? q.image : '',
    points: q.points,
    time: q.time,
    unit: q.unit || '',
    choices: q.type === 'choice' ? q.choices.map((c) => c.text) : undefined,
    multi: q.type === 'choice' && !!q.multi,
    pick: q.type === 'choice' && q.multi ? q.choices.filter((c) => c.correct).length : undefined,
    view: q.type === 'map' ? q.view : undefined,
    // Curseur : seulement les bornes et le pas (jamais la réponse)
    slider: q.type === 'number' ? (({ min, max, step }) => ({ min, max, step }))(QSlider.forQuestion(q)) : undefined,
  };
}

const remaining = (room) => (room.state === 'question' && room.deadline ? Math.max(0, room.deadline - Date.now()) : 0);

function textGroups(room) {
  const groups = new Map();
  for (const [pid, a] of room.answers) {
    if (!room.players.has(pid)) continue;
    const key = a.key ?? normalize(a.value);
    const g = groups.get(key) || { key, text: a.value, count: 0, correct: false, players: [] };
    g.count++;
    g.correct = g.correct || !!a.correct;
    g.players.push(room.players.get(pid).name);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function revealData(room) {
  const q = currentQ(room);
  if (!q) return null;
  const answers = [...room.answers.entries()].filter(([pid]) => room.players.has(pid)).map(([pid, a]) => ({ ...a, pid }));
  const correctCount = answers.filter((a) => a.correct).length;
  const base = { answer: correctAnswerText(q), correctCount, answerCount: answers.length };
  if (q.trap) {
    // Ceux qui ont résisté = joueurs sans réponse
    base.trap = true;
    base.resisted = activePlayers(room).filter((p) => !room.answers.has(p.id)).length;
    base.playerCount = activePlayers(room).length;
  }
  if (q.type === 'choice') {
    const counts = q.choices.map(() => 0);
    answers.forEach((a) => (Array.isArray(a.value) ? a.value : [a.value]).forEach((i) => counts[i]++));
    base.partialCount = answers.filter((a) => a.partial).length;
    return { ...base, correct: q.choices.map((c, i) => (c.correct ? i : -1)).filter((i) => i >= 0), counts };
  }
  if (q.type === 'map') {
    const sorted = [...answers].sort((a, b) => a.diff - b.diff);
    return {
      ...base,
      partialCount: answers.filter((a) => a.partial).length,
      target: { lat: q.lat, lng: q.lng, label: q.label },
      tolerance: q.tolerance,
      maxKm: q.maxKm,
      mode: q.mode,
      pins: sorted.slice(0, 300).map((a) => ({
        name: room.players.get(a.pid)?.name ?? '?', lat: a.value.lat, lng: a.value.lng,
        d: Math.round(a.diff), correct: !!a.correct, partial: !!a.partial, points: a.points ?? 0,
      })),
    };
  }
  if (q.type === 'text') {
    return { ...base, accepted: q.answers, groups: textGroups(room).slice(0, 14).map(({ players, ...g }) => g) };
  }
  const sorted = [...answers].sort((a, b) => a.diff - b.diff);
  const avg = answers.length ? answers.reduce((s, a) => s + a.value, 0) / answers.length : null;
  return {
    ...base,
    value: q.value,
    unit: q.unit,
    tolerance: q.tolerance,
    mode: q.mode,
    avg,
    closest: sorted.slice(0, 5).map((a) => ({ name: room.players.get(a.pid)?.name ?? '?', value: a.value, correct: a.correct })),
  };
}

function displayView(room) {
  const showBoard = ['reveal', 'leaderboard', 'end', 'stageEnd'].includes(room.state);
  return {
    tour: tourInfo(room),
    th: room.state === 'themes' ? themesView(room, false) : null,
    im: ['guess', 'imFound'].includes(room.state) ? imagesView(room, 'display') : null,
    code: room.code,
    joinUrl: `${publicUrl}/play?room=${room.code}`,
    // 'starting' : l'adresse Internet n'est pas encore prête, ne pas afficher le QR code
    netReady: tunnel.mode !== 'starting',
    title: room.quiz.title,
    state: room.state,
    players: activePlayers(room).map((p) => ({ name: p.name, connected: playerConnected(p) })),
    question: publicQuestion(room, true),
    remaining: remaining(room),
    answeredCount: room.answers.size,
    reveal: room.state === 'reveal' ? revealData(room) : null,
    steal: ['reveal', 'leaderboard'].includes(room.state) ? stealInfo(room) : null,
    leaderboard: showBoard
      ? ranking(room).slice(0, ['end', 'stageEnd'].includes(room.state) ? 30 : 10).map((e) => {
        const p = room.players.get(e.id);
        // cheater : démasqué en fin de partie ; qualified : fin d'étape d'un tournoi
        return { ...e, cheater: room.state === 'end' && !!p?.busted, qualified: room.state === 'stageEnd' ? !!p?.qualified : undefined };
      })
      : null,
  };
}

// Pseudos visibles par les joueurs dans le salon d'attente (ordre d'arrivée).
const lobbyNames = (room) => (['lobby', 'stageIntro'].includes(room.state) ? activePlayers(room).map((p) => p.name) : null);

// Classement complet envoyé aux téléphones à l'écran « Classement » entre les
// questions et à la fin (pas à l'écran de la réponse).
// (nom, rang, score, points de la dernière question). Pas d'identifiants internes.
const BOARD_STATES = ['leaderboard', 'end', 'stageEnd'];
const publicBoard = (room, board) =>
  BOARD_STATES.includes(room.state)
    ? board.map((e) => {
      const p = room.players.get(e.id);
      return { rank: e.rank, name: e.name, score: e.score, last: e.last, move: e.move, cheater: room.state === 'end' && !!p?.busted, qualified: room.state === 'stageEnd' ? !!p?.qualified : undefined };
    })
    : null;

function playerView(room, p, board, names = lobbyNames(room), pub = publicBoard(room, board)) {
  const a = room.answers.get(p.id);
  const me = board.find((e) => e.id === p.id);
  const revealed = ['reveal', 'leaderboard', 'end', 'stageEnd'].includes(room.state);
  const q = currentQ(room);
  const th = room.state === 'themes' ? themesView(room, false) : null;
  return {
    tour: tourInfo(room),
    out: !!p.out, // éliminé du tournoi : il regarde seulement
    qualified: room.state === 'stageEnd' ? !!p.qualified : null,
    // Thèmes : tout le monde voit la question ; l'équipe dont c'est le tour joue sur son téléphone
    th: th ? { ...th, scores: undefined, me: !p.out && thTeam(room)?.id === p.id } : null,
    im: stageType(room) === 'images' && room.im && !p.out ? imagesView(room, 'player', p) : null,
    code: room.code,
    title: room.quiz.title,
    state: room.state,
    name: p.name,
    score: me?.score ?? 0,
    rank: revealed ? me?.rank : null,
    playerCount: activePlayers(room).length,
    players: names,
    board: pub,
    question: publicQuestion(room, false),
    remaining: remaining(room),
    answered: !!a,
    myAnswer: answerText(q, a),
    result:
      room.state === 'reveal' && q
        ? q.trap
          ? { trap: true, answered: !!a, correct: a ? !!a.correct : true, partial: false, points: p.history[room.qIndex] ?? 0, answer: correctAnswerText(q) }
          : {
            answered: !!a, correct: !!a?.correct, partial: !!a?.partial, points: a?.points ?? 0, answer: correctAnswerText(q),
            map: q.type === 'map' ? { target: { lat: q.lat, lng: q.lng }, mine: a?.value ?? null, d: a ? Math.round(a.diff) : null, tolerance: q.tolerance } : undefined,
          }
        : null,
    dev: devActive(room, p),
    // Tentation de triche
    offer: !!(room.settings.luck && p.offer && ['reveal', 'leaderboard'].includes(room.state)) ? { risk: riskLabel(cheatRisk(room, { ...p, busted: false })), first: p.cheats === 0 } : null,
    cheatPending: !!(room.settings.luck && p.cheatNext),
    cheated: !!room.cheated?.has(p.id) && ['question', 'closed', 'reveal'].includes(room.state),
    busted: room.state === 'end' && !!p.busted, // étiquette « Tricheur » au classement final
    // Vol de points : proposition (seul à avoir bien répondu), puis ce qui s'est passé
    stealOffer: room.steal && room.steal.thiefId === p.id && !room.steal.victimId && ['reveal', 'leaderboard'].includes(room.state)
      ? { amount: room.steal.amount, targets: stealTargets(room) } : null,
    steal: ['reveal', 'leaderboard'].includes(room.state) ? stealInfo(room) : null,
    // Uniquement dans la vue de CE joueur, et seulement s'il s'est inscrit avec #dev
    devAnswer: devActive(room, p) && q ? devAnswer(q) : null,
  };
}

// Mode test actif : le joueur s'est inscrit avec #dev, l'animateur ne le lui a pas retiré
// et ne l'a pas désactivé pour tout le salon.
const devActive = (room, p) => !!p.dev && room.settings.allowDev !== false;

function devAnswer(q) {
  if (q.trap) return { text: '🪤 Piège : ne réponds pas !', trap: true };
  const out = { text: correctAnswerText(q) };
  if (q.type === 'choice') out.correct = q.choices.map((c, i) => (c.correct ? i : -1)).filter((i) => i >= 0);
  else if (q.type === 'text') out.accepted = q.answers;
  else if (q.type === 'map') out.target = { lat: q.lat, lng: q.lng };
  else Object.assign(out, { value: q.value, tolerance: q.tolerance, unit: q.unit || '' });
  return out;
}

function hostView(room) {
  const q = currentQ(room);
  const scored = room.state !== 'question';
  const answers = [...room.answers.entries()]
    .filter(([pid]) => room.players.has(pid))
    .map(([pid, a]) => ({
      playerId: pid,
      name: room.players.get(pid).name,
      value: answerText(q, a),
      correct: scored ? !!a.correct : null,
      partial: scored ? !!a.partial : null,
      points: scored ? a.points : null,
      ms: a.at - room.startedAt,
    }))
    .sort((x, y) => x.ms - y.ms);
  return {
    tour: tourInfo(room),
    th: room.state === 'themes' ? themesView(room, true) : null,
    im: stageType(room) === 'images' && room.im ? imagesView(room, 'host') : null,
    eliminated: [...room.players.values()].filter((p) => p.out).map((p) => p.name),
    code: room.code,
    joinUrl: `${publicUrl}/play?room=${room.code}`,
    // 'starting' : l'adresse Internet n'est pas encore prête, ne pas afficher le QR code
    netReady: tunnel.mode !== 'starting',
    title: room.quiz.title,
    quizId: room.quiz.id,
    questions: room.quiz.questions.map((x) => ({ text: x.text, type: x.type, points: x.points })),
    settings: room.settings,
    state: room.state,
    qIndex: room.qIndex,
    question: q ? { ...q, answerText: correctAnswerText(q) } : null,
    remaining: remaining(room),
    answers,
    groups: q?.type === 'text' && scored ? textGroups(room) : null,
    reveal: scored && q ? revealData(room) : null,
    steal: stealInfo(room),
    stealPending: room.steal && !room.steal.victimId && room.steal.qIndex === room.qIndex ? room.players.get(room.steal.thiefId)?.name : null,
    ranking: ranking(room, false).map((e) => {
      const p = room.players.get(e.id);
      return {
        ...e, dev: !!p?.dev, cheats: p?.cheats || 0, busted: !!p?.busted,
        risk: p ? Math.round(cheatRisk(room, p) * 100) : 0, offer: !!p?.offer, cheatNext: !!p?.cheatNext,
        qualified: !!p?.qualified,
      };
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Diffusion temps réel (Server-Sent Events)                            */
/* ------------------------------------------------------------------ */
function send(stream, event, data) {
  stream.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/*
 * Repli « long polling » : certains tunnels/proxys (ex. tunnel Cloudflare sur
 * certains réseaux) retiennent le contenu des flux SSE. La page interroge alors
 * /api/poll avec la dernière version reçue ; le serveur répond dès que l'état
 * change (ou au bout de 25 s), ce qui passe partout.
 */
const POLL_WAIT = 25000;
const playerConnected = (p) => p.streams > 0 || p.polls > 0 || Date.now() - (p.lastPoll || 0) < 6000;

function viewFor(room, role, pid) {
  if (role === 'host') return hostView(room);
  if (role === 'display') return displayView(room);
  const p = room.players.get(pid);
  return p ? playerView(room, p, ranking(room)) : null;
}

function answerPoll(room, w) {
  clearTimeout(w.timer);
  room.waiters.delete(w);
  if (w.done) return;
  w.done = true;
  if (w.pid && room.kicked.has(w.pid)) return json(w.res, 404, { error: 'Retiré de la partie', kicked: true });
  const state = viewFor(room, w.role, w.pid);
  if (!state) return json(w.res, 404, { error: 'Accès refusé' });
  json(w.res, 200, { v: room.version, state });
}

function openPoll(req, res, room, role, pid, since) {
  res.setHeader('Cache-Control', 'no-store, no-transform');
  const p = pid && room.players.get(pid);
  if (p) {
    const wasConnected = playerConnected(p);
    p.lastPoll = Date.now();
    if (!wasConnected) setImmediate(() => broadcast(room)); // l'animateur voit le joueur connecté
  }
  const w = { res, role, pid, done: false };
  if (since !== room.version) return answerPoll(room, w);
  room.waiters.add(w);
  if (p) p.polls++;
  w.timer = setTimeout(() => answerPoll(room, w), POLL_WAIT);
  res.on('close', () => {
    if (p) {
      p.polls = Math.max(0, p.polls - 1);
      p.lastPoll = Date.now();
      // Si la page ne revient pas (téléphone verrouillé, onglet fermé), l'animateur le voit déconnecté
      // et, si tous les autres ont répondu, on passe à la réponse
      recheckAfterLeave(room, p);
    }
    if (!w.done) { w.done = true; clearTimeout(w.timer); room.waiters.delete(w); }
  });
}

/* onlyPlayer : si fourni, seuls l'animateur, l'écran et ce joueur sont mis à jour */
function broadcast(room, onlyPlayer) {
  room.lastActive = Date.now();
  room.version++;
  for (const w of [...room.waiters]) {
    if (!onlyPlayer || w.role !== 'player' || w.pid === onlyPlayer.id) answerPoll(room, w);
  }
  let host, display, board, names, pub;
  for (const s of room.streams) {
    if (s.role === 'host') send(s, 'state', (host ??= hostView(room)));
    else if (s.role === 'display') send(s, 'state', (display ??= displayView(room)));
    else if (!onlyPlayer || s.pid === onlyPlayer.id) {
      const p = room.players.get(s.pid);
      if (p) {
        board ??= ranking(room);
        send(s, 'state', playerView(room, p, board, (names ??= lobbyNames(room)), (pub ??= publicBoard(room, board))));
      }
    }
  }
}

function openStream(req, res, room, role, pid) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1500\n\n');
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  const stream = { res, role, pid };
  room.streams.add(stream);
  const p = pid && room.players.get(pid);
  if (p) {
    p.streams++;
    if (p.streams === 1) broadcast(room);
  }
  if (role === 'host') send(stream, 'state', hostView(room));
  else if (role === 'display') send(stream, 'state', displayView(room));
  else if (p && p.streams > 1) send(stream, 'state', playerView(room, p, ranking(room)));

  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    room.streams.delete(stream);
    const pl = pid && room.players.get(pid);
    if (pl) {
      pl.streams = Math.max(0, pl.streams - 1);
      if (pl.streams === 0) {
        pl.lastPoll = Date.now(); // délai de grâce avant de le considérer parti
        recheckAfterLeave(room, pl);
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* Actions                                                              */
/* ------------------------------------------------------------------ */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (msg, status = 400) => { throw new HttpError(status, msg); };

function hostRoom(body) {
  const room = rooms.get(String(body.code));
  if (!room || room.token !== body.token) fail('Salon introuvable ou expiré', 404);
  return room;
}
function playerOf(body) {
  const room = rooms.get(String(body.code ?? '').trim());
  if (!room) fail('Salon introuvable', 404);
  const p = room.players.get(body.playerId);
  if (!p || p.key !== body.key) fail('Tu ne fais plus partie du salon', 404);
  return { room, p };
}

function hostAction(room, action, payload = {}) {
  if (!(room.tour && tourAction(room, action, payload))) quizAction(room, action, payload);
  // Tentation de triche et vol de points : seulement dans un quiz (partie simple ou étape Quiz)
  if (stageType(room) === 'quiz' && (room.state === 'reveal' || room.state === 'leaderboard')) { makeOffers(room); makeSteal(room); }
  broadcast(room);
}

function quizAction(room, action, payload) {
  const total = room.quiz.questions.length;
  switch (action) {
    case 'next':
      closeQuestion(room);
      if (room.qIndex + 1 < total) startQuestion(room, room.qIndex + 1);
      else {
        room.prevRanks = new Map(ranking(room).map((e) => [e.id, e.rank]));
        room.state = 'end';
      }
      break;
    case 'goto':
      closeQuestion(room);
      startQuestion(room, Number(payload.index));
      break;
    case 'close':
      closeQuestion(room);
      break;
    case 'reveal':
      closeQuestion(room);
      if (room.state === 'closed' || room.state === 'leaderboard') room.state = 'reveal';
      break;
    case 'leaderboard':
      closeQuestion(room);
      if (room.qIndex >= 0) room.state = 'leaderboard';
      break;
    case 'end':
      closeQuestion(room);
      room.state = 'end';
      break;
    case 'reset':
      resetScores(room);
      break;
    case 'addTime':
      if (room.state !== 'question' || !room.deadline) break;
      clearTimeout(room.timer);
      room.deadline += 10000;
      room.timer = setTimeout(() => closeQuestion(room, true), room.deadline - Date.now() + 250);
      break;
    case 'toggleGroup': {
      if (room.state === 'question' || currentQ(room)?.type !== 'text') break;
      const g = textGroups(room).find((x) => x.key === payload.key);
      if (!g) break;
      room.textOverrides.set(g.key, !g.correct);
      for (const [pid, a] of room.answers) if ((a.key ?? normalize(a.value)) === g.key) room.playerOverrides.delete(pid);
      scoreQuestion(room);
      break;
    }
    case 'togglePlayer': {
      if (room.state === 'question') break;
      const a = room.answers.get(payload.playerId);
      if (!a) break;
      room.playerOverrides.set(payload.playerId, !a.correct);
      scoreQuestion(room);
      break;
    }
    case 'adjust': {
      const p = room.players.get(payload.playerId);
      if (p) p.bonus += Math.round(Number(payload.delta) || 0);
      break;
    }
    case 'kick': {
      const p = room.players.get(payload.playerId);
      if (!p) break;
      room.players.delete(p.id);
      room.answers.delete(p.id);
      room.kicked.add(p.id);
      maybeAutoClose(room); // c'était peut-être le dernier à ne pas avoir répondu
      for (const w of [...room.waiters]) if (w.pid === p.id) answerPoll(room, w);
      for (const s of room.streams) {
        if (s.pid === p.id) {
          send(s, 'kicked', {});
          s.res.end();
          room.streams.delete(s);
        }
      }
      break;
    }
    case 'settings':
      room.settings.autoClose = !!payload.autoClose;
      if ('speed' in payload) room.settings.speed = !!payload.speed;
      if ('allowDev' in payload) room.settings.allowDev = !!payload.allowDev;
      if ('steal' in payload) {
        room.settings.steal = !!payload.steal;
        // Désactivé : on annule un vol proposé mais pas encore fait
        if (!room.settings.steal && room.steal && !room.steal.victimId) room.steal = null;
      }
      if ('luck' in payload) {
        room.settings.luck = !!payload.luck;
        // Désactivée : on retire les propositions en cours et les triches acceptées pas encore jouées
        if (!room.settings.luck) for (const p of room.players.values()) { p.offer = false; p.cheatNext = false; }
      }
      maybeAutoClose(room); // fermeture auto activée alors que tout le monde a déjà répondu
      break;
    case 'undev': {
      // Retire définitivement le mode test (#dev) à un joueur
      const p = room.players.get(payload.playerId);
      if (p) p.dev = false;
      break;
    }
    case 'reloadQuiz': {
      if (room.state !== 'lobby' && room.state !== 'end') fail('Possible uniquement dans la salle d’attente ou en fin de partie');
      const quiz = quizzes.find((q) => q.id === payload.quizId);
      if (!quiz || !quiz.questions.length) fail('Quiz introuvable ou vide');
      room.quiz = JSON.parse(JSON.stringify(quiz));
      resetScores(room);
      break;
    }
    default:
      fail('Action inconnue');
  }
}

const NAME_TAGS = ['dev'];

function playerJoin(body) {
  const room = rooms.get(String(body.code ?? '').trim());
  if (!room) fail('Salon introuvable. Vérifie le code.', 404);
  let p = body.playerId ? room.players.get(body.playerId) : null;
  if (p && p.key !== body.key) p = null;
  if (!p) {
    if (body.playerId && !body.name) fail('Session expirée, rejoins à nouveau', 404);
    // Étiquette en fin de pseudo (« Lucas#dev », « Lucas #dev ») :
    //   #dev : mode test, le joueur voit les bonnes réponses sur son téléphone
    // Elle est retirée du nom affiché partout. Une étiquette inconnue reste dans le pseudo.
    let raw = String(body.name ?? '').replace(/\s+/g, ' ').trim();
    const tags = new Set();
    for (let m; (m = /\s*#([a-z]+)$/i.exec(raw)) && NAME_TAGS.includes(m[1].toLowerCase());) {
      tags.add(m[1].toLowerCase());
      raw = raw.slice(0, m.index);
    }
    const dev = tags.has('dev');
    const clean = raw.slice(0, 20).trim();
    if (!clean) fail('Choisis un pseudo');
    if ([...room.players.values()].some((x) => x.name.toLowerCase() === clean.toLowerCase())) fail('Ce pseudo est déjà pris');
    if (room.players.size >= 300) fail('Le salon est complet');
    p = {
      id: uid(), key: uid() + uid(), name: clean, dev, history: {}, bonus: 0, streams: 0, polls: 0, lastPoll: 0,
      cheats: 0, busted: false, offer: false, cheatNext: false, wipes: {}, wipeAt: new Set(), // tentation de triche
      imLevel: 0, imCorrect: 0, imWins: 0, qualified: false,
      // Tournoi déjà commencé : l'équipe arrivée en retard regarde seulement
      out: !!room.tour && room.stageIndex >= 0,
    };
    room.players.set(p.id, p);
    broadcast(room);
  }
  return { playerId: p.id, key: p.key, name: p.name, code: room.code };
}

function playerAnswer(body) {
  const { room, p } = playerOf(body);
  if (room.state !== 'question') fail('Les réponses sont fermées');
  if (p.out) fail('Tu es éliminé : regarde l’écran');
  if (room.answers.has(p.id)) fail('Tu as déjà répondu');
  const q = currentQ(room);
  let v;
  const validChoice = (x) => Number.isInteger(x) && x >= 0 && x < q.choices.length;
  if (q.type === 'choice' && q.multi) {
    if (!Array.isArray(body.value)) fail('Choix invalide');
    v = [...new Set(body.value.map(Number))].sort((a, b) => a - b);
    if (!v.length) fail('Coche au moins une réponse');
    if (!v.every(validChoice)) fail('Choix invalide');
  } else if (q.type === 'choice') {
    v = Number(body.value);
    if (!validChoice(v)) fail('Choix invalide');
  } else if (q.type === 'text') {
    v = String(body.value ?? '').trim().slice(0, 100);
    if (!v) fail('Réponse vide');
  } else if (q.type === 'map') {
    const lat = Number(body.value?.lat), lng = Number(body.value?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail('Place ton repère sur la carte');
    v = { lat, lng };
  } else {
    v = Number(String(body.value ?? '').replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(v)) fail('Entre un nombre valide');
  }
  room.answers.set(p.id, { value: v, at: Date.now() });

  if (!maybeAutoClose(room)) broadcast(room, p);
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                 */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
};
const PAGES = { '/': 'index.html', '/host': 'host.html', '/display': 'display.html', '/play': 'play.html' };

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new HttpError(413, 'Requête trop volumineuse'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = PAGES[pathname] || pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 403, { error: 'Interdit' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'Introuvable' });
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes' };
    // Requêtes partielles (lecteurs audio : lecture en boucle, Safari)
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let start = 0, end = st.size - 1, status = 200;
    if (range && st.size) {
      start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = st.size ? end - start + 1 : 0;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || !st.size) return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
  });
}

/*
 * Image d'une étape Images : téléchargée par le serveur (adresse Internet) ou lue dans
 * le dossier public (adresse locale « /images/… »). Petit cache mémoire : tous les
 * téléphones demandent la même image en même temps.
 */
const imageCache = new Map(); // adresse → { type, buf }
async function serveStageImage(req, res, src) {
  if (!/^https?:\/\//i.test(src)) {
    const rel = src.split(/[?#]/)[0].replace(/^\/+/, '');
    try { return serveStatic(req, res, '/' + decodeURIComponent(rel)); } catch { return json(res, 404, { error: 'Image introuvable' }); }
  }
  let img = imageCache.get(src);
  if (!img) {
    let r;
    try { r = await fetch(src, { redirect: 'follow', signal: AbortSignal.timeout(10000) }); } catch { return json(res, 502, { error: 'Image injoignable' }); }
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !type.startsWith('image/')) return json(res, 502, { error: 'Ce lien ne mène pas à une image' });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 15 * 1024 * 1024) return json(res, 502, { error: 'Image trop lourde' });
    img = { type, buf };
    imageCache.set(src, img);
    if (imageCache.size > 40) imageCache.delete(imageCache.keys().next().value);
  }
  res.writeHead(200, { 'Content-Type': img.type, 'Content-Length': img.buf.length, 'Cache-Control': 'private, max-age=600' });
  res.end(req.method === 'HEAD' ? undefined : img.buf);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;

  if (m === 'GET' && p === '/api/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    return res.end(INSTANCE_ID);
  }
  if (m === 'GET' && p === '/api/info') {
    return json(res, 200, { publicUrl, lanUrl: LAN_URL, tunnel: tunnel.mode, tunnelError: tunnel.error });
  }
  if (m === 'GET' && p === '/api/stage-image') {
    // Image de l'étape Images en cours (seulement l'image courante, adresse d'origine cachée)
    const room = rooms.get(url.searchParams.get('code') || '');
    if (!room?.im || stageType(room) !== 'images' || Number(url.searchParams.get('n')) !== room.im.img) return json(res, 404, { error: 'Image indisponible' });
    return serveStageImage(req, res, imImage(room).image);
  }
  const adminOnly = (m === 'GET' && (p === '/api/quizzes' || p === '/api/tournaments'))
    || (m === 'POST' && (p.startsWith('/api/quizzes') || p.startsWith('/api/tournaments') || p === '/api/room/create'));
  if (adminOnly && !isAdmin(req)) {
    return json(res, 401, {
      error: ADMIN_PASSWORD ? 'Mot de passe requis' : 'La gestion n’est accessible que depuis le PC qui fait tourner le quiz',
      needPassword: !!ADMIN_PASSWORD,
    });
  }
  if (m === 'GET' && p === '/api/quizzes') return json(res, 200, quizzes);
  if (m === 'GET' && p === '/api/tournaments') return json(res, 200, tournaments);
  if (m === 'GET' && p.startsWith('/api/qr/')) {
    const code = p.slice(8).replace(/\D/g, '').slice(0, 8);
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
    return res.end(QR.toSvg(`${publicUrl}/play?room=${code}`));
  }
  if (m === 'GET' && p === '/api/events') {
    const q = url.searchParams;
    const room = rooms.get(q.get('code') || '');
    const role = q.get('role');
    if (!room) return json(res, 404, { error: 'Salon introuvable' });
    if (role === 'host' && q.get('token') === room.token) return openStream(req, res, room, 'host');
    if (role === 'display') return openStream(req, res, room, 'display');
    if (role === 'player') {
      const pl = room.players.get(q.get('playerId') || '');
      if (pl && pl.key === q.get('key')) return openStream(req, res, room, 'player', pl.id);
    }
    return json(res, 404, { error: 'Accès refusé' });
  }
  if (m === 'GET' && p === '/api/poll') {
    const q = url.searchParams;
    const room = rooms.get(q.get('code') || '');
    const role = q.get('role');
    const since = q.has('v') ? Number(q.get('v')) : -1;
    if (!room) return json(res, 404, { error: 'Salon introuvable' });
    if (role === 'host' && q.get('token') === room.token) return openPoll(req, res, room, 'host', null, since);
    if (role === 'display') return openPoll(req, res, room, 'display', null, since);
    if (role === 'player') {
      const pid = q.get('playerId') || '';
      if (room.kicked.has(pid)) return json(res, 404, { error: 'Retiré de la partie', kicked: true });
      const pl = room.players.get(pid);
      if (pl && pl.key === q.get('key')) return openPoll(req, res, room, 'player', pl.id, since);
    }
    return json(res, 404, { error: 'Accès refusé' });
  }

  if (m === 'POST' && p.startsWith('/api/')) {
    const body = await readBody(req);
    switch (p) {
      case '/api/quizzes': {
        const q = cleanQuiz(body);
        const i = quizzes.findIndex((x) => x.id === q.id);
        if (i >= 0) quizzes[i] = q;
        else quizzes.push(q);
        persist();
        return json(res, 200, q);
      }
      case '/api/quizzes/delete':
        quizzes = quizzes.filter((q) => q.id !== body.id);
        persist();
        return json(res, 200, { ok: true });
      case '/api/tournaments': {
        const t = cleanTournament(body);
        const i = tournaments.findIndex((x) => x.id === t.id);
        if (i >= 0) tournaments[i] = t;
        else tournaments.push(t);
        persistTournaments();
        return json(res, 200, t);
      }
      case '/api/tournaments/delete':
        tournaments = tournaments.filter((t) => t.id !== body.id);
        persistTournaments();
        return json(res, 200, { ok: true });
      case '/api/room/create': {
        if (body.tournamentId) {
          const t = tournaments.find((x) => x.id === body.tournamentId);
          if (!t) fail('Tournoi introuvable', 404);
          const room = createRoom(null, body.settings, resolveTournament(t));
          return json(res, 200, { code: room.code, token: room.token });
        }
        const quiz = quizzes.find((q) => q.id === body.quizId);
        if (!quiz) fail('Quiz introuvable', 404);
        if (!quiz.questions.length) fail('Ce quiz ne contient aucune question');
        const room = createRoom(quiz, body.settings);
        return json(res, 200, { code: room.code, token: room.token });
      }
      case '/api/room/action':
        hostAction(hostRoom(body), body.action, body.payload);
        return json(res, 200, { ok: true });
      case '/api/player/join':
        return json(res, 200, playerJoin(body));
      case '/api/player/answer':
        return json(res, 200, playerAnswer(body));
      case '/api/player/cheat':
        return json(res, 200, playerCheat(body));
      case '/api/player/steal':
        return json(res, 200, playerSteal(body));
      case '/api/player/theme':
        return json(res, 200, playerTheme(body));
      case '/api/player/guess':
        return json(res, 200, playerGuess(body));
    }
    return json(res, 404, { error: 'Introuvable' });
  }

  if (m === 'GET' || m === 'HEAD') return serveStatic(req, res, p);
  json(res, 405, { error: 'Méthode non autorisée' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (res.headersSent) return res.end();
    if (err instanceof HttpError) return json(res, err.status, { error: err.message });
    console.error(err);
    json(res, 500, { error: 'Erreur serveur' });
  });
});

/* Nettoyage des salons inactifs depuis 12 h */
setInterval(() => {
  const limit = Date.now() - 12 * 3600 * 1000;
  for (const [code, room] of rooms) {
    if (room.lastActive < limit && !room.streams.size) {
      clearTimeout(room.timer);
      rooms.delete(code);
    }
  }
}, 30 * 60 * 1000).unref();

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE'
    ? `\n  ⚠ Le port ${PORT} est déjà utilisé : le quiz tourne peut-être déjà. Fermez l’autre fenêtre ou changez PORT.\n`
    : `\n  ⚠ Impossible de démarrer : ${e.message}\n`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Quiz Live démarré !');
  if (HOSTED) {
    console.log(`  Mode hébergé        : ${publicUrl}`);
    console.log(`  Gestion             : ${publicUrl}/host (mot de passe obligatoire)`);
    console.log(`  Écoute              : ${HOST}:${PORT}`);
    if (!ADMIN_PASSWORD) {
      console.log('');
      console.log('  ⚠ ADMIN_PASSWORD n’est pas défini : personne ne peut ouvrir la page de gestion.');
      console.log('    Définissez ADMIN_PASSWORD puis redémarrez.');
    }
    if (HOST === '0.0.0.0' || HOST === '::') {
      console.log(`  ⓘ Le port ${PORT} est joignable depuis l’extérieur. Derrière un serveur web, mettez HOST=127.0.0.1.`);
    }
  } else {
    console.log(`  Gestion (sur ce PC) : http://localhost:${PORT}/host`);
    console.log(`  Adresse réseau local: ${LAN_URL}`);
    if (tunnel.mode === 'custom') console.log(`  Adresse publique    : ${publicUrl}`);
    else if (!INTERNET) console.log('  Mode Wi-Fi local. Pour jouer depuis n’importe où : Lancer-Quiz-Internet.bat');
  }
  console.log('');
  if (INTERNET && tunnel.mode === 'starting') startTunnel();
});
