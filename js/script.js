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


// document.addEventListener('DOMContentLoaded', () => {
//   // ===================== UTILS =====================
//   const clamp01 = x => Math.max(0, Math.min(1, x));
//   const lerp = (a, b, t) => a + (b - a) * t;
//   const easeOut = t => 1 - Math.pow(1 - t, 3);

//   function springUpdate(state, target, dt, k = 10) {
//     const c = 2 * Math.sqrt(k);
//     const a = k * (target - state.x) - c * state.v;
//     state.v += a * dt;
//     state.x += state.v * dt;
//   }

//   function frameObject(object, camera, padding = 1.5) {
//     const box = new THREE.Box3().setFromObject(object);
//     const size = new THREE.Vector3();
//     const center = new THREE.Vector3();
//     box.getSize(size);
//     box.getCenter(center);

//     const radius = 0.5 * Math.max(size.x, size.y, size.z);
//     const fov = THREE.MathUtils.degToRad(camera.fov);
//     const aspect = camera.aspect;
//     const horizFov = 2 * Math.atan(Math.tan(fov / 2) * aspect);

//     const distV = (radius * padding) / Math.sin(fov / 2);
//     const distH = (radius * padding) / Math.sin(horizFov / 2);
//     const dist = Math.max(distV, distH);

//     camera.position.set(center.x, center.y, center.z + dist);
//     camera.near = Math.max(0.001, dist / 100);
//     camera.far  = dist * 100;
//     camera.lookAt(center);
//     camera.updateProjectionMatrix();
//   }

//   // ====== Универсальные утилиты для N секций ======
//   function measureSections(sections) {
//     const start = sections[0].offsetTop;
//     const ends = [];
//     let cum = 0;
//     for (let i = 0; i < sections.length; i++) {
//       const h = sections[i].offsetHeight;
//       cum += h;
//       ends.push(cum);
//     }
//     const total = cum;
//     return { start, ends, total };
//   }

//   function globalProgress(sectionsMeta) {
//     const y = window.scrollY || window.pageYOffset;
//     const rel = y - sectionsMeta.start;
//     return clamp01(rel / sectionsMeta.total);
//   }

//   function segmentAtProgress(sectionsMeta) {
//     const y = window.scrollY || window.pageYOffset;
//     const rel = Math.max(0, y - sectionsMeta.start);
//     const { ends } = sectionsMeta;

//     let i = 0, prevEnd = 0;
//     for (; i < ends.length; i++) {
//       const segEnd = ends[i];
//       if (rel <= segEnd) {
//         const segLen = Math.max(1, segEnd - prevEnd);
//         const t = (rel - prevEnd) / segLen; // 0..1
//         return { i, t };
//       }
//       prevEnd = segEnd;
//     }
//     return { i: ends.length - 1, t: 1 };
//   }

//   function sampleKF(KF, sectionsMeta, easing = easeOut) {
//     if (KF.length <= 1) return { ...KF[0] };
//     const { i, t } = segmentAtProgress(sectionsMeta);
//     const i0 = Math.min(Math.max(0, i), KF.length - 2);
//     const i1 = i0 + 1;
//     const a = KF[i0];
//     const b = KF[i1];
//     const tt = easing(clamp01(t));

//     const out = {};
//     for (const k of Object.keys(a)) {
//       const av = a[k], bv = b[k];
//       out[k] = (typeof av === 'number' && typeof bv === 'number') ? lerp(av, bv, tt) : bv;
//     }
//     return out;
//   }

//   function buildRotYKeyframes(n, totalTurns = 2, posArr) {
//     const out = [];
//     for (let i = 0; i < n; i++) {
//       const t = n > 1 ? i / (n - 1) : 0;
//       const rotY = t * (Math.PI * 2 * totalTurns);
//       const x = posArr?.x?.[i] ?? 0;
//       const y = posArr?.y?.[i] ?? 0;
//       out.push({ rotY, x, y });
//     }
//     return out;
//   }

//   // ===================== THREE / CANVAS =====================
//   const canvas = document.getElementById('model');

//   const renderer = new THREE.WebGLRenderer({
//     canvas,
//     antialias: true,
//     alpha: true,
//     powerPreference: 'high-performance'
//   });
//   renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
//   renderer.shadowMap.enabled = true;

//   const scene = new THREE.Scene();
//   const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);

//   // ===================== СЕКЦИИ/КЕЙФРЕЙМЫ (сначала соберём секции!) =====================
//   const sections = Array.from(document.querySelectorAll('section'));

//   // Генерация ключей канваса под количество секций
//   const canvasKF = (() => {
//     const n = sections.length;
//     const arr = [];
//     for (let i = 0; i < n; i++) {
//       const t = n > 1 ? i / (n - 1) : 0;
//       const xVW = lerp(45, 15, Math.sin(Math.PI * t)) || (i === n - 1 ? 45 : 45);
//       arr.push({ xVW });
//     }
//     if (n >= 1) arr[0].xVW = 45;
//     if (n >= 2) arr[n - 1].xVW = 45;
//     return arr;
//   })();

