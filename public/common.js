/* Utilitaires partagés entre les pages */
window.Q = (() => {
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const COLORS = ['#e5484d', '#3e63dd', '#f5a524', '#30a46c', '#8e4ec6', '#f76b15'];
  const SHAPES = ['▲', '◆', '●', '■', '★', '⬢'];
  const TYPE_LABELS = { choice: 'Choix multiple', text: 'Mot / nom', number: 'Valeur à trouver', map: 'Carte (repère)' };

  const fmt = (n) =>
    typeof n === 'number' && Number.isFinite(n)
      ? n.toLocaleString('fr-FR', { maximumFractionDigits: 4, useGrouping: Math.abs(n) >= 10000 })
      : esc(n);

  const params = new URLSearchParams(location.search);

  /* Compte à rebours basé sur le temps restant envoyé par le serveur */
  function countdown() {
    let end = 0;
    let total = 0;
    let listeners = [];
    setInterval(() => {
      const left = end ? Math.max(0, end - performance.now()) : 0;
      listeners.forEach((fn) => fn(left, total));
    }, 100);
    return {
      set(remainingMs, totalSec) {
        end = remainingMs > 0 ? performance.now() + remainingMs : 0;
        total = (totalSec || 0) * 1000;
      },
      on(fn) {
        listeners.push(fn);
      },
    };
  }

  const ordinal = (n) => (n === 1 ? '1er' : `${n}e`);

  /*
   * Requête JSON ; lève une erreur avec le message du serveur.
   * Si la gestion est ouverte depuis un autre appareil que le PC du quiz,
   * le serveur réclame le mot de passe ADMIN_PASSWORD : on le demande une fois.
   */
  const PW_KEY = 'quiz-admin-pw';
  const store = {
    get: () => { try { return sessionStorage.getItem(PW_KEY) || ''; } catch { return ''; } },
    set: (v) => { try { sessionStorage.setItem(PW_KEY, v); } catch {} },
  };
  async function request(method, path, body, retried) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const pw = store.get();
    if (pw) headers['x-admin-password'] = pw;
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    let data = {};
    try { data = await res.json(); } catch {}
    if (res.status === 401 && data.needPassword && !retried) {
      const given = prompt(pw ? 'Mot de passe incorrect. Mot de passe de gestion :' : 'Mot de passe de gestion :');
      if (given) {
        store.set(given);
        return request(method, path, body, true);
      }
    }
    if (!res.ok) throw Object.assign(new Error(data.error || 'Erreur réseau'), { status: res.status });
    return data;
  }
  const api = (path, body) => request('POST', path, body || {});
  const get = (path) => request('GET', path);

  /*
   * Flux temps réel avec reconnexion automatique.
   * La page démarre tout de suite en « long polling » (/api/poll), qui passe
   * partout et affiche l'état sans attendre. En parallèle, elle essaie le flux
   * Server-Sent Events : s'il livre un état, on passe dessus et on arrête le
   * polling ; s'il reste muet (tunnel ou proxy qui retient le flux), on le ferme
   * et on reste en polling. Le résultat est mémorisé pour cette adresse.
   * onGone est appelé si le serveur refuse le flux (salon/joueur inexistant).
   */
  const POLL_KEY = 'quiz-use-poll';
  const SSE_PROBE = 5000;
  const mem = {
    get: () => { try { return localStorage.getItem(POLL_KEY) === '1'; } catch { return false; } },
    set: () => { try { localStorage.setItem(POLL_KEY, '1'); } catch {} },
  };
  function stream(url, { onState, onGone, onKicked, onStatus } = {}) {
    let es = null;
    let stopped = false;
    let sseLive = false; // le flux SSE a livré au moins un état
    let probe = null;
    let pollCtrl = null;
    const pollOnly = mem.get() || params.get('poll') === '1';

    function gone() {
      fetch('/api/info', { cache: 'no-store' })
        .then((r) => { if (r.ok && !stopped) { stop(); onGone && onGone(); } })
        .catch(() => {});
    }

    function openSse() {
      if (stopped || pollOnly) return;
      es = new EventSource(url);
      probe = setTimeout(() => {
        if (sseLive || stopped) return;
        es.close(); // rien reçu : le flux est retenu quelque part, on reste en polling
        es = null;
        mem.set();
      }, SSE_PROBE);
      es.addEventListener('state', (e) => {
        if (!sseLive) {
          sseLive = true;
          clearTimeout(probe);
          pollCtrl && pollCtrl.abort(); // le flux direct prend le relais
        }
        onState && onState(JSON.parse(e.data));
      });
      es.addEventListener('kicked', () => { stop(); onKicked && onKicked(); });
      es.onopen = () => sseLive && onStatus && onStatus(true);
      es.onerror = () => {
        if (stopped || !sseLive) return; // pendant l'essai, le polling assure l'affichage
        onStatus && onStatus(false);
        if (es.readyState !== EventSource.CLOSED) return; // le navigateur réessaie seul
        es.close();
        // Flux coupé définitivement : salon terminé ? sinon on repart en polling
        sseLive = false;
        gone();
        if (!stopped) poll();
      };
    }

    async function poll() {
      const base = url.replace('/api/events', '/api/poll');
      let v = -1;
      while (!stopped && !sseLive) {
        try {
          pollCtrl = new AbortController();
          const res = await fetch(`${base}&v=${v}&t=${Date.now()}`, { cache: 'no-store', signal: pollCtrl.signal });
          const data = await res.json().catch(() => ({}));
          if (stopped || sseLive) return;
          if (res.status === 404) {
            stop();
            if (data.kicked) onKicked && onKicked(); else onGone && onGone();
            return;
          }
          if (!res.ok) throw new Error(res.status);
          onStatus && onStatus(true);
          if (data.v !== v) { v = data.v; onState && onState(data.state); }
        } catch {
          if (stopped || sseLive) return;
          onStatus && onStatus(false);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }

    function stop() {
      stopped = true;
      clearTimeout(probe);
      es && es.close();
      pollCtrl && pollCtrl.abort();
    }
    poll();
    openSse();
    return { stop };
  }

  /*
   * Cartes (questions « Carte ») : Leaflet est chargé seulement quand une carte
   * s'affiche. Fond de carte Esri « gris clair », sans clé d'accès ; les noms de
   * lieux sont une couche à part, ajoutée seulement avec « labels: true »
   * (les joueurs voient une carte sans aucun nom : elle ne donne pas la réponse).
   */
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
  let leafletPromise = null;
  function leaflet() {
    if (window.L) return Promise.resolve(window.L);
    leafletPromise ??= new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      css.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
      css.crossOrigin = '';
      document.head.appendChild(css);
      const js = document.createElement('script');
      js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      js.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
      js.crossOrigin = '';
      js.onload = () => resolve(window.L);
      js.onerror = () => { leafletPromise = null; reject(new Error('Carte indisponible : impossible de charger la carte (connexion Internet nécessaire).')); };
      document.head.appendChild(js);
    });
    return leafletPromise;
  }
  function makeMap(el, { view, labels = false } = {}) {
    const v = view || { lat: 46.6, lng: 2.4, zoom: 5 };
    const map = window.L.map(el, { worldCopyJump: true }).setView([v.lat, v.lng], v.zoom);
    const opts = { maxZoom: 16, attribution: 'Fond de carte &copy; Esri' };
    window.L.tileLayer(`${ESRI}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`, opts).addTo(map);
    if (labels) window.L.tileLayer(`${ESRI}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, opts).addTo(map);
    return map;
  }
  // Repère en forme d'épingle, de la couleur voulue
  function pinIcon(color = '#e5484d', size = 1) {
    const w = 26 * size, h = 34 * size;
    return window.L.divIcon({
      className: 'qpin',
      html: `<svg width="${w}" height="${h}" viewBox="0 0 26 34"><path d="M13 0C6 0 0 5.6 0 12.6 0 22 13 34 13 34s13-12 13-21.4C26 5.6 20 0 13 0z" fill="${color}" stroke="#fff" stroke-width="2"/><circle cx="13" cy="12.5" r="4.5" fill="#fff"/></svg>`,
      iconSize: [w, h], iconAnchor: [w / 2, h], tooltipAnchor: [0, -h + 6],
    });
  }
  const fmtKm = (d) => (d < 1 ? 'moins d’1 km' : `${Math.round(d).toLocaleString('fr-FR')} km`);

  /*
   * Image de l'étape Images (tournoi), de plus en plus nette : level / levels.
   * blur  : flou de maxBlur px au départ, net à la fin ;
   * small : minuscule au départ, pleine taille à la fin.
   * Le cadre (.simg) doit avoir une taille fixée par la page.
   */
  // Taille (en %) de l'effet « toute petite » : elle est multipliée par le même facteur à chaque
  // bonne réponse (5 % → 100 %). Elle reste donc petite au début, quand une image deviendrait
  // vite reconnaissable, et grandit surtout à la fin.
  const SMALL_MIN = 5;
  const smallSize = (f) => Math.round(SMALL_MIN * (100 / SMALL_MIN) ** f * 10) / 10;
  function stageImage(im, maxBlur = 40) {
    const f = im.levels ? Math.max(0, Math.min(1, im.level / im.levels)) : 1;
    const size = smallSize(f);
    const style = im.effect === 'small'
      ? `width:${size}%;height:${size}%`
      : `filter:blur(${Math.round((1 - f) * maxBlur)}px)`;
    return `<div class="simg"><img src="${esc(im.src)}" style="${style}" alt="" draggable="false"></div>`;
  }

  /*
   * Images du podium à la fin d'un tournoi, sur le téléphone de l'équipe (pas sur la projection).
   * Une ligne par place : déposez l'image dans public/images/podium/ et ajoutez-la ici.
   */
  const PODIUM_IMAGES = {
    2: '/images/podium/2.png',
    3: '/images/podium/3.webp',
  };
  const podiumImage = (rank, cls = '') =>
    PODIUM_IMAGES[rank] ? `<img class="${cls}" src="${esc(PODIUM_IMAGES[rank])}" alt="" draggable="false">` : '';

  return { esc, COLORS, SHAPES, TYPE_LABELS, fmt, params, countdown, ordinal, api, get, stream, leaflet, makeMap, pinIcon, fmtKm, stageImage, smallSize, podiumImage };

})();
