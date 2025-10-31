document.addEventListener('DOMContentLoaded', () => {
  // ===================== UTILS =====================
  const clamp01 = x => Math.max(0, Math.min(1, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = t => 1 - Math.pow(1 - t, 3);

  // Критически демпфированная "пружина" для сглаживания любого скалярного значения
  function springUpdate(state, target, dt, k = 10) {
    const c = 2 * Math.sqrt(k);               // критическое демпфирование
    const a = k * (target - state.x) - c * state.v;
    state.v += a * dt;
    state.x += state.v * dt;
  }

  // Автокадрирование камеры под объект
  function frameObject(object, camera, padding = 1.5) {
    const box = new THREE.Box3().setFromObject(object);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const radius = 0.5 * Math.max(size.x, size.y, size.z);

    const fov = THREE.MathUtils.degToRad(camera.fov);
    const aspect = camera.aspect;
    const horizFov = 2 * Math.atan(Math.tan(fov / 2) * aspect);

    const distV = (radius * padding) / Math.sin(fov / 2);
    const distH = (radius * padding) / Math.sin(horizFov / 2);
    const dist = Math.max(distV, distH);

    camera.position.set(center.x, center.y, center.z + dist);
    camera.near = Math.max(0.001, dist / 100);
    camera.far  = dist * 100;
    camera.lookAt(center);
    camera.updateProjectionMatrix();
  }

  // Единый прогресс от начала secStart до конца secEnd (0..1)
  function totalProgress(secStart, secEnd) {
    const y = window.scrollY || window.pageYOffset;
    const start = secStart.offsetTop;
    const end   = secEnd.offsetTop + secEnd.offsetHeight;
    return clamp01((y - start) / (end - start));
  }

  // Разложение общего скролла на 2 фазы по фактическим высотам секций
  // sections: [sec1, sec2, sec3]
  function twoPhaseProgress(sections) {
    const [s1, s2, s3] = sections;
    const y = window.scrollY || window.pageYOffset;

    const start = s1.offsetTop;
    const brk   = s2.offsetTop + s2.offsetHeight; // конец 2-й секции
    const end   = s3.offsetTop + s3.offsetHeight; // конец 3-й секции

    const total = end - start;
    const partA = brk - start; // длина фазы 0→1
    const partB = end - brk;   // длина фазы 1→2

    let tA = 0, tB = 0;

    if (y <= start) {
      tA = 0; tB = 0;
    } else if (y < brk) {
      tA = (y - start) / partA; tB = 0;
    } else if (y < end) {
      tA = 1; tB = (y - brk) / partB;
    } else {
      tA = 1; tB = 1;
    }

    // Мягкое сглаживание кривой прогресса
    return { tA: easeOut(clamp01(tA)), tB: easeOut(clamp01(tB)) };
  }

  // ===================== THREE / CANVAS =====================
  const canvas = document.getElementById('model');

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance'
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);

  function resizeRendererToCanvas() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resizeRendererToCanvas();
  window.addEventListener('resize', resizeRendererToCanvas);

  scene.add(new THREE.AmbientLight(0xffffff, 0.65));
  const dir = new THREE.DirectionalLight(0xffffff, 1.05);
  dir.position.set(3, 5, 2);
  dir.castShadow = true;
  scene.add(dir);

  // ===================== МОДЕЛЬ =====================
  const draco = new THREE.DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
  const loader = new THREE.GLTFLoader();
  loader.setDRACOLoader(draco);

  let model, mixer, framed = false;

  loader.load(
    'model.glb',
    (gltf) => {
      model = gltf.scene;
      model.traverse(o => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; }});
      scene.add(model);

      frameObject(model, camera, 1.5);

      if (gltf.animations?.length) {
        mixer = new THREE.AnimationMixer(model);
        mixer.clipAction(gltf.animations[0]).play();
      }

      framed = true;
    },
    undefined,
    (err) => console.error('GLB load error:', err)
  );

  // ===================== СЕКЦИИ/КЕЙФРЕЙМЫ =====================
  const sections = document.querySelectorAll('section');
  const sec1 = sections[0];
  const sec2 = sections[1];
  const sec3 = sections[2];

  // Ключевые кадры для canvas translateX (vw)
  const canvasKF = [
    { xVW: 45 }, // секция 1
    { xVW: 15 }, // секция 2 (чуть левее центра)
    { xVW: 45 }, // секция 3 (возврат направо)
  ];

  // Ключевые кадры для модели
  const modelKF = [
    { rotY: 0.0,           x:  0.00, y:  0.00 },        // начало
    { rotY: Math.PI,       x: -0.10, y:  0.00 },        // середина (180°)
    { rotY: Math.PI * 2.0, x:  0.20, y: -0.25 },        // финал (360°)
    // Если нужен "большой оборот": замените на Math.PI * 4.0 (720°)
  ];

  // Пружинные состояния
  const canvasX = { x: canvasKF[0].xVW, v: 0 };
  const rotY    = { x: modelKF[0].rotY, v: 0 };
  const posX    = { x: modelKF[0].x,    v: 0 };
  const posY    = { x: modelKF[0].y,    v: 0 };

  // Наклон канваса
  let tiltDeg = 0;

  // ===================== ЦИКЛ =====================
  const clock = new THREE.Clock();
  const box = new THREE.Box3();
  const centerNow = new THREE.Vector3();

  (function tick() {
    const dt = Math.min(clock.getDelta(), 0.05);
    if (mixer) mixer.update(dt);

    // ЕДИНЫЙ ПРОГРЕСС: 2 фазы на все секции
    const { tA, tB } = twoPhaseProgress([sec1, sec2, sec3]);

    // Интерполяция ключей: 0→1 по tA, затем →2 по tB
    let targetCanvas = lerp(canvasKF[0].xVW, canvasKF[1].xVW, tA);
    let targetRotY   = lerp(modelKF[0].rotY, modelKF[1].rotY, tA);
    let targetX      = lerp(modelKF[0].x,    modelKF[1].x,    tA);
    let targetY      = lerp(modelKF[0].y,    modelKF[1].y,    tA);

    targetCanvas = lerp(targetCanvas, canvasKF[2].xVW, tB);
    targetRotY   = lerp(targetRotY,   modelKF[2].rotY, tB);
    targetX      = lerp(targetX,      modelKF[2].x,    tB);
    targetY      = lerp(targetY,      modelKF[2].y,    tB);

    // Пружины (мягче по Y)
    springUpdate(canvasX, targetCanvas, dt, 16);
    springUpdate(rotY,    targetRotY,   dt, 10); // было 18 — сделали мягче
    springUpdate(posX,    targetX,      dt, 18);
    springUpdate(posY,    targetY,      dt, 18);

    // Наклон канваса от скорости поперечного скольжения
    const desiredTilt = Math.max(-4, Math.min(4, canvasX.v * 0.08));
    tiltDeg += (desiredTilt - tiltDeg) * (1 - Math.pow(0.12, dt));

    // Применить к канвасу
    canvas.style.transform = `translateX(${canvasX.x}vw) rotateZ(${tiltDeg}deg)`;

    // Применить к модели
    if (model && framed) {
      box.setFromObject(model);
      box.getCenter(centerNow);
      camera.lookAt(centerNow);

      model.position.x = posX.x;
      model.position.y = posY.x;
      model.rotation.y = rotY.x;

      // "Дыхание" затухает к финалу (в фазе B)
      const overall = 1 - tB;
      model.rotation.x = Math.sin(performance.now() * 0.0015) * 0.03 * overall;
    }

    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  })();
});
