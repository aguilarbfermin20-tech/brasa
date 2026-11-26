// three se carga dinámicamente en boot(): si el CDN falla, el formulario
// y la reserva siguen funcionando y se muestra la foto.
let THREE, RoomEnvironment;

/* ------------------------------------------------------------------
   Brasa 3D — la botella modelada en tiempo real.
   Colores muestreados de las fotos de producto:
   cuerpo #16171b · hombro #222224 · tapa #2d2e30 · estudio #d9e2eb
------------------------------------------------------------------- */

const root = document.documentElement;
const mqReduce = matchMedia('(prefers-reduced-motion: reduce)');
const mqSmall = matchMedia('(max-width: 767px)');
const qs = new URLSearchParams(location.search);
const reduce = mqReduce.matches || qs.has("quieto");   // ?quieto simula movimiento reducido
const small = mqSmall.matches;

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

/* ---------- precios y estado de la reserva (vale aunque no haya WebGL) ---------- */
// los precios viven en el HTML (data-price / data-cuotas); acá sólo se leen
const PRICES = Object.fromEntries($$('input[name="cap"]').map((r) => [r.value, Number(r.dataset.price)]));
const ENGRAVE_PRICE = Number($('#engrave-toggle')?.dataset.price) || 0;
const CUOTAS = Number($('#reserva-form')?.dataset.cuotas) || 1;
const state = { cap: '1000', engrave: false, text: '' };
const fmt = (n) => '$ ' + n.toLocaleString('es-AR');
const cuota = (n) => fmt(Math.ceil(n / CUOTAS));

$$('[data-price-of]').forEach((el) => {
  const k = el.dataset.priceOf;
  el.textContent = fmt(k === 'engrave' ? ENGRAVE_PRICE : PRICES[k]);
});
$$('[data-price-from]').forEach((el) => { el.textContent = fmt(Math.min(...Object.values(PRICES))); });
$$('[data-cuotas]:not(form)').forEach((el) => { el.textContent = CUOTAS; });
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function webglOK() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch { return false; }
}

const has3D = webglOK() && !qs.has("sin3d");          // ?sin3d simula un navegador sin WebGL
// el HTML arranca con .no-3d (sirve sin JS); acá se cambia si hay WebGL
root.classList.toggle('no-3d', !has3D);
root.classList.toggle('has-3d', has3D);
function fallbackTo2D(err) {
  root.classList.remove('has-3d'); root.classList.add('no-3d');
  console.warn('Brasa: 3D no disponible, se muestra la foto.', err);
}
if (reduce) root.classList.add('is-static');

/* ================================================================
   TEXTURAS
================================================================ */
function grainTexture(size = 256, strength = 16) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (Math.random() - 0.5) * strength * 2;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // granos un poco más grandes, como el pebble del cuerpo
  g.globalAlpha = 0.12;
  for (let i = 0; i < size * 6; i++) {
    const x = Math.random() * size, y = Math.random() * size, r = Math.random() * 1.6 + 0.4;
    g.fillStyle = Math.random() > 0.5 ? '#fff' : '#000';
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// grabado vertical, se lee de arriba hacia abajo como en las fotos
function engraveCanvas() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 1024;
  return c;
}
function drawEngrave(canvas, text, { weight = 600, track = 0.22, maxPx = 92 } = {}) {
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  if (!text) return;
  g.save();
  g.translate(canvas.width / 2, canvas.height / 2);
  g.rotate(Math.PI / 2);
  const fam = '"Big Shoulders Display", "Arial Narrow", sans-serif';
  let px = maxPx;
  const fit = () => {
    g.font = `${weight} ${px}px ${fam}`;
    const letters = [...text];
    const w = letters.reduce((s, ch) => s + g.measureText(ch).width, 0) + track * px * (letters.length - 1);
    return w;
  };
  while (fit() > canvas.height * 0.9 && px > 24) px -= 2;
  const letters = [...text];
  let x = -fit() / 2;
  g.fillStyle = '#fff';
  g.textBaseline = 'middle';
  for (const ch of letters) {
    g.fillText(ch, x, 2);
    x += g.measureText(ch).width + track * px;
  }
  g.restore();
}

