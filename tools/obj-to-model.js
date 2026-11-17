#!/usr/bin/env node
/*
 * Convertit un modèle 3D .obj (souvent très lourd) en un petit fichier binaire
 * affichable sur téléphone par public/model3d.js.
 *
 *   node tools/obj-to-model.js chemin/vers/modele.obj public/models/trophy.bin [triangles max]
 *
 * - Simplification par regroupement de sommets sur une grille (la plus fine possible
 *   sous la limite de triangles, 60 000 par défaut, et 65 535 sommets).
 * - Les sommets ne sont regroupés que s'ils regardent dans la même direction
 *   (même octant de normale) : les deux faces d'une paroi fine ne se mélangent pas
 *   et les arêtes vives restent nettes.
 * - Le modèle est centré et mis à l'échelle dans un cube [-1, 1].
 *
 * Format de sortie (little-endian) :
 *   'QM3D' | uint32 nbSommets | uint32 nbIndices |
 *   positions int16 × 3 × nbSommets (÷ 32767) | normales int8 × 3 × nbSommets (÷ 127) |
 *   (alignement sur 2 octets) | indices uint16 × nbIndices
 */
'use strict';
const fs = require('fs');

const [, , input, output = 'public/models/model.bin', maxTrisArg] = process.argv;
if (!input) {
  console.error('Usage : node tools/obj-to-model.js modele.obj sortie.bin [triangles max]');
  process.exit(1);
}
const MAX_TRIS = Number(maxTrisArg) || 60000;
const MAX_VERTS = 65535;

// ---------- Lecture du .obj (positions, normales, faces → triangles)
console.log(`Lecture de ${input}…`);
const text = fs.readFileSync(input, 'utf8');
const P = []; // x, y, z à la suite
const N = [];
const corners = []; // par coin de triangle : [indice position, indice normale ou -1]
let lineStart = 0;
for (let i = 0; i <= text.length; i++) {
  if (i < text.length && text.charCodeAt(i) !== 10) continue;
  const line = text.slice(lineStart, i).trim();
  lineStart = i + 1;
  if (line.startsWith('v ')) {
    const [, x, y, z] = line.split(/\s+/);
    P.push(+x, +y, +z);
  } else if (line.startsWith('vn ')) {
    const [, x, y, z] = line.split(/\s+/);
    N.push(+x, +y, +z);
  } else if (line.startsWith('f ')) {
    const vs = line.split(/\s+/).slice(1).map((t) => {
      const [v, , n] = t.split('/');
      const vi = +v, ni = n ? +n : 0;
      return [vi < 0 ? P.length / 3 + vi : vi - 1, ni < 0 ? N.length / 3 + ni : ni ? ni - 1 : -1];
    });
    for (let k = 1; k + 1 < vs.length; k++) corners.push(vs[0], vs[k], vs[k + 1]); // éventail
  }
}
const nTris = corners.length / 3;
console.log(`  ${P.length / 3} sommets, ${N.length / 3} normales, ${nTris} triangles`);

// Normales de face (pour les coins sans normale, et pour l'octant)
function faceNormal(t) {
  const [a, b, c] = [corners[3 * t][0], corners[3 * t + 1][0], corners[3 * t + 2][0]];
  const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
  const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

// ---------- Boîte englobante → centrage et mise à l'échelle dans [-1, 1]
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], P[i + k]); max[k] = Math.max(max[k], P[i + k]); }
const center = min.map((m, k) => (m + max[k]) / 2);
const half = Math.max(...max.map((m, k) => m - min[k])) / 2;
console.log(`  dimensions : ${max.map((m, k) => (m - min[k]).toFixed(1)).join(' × ')}`);

// ---------- Regroupement sur une grille de G cellules par côté
function simplify(G) {
  const cell = (2 * half) / G;
  const key = new Map(); // clé de regroupement → numéro de sommet simplifié
  const pos = [], nor = [], count = [];
  const tri = [];
  const seen = new Set();
  for (let t = 0; t < nTris; t++) {
    const fn = faceNormal(t);
    const ids = [];
    for (let c = 0; c < 3; c++) {
      const [vi, ni] = corners[3 * t + c];
      const x = P[3 * vi], y = P[3 * vi + 1], z = P[3 * vi + 2];
      const n = ni >= 0 ? [N[3 * ni], N[3 * ni + 1], N[3 * ni + 2]] : fn;
      const oct = (n[0] >= 0 ? 1 : 0) | (n[1] >= 0 ? 2 : 0) | (n[2] >= 0 ? 4 : 0);
      const k = `${Math.floor((x - min[0]) / cell)},${Math.floor((y - min[1]) / cell)},${Math.floor((z - min[2]) / cell)},${oct}`;
      let id = key.get(k);
      if (id === undefined) {
        id = count.length;
        key.set(k, id);
        pos.push(0, 0, 0); nor.push(0, 0, 0); count.push(0);
      }
      pos[3 * id] += x; pos[3 * id + 1] += y; pos[3 * id + 2] += z;
      const l = Math.hypot(...n) || 1;
      nor[3 * id] += n[0] / l; nor[3 * id + 1] += n[1] / l; nor[3 * id + 2] += n[2] / l;
      count[id]++;
      ids.push(id);
    }
    const [a, b, c] = ids;
    if (a === b || b === c || a === c) continue; // triangle écrasé
    const s = [a, b, c].sort((x, y) => x - y).join(',');
    if (seen.has(s)) continue; // doublon
    seen.add(s);
    tri.push(a, b, c);
  }
  return { pos, nor, count, tri };
}

let G = 256, best = null;
for (; G >= 16; G = Math.floor(G * 0.85)) {
  const r = simplify(G);
  console.log(`  grille ${G} : ${r.count.length} sommets, ${r.tri.length / 3} triangles`);
  if (r.tri.length / 3 <= MAX_TRIS && r.count.length <= MAX_VERTS) { best = r; break; }
}
if (!best) { console.error('Impossible de simplifier suffisamment.'); process.exit(1); }

// ---------- Écriture du binaire
const nv = best.count.length, ni = best.tri.length;
const header = 12, posBytes = nv * 6, norBytes = nv * 3;
const pad = (header + posBytes + norBytes) % 2;
const buf = Buffer.alloc(header + posBytes + norBytes + pad + ni * 2);
buf.write('QM3D', 0, 'latin1');
buf.writeUInt32LE(nv, 4);
buf.writeUInt32LE(ni, 8);
let o = header;
for (let i = 0; i < nv; i++) {
  for (let k = 0; k < 3; k++) {
    const v = (best.pos[3 * i + k] / best.count[i] - center[k]) / half;
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), o); o += 2;
  }
}
for (let i = 0; i < nv; i++) {
  const n = [best.nor[3 * i], best.nor[3 * i + 1], best.nor[3 * i + 2]];
  const l = Math.hypot(...n) || 1;
  for (let k = 0; k < 3; k++) { buf.writeInt8(Math.round((n[k] / l) * 127), o); o += 1; }
}
o += pad;
for (let i = 0; i < ni; i++) { buf.writeUInt16LE(best.tri[i], o); o += 2; }
fs.mkdirSync(require('path').dirname(output), { recursive: true });
fs.writeFileSync(output, buf);
console.log(`→ ${output} : ${nv} sommets, ${ni / 3} triangles, ${(buf.length / 1024).toFixed(0)} Ko (grille ${G})`);
