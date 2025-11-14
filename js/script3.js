document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('model');

  // ---------- Renderer ----------
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance'
  });
  const DPR_CAP = 2;
  const setDPR = () =>
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, DPR_CAP));
  setDPR();
  renderer.shadowMap.enabled = true;

  // Цвет/тонмаппинг для PBR
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.physicallyCorrectLights = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  // ---------- Scene & Camera ----------
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  scene.add(camera);

  // ---------- Lights ----------
  scene.add(new THREE.AmbientLight(0xffffff, 0.65));
  const dir = new THREE.DirectionalLight(0xffffff, 1.05);
  dir.position.set(3, 5, 2);
  dir.castShadow = true;
  dir.shadow.mapSize.set(1024, 1024);
  scene.add(dir);

  // ---------- Helpers ----------
  function dirLightFollowTarget(target, sceneSize) {
    dir.position.copy(target.clone().add(new THREE.Vector3(3, 5, 2)));
    dir.target?.position?.copy?.(target) ?? scene.add((dir.target = new THREE.Object3D()));
    dir.target.position.copy(target);
    dir.shadow.camera.near = 0.1;
    dir.shadow.camera.far = sceneSize * 10;
    dir.shadow.camera.left = dir.shadow.camera.bottom = -sceneSize * 2;
    dir.shadow.camera.right = dir.shadow.camera.top = sceneSize * 2;
    dir.shadow.needsUpdate = true;
  }

  function getForwardWorld(object) {
    const q = new THREE.Quaternion();
    object.getWorldQuaternion(q);
    return new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
  }

  // Фрейминг по сфере + камера "передом" (-forward), без вращения
  function frameObjectFront(object, camera, padding = 1.25, elevRatio = 0.2) {
    const box = new THREE.Box3().setFromObject(object);
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);

    const center = sphere.center.clone();
    const radius = Math.max(sphere.radius, 1e-6);

    const fovY = THREE.MathUtils.degToRad(camera.fov);
    const fovX = 2 * Math.atan(Math.tan(fovY * 0.5) * (camera.aspect || 1));

    const distY = (radius * padding) / Math.sin(fovY * 0.5);
    const distX = (radius * padding) / Math.sin(fovX * 0.5);
    const distance = Math.max(distX, distY, 0.01);

    const forward = getForwardWorld(object);
    const elev = new THREE.Vector3(0, distance * elevRatio, 0);
    const camPos = center.clone().sub(forward.clone().multiplyScalar(distance)).add(elev);

    camera.position.copy(camPos);
    camera.near = Math.max(0.01, distance - radius * 3);
    camera.far  = distance + radius * 6;
    camera.updateProjectionMatrix();
    camera.lookAt(center);

    dirLightFollowTarget(center, radius * 2);
  }

  function resizeRendererToCanvas() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (model) frameObjectFront(model, camera, 1.25);
  }

  const ro = new ResizeObserver(() => {
    setDPR();
    resizeRendererToCanvas();
  });
  ro.observe(canvas);

  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      setDPR();
      resizeRendererToCanvas();
    }, 50);
  }, { passive: true });

  // ---------- Optional environment (HDR) ----------
  // Если подключили RGBELoader.js в HTML — подхватим его, иначе тихо пропустим.
  if (THREE.RGBELoader) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    // замените путь на свой HDRI при желании:
    const HDR_PATH = null; // например: '/hdr/studio_small_09_2k.hdr'
    if (HDR_PATH) {
      new THREE.RGBELoader()
        .setDataType(THREE.UnsignedByteType)
        .load(HDR_PATH, (hdr) => {
          scene.environment = pmrem.fromEquirectangular(hdr).texture;
          hdr.dispose?.();
        });
    }
  }

  // ---------- Loaders ----------
  const draco = new THREE.DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');

  const loader = new THREE.GLTFLoader();
  loader.setDRACOLoader(draco);

  let model = null;
  let mixer = null;

  loader.setPath('/models/');

  if (typeof MeshoptDecoder !== 'undefined') loader.setMeshoptDecoder(MeshoptDecoder);
  if (THREE.KTX2Loader) {
    const ktx2 = new THREE.KTX2Loader()
      .setTranscoderPath('https://unpkg.com/three@0.128.0/examples/js/libs/basis/')
      .detectSupport(renderer);
    loader.setKTX2Loader(ktx2);
  }

  // ---------- Load model ----------

  loader.load(
    'uploads_files_6420976_I+phone+17+pro.gltf',
    async (gltf) => {
      model = gltf.scene;
      model.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
          // sRGB для colorMap в r128 GLTFLoader обычно выставляет сам,
          // но на всякий случай для кастомных материалов:
          if (o.material && o.material.map && o.material.map.encoding === undefined) {
            o.material.map.encoding = THREE.sRGBEncoding;
          }
        }
      });
      scene.add(model);

      // Если есть анимации — запустим первую (без автоворота)
      if (gltf.animations && gltf.animations.length) {
        mixer = new THREE.AnimationMixer(model);
        mixer.clipAction(gltf.animations[0]).play();
      }

      // Если в glTF есть варианты материалов (KHR_materials_variants),
      // выберем первый вариант, чтобы точно увидеть “правильный” вид.
      try {
        const parser = gltf.parser;
        const ext = parser.getExtension && parser.getExtension('KHR_materials_variants');
        if (ext && ext.selectVariant) {
          const variantNames = ext.variants?.map(v => v.name) || [];
          if (variantNames.length) {
            // возьмём первый (или замените на нужное имя)
            const preferred = variantNames[0];
            ext.selectVariant(model, parser.associations, preferred);
            // материалы могли поменяться — убедимся, что текстуры sRGB
            model.traverse((o) => {
              if (o.isMesh && o.material && o.material.map && o.material.map.encoding === undefined) {
                o.material.map.encoding = THREE.sRGBEncoding;
              }
            });
          }
        }
      } catch (e) {
        console.warn('Variants check failed:', e);
      }

      // Важно: сначала размер канваса, затем фрейминг "передом"
      resizeRendererToCanvas();
      frameObjectFront(model, camera, 1.25);
    },
    undefined,
    (err) => console.error('GLTF load error:', err)
  );

  // ---------- Render loop ----------
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = clock.getDelta();
    if (mixer) mixer.update(dt);
    renderer.render(scene, camera);
  });
});