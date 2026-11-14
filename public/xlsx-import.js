/* Import et export de quiz au format Excel (.xlsx), sans dépendance.
   Un .xlsx est un zip de fichiers XML : lecture avec DecompressionStream, écriture en zip non compressé. */
(() => {
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  async function unzip(buf) {
    const b = new Uint8Array(buf);
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
      if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Ce fichier n’est pas un classeur Excel (.xlsx).');
    const count = u16(b, eocd + 10);
    let p = u32(b, eocd + 16);
    const files = {};
    const dec = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (u32(b, p) !== 0x02014b50) break;
      const method = u16(b, p + 10), size = u32(b, p + 20);
      const nameLen = u16(b, p + 28), extraLen = u16(b, p + 30), commentLen = u16(b, p + 32);
      const local = u32(b, p + 42);
      const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      const start = local + 30 + u16(b, local + 26) + u16(b, local + 28);
      const data = b.subarray(start, start + size);
      files[name] = { method, data };
    }
    return async (name) => {
      const f = files[name];
      if (!f) return null;
      if (f.method === 0) return dec.decode(f.data);
      if (f.method !== 8) throw new Error('Compression non prise en charge');
      const stream = new Blob([f.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return await new Response(stream).text();
    };
  }

  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const all = (node, tag) => Array.from(node.getElementsByTagNameNS('*', tag));
  const textOf = (node) => all(node, 't')
    .filter((t) => t.parentNode?.localName !== 'rPh') // ignore les annotations phonétiques
    .map((t) => t.textContent).join('');
  const colIndex = (ref) => {
    let n = 0;
    for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };

  /** Renvoie les lignes de la feuille « Questions » (ou de la première feuille) : tableau de tableaux de chaînes. */
  async function readSheet(buf) {
    const read = await unzip(buf);
    const wb = xml(await read('xl/workbook.xml') || '');
    const sheets = all(wb, 'sheet');
    if (!sheets.length) throw new Error('Classeur vide ou illisible.');
    const sheet = sheets.find((s) => /^questions?$/i.test(s.getAttribute('name').trim())) || sheets[0];
    const rid = sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
      || sheet.getAttribute('r:id');
    let path = 'xl/worksheets/sheet1.xml';
    const rels = await read('xl/_rels/workbook.xml.rels');
    if (rels) {
      const rel = all(xml(rels), 'Relationship').find((r) => r.getAttribute('Id') === rid);
      if (rel) {
        const t = rel.getAttribute('Target');
        path = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
      }
    }
    const ssXml = await read('xl/sharedStrings.xml');
    const shared = ssXml ? all(xml(ssXml), 'si').map(textOf) : [];
    const ws = xml(await read(path) || '');
    const rows = [];
    for (const row of all(ws, 'row')) {
      const r = Number(row.getAttribute('r')) - 1;
      const cells = [];
      all(row, 'c').forEach((c, i) => {
        const ref = c.getAttribute('r');
        const col = ref ? colIndex(ref) : i;
        const t = c.getAttribute('t');
        const v = all(c, 'v')[0]?.textContent ?? '';
        let val;
        if (t === 's') val = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') val = textOf(c);
        else if (t === 'b') val = v === '1' ? 'Oui' : 'Non';
        else val = v;
        cells[col] = String(val).trim();
      });
      rows[Number.isFinite(r) && r >= 0 ? r : rows.length] = cells;
    }
    return Array.from(rows, (r) => Array.from(r || [], (v) => v ?? ''));
  }

  const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const toNum = (s) => {
    const t = String(s ?? '').replace(/[\s  ]/g, '').replace(',', '.');
    if (t === '') return NaN;
    return Number(t);
  };

  const COLS = {
    type: (h) => h === 'type',
    text: (h) => h === 'question' || h === 'intitule',
    points: (h) => h.startsWith('point'),
    time: (h) => h.startsWith('temps') || h.startsWith('duree'),
    answer: (h) => h.startsWith('bonne') || h.startsWith('reponse'),
    tolerance: (h) => h.startsWith('tolerance'),
    unit: (h) => h.startsWith('unite'),
    mode: (h) => h === 'mode',
    fuzzy: (h) => h.startsWith('faute'),
    image: (h) => h.startsWith('image'),
    multi: (h) => h.startsWith('plusieurs'),
    trap: (h) => h.startsWith('piege'),
  };

  /** Convertit le classeur en quiz { title, questions } + avertissements. */
  async function parseQuizXlsx(buf, fileName = '') {
    const rows = await readSheet(buf);
    const hr = rows.findIndex((r) => r && r.some((v) => norm(v) === 'question') && r.some((v) => norm(v) === 'type'));
    if (hr < 0) throw new Error('Colonnes « Type » et « Question » introuvables. Utilisez le modèle Excel.');
    const head = rows[hr].map(norm);
    const col = {};
    for (const [key, test] of Object.entries(COLS)) col[key] = head.findIndex((h) => test(h));
    const choiceCols = [];
    head.forEach((h, i) => {
      const m = h.match(/^choix ([a-f])$/);
      if (m) choiceCols[m[1].charCodeAt(0) - 97] = i;
    });

    let title = '';
    for (const r of rows.slice(0, hr)) {
      const i = (r || []).findIndex((v) => norm(v).startsWith('titre'));
      if (i >= 0) { title = r.slice(i + 1).find((v) => v) || ''; break; }
    }
    if (!title) title = fileName.replace(/\.xlsx$/i, '') || 'Quiz importé';

    const get = (r, key) => (col[key] >= 0 ? r[col[key]] ?? '' : '');
    const questions = [];
    const warnings = [];
    const toLocate = []; // questions « Carte » à placer d'après le nom du lieu
    rows.slice(hr + 1).forEach((r, i) => {
      if (!r) return;
      const line = hr + i + 2;
      const text = get(r, 'text');
      if (!text) return;
      const choices = choiceCols.map((c) => (c >= 0 ? r[c] ?? '' : ''));
      const answer = get(r, 'answer');
      const t = norm(get(r, 'type'));
      let type;
      if (t.startsWith('choix') || t.startsWith('qcm') || t.startsWith('vrai')) type = 'choice';
      else if (t.startsWith('mot') || t.startsWith('nom') || t.startsWith('texte')) type = 'text';
      else if (t.startsWith('valeur') || t.startsWith('nombre')) type = 'number';
      else if (t.startsWith('carte') || t.startsWith('map') || t.startsWith('lieu')) type = 'map';
      else if (choices.some(Boolean)) type = 'choice';
      else if (Number.isFinite(toNum(answer))) type = 'number';
      else type = 'text';

      const q = { type, text, image: get(r, 'image') };
      const pts = toNum(get(r, 'points'));
      const time = toNum(get(r, 'time'));
      if (Number.isFinite(pts)) q.points = pts;
      if (Number.isFinite(time)) q.time = time;
      // Question piège : aucune bonne réponse, seuls ceux qui ne répondent pas marquent
      q.trap = /^(oui|yes|1|vrai|x)/.test(norm(get(r, 'trap')));

      if (type === 'choice') {
        const list = choices.map((c, k) => ({ text: c, k })).filter((c) => c.text);
        if (list.length < 2) warnings.push(`Ligne ${line} : moins de 2 choix remplis.`);
        const tokens = answer.split(/[,;\/|+]|\s+et\s+/i).map((s) => s.trim()).filter(Boolean);
        const letters = tokens.length && tokens.every((s) => /^[a-f]$/i.test(s));
        const good = new Set();
        if (letters) tokens.forEach((s) => good.add(s.toUpperCase().charCodeAt(0) - 65));
        else {
          const wanted = new Set([norm(answer), ...tokens.map(norm)]);
          list.forEach((c) => { if (wanted.has(norm(c.text))) good.add(c.k); });
        }
        q.choices = list.map((c) => ({ text: c.text, correct: good.has(c.k) }));
        const multi = norm(get(r, 'multi'));
        q.multi = /^(oui|yes|toutes?|1|vrai)/.test(multi) || multi.includes('partiel');
        q.partial = q.multi && multi.includes('partiel');
        if (!q.trap && !q.choices.some((c) => c.correct)) warnings.push(`Ligne ${line} : aucune bonne réponse reconnue (« ${answer || 'vide'} »).`);
      } else if (type === 'map') {
        // « Lyon (45.764, 4.836) » ou « 45,764 ; 4,836 » : nom affiché facultatif + latitude, longitude
        const m = /^(.*?)[\s(]*(-?\d+(?:[.,]\d+)?)\s*[;,]\s*(-?\d+(?:[.,]\d+)?)\s*\)?\s*$/.exec(answer);
        const lat = m ? toNum(m[2]) : NaN, lng = m ? toNum(m[3]) : NaN;
        const hasPos = Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
        q.lat = hasPos ? lat : 46.6;
        q.lng = hasPos ? lng : 2.4;
        q.label = m ? m[1].trim() : answer.trim();
        // Seulement un nom de lieu (« Lyon ») : il sera placé automatiquement après la lecture
        if (!hasPos) {
          if (q.label) toLocate.push({ q, line });
          else warnings.push(`Ligne ${line} : indiquez le lieu à trouver (ex. « Lyon » ou « Lyon (45.764, 4.836) »).`);
        }
        const tol = toNum(get(r, 'tolerance'));
        q.tolerance = Number.isFinite(tol) ? Math.abs(tol) : 25;
        q.mode = norm(get(r, 'mode')).includes('proche') ? 'closest' : 'gradual';
      } else if (type === 'text') {
        q.answers = answer.split('|').map((s) => s.trim()).filter(Boolean);
        q.fuzzy = !/^(non|no|0|faux|false)$/.test(norm(get(r, 'fuzzy')));
        if (!q.trap && !q.answers.length) warnings.push(`Ligne ${line} : aucune réponse acceptée.`);
      } else {
        const v = toNum(answer);
        if (!Number.isFinite(v)) warnings.push(`Ligne ${line} : la bonne réponse « ${answer || 'vide'} » n’est pas un nombre.`);
        q.value = Number.isFinite(v) ? v : 0;
        const tol = toNum(get(r, 'tolerance'));
        q.tolerance = Number.isFinite(tol) ? Math.abs(tol) : 0;
        q.unit = get(r, 'unit');
        q.mode = norm(get(r, 'mode')).includes('proche') ? 'closest' : 'tolerance';
      }
      questions.push(q);
    });
    if (!questions.length) throw new Error('Aucune question trouvée dans le fichier.');
    // Questions « Carte » données par un simple nom : on cherche le lieu sur OpenStreetMap
    for (const [i, { q, line }] of toLocate.entries()) {
      if (i) await new Promise((r) => setTimeout(r, 1100)); // règle d'usage de Nominatim : 1 requête par seconde
      const found = await geocode(q.label);
      if (found) {
        Object.assign(q, { lat: found.lat, lng: found.lng });
        warnings.push(`Ligne ${line} : « ${q.label} » placé automatiquement (${found.name}). Vérifiez le point dans l’éditeur.`);
      } else {
        warnings.push(`Ligne ${line} : lieu « ${q.label} » introuvable. Placez le point à la main dans l’éditeur, ou écrivez « ${q.label} (latitude, longitude) ».`);
      }
    }
    return { title, questions, warnings };
  }

  /** Cherche un lieu par son nom (OpenStreetMap / Nominatim). Renvoie { lat, lng, name } ou null. */
  async function geocode(name) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=fr&q=${encodeURIComponent(name)}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const [hit] = await res.json();
      if (!hit) return null;
      return { lat: +Number(hit.lat).toFixed(5), lng: +Number(hit.lon).toFixed(5), name: String(hit.display_name || name).split(',').slice(0, 3).join(',').trim() };
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Export : quiz → classeur .xlsx au même format que le modèle          */
  /* ------------------------------------------------------------------ */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (b) => {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  /** Zip sans compression (méthode « stored »), lu sans problème par Excel. */
  function zip(entries) {
    const enc = new TextEncoder();
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const parts = [], central = [];
    let offset = 0;
    for (const [name, text] of entries) {
      const nameB = enc.encode(name), data = enc.encode(text), crc = crc32(data);
      const head = (sig, extra) => {
        const h = new DataView(new ArrayBuffer(extra));
        h.setUint32(0, sig, true);
        return h;
      };
      const l = head(0x04034b50, 30);
      l.setUint16(4, 20, true); l.setUint16(6, 0x0800, true); l.setUint16(8, 0, true);
      l.setUint16(10, time, true); l.setUint16(12, date, true); l.setUint32(14, crc, true);
      l.setUint32(18, data.length, true); l.setUint32(22, data.length, true); l.setUint16(26, nameB.length, true);
      const c = head(0x02014b50, 46);
      c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nameB.length, true);
      c.setUint32(42, offset, true);
      parts.push(l, nameB, data);
      central.push(c, nameB);
      offset += 30 + nameB.length + data.length;
    }
    const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true);
    e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
    return new Blob([...parts, ...central, e], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  const X = (s) => String(s ?? '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const colName = (i) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = (i - 1 - m) / 26; } return s; };

  const HEADERS = [
    ['Type', 18], ['Question', 50], ['Points', 9], ['Temps (s)', 10], ['Bonne réponse', 28],
    ['Choix A', 18], ['Choix B', 18], ['Choix C', 18], ['Choix D', 18], ['Choix E', 18], ['Choix F', 18],
    ['Tolérance ±', 12], ['Unité', 10], ['Mode', 16], ['Fautes tolérées', 15], ['Image (URL)', 30],
    ['Plusieurs réponses', 24], ['Piège', 10],
  ];
  const MULTI_NAMES = ['Non', 'Oui - tout ou rien', 'Oui - points partiels'];
  const TYPE_NAMES = { choice: 'Choix multiple', text: 'Mot / nom', number: 'Valeur à trouver', map: 'Carte' };

  function questionRow(q) {
    const row = new Array(HEADERS.length).fill(null);
    row[0] = TYPE_NAMES[q.type] || TYPE_NAMES.choice;
    row[1] = q.text || '';
    row[2] = Number(q.points ?? 100);
    row[3] = Number(q.time ?? 30);
    if (q.type === 'text') {
      row[4] = (q.answers || []).join(' | ');
      row[14] = q.fuzzy === false ? 'Non' : 'Oui';
    } else if (q.type === 'map') {
      row[4] = `${q.label ? q.label + ' ' : ''}(${Number(q.lat).toFixed(5)}, ${Number(q.lng).toFixed(5)})`;
      row[11] = Number(q.tolerance ?? 25);
      row[13] = q.mode === 'closest' ? 'Le plus proche' : 'Dégressif';
    } else if (q.type === 'number') {
      row[4] = Number(q.value ?? 0);
      row[11] = Number(q.tolerance ?? 0);
      row[12] = q.unit || null;
      row[13] = q.mode === 'closest' ? 'Le plus proche' : 'Tolérance';
    } else {
      const ch = (q.choices || []).slice(0, 6);
      row[4] = ch.map((c, i) => (c.correct ? String.fromCharCode(65 + i) : '')).filter(Boolean).join(',');
      ch.forEach((c, i) => { row[5 + i] = c.text || null; });
      row[16] = MULTI_NAMES[q.multi ? (q.partial ? 2 : 1) : 0];
    }
    row[15] = q.image || null;
    row[17] = q.trap ? 'Oui' : 'Non';
    return row;
  }

  /** Construit le fichier Excel d'un quiz (Blob). Il se réimporte tel quel. */
  function buildQuizXlsx(quiz) {
    const HR = 4; // ligne des en-têtes
    const qs = quiz.questions || [];
    const last = HR + Math.max(200, qs.length + 50);
    const cell = (r, c, v, s) => {
      const ref = colName(c) + r;
      if (v === null || v === undefined || v === '') return `<c r="${ref}" s="${s}"/>`;
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
      return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${X(v)}</t></is></c>`;
    };
    const rows = [];
    rows.push(`<row r="1">${cell(1, 0, 'Titre du quiz', 5)}${cell(1, 1, quiz.title || 'Quiz', 4)}${[2, 3, 4].map((c) => cell(1, c, null, 4)).join('')}</row>`);
    rows.push(`<row r="2" ht="28" customHeight="1">${cell(2, 0, 'Remplissez une ligne par question (cases jaunes). Type, Mode, Fautes tolérées, Plusieurs réponses et Piège ont une liste déroulante. Carte : bonne réponse « Lyon (45.764, 4.836) », tolérance en km. Importez ensuite le fichier avec le bouton « Importer » de la page de gestion.', 6)}</row>`);
    rows.push(`<row r="${HR}" ht="30" customHeight="1">${HEADERS.map(([h], c) => cell(HR, c, h, 1)).join('')}</row>`);
    for (let r = HR + 1; r <= last; r++) {
      const data = qs[r - HR - 1] ? questionRow(qs[r - HR - 1]) : new Array(HEADERS.length).fill(null);
      rows.push(`<row r="${r}">${data.map((v, c) => cell(r, c, v, c === 1 || c === 4 ? 3 : 2)).join('')}</row>`);
    }
    const r0 = HR + 1;
    const list = (sqref, items) =>
      `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${sqref}"><formula1>"${X(items)}"</formula1></dataValidation>`;
    const whole = (sqref, max, msg) =>
      `<dataValidation type="whole" operator="between" allowBlank="1" showErrorMessage="1" error="${X(msg)}" sqref="${sqref}"><formula1>0</formula1><formula2>${max}</formula2></dataValidation>`;
    // Grise la plage quand le type de la ligne n'est pas l'un de ceux qui l'utilisent
    const grey = (sqref, types, prio) =>
      `<conditionalFormatting sqref="${sqref}"><cfRule type="expression" dxfId="0" priority="${prio}"><formula>${X(`AND($A${r0}<>"",${[].concat(types).map((t) => `$A${r0}<>"${t}"`).join(',')})`)}</formula></cfRule></conditionalFormatting>`;

    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane xSplit="2" ySplit="${HR}" topLeftCell="C${r0}" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>
<cols>${HEADERS.map(([, w], i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${rows.join('')}</sheetData>
<mergeCells count="2"><mergeCell ref="B1:E1"/><mergeCell ref="A2:R2"/></mergeCells>
${grey(`F${r0}:K${last}`, 'Choix multiple', 1)}${grey(`Q${r0}:Q${last}`, 'Choix multiple', 4)}${grey(`L${r0}:L${last}`, ['Valeur à trouver', 'Carte'], 2)}${grey(`M${r0}:M${last}`, 'Valeur à trouver', 5)}${grey(`N${r0}:N${last}`, ['Valeur à trouver', 'Carte'], 6)}${grey(`O${r0}:O${last}`, 'Mot / nom', 3)}
<dataValidations count="7">${list(`A${r0}:A${last}`, 'Choix multiple,Mot / nom,Valeur à trouver,Carte')}${list(`R${r0}:R${last}`, 'Oui,Non')}${list(`Q${r0}:Q${last}`, MULTI_NAMES.join(','))}${list(`N${r0}:N${last}`, 'Le plus proche,Tolérance,Dégressif')}${list(`O${r0}:O${last}`, 'Oui,Non')}${whole(`C${r0}:C${last}`, 100000, 'Nombre entier entre 0 et 100000')}${whole(`D${r0}:D${last}`, 600, 'Nombre entier de secondes entre 0 et 600 (0 = illimité)')}</dataValidations>
</worksheet>`;

    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="5"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font><font><b/><sz val="14"/><color rgb="FF4F46E5"/><name val="Arial"/></font><font><b/><sz val="12"/><name val="Arial"/></font><font><i/><sz val="9"/><color rgb="FF666666"/><name val="Arial"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4F46E5"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF9DB"/></patternFill></fill></fills>
<borders count="2"><border/><border><left style="thin"><color rgb="FFD0D0D0"/></left><right style="thin"><color rgb="FFD0D0D0"/></right><top style="thin"><color rgb="FFD0D0D0"/></top><bottom style="thin"><color rgb="FFD0D0D0"/></bottom></border></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="7">
<xf fontId="0" fillId="0" borderId="0"/>
<xf fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf fontId="0" fillId="3" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf fontId="0" fillId="3" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf fontId="2" fillId="3" borderId="0" applyFont="1" applyFill="1"/>
<xf fontId="3" fillId="0" borderId="0" applyFont="1"/>
<xf fontId="4" fillId="0" borderId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="1"><dxf><fill><patternFill patternType="solid"><bgColor rgb="FFEEEEEE"/></patternFill></fill></dxf></dxfs>
</styleSheet>`;

    return zip([
      ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
      ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
      ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Questions" sheetId="1" r:id="rId1"/></sheets></workbook>`],
      ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
      ['xl/styles.xml', styles],
      ['xl/worksheets/sheet1.xml', sheet],
    ]);
  }

  window.QuizXlsx = { parseQuizXlsx, readSheet, buildQuizXlsx };
})();