/* ================================================================
   MODELO
================================================================ */
const R = 0.5;              // radio del cuerpo
const SEG = small ? 56 : 112;

function bottleDims(cap) {
  const Hb = cap === '750' ? 2.02 : 2.5;     // cuerpo negro
  return {
    Hb,
    sleeveTop: Hb + 0.56,                     // hombro recto grafito
    neck: Hb + 0.86,                          // fin de la curva del hombro
    capBase: Hb + 0.9,
    capTop: Hb + 1.29,
    total: Hb + 1.29,
  };
}

function makeMaterials() {
  const grain = grainTexture();
  grain.repeat.set(6, 10);
  const grainFine = grain.clone();
  grainFine.repeat.set(4, 3);
  grainFine.needsUpdate = true;
  return {
    grain,
    body: new THREE.MeshPhysicalMaterial({
      color: 0x16171b, roughness: 1.25, metalness: 0.05,
      clearcoat: 0.12, clearcoatRoughness: 0.6, envMapIntensity: 0.55,
      roughnessMap: grain,
    }),
    sleeve: new THREE.MeshPhysicalMaterial({
      color: 0x35363a, roughness: 1.6, metalness: 0.02,
      roughnessMap: grain, envMapIntensity: 0.7,
    }),
    cap: new THREE.MeshPhysicalMaterial({
      color: 0x3a3b3e, roughness: 1.35, metalness: 0.02,
      roughnessMap: grainFine, envMapIntensity: 0.7,
    }),
    ring: new THREE.MeshPhysicalMaterial({ color: 0x0f1012, roughness: 0.32, metalness: 0.1, clearcoat: 0.6 }),
    gloss: new THREE.MeshPhysicalMaterial({ color: 0x0b0b0d, roughness: 0.18, metalness: 0.2, clearcoat: 1 }),
    mouth: new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.9 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xc9ccd0, roughness: 0.28, metalness: 1 }),
    shadow: null,
  };
}

function roundedProfile(points) {
  return points.map(([x, y]) => new THREE.Vector2(x, y));
}

function arc(cx, cy, r, a0, a1, n = 10) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = lerp(a0, a1, i / n);
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

