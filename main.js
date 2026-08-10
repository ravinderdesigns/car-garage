import * as THREE from './vendor/three/three.module.js';
import { GLTFLoader } from './vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from './vendor/three/examples/jsm/environments/RoomEnvironment.js';

window.addEventListener('error', (e) => {
  console.error('[SECTOR35] Uncaught error:', e.message, e.filename, e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[SECTOR35] Unhandled promise rejection:', e.reason);
});

/* ============================================================
   Basic DOM wiring
   ============================================================ */
const loaderEl   = document.getElementById('loader');
const loaderBar  = document.getElementById('loaderBar');
const loaderPct  = document.getElementById('loaderPct');
const hudStage   = document.getElementById('hudStage');
const navBurger  = document.getElementById('navBurger');
const navMobile  = document.getElementById('navMobile');

navBurger.addEventListener('click', () => {
  navMobile.classList.toggle('open');
});
navMobile.querySelectorAll('a').forEach(a =>
  a.addEventListener('click', () => navMobile.classList.remove('open'))
);

/* ============================================================
   Hover "light on" state — headings, cards, buttons
   ============================================================ */
let hoverTarget = 0.28; // dim by default, 1 = fully lit
document.querySelectorAll('.light-trigger').forEach(el => {
  el.addEventListener('mouseenter', () => {
    hoverTarget = 1.0;
    document.body.classList.add('is-hovering');
  });
  el.addEventListener('mouseleave', () => {
    hoverTarget = 0.28;
    document.body.classList.remove('is-hovering');
  });
  el.addEventListener('focus', () => { hoverTarget = 1.0; document.body.classList.add('is-hovering'); });
  el.addEventListener('blur',  () => { hoverTarget = 0.28; document.body.classList.remove('is-hovering'); });
});

/* ============================================================
   Small helper: a soft radial-gradient glow texture, generated
   on a canvas at runtime (no external image asset needed) —
   used for the headlight/taillight glow sprites.
   ============================================================ */
function makeGlowTexture(colorHex) {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const col = new THREE.Color(colorHex);
  const r = Math.round(col.r * 255), g = Math.round(col.g * 255), b = Math.round(col.b * 255);
  grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
  grad.addColorStop(0.35, `rgba(${r},${g},${b},0.55)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ============================================================
   Renderer / scene / camera
   ============================================================ */
const canvas = document.getElementById('stage');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
} catch (rendererErr) {
  console.error('WebGL unavailable:', rendererErr);
  loaderPct.textContent = 'WEBGL UNAVAILABLE IN THIS BROWSER';
  loaderBar.style.background = '#ff4a1f';
  loaderBar.style.width = '100%';
  throw rendererErr;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.83; // ~15% darker again on top of the previous pass

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x0a0b0d, 0.012);

// studio environment map — without this, glossy/metallic car paint has
// nothing to reflect and reads as flat black against the dark background.
// Wrapped defensively: if this fails on a given GPU/driver, the rest of
// the scene must still render instead of the whole page going blank.
try {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
} catch (envErr) {
  console.warn('Environment map failed, continuing without it:', envErr);
}

const camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(0, 0, 10);
camera.lookAt(0, 0, 0);

/* ============================================================
   Lighting rig — dim by default, flares on hover
   ============================================================ */
const ambient = new THREE.AmbientLight(0x2b3038, 0.9);
scene.add(ambient);

const keyLight = new THREE.DirectionalLight(0xffffff, 0.5);
keyLight.position.set(4, 6, 6);
scene.add(keyLight);

const rimLight = new THREE.PointLight(0xff4a1f, 0.6, 40, 2);
rimLight.position.set(-5, 2, -4);
scene.add(rimLight);

// real headlamp spotlights — repositioned to the model's actual
// headlight geometry once it loads (see below)
const headlampL = new THREE.SpotLight(0xbfeeff, 0, 20, Math.PI / 8, 0.35, 1.4);
const headlampR = new THREE.SpotLight(0xbfeeff, 0, 20, Math.PI / 8, 0.35, 1.4);
scene.add(headlampL, headlampL.target, headlampR, headlampR.target);

// red taillight point light — always on, matches the car's real tail lenses
const taillampGlow = new THREE.PointLight(0xff1a1a, 0, 6, 2);
scene.add(taillampGlow);

const fillLight = new THREE.HemisphereLight(0x3a4652, 0x0a0b0d, 0.5);
scene.add(fillLight);

// intensities we lerp toward each frame
const LIGHT_LEVELS = {
  ambient:  { dim: 0.9,  lit: 1.35 },
  key:      { dim: 1.0,  lit: 2.2  },
  rim:      { dim: 0.85, lit: 2.6  },
  headlamp: { dim: 1.7,  lit: 3.4  }, // headlamps stay on by default, flare brighter on hover
  taillamp: { dim: 1.1,  lit: 1.9  }, // taillights stay on too, glow harder on hover
  beam:     { dim: 0.10, lit: 0.22 },
};
let currentGlow = 0.28;

/* ============================================================
   Load model
   ============================================================ */
const group = new THREE.Group();
scene.add(group);

let modelRadius = 3;
let modelReady = false;
let wheelObjects = [];   // spin these on scroll-driven movement
let beamL = null, beamR = null; // headlight beam cones

const glowTexWhite = makeGlowTexture(0xbfeeff);
const glowTexRed = makeGlowTexture(0xff2a2a);

function makeGlowSprite(texture, size) {
  const mat = new THREE.SpriteMaterial({
    map: texture,
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(size, size, 1);
  return sprite;
}

function makeBeamCone(color, length, radius) {
  const geo = new THREE.ConeGeometry(radius, length, 20, 1, true);
  geo.translate(0, -length / 2, 0); // apex sits at local origin, base extends toward -Y
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.14,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  return new THREE.Mesh(geo, mat);
}

const loader = new GLTFLoader();
loader.load(
  'assets/gtr.glb',
  (gltf) => {
    const model = gltf.scene;

    model.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = false;
        child.receiveShadow = false;
        if (child.material) {
          child.material.envMapIntensity = 1.15;
          child.material.needsUpdate = true;
        }
      }
    });

    // auto-fit: center the model and derive a working radius
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    model.position.sub(center);
    const rawRadius = Math.max(size.x, size.y, size.z) / 2 || 3;

    // Normalize scale: this GLB's native units are extremely small
    // (~0.02 world units across), which puts the camera closer than the
    // near clipping plane and clips the whole car invisibly. Rescale the
    // model itself so downstream camera/light/keyframe math — all written
    // in terms of a "radius" — works at a sane, numerically stable scale.
    const TARGET_RADIUS = 3;
    const normalizeScale = TARGET_RADIUS / rawRadius;
    model.scale.setScalar(normalizeScale);
    modelRadius = TARGET_RADIUS;

    // face the car ~3/4 toward camera by default
    model.rotation.y = Math.PI * 0.18;

    // Force matrices up to date *before* reading world positions below,
    // and *before* adding to `group` — this keeps every position we read
    // in group-local space (model has no parent yet at this point), which
    // is exactly the space new siblings of `model` need to be placed in.
    model.updateMatrixWorld(true);

    /* ---------- find wheel groups, headlights, taillights by name ---------- */
    const headL = [], headR = [], tailL = [], tailR = [];
    const tmp = new THREE.Vector3();

    model.traverse((child) => {
      const name = child.name || '';

      // 4 wheel groups: "3DWheel Front L/R", "3DWheel Rear L/R"
      if (/wheel/i.test(name) && !/steering/i.test(name) && (/front/i.test(name) || /rear/i.test(name))) {
        wheelObjects.push(child);
      }

      if (!child.isMesh) return;
      const lname = name.toLowerCase();

      if (lname.includes('headlightl')) {
        child.getWorldPosition(tmp);
        headL.push(tmp.clone());
        if (child.material) {
          child.material = child.material.clone();
          child.material.emissive = new THREE.Color(0xdfffff);
          child.material.emissiveIntensity = 1.6;
        }
      } else if (lname.includes('headlightr')) {
        child.getWorldPosition(tmp);
        headR.push(tmp.clone());
        if (child.material) {
          child.material = child.material.clone();
          child.material.emissive = new THREE.Color(0xdfffff);
          child.material.emissiveIntensity = 1.6;
        }
      } else if (lname.includes('taillightl')) {
        child.getWorldPosition(tmp);
        tailL.push(tmp.clone());
        if (child.material) {
          child.material = child.material.clone();
          child.material.emissive = new THREE.Color(0xff1a1a);
          child.material.emissiveIntensity = 1.4;
        }
      } else if (lname.includes('taillightr')) {
        child.getWorldPosition(tmp);
        tailR.push(tmp.clone());
        if (child.material) {
          child.material = child.material.clone();
          child.material.emissive = new THREE.Color(0xff1a1a);
          child.material.emissiveIntensity = 1.4;
        }
      }
    });

    const avg = (arr, fallback) => {
      if (!arr.length) return fallback.clone();
      const v = new THREE.Vector3();
      arr.forEach((p) => v.add(p));
      return v.divideScalar(arr.length);
    };

    const fallbackHeadL = new THREE.Vector3(modelRadius * 0.32, modelRadius * 0.18, modelRadius * 0.62);
    const fallbackHeadR = new THREE.Vector3(-modelRadius * 0.32, modelRadius * 0.18, modelRadius * 0.62);
    const fallbackTailL = new THREE.Vector3(modelRadius * 0.32, modelRadius * 0.2, -modelRadius * 0.62);
    const fallbackTailR = new THREE.Vector3(-modelRadius * 0.32, modelRadius * 0.2, -modelRadius * 0.62);

    const headLPos = avg(headL, fallbackHeadL);
    const headRPos = avg(headR, fallbackHeadR);
    const tailLPos = avg(tailL, fallbackTailL);
    const tailRPos = avg(tailR, fallbackTailR);

    const headCenter = headLPos.clone().add(headRPos).multiplyScalar(0.5);
    const tailCenter = tailLPos.clone().add(tailRPos).multiplyScalar(0.5);
    const forwardDir = headCenter.clone().sub(tailCenter).normalize();
    if (forwardDir.lengthSq() < 0.001) forwardDir.set(0, 0, 1); // guard against degenerate geometry

    console.log('[SECTOR35] wheels found:', wheelObjects.length, 'headlights L/R:', headL.length, headR.length, 'taillights L/R:', tailL.length, tailR.length);

    group.add(model);

    // camera distance relative to model size (now normalized, so this is stable)
    camera.position.set(0, modelRadius * 0.18, modelRadius * 2.5);
    camera.near = modelRadius * 0.02;
    camera.far = modelRadius * 200;
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();

    /* ---------- headlamp spotlights, aimed using the real geometry ---------- */
    headlampL.position.copy(headLPos);
    headlampR.position.copy(headRPos);
    const aimL = headLPos.clone().add(forwardDir.clone().multiplyScalar(modelRadius * 3));
    const aimR = headRPos.clone().add(forwardDir.clone().multiplyScalar(modelRadius * 3));
    headlampL.target.position.copy(aimL);
    headlampR.target.position.copy(aimR);
    group.add(headlampL, headlampL.target, headlampR, headlampR.target);
    // (lights now live inside `group` so they travel with the car during scroll)

    /* ---------- visible headlight beam cones ---------- */
    // beamL = makeBeamCone(0xbfeeff, modelRadius * 2.2, modelRadius * 0.55);
    // beamR = makeBeamCone(0xbfeeff, modelRadius * 2.2, modelRadius * 0.55);
    // const beamQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), forwardDir);
    // beamL.position.copy(headLPos);
    // beamR.position.copy(headRPos);
    // beamL.quaternion.copy(beamQuat);
    // beamR.quaternion.copy(beamQuat);
    // group.add(beamL, beamR);

    /* ---------- glow sprites at the lamps themselves ---------- */
    // const headGlowSize = modelRadius * 0.22;
    // const headGlowL = makeGlowSprite(glowTexWhite, headGlowSize);
    // const headGlowR = makeGlowSprite(glowTexWhite, headGlowSize);
    // headGlowL.position.copy(headLPos).addScaledVector(forwardDir, modelRadius * 0.02);
    // headGlowR.position.copy(headRPos).addScaledVector(forwardDir, modelRadius * 0.02);
    // group.add(headGlowL, headGlowR);

    // const tailGlowSize = modelRadius * 0.2;
    // const tailGlowL = makeGlowSprite(glowTexRed, tailGlowSize);
    // const tailGlowR = makeGlowSprite(glowTexRed, tailGlowSize);
    // tailGlowL.position.copy(tailLPos).addScaledVector(forwardDir, -modelRadius * 0.02);
    // tailGlowR.position.copy(tailRPos).addScaledVector(forwardDir, -modelRadius * 0.02);
    // group.add(tailGlowL, tailGlowR);

    /* ---------- red taillight point light, always on ---------- */
    taillampGlow.position.copy(tailCenter).addScaledVector(forwardDir, -modelRadius * 0.15);
    group.add(taillampGlow);

    keyLight.position.set(modelRadius * 1.3, modelRadius * 2, modelRadius * 1.8);
    rimLight.position.set(-modelRadius * 1.6, modelRadius * 0.6, -modelRadius * 1.2);

    modelReady = true;
    finishLoading();
  },
  (xhr) => {
    if (xhr.total) {
      const pct = Math.min(100, Math.round((xhr.loaded / xhr.total) * 100));
      loaderBar.style.width = pct + '%';
      loaderPct.textContent = `LOADING CHASSIS — ${pct}%`;
    }
  },
  (err) => {
    console.error('Model failed to load', err);
    loaderPct.textContent = 'MODEL UNAVAILABLE — CHECK CONSOLE (F12)';
    loaderBar.style.background = '#ff4a1f';
    setTimeout(finishLoading, 2200);
  }
);

function finishLoading() {
  loaderBar.style.width = '100%';
  loaderPct.textContent = 'READY';
  setTimeout(() => loaderEl.classList.add('hidden'), 380);
}

/* ============================================================
   Scroll choreography
   Keyframes describe where the whole group sits & how it's
   rotated at each named "stage" of the page. We lerp between
   them continuously as the user scrolls, independent of the
   raw page scroll (which stays native + CSS smooth-scroll).
   Offsets are expressed as fractions of modelRadius so they
   scale correctly regardless of the model's real-world units.
   ============================================================ */
const KEYFRAMES = [
  // hero — centered, angled 3/4
  { rotY: 0.55,  x:  0.15, y: -0.05, z: 0.0, tilt: 0.03 },
  // services — pushed right, text panel sits on the left
  { rotY: 1.55,  x:  0.62, y:  0.02, z: -0.15, tilt: -0.02 },
  // process — pushed left, text panel sits on the right
  { rotY: 2.75,  x: -0.60, y: -0.02, z: -0.1, tilt: 0.02 },
  // specs — near side profile, centered-ish
  { rotY: 3.95,  x:  0.20, y:  0.04, z: 0.05, tilt: -0.015 },
  // cta — big centered hero moment again
  { rotY: 5.4,   x: -0.05, y: -0.02, z: 0.2, tilt: 0.0 },
];

const stageSections = Array.from(document.querySelectorAll('.stage-section'));

function getScrollProgress() {
  const doc = document.documentElement;
  const max = doc.scrollHeight - window.innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
}

function getKeyframeBlend(progress) {
  const f = progress * (KEYFRAMES.length - 1);
  const i0 = Math.floor(f);
  const i1 = Math.min(KEYFRAMES.length - 1, i0 + 1);
  const t = f - i0;
  const a = KEYFRAMES[i0];
  const b = KEYFRAMES[i1];
  return {
    rotY: THREE.MathUtils.lerp(a.rotY, b.rotY, t),
    x:    THREE.MathUtils.lerp(a.x,    b.x,    t),
    y:    THREE.MathUtils.lerp(a.y,    b.y,    t),
    z:    THREE.MathUtils.lerp(a.z,    b.z,    t),
    tilt: THREE.MathUtils.lerp(a.tilt, b.tilt, t),
    idx:  i0,
  };
}

// current (smoothed) transform values the render loop eases toward
const current = { rotY: KEYFRAMES[0].rotY, x: KEYFRAMES[0].x, y: KEYFRAMES[0].y, z: KEYFRAMES[0].z, tilt: KEYFRAMES[0].tilt };
let prevRotY = current.rotY;
let prevX = current.x;
let prevZ = current.z;

let mouseX = 0, mouseY = 0;
window.addEventListener('pointermove', (e) => {
  mouseX = (e.clientX / window.innerWidth) - 0.5;
  mouseY = (e.clientY / window.innerHeight) - 0.5;
});

/* update the HUD stage readout only when it changes */
let lastStageIdx = -1;
function updateHud(idx) {
  if (idx === lastStageIdx) return;
  lastStageIdx = idx;
  const section = stageSections[idx] || stageSections[0];
  hudStage.textContent = section.dataset.label || '00 / INTRO';
}

/* ============================================================
   Resize
   ============================================================ */
function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', onResize);

/* ============================================================
   Render loop
   ============================================================ */
const DAMP = 0.07;       // scroll-driven motion smoothing
const GLOW_DAMP = 0.08;  // hover light smoothing
const WHEEL_SPIN_MULT = 7; // how many radians the wheels turn per radian of body turntable motion

function animate() {
  requestAnimationFrame(animate);

  const progress = getScrollProgress();
  const blend = getKeyframeBlend(progress);
  updateHud(blend.idx);

  current.rotY = THREE.MathUtils.lerp(current.rotY, blend.rotY, DAMP);
  current.x    = THREE.MathUtils.lerp(current.x,    blend.x,    DAMP);
  current.y    = THREE.MathUtils.lerp(current.y,    blend.y,    DAMP);
  current.z    = THREE.MathUtils.lerp(current.z,    blend.z,    DAMP);
  current.tilt = THREE.MathUtils.lerp(current.tilt, blend.tilt, DAMP);

  if (modelReady) {
    group.rotation.y = current.rotY + mouseX * 0.12;
    group.rotation.x = current.tilt + mouseY * 0.03;
    group.position.x = current.x * modelRadius;
    group.position.y = current.y * modelRadius + Math.sin(performance.now() * 0.0003) * modelRadius * 0.01;
    group.position.z = current.z * modelRadius;

    // spin the wheels proportional to how much the car has actually moved
    // this frame (turntable rotation + lateral/forward drift), so they
    // roll while scrolling and settle once the car stops moving
    const movedRot = Math.abs(current.rotY - prevRotY);
    const movedPos = Math.abs(current.x - prevX) + Math.abs(current.z - prevZ);
    const spinDelta = (movedRot + movedPos) * WHEEL_SPIN_MULT;
    if (wheelObjects.length && spinDelta > 0.00001) {
      for (const wheel of wheelObjects) wheel.rotation.x -= spinDelta;
    }
    prevRotY = current.rotY;
    prevX = current.x;
    prevZ = current.z;
  }

  // hover lighting
  currentGlow = THREE.MathUtils.lerp(currentGlow, hoverTarget, GLOW_DAMP);
  ambient.intensity   = THREE.MathUtils.lerp(LIGHT_LEVELS.ambient.dim, LIGHT_LEVELS.ambient.lit, currentGlow);
  keyLight.intensity  = THREE.MathUtils.lerp(LIGHT_LEVELS.key.dim,     LIGHT_LEVELS.key.lit,     currentGlow);
  rimLight.intensity  = THREE.MathUtils.lerp(LIGHT_LEVELS.rim.dim,     LIGHT_LEVELS.rim.lit,     currentGlow);
  headlampL.intensity = THREE.MathUtils.lerp(LIGHT_LEVELS.headlamp.dim, LIGHT_LEVELS.headlamp.lit, currentGlow);
  headlampR.intensity = headlampL.intensity;
  taillampGlow.intensity = THREE.MathUtils.lerp(LIGHT_LEVELS.taillamp.dim, LIGHT_LEVELS.taillamp.lit, currentGlow);

  if (beamL && beamR) {
    const beamOpacity = THREE.MathUtils.lerp(LIGHT_LEVELS.beam.dim, LIGHT_LEVELS.beam.lit, currentGlow);
    beamL.material.opacity = beamOpacity;
    beamR.material.opacity = beamOpacity;
  }

  try {
    renderer.render(scene, camera);
  } catch (renderErr) {
    console.error('Render frame failed:', renderErr);
  }
}
animate();
