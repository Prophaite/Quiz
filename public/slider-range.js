/*
 * Curseur des questions « Valeur à trouver » : bornes min / max et pas.
 * Utilisé par le serveur (require) et par la page de gestion (balise <script>),
 * pour que l'éditeur affiche exactement la plage que verront les joueurs.
 *
 * Plage automatique (si l'animateur n'a pas fixé min et max) :
 *  - largeur dans le bon ordre de grandeur : environ 2 × la valeur, arrondie à
 *    un nombre « rond » (1, 2, 2,5 ou 5 × 10^n) ; 200 ans pour une année ;
 *  - la bonne réponse n'est jamais au milieu : sa position (entre 15 et 85 %
 *    de la plage) dépend de la question, toujours la même pour une question donnée ;
 *  - pas de plage négative pour une valeur positive ;
 *  - le pas permet toujours de tomber exactement sur la bonne réponse.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QSlider = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Plus petit nombre « rond » (1, 2, 2,5, 5 × 10^n) supérieur ou égal à x
  function niceUp(x) {
    const p = Math.pow(10, Math.floor(Math.log10(x)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= x * (1 - 1e-9)) return m * p;
    return 10 * p;
  }
  // Nombre de décimales d'une valeur (0,25 → 2)
  function decimals(v) {
    const s = String(Math.abs(v));
    if (s.includes('e-')) return Number(s.split('e-')[1]);
    return (s.split('.')[1] || '').length;
  }
  // Plus grande puissance de 10 dont la valeur est un multiple (330 → 10, 1969 → 1, 0,25 → 0,01)
  function precision(v) {
    const d = decimals(v);
    if (d) return Math.pow(10, -d);
    let p = 1;
    const a = Math.abs(Math.round(v));
    while (a && a % (p * 10) === 0 && p < 1e12) p *= 10;
    return p;
  }
  // Nombre pseudo-aléatoire stable dans [0, 1) tiré d'un texte (l'identifiant de la question)
  function hash01(seed) {
    let h = 2166136261;
    for (const c of String(seed)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 10007) / 10007;
  }
  const clean = (x, step) => Number((Math.round(x / step) * step).toFixed(Math.max(0, decimals(step))));

  // Pas : environ 100 à 1 000 crans sur la plage ; entier si la réponse est entière ; affiné si
  // besoin pour qu'on puisse tomber exactement sur la réponse (sauf plage immense : > 5 000 crans).
  function stepFor(width, v) {
    let step = Math.pow(10, Math.floor(Math.log10(width)) - 2);
    const p = precision(v);
    step = Number.isInteger(v) ? Math.max(step, 1) : Math.max(step, p / 10);
    if (p < step && width / p <= 5000) step = p;
    return Math.max(1e-6, step);
  }
  const reachable = (r, v) => { const k = (v - r.min) / r.step; return v >= r.min && v <= r.max && Math.abs(k - Math.round(k)) < 1e-6; };

  /** Plage automatique pour la valeur v (tolérance facultative, seed = identifiant de la question). */
  function auto(value, tolerance = 0, seed = '') {
    const v = Number(value) || 0;
    const a = Math.abs(v);
    const yearLike = Number.isInteger(v) && v >= 1000 && v <= 2200;
    // Au moins 10 de large pour un nombre entier (sinon 1 donnerait 0–2 : trop facile)
    const width = yearLike ? 200 : niceUp(Math.max(a * 2, Math.abs(tolerance) * 8, Number.isInteger(v) ? 10 : 0, 1e-6));
    const f = 0.15 + 0.7 * hash01(seed); // position de la réponse dans la plage
    let min, max;
    if (!yearLike && v > 0 && v - f * width < 0) {
      // Une valeur positive ne descend pas sous 0 : la plage part de 0 et s'allonge
      // pour que la réponse reste à sa position f (sinon elle serait toujours au même endroit)
      const span = v / f;
      const g = niceUp(span) / 10;
      min = 0;
      max = Math.max(Math.ceil(span / g) * g, Number.isInteger(v) ? 10 : 0);
    } else {
      const grid = width / 10;
      min = Math.floor((v - f * width) / grid) * grid;
      max = min + width;
    }
    const step = stepFor(max - min, v);
    min = Math.floor(min / step + 1e-9) * step; // bornes sur la grille du pas
    max = Math.ceil(max / step - 1e-9) * step;
    return { min: clean(min, step), max: clean(max, step), step, auto: true };
  }

  /** Plage d'une question : min / max fixés par l'animateur s'ils sont valides, sinon automatique. */
  function forQuestion(q) {
    const lo = q.sliderMin, hi = q.sliderMax;
    const v = Number(q.value) || 0;
    let r;
    if (lo !== null && lo !== undefined && lo !== '' && hi !== null && hi !== undefined && hi !== '' && Number(hi) > Number(lo)) {
      const min = Number(lo), max = Number(hi);
      r = { min, max, step: Math.min(stepFor(max - min, v), precision(min)), auto: false };
    } else r = auto(v, q.tolerance, q.id);
    // contains : la réponse est dans la plage ; exact : on peut l'atteindre exactement avec le pas
    return { ...r, contains: v >= r.min && v <= r.max, exact: reachable(r, v) };
  }

  return { auto, forQuestion };
});