function buildBottle(M, cap, engr) {
  const d = bottleDims(cap);
  const g = new THREE.Group();        // origen en la base
  const fillet = 0.13;

  // cuerpo negro, base redondeada
  const bodyPts = [[0.0001, 0], [R - fillet, 0], ...arc(R - fillet, fillet, fillet, -Math.PI / 2, 0, 12).slice(1), [R, d.Hb]];
  const body = new THREE.Mesh(new THREE.LatheGeometry(roundedProfile(bodyPts), SEG), M.body);
  g.add(body);

  // junta oscura entre cuerpo y hombro
  const seam = new THREE.Mesh(new THREE.CylinderGeometry(R - 0.004, R - 0.004, 0.012, SEG, 1, true), M.ring);
  seam.position.y = d.Hb + 0.002;
  g.add(seam);

  // hombro grafito: recto y después curva hacia el cuello
  const sh = [[R + 0.002, d.Hb + 0.008], [R + 0.002, d.sleeveTop]];
  const steps = 16;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // curva suave tipo botella (cuarto de elipse)
    const a = t * Math.PI / 2;
    const x = 0.335 + (R + 0.002 - 0.335) * Math.cos(a);
    const y = d.sleeveTop + (d.neck - d.sleeveTop) * Math.sin(a);
    sh.push([x, y]);
  }
  sh.push([0.318, d.neck + 0.005]);
  const sleeve = new THREE.Mesh(new THREE.LatheGeometry(roundedProfile(sh), SEG), M.sleeve);
  g.add(sleeve);

  // aro del cuello
  const neckRing = new THREE.Mesh(new THREE.CylinderGeometry(0.318, 0.322, d.capBase - d.neck + 0.01, SEG, 1, true), M.ring);
  neckRing.position.y = (d.neck + d.capBase) / 2;
  g.add(neckRing);

  // boca (se ve cuando la tapa sale)
  const lip = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.32, SEG), M.ring);
  lip.rotation.x = -Math.PI / 2;
  lip.position.y = d.capBase - 0.002;
  g.add(lip);
  const mouth = new THREE.Mesh(new THREE.CircleGeometry(0.2, SEG), M.mouth);
  mouth.rotation.x = -Math.PI / 2;
  mouth.position.y = d.capBase - 0.03;
  g.add(mouth);
  const spoutRing = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.012, 8, SEG), M.gloss);
  spoutRing.rotation.x = Math.PI / 2;
  spoutRing.position.y = d.capBase;
  g.add(spoutRing);

  // tapa (grupo aparte para poder levantarla)
  const capG = new THREE.Group();
  const ch = d.capTop - d.capBase;
  const cf = 0.035;
  const capPts = [[0.33, 0], [0.33, ch - cf], ...arc(0.33 - cf, ch - cf, cf, 0, Math.PI / 2, 6).slice(1), [0.0001, ch]];
  const capMesh = new THREE.Mesh(new THREE.LatheGeometry(roundedProfile(capPts), SEG), M.cap);
  capG.add(capMesh);
  const capBottom = new THREE.Mesh(new THREE.CircleGeometry(0.33, SEG), M.ring);
  capBottom.rotation.x = Math.PI / 2;
  capG.add(capBottom);
  // botón cebador
  const btnRing = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.013, 10, 48), M.gloss);
  btnRing.rotation.x = Math.PI / 2;
  btnRing.position.y = ch + 0.004;
  capG.add(btnRing);
  const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.104, 0.018, 48), M.gloss);
  btn.position.y = ch + 0.006;
  capG.add(btn);
  // argolla de acero
  const loop = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.014, 10, 32, Math.PI * 1.25), M.steel);
  loop.rotation.z = -Math.PI * 0.62;
  loop.position.set(0.37, ch * 0.62, 0);
  capG.add(loop);
  const loopPin = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.05, 16), M.ring);
  loopPin.rotation.z = Math.PI / 2;
  loopPin.position.set(0.34, ch * 0.62, 0);
  capG.add(loopPin);
  capG.position.y = d.capBase;
  g.add(capG);

  // grabados: BRASA al frente, personalizado atrás
  const engH = Math.min(1.7, d.Hb * 0.7);
  const theta = 0.52;
  const mkEngrave = (tex, start) => {
    const geo = new THREE.CylinderGeometry(R + 0.0035, R + 0.0035, engH, 24, 1, true, start, theta);
    const mat = new THREE.MeshStandardMaterial({
      map: tex, transparent: true, color: 0x9a9ea5, roughness: 0.85, metalness: 0,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.y = d.Hb * 0.5;
    return m;
  };
  const front = mkEngrave(engr.brandTex, -theta / 2);
  const back = mkEngrave(engr.userTex, Math.PI - theta / 2);
  g.add(front, back);

  return { group: g, capG, dims: d, engr: { front, back } };
}

/* ================================================================
   ESCENA
================================================================ */
let renderer, scene, camera, pivot, bottle, M, contactShadow;
const engr = {};

function initScene() {
  tmpV = new THREE.Vector3();
  tmpV2 = new THREE.Vector3();
  const canvas = document.createElement('canvas');
  canvas.className = 'bottle-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: !small, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.75 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  camera = new THREE.PerspectiveCamera(26, 1, 0.1, 60);

  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffd2b8, 1.4);   // borde cálido, la "brasa"
  rim.position.set(-4, 2, -3);
  scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xe6edf3, 0x8f979f, 0.25));

  M = makeMaterials();

  engr.brandCanvas = engraveCanvas();
  drawEngrave(engr.brandCanvas, 'BRASA', { weight: 700, track: 0.32 });
  engr.brandTex = new THREE.CanvasTexture(engr.brandCanvas);
  engr.brandTex.colorSpace = THREE.SRGBColorSpace;
  engr.brandTex.anisotropy = 4;
  engr.userCanvas = engraveCanvas();
  engr.userTex = new THREE.CanvasTexture(engr.userCanvas);
  engr.userTex.colorSpace = THREE.SRGBColorSpace;
  engr.userTex.anisotropy = 4;

  pivot = new THREE.Group();
  scene.add(pivot);

  // sombra de contacto: un plano con gradiente, barato y suave
  const sc = document.createElement('canvas');
  sc.width = sc.height = 128;
  const sg = sc.getContext('2d');
  const grd = sg.createRadialGradient(64, 64, 4, 64, 64, 62);
  grd.addColorStop(0, 'rgba(20,24,30,.55)');
  grd.addColorStop(0.5, 'rgba(20,24,30,.18)');
  grd.addColorStop(1, 'rgba(20,24,30,0)');
  sg.fillStyle = grd; sg.fillRect(0, 0, 128, 128);
  contactShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(2.6, 2.6),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false })
  );
  contactShadow.rotation.x = -Math.PI / 2;
  scene.add(contactShadow);

  setCapacity(state.cap);
  return canvas;
}