//   // Ключи модели: вращение на totalTurns оборотов + лёгкие смещения
//   const totalTurns = 2; // 720°
//   const posArr = {
//     x: sections.map((_, i, a) => lerp(0.0, 0.2, i / Math.max(1, a.length - 1)) - 0.1),
//     y: sections.map((_, i, a) => (i === a.length - 1 ? -0.25 : 0)),
//   };
//   const modelKF = buildRotYKeyframes(sections.length, totalTurns, posArr);

//   // Пружины (инициализация из первых ключей)
//   const canvasX = { x: canvasKF[0]?.xVW ?? 45, v: 0 };
//   const rotY    = { x: modelKF[0]?.rotY ?? 0,  v: 0 };
//   const posX    = { x: modelKF[0]?.x   ?? 0,   v: 0 };
//   const posY    = { x: modelKF[0]?.y   ?? 0,   v: 0 };

//   // Измерения секций — ДОЛЖНЫ быть до первого вызова resizeRendererToCanvas
//   let sectionsMeta = measureSections(sections);

//   // Теперь можно объявлять и вызывать resize (он обращается к sections/sectionsMeta)
//   function resizeRendererToCanvas() {
//     const rect = canvas.getBoundingClientRect();
//     const w = Math.max(1, Math.round(rect.width));
//     const h = Math.max(1, Math.round(rect.height));
//     renderer.setSize(w, h, false);
//     camera.aspect = w / h;
//     camera.updateProjectionMatrix();
//     sectionsMeta = measureSections(sections);
//   }
//   resizeRendererToCanvas();
//   window.addEventListener('resize', resizeRendererToCanvas);

//   // Свет
//   scene.add(new THREE.AmbientLight(0xffffff, 0.65));
//   const dir = new THREE.DirectionalLight(0xffffff, 1.05);
//   dir.position.set(3, 5, 2);
//   dir.castShadow = true;
//   scene.add(dir);

//   // ===================== МОДЕЛЬ =====================
//   const draco = new THREE.DRACOLoader();
//   draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
//   const loader = new THREE.GLTFLoader();
//   loader.setDRACOLoader(draco);

//   let model, mixer, framed = false;

//   loader.load(
//     'model.glb',
//     (gltf) => {
//       model = gltf.scene;
//       model.traverse(o => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; }});
//       scene.add(model);

//       frameObject(model, camera, 1.5);

//       if (gltf.animations?.length) {
//         mixer = new THREE.AnimationMixer(model);
//         mixer.clipAction(gltf.animations[0]).play();
//       }

//       framed = true;
//     },
//     undefined,
//     (err) => console.error('GLB load error:', err)
//   );

//   // ===================== ЦИКЛ =====================
//   let tiltDeg = 0;
//   const clock = new THREE.Clock();
//   const box = new THREE.Box3();
//   const centerNow = new THREE.Vector3();

//   (function tick() {
//     const dt = Math.min(clock.getDelta(), 0.05);
//     if (mixer) mixer.update(dt);

//     // Сэмплинг ключей по активному сегменту
//     const targetCanvas = sampleKF(canvasKF, sectionsMeta, easeOut);
//     const targetModel  = sampleKF(modelKF,  sectionsMeta, easeOut);

//     // Пружины (Y помягче)
//     springUpdate(canvasX, targetCanvas.xVW, dt, 16);
//     springUpdate(rotY,    targetModel.rotY, dt, 10);
//     springUpdate(posX,    targetModel.x,    dt, 18);
//     springUpdate(posY,    targetModel.y,    dt, 18);

//     // Наклон канваса от скорости поперечного движения
//     const desiredTilt = Math.max(-4, Math.min(4, canvasX.v * 0.08));
//     tiltDeg += (desiredTilt - tiltDeg) * (1 - Math.pow(0.12, dt));

//     // Применяем к канвасу
//     canvas.style.transform = `translateX(${canvasX.x}vw) rotateZ(${tiltDeg}deg)`;

//     // Применяем к модели
//     if (model && framed) {
//       box.setFromObject(model);
//       box.getCenter(centerNow);
//       camera.lookAt(centerNow);

//       model.position.x = posX.x;
//       model.position.y = posY.x;
//       model.rotation.y = rotY.x;

//       // "Дыхание" затухает к концу всех секций
//       const pGlobal = globalProgress(sectionsMeta);
//       const overall = 1 - pGlobal;
//       model.rotation.x = Math.sin(performance.now() * 0.0015) * 0.03 * overall;
//     }

//     renderer.render(scene, camera);
//     requestAnimationFrame(tick);
//   })();
// });