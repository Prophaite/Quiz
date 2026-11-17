/*
 * Petit afficheur 3D (WebGL, sans bibliothèque) pour les modèles préparés par
 * tools/obj-to-model.js : le modèle tourne sur lui-même, en métal doré, et le
 * joueur peut le faire tourner du doigt.
 *
 *   const stop = Model3D.show(canvas, '/models/trophy.bin');
 *
 * L'animation s'arrête d'elle-même quand le canvas quitte la page.
 * Sans WebGL (ou si le fichier ne se charge pas), un 🏆 remplace le canvas.
 */
window.Model3D = (() => {
  const cache = new Map(); // url → Promise<{ pos, nor, idx }>

  function load(url) {
    if (!cache.has(url)) {
      cache.set(url, fetch(url).then((r) => {
        if (!r.ok) throw new Error(`Modèle introuvable (${r.status})`);
        return r.arrayBuffer();
      }).then((buf) => {
        const dv = new DataView(buf);
        if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'QM3D') throw new Error('Format de modèle inconnu');
        const nv = dv.getUint32(4, true), ni = dv.getUint32(8, true);
        let o = 12;
        const pos = new Int16Array(buf, o, nv * 3); o += nv * 6;
        const nor = new Int8Array(buf, o, nv * 3); o += nv * 3;
        o += o % 2;
        const idx = new Uint16Array(buf, o, ni);
        return { pos, nor, idx };
      }).catch((e) => { cache.delete(url); throw e; }));
    }
    return cache.get(url);
  }

  const VS = `
    attribute vec3 aPos; attribute vec3 aNor;
    uniform mat4 uModel, uProj; uniform float uDist;
    varying vec3 vNor; varying vec3 vView;
    void main() {
      vec4 p = uModel * vec4(aPos, 1.0);
      vNor = mat3(uModel) * aNor;
      vec3 eye = vec3(0.0, 0.0, uDist);
      vView = normalize(eye - p.xyz);
      gl_Position = uProj * vec4(p.xyz - eye, 1.0);
    }`;
  // Or poli : diffus doux + deux reflets + reflet d'un « ciel » et liseré sur les bords
  const FS = `
    precision mediump float;
    varying vec3 vNor; varying vec3 vView;
    void main() {
      vec3 n = normalize(vNor);
      vec3 v = normalize(vView);
      if (dot(n, v) < 0.0) n = -n; // faces vues de dos (parois fines)
      vec3 gold = vec3(1.0, 0.76, 0.28);
      vec3 l1 = normalize(vec3(0.6, 0.9, 0.8)), l2 = normalize(vec3(-0.8, 0.2, 0.4));
      float d = max(dot(n, l1), 0.0) * 0.55 + max(dot(n, l2), 0.0) * 0.25 + 0.22;
      float s1 = pow(max(dot(n, normalize(l1 + v)), 0.0), 60.0);
      float s2 = pow(max(dot(n, normalize(l2 + v)), 0.0), 25.0) * 0.4;
      vec3 r = reflect(-v, n);
      float sky = smoothstep(-0.2, 0.9, r.y);
      vec3 env = mix(vec3(0.25, 0.12, 0.02), vec3(1.0, 0.93, 0.75), sky);
      float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
      vec3 col = gold * d * 0.7 + gold * env * 0.55 + vec3(1.0, 0.95, 0.8) * (s1 + s2) + vec3(1.0, 0.9, 0.6) * fres * 0.35;
      gl_FragColor = vec4(col, 1.0);
    }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const perspective = (fovy, aspect, near, far) => {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  };
  // Rotation autour de Y (angle a) puis inclinaison légère autour de X (angle b)
  const rotation = (a, b) => {
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    return new Float32Array([ca, sa * sb, -sa * cb, 0, 0, cb, sb, 0, sa, -ca * sb, ca * cb, 0, 0, 0, 0, 1]);
  };

  function fallback(canvas) {
    const el = document.createElement('div');
    el.className = canvas.className;
    el.style.cssText = 'display:grid;place-items:center;font-size:120px;';
    el.textContent = '🏆';
    canvas.replaceWith(el);
  }

  function show(canvas, url, { speed = 1 } = {}) {
    let stopped = false;
    const gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false });
    if (!gl) { fallback(canvas); return () => {}; }

    load(url).then(({ pos, nor, idx }) => {
      if (stopped || !canvas.isConnected) return;
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      gl.useProgram(prog);
      const buffer = (target, data) => { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); return b; };
      buffer(gl.ARRAY_BUFFER, pos);
      const aPos = gl.getAttribLocation(prog, 'aPos');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 3, gl.SHORT, true, 0, 0);
      buffer(gl.ARRAY_BUFFER, nor);
      const aNor = gl.getAttribLocation(prog, 'aNor');
      gl.enableVertexAttribArray(aNor);
      gl.vertexAttribPointer(aNor, 3, gl.BYTE, true, 0, 0);
      buffer(gl.ELEMENT_ARRAY_BUFFER, idx);
      const uModel = gl.getUniformLocation(prog, 'uModel');
      const uProj = gl.getUniformLocation(prog, 'uProj');
      gl.uniform1f(gl.getUniformLocation(prog, 'uDist'), 3.3);
      gl.enable(gl.DEPTH_TEST);
      gl.clearColor(0, 0, 0, 0);

      // Le joueur peut faire tourner le trophée du doigt ; il repart tout seul ensuite
      let angle = 0, spin = 0, dragX = null, last = performance.now();
      canvas.style.touchAction = 'pan-y';
      canvas.addEventListener('pointerdown', (e) => { dragX = e.clientX; spin = 0; canvas.setPointerCapture(e.pointerId); });
      canvas.addEventListener('pointermove', (e) => {
        if (dragX === null) return;
        const dx = e.clientX - dragX;
        dragX = e.clientX;
        angle += dx * 0.012;
        spin = dx * 0.6;
      });
      const release = () => { dragX = null; };
      canvas.addEventListener('pointerup', release);
      canvas.addEventListener('pointercancel', release);

      const frame = (now) => {
        if (stopped || !canvas.isConnected) return; // la page a changé : on arrête
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        if (dragX === null) {
          spin *= Math.pow(0.05, dt); // l'élan du doigt s'amortit
          angle += (0.9 * speed + spin) * dt; // environ un tour en 7 s
        }
        gl.viewport(0, 0, w, h);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.uniformMatrix4fv(uProj, false, perspective(0.62, w / Math.max(1, h), 0.1, 20));
        gl.uniformMatrix4fv(uModel, false, rotation(angle, 0.12 + 0.05 * Math.sin(now / 1700)));
        gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0);
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }).catch(() => { if (!stopped && canvas.isConnected) fallback(canvas); });

    return () => { stopped = true; };
  }

  return { show, load };
})();