function setCapacity(cap) {
  if (bottle) {
    pivot.remove(bottle.group);
    bottle.group.traverse((o) => o.geometry && o.geometry.dispose());
    // los materiales de los grabados se crean por botella; el resto es compartido
    bottle.engr.front.material.dispose();
    bottle.engr.back.material.dispose();
  }
  bottle = buildBottle(M, cap, engr);
  bottle.group.position.y = -bottle.dims.total / 2;
  pivot.add(bottle.group);
  bottle.capRest = bottle.capG.position.clone();
  requestRender();
}

function setUserEngraving(text) {
  if (!engr.userCanvas) return;
  drawEngrave(engr.userCanvas, text.toUpperCase(), { weight: 600, track: 0.18 });
  engr.userTex.needsUpdate = true;
  requestRender();
}

/* ================================================================
   COREOGRAFÍA DEL SCROLL
================================================================ */
const TAU = Math.PI * 2;
// p: progreso · ry: giro · tx: inclinación · cz: distancia · cy: altura cámara · ly: mira · cap: tapa afuera
const KEYS = [
  { p: 0.00, ry: -0.45, tx: 0.00, cz: 11.6, cy: 0.5, ly: 0.25, cap: 0 },
  { p: 0.17, ry: 0.95, tx: -0.03, cz: 8.4, cy: 0.1, ly: -0.25, cap: 0 },
  { p: 0.33, ry: 2.25, tx: 0.06, cz: 8.8, cy: -0.4, ly: -0.7, cap: 0 },
  { p: 0.50, ry: 3.45, tx: 0.58, cz: 7.2, cy: 1.6, ly: 1.15, cap: 0 },
  { p: 0.67, ry: 4.6, tx: 0.22, cz: 8.6, cy: 1.2, ly: 0.9, cap: 1 },
  { p: 0.84, ry: TAU, tx: 0.0, cz: 7.6, cy: 0.2, ly: 0.15, cap: 0 },
  { p: 1.00, ry: TAU + 0.55, tx: 0.0, cz: 11.6, cy: 0.5, ly: 0.25, cap: 0 },
];
const FEATURE_P = [0.17, 0.33, 0.5, 0.67, 0.84];
const WINDOW = 0.07;

function poseAt(p) {
  let i = 0;
  while (i < KEYS.length - 2 && p > KEYS[i + 1].p) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const t = smooth(clamp((p - a.p) / (b.p - a.p)));
  const o = {};
  for (const k of ['ry', 'tx', 'cz', 'cy', 'ly', 'cap']) o[k] = lerp(a[k], b[k], t);
  return o;
}

const POSE_STATIC = { ry: 0.55, tx: 0.04, cz: 9.4, cy: 0.5, ly: 0.05, cap: 0 };
const POSE_FRONT = { ry: -0.15, tx: 0.03, cz: 10.6, cy: 0.6, ly: 0.05, cap: 0 };
const POSE_BACK = { ry: Math.PI + 0.12, tx: 0.03, cz: 9.4, cy: 0.4, ly: -0.15, cap: 0 };

/* anclas para las líneas guía, en coordenadas del mundo */
let tmpV, tmpV2;   // se crean en initScene, cuando three ya cargó
function anchorWorld(i) {
  const d = bottle.dims;
  const toCam = (y) => {
    // punto de la superficie que mira a la cámara, a la altura y del cuerpo
    bottle.group.localToWorld(tmpV.set(0, y, 0));
    tmpV2.copy(camera.position).sub(tmpV); tmpV2.y = 0; tmpV2.normalize().multiplyScalar(R);
    return tmpV.add(tmpV2);
  };
  switch (i) {
    case 0: return toCam(d.Hb * 0.5);
    case 1: return toCam(d.Hb * 0.18);
    case 2: return bottle.capG.localToWorld(tmpV.set(0, d.capTop - d.capBase + 0.01, 0));
    case 3: return bottle.group.localToWorld(tmpV.set(0, d.capBase, 0));
    case 4: return bottle.group.localToWorld(tmpV.set(0, d.Hb * 0.62, R));
  }
}

/* ================================================================
   MONTAJES: el mismo canvas viaja entre el recorrido y la reserva
================================================================ */
const mounts = {};
let active = null;          // 'tour' | 'config'
let visible = new Set();
let current = { ...KEYS[0] };
let target = { ...KEYS[0] };
let configView = 'back';
let dragRy = 0, dragging = false, lastX = 0, idleT = 0;
let needsFrame = true;
let rafId = 0;
let scrollP = 0;
let snapNext = false;
let lastNow = 0;

function requestRender() {
  needsFrame = true;
  if (!rafId && active) rafId = requestAnimationFrame(frame);
}

function mountTo(name) {
  if (active === name) return;
  const m = mounts[name];
  if (!m) return;
  m.host.appendChild(renderer.domElement);
  active = name;
  resize();
  if (name === 'config') {
    Object.assign(current, configView === 'back' ? POSE_BACK : POSE_FRONT);
  }
  requestRender();
}

function resize() {
  if (!active) return;
  const host = mounts[active].host;
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // en pantallas angostas la botella necesita más distancia
  camera.userData.fitZ = w / h < 0.62 ? 1.45 : w / h < 0.95 ? 1.3 : 1;
  camera.updateProjectionMatrix();
  requestRender();
}

function applyPose(o, now) {
  pivot.rotation.set(o.tx, o.ry + dragRy, 0, 'XYZ');
  const fz = camera.userData.fitZ || 1;
  camera.position.set(0, o.cy, o.cz * fz);
  camera.lookAt(0, o.ly, 0);

  // la tapa sale flotando al costado y gira un poco
  const c = smooth(clamp(o.cap));
  const d = bottle.dims;
  const bob = active === 'tour' && !reduce ? Math.sin(now / 600) * 0.03 * c : 0;
  bottle.capG.position.set(
    bottle.capRest.x + 0.95 * c,
    bottle.capRest.y + Math.sin(c * Math.PI) * 0.35 + 0.42 * c + bob,
    bottle.capRest.z + 0.15 * c
  );
  bottle.capG.rotation.set(0.35 * c, 0, -0.42 * c);

  // sombra de contacto debajo de la botella
  bottle.group.updateWorldMatrix(true, false);
  bottle.group.localToWorld(tmpV.set(0, 0, 0));
  contactShadow.position.set(tmpV.x, tmpV.y - 0.01, tmpV.z);
  contactShadow.material.opacity = 1 - clamp(Math.abs(o.tx) * 1.4);
}

function frame(now) {
  rafId = 0;
  if (!active) return;
  let moving = false;
  // dt real: la animación va a la misma velocidad a 60 Hz que a 120 Hz
  const dt = lastNow ? Math.min((now - lastNow) / 1000, 0.05) : 1 / 60;
  lastNow = now;

  if (active === 'tour') {
    target = reduce ? POSE_STATIC : poseAt(scrollP);
  } else {
    const base = configView === 'back' ? POSE_BACK : POSE_FRONT;
    target = { ...base };
    if (!dragging && !reduce) {
      idleT += dt;
      target.ry = base.ry + Math.sin(idleT * 0.8) * 0.18;
      moving = true;
    }
  }

  const k = reduce || snapNext ? 1 : 1 - Math.pow(1 - 0.11, dt * 60);
  snapNext = false;
  for (const key in target) {
    const diff = target[key] - current[key];
    if (Math.abs(diff) > 0.0005) moving = true;
    current[key] += diff * k;
  }
  applyPose(current, now);
  renderer.render(scene, camera);
  if (active === 'tour') updateCallouts();

  needsFrame = false;
  if ((moving || dragging || current.cap > 0.01) && visible.has(active)) {
    rafId = requestAnimationFrame(frame);
  } else {
    lastNow = 0;   // el próximo arranque no hereda un dt viejo
  }
}

/* ================================================================
   RECORRIDO: progreso, termómetro, callouts y líneas guía
================================================================ */
const tour = $('#recorrido');
const stage = $('#stage');
const leaders = $('#leaders');
const callouts = $$('.callout');
const ticks = $$('.hud-tick');
const tempEl = $('#temp-value');
const hourEl = $('#temp-hour');
const progressEl = $('#progress-bar');
const heroCopy = $('.hero-copy');
const giant = $('.giant');
let activeIdx = -1;

function readScroll() {
  if (!tour) return;
  const r = tour.getBoundingClientRect();
  const span = r.height - window.innerHeight;
  scrollP = span > 0 ? clamp(-r.top / span) : 0;

  const tp = clamp((scrollP - 0.08) / 0.84);
  const temp = 85 - 6 * tp;
  if (tempEl) tempEl.textContent = temp.toFixed(1).replace('.', ',');
  if (hourEl) hourEl.textContent = String(Math.round(tp * 12)).padStart(2, '0');
  if (progressEl) progressEl.style.transform = `scaleY(${scrollP})`;

  let idx = -1;
  FEATURE_P.forEach((fp, i) => { if (Math.abs(scrollP - fp) < WINDOW) idx = i; });
  if (idx !== activeIdx) {
    activeIdx = idx;
    callouts.forEach((c, i) => c.classList.toggle('is-on', i === idx));
    ticks.forEach((t, i) => t.classList.toggle('is-on', i <= idx || scrollP > FEATURE_P[i]));
  }
  const heroFade = clamp(1 - scrollP / 0.08);
  if (heroCopy) heroCopy.style.opacity = heroFade;
  if (heroCopy) heroCopy.style.visibility = heroFade < 0.02 ? 'hidden' : 'visible';
  if (giant) giant.style.setProperty('--fade', (0.35 + heroFade * 0.65).toFixed(3));
  // sólo dibujar si el recorrido está en pantalla: scrollear el resto no gasta GPU
  if (active === 'tour' && visible.has('tour')) requestRender();
}

const line = leaders ? leaders.querySelector('line') : null;
const dot = leaders ? leaders.querySelector('circle') : null;
function updateCallouts() {
  if (!leaders || reduce) return;
  if (activeIdx < 0) { leaders.classList.remove('is-on'); return; }
  const a = anchorWorld(activeIdx).clone().project(camera);
  const sr = stage.getBoundingClientRect();
  const cr = renderer.domElement.getBoundingClientRect();
  const ax = cr.left - sr.left + (a.x + 1) / 2 * cr.width;
  const ay = cr.top - sr.top + (1 - a.y) / 2 * cr.height;
  const box = callouts[activeIdx].getBoundingClientRect();
  const bx0 = box.left - sr.left, bx1 = box.right - sr.left;
  const by0 = box.top - sr.top, by1 = box.bottom - sr.top;
  let ex, ey;
  if (ax < bx0) { ex = bx0; ey = clamp(ay, by0 + 14, by1 - 14); }
  else if (ax > bx1) { ex = bx1; ey = clamp(ay, by0 + 14, by1 - 14); }
  else { ex = clamp(ax, bx0 + 14, bx1 - 14); ey = ay < by0 ? by0 : by1; }
  leaders.setAttribute('viewBox', `0 0 ${sr.width} ${sr.height}`);
  line.setAttribute('x1', ax); line.setAttribute('y1', ay);
  line.setAttribute('x2', ex); line.setAttribute('y2', ey);
  dot.setAttribute('cx', ax); dot.setAttribute('cy', ay);
  leaders.classList.add('is-on');
}

/* ================================================================
   MENÚ MOBILE
================================================================ */
const menuBtn = $('#menu-btn');
const navLinks = $('#nav-links');
if (menuBtn && navLinks) {
  root.classList.add('has-menu');
  menuBtn.hidden = false;
  const setMenu = (open, { focusBtn = false } = {}) => {
    menuBtn.setAttribute('aria-expanded', String(open));
    navLinks.classList.toggle('is-open', open);
    if (focusBtn) menuBtn.focus();
  };
  menuBtn.addEventListener('click', () => {
    const open = menuBtn.getAttribute('aria-expanded') !== 'true';
    setMenu(open);
    if (open) navLinks.querySelector('a')?.focus();
  });
  navLinks.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && navLinks.classList.contains('is-open')) setMenu(false, { focusBtn: true });
  });
  document.addEventListener('click', (e) => {
    if (navLinks.classList.contains('is-open') && !e.target.closest('.nav-menu')) setMenu(false);
  });
  // al pasar a escritorio, el menú no queda abierto "escondido"
  matchMedia('(min-width: 861px)').addEventListener('change', (e) => { if (e.matches) setMenu(false); });
}

/* ================================================================
   RESERVA
================================================================ */
const form = $('#reserva-form');
const capRadios = $$('input[name="cap"]');
const engraveToggle = $('#engrave-toggle');
const engraveField = $('#engrave-field');
const engraveInput = $('#engrave-text');
const engraveCount = $('#engrave-count');
const engraveErr = $('#engrave-error');
const sumCap = $('#sum-cap');
const sumEng = $('#sum-engrave');
const sumTotal = $('#sum-total');
const sumCuotas = $('#sum-cuotas');
const result = $('#reserva-result');
const viewBtns = $$('[data-view]');

function total() {
  return PRICES[state.cap] + (state.engrave && state.text.trim() ? ENGRAVE_PRICE : 0);
}
function renderSummary() {
  if (!form) return;
  sumCap.textContent = `${state.cap === '750' ? '750 ml' : '1 L'} · ${fmt(PRICES[state.cap])}`;
  const engOn = state.engrave && state.text.trim();
  sumEng.textContent = engOn ? `“${state.text.trim().toUpperCase()}” · + ${fmt(ENGRAVE_PRICE)}` : 'Sin grabado';
  sumTotal.textContent = fmt(total());
  sumCuotas.textContent = `${CUOTAS} cuotas de ${cuota(total())}`;
}

capRadios.forEach((r) => r.addEventListener('change', () => {
  if (!r.checked) return;
  state.cap = r.value;
  if (renderer) setCapacity(state.cap);
  renderSummary();
}));
// si el navegador restauró el formulario (atrás/adelante), respetar lo marcado
const checkedCap = capRadios.find((r) => r.checked);
if (checkedCap) state.cap = checkedCap.value;

engraveToggle?.addEventListener('click', () => {
  state.engrave = engraveToggle.getAttribute('aria-pressed') !== 'true';
  engraveToggle.setAttribute('aria-pressed', String(state.engrave));
  engraveField.hidden = !state.engrave;
  if (state.engrave) {
    engraveInput.focus();
    setView('back');
  }
  setUserEngraving(state.engrave ? state.text : '');
  renderSummary();
});

const ALLOWED = /^[A-ZÁÉÍÓÚÜÑa-záéíóúüñ0-9 .&'-]*$/;
const ERR_CHARS = engraveErr?.textContent;
engraveInput?.addEventListener('input', () => {
  let v = engraveInput.value;
  const ok = ALLOWED.test(v);
  engraveErr.textContent = ERR_CHARS;   // el submit puede haber puesto otro mensaje
  engraveErr.hidden = ok;
  engraveInput.setAttribute('aria-invalid', String(!ok));
  if (!ok) {
    // sacar lo no permitido también del input, para que lo que se ve sea lo que se graba
    const pos = engraveInput.selectionStart;
    const clean = v.replace(/[^A-ZÁÉÍÓÚÜÑa-záéíóúüñ0-9 .&'-]/g, '');
    const removed = v.length - clean.length;
    engraveInput.value = v = clean;
    if (pos != null) engraveInput.setSelectionRange(pos - removed, pos - removed);
  }
  state.text = [...v].slice(0, 14).join('');
  engraveCount.textContent = `${[...state.text].length}/14`;
  setUserEngraving(state.text);
  if (configView !== 'back') setView('back');
  renderSummary();
});

function setView(v) {
  configView = v;
  viewBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
  dragRy = 0;
  requestRender();
}
viewBtns.forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

form?.addEventListener('submit', (e) => {
  e.preventDefault();
  if (state.engrave && !state.text.trim()) {
    engraveErr.hidden = false;
    engraveErr.textContent = 'Escribí el texto a grabar o sacá el grabado.';
    engraveInput.setAttribute('aria-invalid', 'true');
    engraveInput.focus();
    return;
  }
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.dataset.state = 'loading';
  btn.querySelector('.btn-label').textContent = 'Reservando…';
  result.hidden = false;
  result.dataset.state = 'loading';
  result.innerHTML = '<p>Armando tu reserva…</p>';
  setTimeout(() => {
    const engOn = state.engrave && state.text.trim();
    result.dataset.state = 'done';
    result.innerHTML = `
      <p class="result-title">Listo: tu Brasa ${state.cap === '750' ? '750 ml' : '1 L'} quedó reservada.</p>
      <p>${engOn ? `Con grabado “${esc(state.text.trim().toUpperCase())}”. ` : ''}Total ${fmt(total())}, en ${CUOTAS} cuotas de ${cuota(total())}.</p>
      <p class="result-demo">Esto es una demo: no se cobra ni se envía nada.</p>`;
    btn.disabled = false;
    btn.dataset.state = '';
    btn.querySelector('.btn-label').textContent = 'Reservar otra';
  }, 700);
});

renderSummary();

/* ================================================================
   ARRANQUE
================================================================ */
async function boot() {
  if (!has3D) return;
  try {
    const [three, env] = await Promise.all([
      import('three'),
      import('three/addons/environments/RoomEnvironment.js'),
    ]);
    THREE = three;
    RoomEnvironment = env.RoomEnvironment;
    initScene();
  } catch (err) {
    fallbackTo2D(err);
    return;
  }
  mounts.tour = { host: $('#stage-canvas') };
  mounts.config = { host: $('#config-canvas') };

  // el canvas va a donde se ve
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const name = e.target === mounts.tour.host ? 'tour' : 'config';
      e.isIntersecting ? visible.add(name) : visible.delete(name);
    }
    if (visible.has('config') && !visible.has('tour')) mountTo('config');
    else if (visible.has('tour')) mountTo('tour');
    requestRender();
  }, { rootMargin: '120px 0px' });
  io.observe(mounts.tour.host);
  io.observe(mounts.config.host);
  mountTo('tour');

  // arrastrar para girar en la reserva
  const ch = mounts.config.host;
  ch.addEventListener('pointerdown', (e) => {
    dragging = true; lastX = e.clientX; ch.setPointerCapture(e.pointerId); requestRender();
  });
  ch.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dragRy += (e.clientX - lastX) * 0.012; lastX = e.clientX; requestRender();
  });
  const end = () => { dragging = false; requestRender(); };
  ch.addEventListener('pointerup', end);
  ch.addEventListener('pointercancel', end);

  window.addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) requestRender(); });

  // fuentes listas → redibujar grabado con la tipografía real
  document.fonts?.ready.then(() => {
    drawEngrave(engr.brandCanvas, 'BRASA', { weight: 700, track: 0.32 });
    engr.brandTex.needsUpdate = true;
    setUserEngraving(state.engrave ? state.text : '');
  });

  root.classList.add('is-ready');
  readScroll();
}

window.addEventListener('scroll', readScroll, { passive: true });
window.addEventListener('resize', readScroll, { passive: true });
readScroll();
boot();

// para probar desde la consola
window.__brasa = { get THREE() { return THREE; }, get scene() { return scene; }, get renderer() { return renderer; }, get M() { return M; }, render: () => requestRender(), snap: () => { snapNext = true; needsFrame = true; frame(performance.now()); }, get p() { return scrollP; }, get active() { return active; }, get frameLoop() { return !!rafId; } };
