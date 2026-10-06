/* =============================================================================
 * scene.js — The 3D world: renderer, camera, river, banks, boat, markers,
 * distance rulers, water particles and camera views.
 *
 * This module only *draws* things. It never computes physics; it receives
 * positions (in metres) and velocities from the app and maps them into the
 * scene with RV.Geo.toScene().
 * ============================================================================= */
window.RV = window.RV || {};

(function (RV) {
  'use strict';

  const { Geo, Labels } = RV;
  const W_SCENE = Geo.SCENE_RIVER_WIDTH;
  const BANK = Geo.BANK_HEIGHT;
  const RIVER_LENGTH = 6000;
  const FLOW_PERIOD = 400; // the water texture repeats every 400 scene units along x

  /** Deterministic pseudo-random numbers so the scenery looks the same every load. */
  function seededRandom(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** "Nice" ruler spacing: 1, 2, 2.5 or 5 × 10ⁿ. */
  function niceStep(rough) {
    const exponent = Math.floor(Math.log10(rough));
    const base = Math.pow(10, exponent);
    const fraction = rough / base;
    const nice = fraction < 1.5 ? 1 : fraction < 2.25 ? 2 : fraction < 3.5 ? 2.5 : fraction < 7.5 ? 5 : 10;
    return nice * base;
  }

  const formatMetres = (value) => {
    const rounded = Math.abs(value) < 1e-9 ? 0 : value;
    return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + ' m';
  };

  // ---------------------------------------------------------------------------
  // Shaders
  // ---------------------------------------------------------------------------

  const WATER_VERTEX = /* glsl */ `
    varying vec3 vWorld;
    varying float vViewDepth;
    void main() {
      vec4 world = modelMatrix * vec4(position, 1.0);
      vWorld = world.xyz;
      vec4 view = viewMatrix * world;
      vViewDepth = -view.z;
      gl_Position = projectionMatrix * view;
    }
  `;

  /*
   * The water pattern is sampled at (x − flowOffset, z). The app advances
   * flowOffset by u · Δt (scaled to scene units), so the pattern drifts
   * downstream at exactly the river speed. At u = 0 the water is still.
   */
  const WATER_FRAGMENT = /* glsl */ `
    uniform float uFlow;
    uniform float uRiverWidth;
    uniform vec3 uDeep;
    uniform vec3 uShallow;
    uniform vec3 uFoam;
    uniform vec3 uFogColor;
    uniform float uFogNear;
    uniform float uFogFar;
    varying vec3 vWorld;
    varying float vViewDepth;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    // Value noise that tiles every 'period' cells along x (so the flow offset can wrap).
    float tiledNoise(vec2 p, float period) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      float x0 = mod(i.x, period);
      float x1 = mod(i.x + 1.0, period);
      float a = hash(vec2(x0, i.y));
      float b = hash(vec2(x1, i.y));
      float c = hash(vec2(x0, i.y + 1.0));
      float d = hash(vec2(x1, i.y + 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }

    void main() {
      float across = clamp(-vWorld.z / uRiverWidth, 0.0, 1.0); // 0 near bank → 1 far bank
      float depth = sin(across * 3.14159);
      vec3 color = mix(uShallow, uDeep, depth);

      float x = mod(vWorld.x - uFlow, ${FLOW_PERIOD.toFixed(1)});
      // Streaks stretched along the flow direction (low frequency in x, high in z)
      float n1 = tiledNoise(vec2(x * (32.0 / ${FLOW_PERIOD.toFixed(1)}), vWorld.z * 0.9), 32.0);
      float n2 = tiledNoise(vec2(x * (96.0 / ${FLOW_PERIOD.toFixed(1)}), vWorld.z * 2.6), 96.0);
      float streak = smoothstep(0.6, 0.95, n1 * 0.6 + n2 * 0.4);
      float ripple = tiledNoise(vec2(x * (160.0 / ${FLOW_PERIOD.toFixed(1)}), vWorld.z * 1.6), 160.0);
      color = mix(color, uFoam, streak * 0.28);
      color *= 0.93 + ripple * 0.12;

      // Foam along the banks
      float edge = 1.0 - smoothstep(0.0, 0.035, min(across, 1.0 - across));
      color = mix(color, uFoam, edge * 0.45);

      float fog = smoothstep(uFogNear, uFogFar, vViewDepth);
      gl_FragColor = vec4(mix(color, uFogColor, fog), 1.0);
    }
  `;

  // ---------------------------------------------------------------------------
  // RiverScene
  // ---------------------------------------------------------------------------

  class RiverScene {
    constructor(container) {
      this.container = container;
      this.metresToScene = W_SCENE / 100;
      this.flowOffset = 0;
      this.displayTime = 0;
      this.followBoat = false;
      this.cameraTween = null;
      this.raycaster = new THREE.Raycaster();
      this.waterPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

      this.initRenderer();
      this.initSceneAndCamera();
      this.buildSky();
      this.buildRiverAndBanks();
      this.buildTrees();
      this.buildParticles();
      this.boat = this.buildBoat();
      this.buildMarkers();
      this.buildAxesGizmo();
      this.rulerGroup = new THREE.Group();
      this.gridGroup = new THREE.Group();
      this.scene.add(this.rulerGroup, this.gridGroup);

      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
      this.resize();
    }

    // ----- setup -------------------------------------------------------------

    initRenderer() {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.domElement.className = 'webgl-canvas';
      this.container.appendChild(this.renderer.domElement);

      this.labelRenderer = new THREE.CSS2DRenderer();
      this.labelRenderer.domElement.className = 'label-layer';
      this.container.appendChild(this.labelRenderer.domElement);
    }

    initSceneAndCamera() {
      this.scene = new THREE.Scene();
      this.fogColor = new THREE.Color(0xc9dbea);
      this.scene.fog = new THREE.Fog(this.fogColor, 320, 1700);
      this.scene.background = this.fogColor;

      this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 8000);
      this.camera.position.set(-6, 34, 48);

      this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
      this.controls.screenSpacePanning = false; // pan along the ground plane
      this.controls.minDistance = 6;
      this.controls.maxDistance = 1400;
      this.controls.maxPolarAngle = Math.PI * 0.48;
      this.controls.target.set(12, 0, -20);
      this.controls.update();

      const hemisphere = new THREE.HemisphereLight(0xdcebff, 0x47603a, 0.72);
      const sun = new THREE.DirectionalLight(0xffffff, 0.7);
      sun.position.set(80, 140, 60);
      this.scene.add(hemisphere, sun, new THREE.AmbientLight(0xffffff, 0.12));
    }

    buildSky() {
      const material = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          topColor: { value: new THREE.Color(0x5b8ed1) },
          horizonColor: { value: this.fogColor.clone() },
        },
        vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform vec3 topColor; uniform vec3 horizonColor; varying vec3 vDir;
          void main(){ float h = max(vDir.y, 0.0); gl_FragColor = vec4(mix(horizonColor, topColor, pow(h, 0.55)), 1.0); }`,
      });
      this.sky = new THREE.Mesh(new THREE.SphereGeometry(4000, 32, 16), material);
      this.scene.add(this.sky);
    }

    buildRiverAndBanks() {
      // Water surface: y = 0, from the near bank (z = 0) to the far bank (z = −W).
      this.waterMaterial = new THREE.ShaderMaterial({
        uniforms: {
          uFlow: { value: 0 },
          uRiverWidth: { value: W_SCENE },
          uDeep: { value: new THREE.Color(0x0f4560) },
          uShallow: { value: new THREE.Color(0x2a7d96) },
          uFoam: { value: new THREE.Color(0xe8f6ff) },
          uFogColor: { value: this.fogColor.clone() },
          uFogNear: { value: this.scene.fog.near },
          uFogFar: { value: this.scene.fog.far },
        },
        vertexShader: WATER_VERTEX,
        fragmentShader: WATER_FRAGMENT,
      });
      const water = new THREE.Mesh(new THREE.PlaneGeometry(RIVER_LENGTH, W_SCENE + 4, 1, 1).rotateX(-Math.PI / 2), this.waterMaterial);
      water.position.set(0, 0, -W_SCENE / 2);
      this.water = water;
      this.scene.add(water);

      // Banks: boxes whose top surface is BANK units above the water.
      const grass = new THREE.MeshLambertMaterial({ color: 0x5f8a4c });
      const earth = new THREE.MeshLambertMaterial({ color: 0x7b6449 });
      const bankMaterials = [earth, earth, grass, earth, earth, earth];
      const depth = 700;
      const nearBank = new THREE.Mesh(new THREE.BoxGeometry(RIVER_LENGTH, 6, depth), bankMaterials);
      nearBank.position.set(0, BANK - 3, depth / 2);
      const farBank = new THREE.Mesh(new THREE.BoxGeometry(RIVER_LENGTH, 6, depth), bankMaterials);
      farBank.position.set(0, BANK - 3, -W_SCENE - depth / 2);
      this.scene.add(nearBank, farBank);

      // Sandy strips along both edges (where the rulers sit)
      const sand = new THREE.MeshLambertMaterial({ color: 0xcdb78a });
      const stripGeometry = new THREE.PlaneGeometry(RIVER_LENGTH, 3.2).rotateX(-Math.PI / 2);
      const nearStrip = new THREE.Mesh(stripGeometry, sand);
      nearStrip.position.set(0, BANK + 0.01, 1.6);
      const farStrip = new THREE.Mesh(stripGeometry, sand);
      farStrip.position.set(0, BANK + 0.01, -W_SCENE - 1.6);
      this.scene.add(nearStrip, farStrip);

      // Bank and flow direction labels
      const flowLabelA = Labels.create('dir-label', 'River current flows → <b>+x</b> (downstream)');
      flowLabelA.position.set(-34, 0.4, -W_SCENE * 0.5);
      const nearLabel = Labels.create('bank-label', 'Start bank &nbsp;(y = 0)');
      nearLabel.position.set(-44, BANK + 0.3, 6);
      const farLabel = Labels.create('bank-label', 'Opposite bank &nbsp;(y = W)');
      farLabel.position.set(-44, BANK + 0.3, -W_SCENE - 6);
      this.directionLabels = new THREE.Group();
      this.directionLabels.add(flowLabelA, nearLabel, farLabel);
      this.scene.add(this.directionLabels);
    }

    buildTrees() {
      const random = seededRandom(7);
      const count = 260;
      const foliage = new THREE.InstancedMesh(
        new THREE.ConeGeometry(1.7, 4.6, 7),
        new THREE.MeshLambertMaterial({ color: 0x3f6e3a }),
        count
      );
      const trunks = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.22, 0.3, 1.4, 6),
        new THREE.MeshLambertMaterial({ color: 0x6a4a32 }),
        count
      );
      const dummy = new THREE.Object3D();
      for (let i = 0; i < count; i++) {
        const nearSide = i % 2 === 0;
        const x = (random() - 0.5) * 1000;
        const z = nearSide ? 16 + random() * 170 : -W_SCENE - 18 - random() * 170;
        const s = 0.7 + random() * 0.9;
        dummy.position.set(x, BANK + 0.7 * s, z);
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        trunks.setMatrixAt(i, dummy.matrix);
        dummy.position.y = BANK + (1.4 + 2.3) * s;
        dummy.updateMatrix();
        foliage.setMatrixAt(i, dummy.matrix);
      }
      this.scene.add(foliage, trunks);
    }

    /**
     * Floating markers that are carried by the water. They move with exactly
     * the river velocity, so a student can compare the boat's drift with them.
     */
    buildParticles() {
      const random = seededRandom(42);
      this.particleRange = 170; // particles live within ±range of the camera target
      this.streakCount = 230;
      this.floatCount = 28;

      this.streaks = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 0.03, 0.1),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false }),
        this.streakCount
      );
      this.floats = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.24, 0.24, 0.16, 12),
        new THREE.MeshLambertMaterial({ color: 0xffd27a }),
        this.floatCount
      );
      this.streaks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.floats.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.streaks.frustumCulled = false;
      this.floats.frustumCulled = false;

      const make = (n) =>
        Array.from({ length: n }, () => ({
          x: (random() - 0.5) * 2 * this.particleRange,
          z: -1.2 - random() * (W_SCENE - 2.4),
          phase: random() * Math.PI * 2,
        }));
      this.streakData = make(this.streakCount);
      this.floatData = make(this.floatCount);
      this.particleGroup = new THREE.Group();
      this.particleGroup.add(this.streaks, this.floats);
      this.scene.add(this.particleGroup);
      this.dummy = new THREE.Object3D();
    }

    buildBoat() {
      const boat = new THREE.Group();

      // Hull outline seen from above: bow (nose) at +x.
      const outline = new THREE.Shape();
      outline.moveTo(-1.35, -0.56);
      outline.lineTo(0.35, -0.6);
      outline.quadraticCurveTo(1.25, -0.52, 1.65, 0);
      outline.quadraticCurveTo(1.25, 0.52, 0.35, 0.6);
      outline.lineTo(-1.35, 0.56);
      outline.closePath();

      const extrude = (depth, bevel) =>
        new THREE.ExtrudeGeometry(outline, {
          depth,
          bevelEnabled: bevel > 0,
          bevelThickness: bevel,
          bevelSize: bevel,
          bevelSegments: 2,
          curveSegments: 18,
        }).rotateX(-Math.PI / 2); // extrusion direction becomes "up"

      const hull = new THREE.Mesh(extrude(0.5, 0.08), new THREE.MeshStandardMaterial({ color: 0xf3f6f9, roughness: 0.5 }));
      hull.position.y = -0.2;
      const stripe = new THREE.Mesh(extrude(0.12, 0.1), new THREE.MeshStandardMaterial({ color: Geo.COLORS.boatWater, roughness: 0.5 }));
      stripe.position.y = 0.05;
      stripe.scale.set(1.01, 1, 1.03);

      const deck = new THREE.Mesh(
        new THREE.ShapeGeometry(outline).rotateX(-Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: 0x9fb3c4, roughness: 0.8 })
      );
      deck.position.y = 0.39;
      deck.scale.set(0.9, 1, 0.82);

      const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.5, 0.82), new THREE.MeshStandardMaterial({ color: 0xe1e9f1, roughness: 0.6 }));
      cabin.position.set(-0.4, 0.66, 0);
      const glass = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.34, 0.74), new THREE.MeshStandardMaterial({ color: 0x1d2b38, roughness: 0.2, metalness: 0.3 }));
      glass.position.set(0.1, 0.7, 0);
      glass.rotation.z = -0.4;
      const motor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.55, 0.3), new THREE.MeshStandardMaterial({ color: 0x2b3440 }));
      motor.position.set(-1.5, 0.25, 0);

      // A small arrow on the bow makes "where the nose points" unmistakable.
      const noseArrow = new THREE.Mesh(
        new THREE.ConeGeometry(0.17, 0.55, 14).rotateZ(-Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: Geo.COLORS.boatWater, emissive: Geo.COLORS.boatWater, emissiveIntensity: 0.4 })
      );
      noseArrow.position.set(0.95, 0.47, 0);

      const hullGroup = new THREE.Group();
      hullGroup.add(hull, stripe, deck, cabin, glass, motor, noseArrow);
      hullGroup.scale.setScalar(1.1);
      boat.add(hullGroup);
      boat.userData.hull = hullGroup;

      this.scene.add(boat);
      return boat;
    }

    makeFlag(color, poleHeight = 3.2) {
      const group = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, poleHeight, 8), new THREE.MeshLambertMaterial({ color: 0xe9eef3 }));
      pole.position.y = poleHeight / 2;
      const flag = new THREE.Mesh(
        new THREE.PlaneGeometry(1.4, 0.8),
        new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, emissive: color, emissiveIntensity: 0.25 })
      );
      flag.position.set(0.72, poleHeight - 0.45, 0);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 0.18, 14), new THREE.MeshLambertMaterial({ color: 0x55606b }));
      base.position.y = 0.09;
      group.add(pole, flag, base);
      group.userData.flag = flag;
      return group;
    }

    buildMarkers() {
      // Start point O = (0, 0)
      this.startMarker = this.makeFlag(0xffffff);
      this.startMarker.position.set(-1.4, BANK, 2.2);
      const startLabel = Labels.create('marker-label start', 'Start &nbsp;O = (0, 0)');
      startLabel.position.set(0, 4.2, 0);
      this.startMarker.add(startLabel);

      // Point directly opposite the start (x = 0, y = W)
      this.oppositeMarker = this.makeFlag(0xff5a4f);
      this.oppositeMarker.position.set(0, BANK, -W_SCENE - 1.4);
      this.oppositeLabel = Labels.create('marker-label opposite', 'Directly opposite &nbsp;(x = 0)');
      this.oppositeLabel.position.set(0, 4.2, 0);
      this.oppositeMarker.add(this.oppositeLabel);

      // Predicted landing point (from r = r₀ + V t)
      this.landingMarker = new THREE.Group();
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.9, 1.35, 40).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: Geo.COLORS.resultant, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false })
      );
      ring.position.y = BANK + 0.04; // sits on the bank edge, above the water
      const pin = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.08, 3.4, 8),
        new THREE.MeshBasicMaterial({ color: Geo.COLORS.resultant })
      );
      pin.position.y = 1.7;
      const pinHead = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12), new THREE.MeshBasicMaterial({ color: Geo.COLORS.resultant }));
      pinHead.position.y = 3.5;
      this.landingRing = ring;
      this.landingMarker.add(ring, pin, pinHead);
      this.landingLabel = Labels.create('marker-label landing', '');
      this.landingLabel.position.set(0, 5, 0);
      this.landingMarker.add(this.landingLabel);
      this.scene.add(this.startMarker, this.oppositeMarker, this.landingMarker);

      // Student prediction (placed by clicking) and its hover ghost
      this.predictionMarker = this.makeFlag(Geo.COLORS.prediction, 3.8);
      this.predictionLabel = Labels.create('marker-label prediction', '');
      this.predictionLabel.position.set(0, 5, 0);
      this.predictionMarker.add(this.predictionLabel);
      this.predictionMarker.visible = false;

      this.predictionGhost = this.makeFlag(Geo.COLORS.prediction, 3.8);
      this.predictionGhost.traverse((o) => {
        if (o.material) {
          o.material = o.material.clone();
          o.material.transparent = true;
          o.material.opacity = 0.5;
        }
      });
      this.ghostLabel = Labels.create('marker-label prediction ghost', '');
      this.ghostLabel.position.set(0, 5, 0);
      this.predictionGhost.add(this.ghostLabel);
      this.predictionGhost.visible = false;
      this.scene.add(this.predictionMarker, this.predictionGhost);

      // A stick-figure observer standing on the bank (learning mode, step 3)
      this.observer = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 1.8, 12), new THREE.MeshLambertMaterial({ color: 0x3f6fd8 }));
      body.position.y = 0.9;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.38, 16, 12), new THREE.MeshLambertMaterial({ color: 0xf1c7a1 }));
      head.position.y = 2.15;
      this.observer.add(body, head);
      this.observer.position.set(-9, BANK, 5.5);
      const observerLabel = Labels.create('marker-label observer', 'Observer on the bank<br><small>measures velocity relative to the <b>ground</b></small>');
      observerLabel.position.set(0, 3.3, 0);
      this.observer.add(observerLabel);
      this.observer.visible = false;
      this.scene.add(this.observer);
    }

    /** Coordinate-system gizmo on the start bank (+x downstream, +y across). */
    buildAxesGizmo() {
      this.axesGroup = new THREE.Group();
      const origin = new THREE.Vector3(-30, BANK + 0.25, 8);
      const makeAxis = (dir, text, cls) => {
        const arrow = new RV.VectorArrow({ color: Geo.COLORS.axis, shaftRadius: 0.12, headRadius: 0.38, headLength: 1.0, labelClass: cls, labelPosition: 1.12, labelOffset: new THREE.Vector3(0, 0.4, 0) });
        arrow.set(origin, dir);
        arrow.setLabel(text);
        this.axesGroup.add(arrow.group);
        return arrow;
      };
      makeAxis(new THREE.Vector3(8, 0, 0), '<b>+x</b> downstream', 'axis');
      makeAxis(new THREE.Vector3(0, 0, -7.2), '<b>+y</b> across', 'axis');
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 10), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      dot.position.copy(origin);
      const title = Labels.create('axis-title', 'Coordinate system');
      title.position.copy(origin).add(new THREE.Vector3(0, 0.6, 1.6));
      this.axesGroup.add(dot, title);
      this.scene.add(this.axesGroup);
    }

    // ----- width-dependent geometry -----------------------------------------

    /**
     * Rebuild rulers, the width dimension and the grid when the river width
     * changes. The river is always W_SCENE units wide; metres are rescaled.
     */
    setRiverWidth(riverWidthMetres) {
      this.riverWidth = riverWidthMetres;
      this.metresToScene = W_SCENE / riverWidthMetres;
      const s = this.metresToScene;

      // Clear previous rulers/labels
      for (const group of [this.rulerGroup, this.gridGroup]) {
        group.traverse((o) => {
          if (o.isCSS2DObject) Labels.all.delete(o);
          // Arrow geometries are shared between all arrows, so only dispose our own.
          if (o.isInstancedMesh || o.isLineSegments) o.geometry.dispose();
        });
        group.clear();
      }

      const spacing = niceStep(riverWidthMetres / 4);
      const spacingScene = spacing * s;
      this.rulerSpacing = spacing;
      const majorCount = Math.min(90, Math.ceil(520 / spacingScene));
      const minorPerMajor = 5;

      // Ticks along both banks (instanced boxes)
      const tickMaterial = new THREE.MeshBasicMaterial({ color: 0x24303b });
      const majorTicks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, 0.05, 1.5), tickMaterial, (2 * majorCount + 1) * 2);
      const minorTicks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 0.04, 0.7), tickMaterial, (2 * majorCount) * (minorPerMajor - 1) * 2);
      const dummy = new THREE.Object3D();
      let majorIndex = 0;
      let minorIndex = 0;
      for (let i = -majorCount; i <= majorCount; i++) {
        const x = i * spacingScene;
        for (const z of [0.85, -W_SCENE - 0.85]) {
          dummy.position.set(x, BANK + 0.04, z);
          dummy.updateMatrix();
          majorTicks.setMatrixAt(majorIndex++, dummy.matrix);
          if (i < majorCount) {
            for (let k = 1; k < minorPerMajor; k++) {
              dummy.position.set(x + (k * spacingScene) / minorPerMajor, BANK + 0.03, z + (z > 0 ? -0.35 : 0.35));
              dummy.updateMatrix();
              minorTicks.setMatrixAt(minorIndex++, dummy.matrix);
            }
          }
        }
        // Distance labels: far bank (to read landing points) and near bank
        const labelRange = Math.min(26, majorCount);
        if (Math.abs(i) <= labelRange) {
          const farLabel = Labels.create('ruler-label' + (i === 0 ? ' zero' : ''), formatMetres(i * spacing));
          farLabel.position.set(x, BANK + 0.1, -W_SCENE - 2.6);
          this.rulerGroup.add(farLabel);
          if (Math.abs(i) <= 12) {
            const nearLabel = Labels.create('ruler-label' + (i === 0 ? ' zero' : ''), formatMetres(i * spacing));
            nearLabel.position.set(x, BANK + 0.1, 2.9);
            this.rulerGroup.add(nearLabel);
          }
        }
      }
      majorTicks.count = majorIndex;
      minorTicks.count = minorIndex;
      this.rulerGroup.add(majorTicks, minorTicks);

      // River-width dimension line (upstream of the start, on the water)
      const dimX = -16;
      const dimensionColor = 0xf4f7fb;
      const mid = new THREE.Vector3(dimX, 0.35, -W_SCENE / 2);
      const up = new RV.VectorArrow({ color: dimensionColor, shaftRadius: 0.07, headRadius: 0.32, headLength: 0.9 });
      const down = new RV.VectorArrow({ color: dimensionColor, shaftRadius: 0.07, headRadius: 0.32, headLength: 0.9 });
      up.set(mid, new THREE.Vector3(0, 0, -W_SCENE / 2 + 0.1));
      down.set(mid, new THREE.Vector3(0, 0, W_SCENE / 2 - 0.1));
      this.rulerGroup.add(up.group, down.group);
      const widthLabel = Labels.create('width-label', `W = ${formatMetres(riverWidthMetres)}`);
      widthLabel.position.copy(mid).add(new THREE.Vector3(-0.2, 0.6, 0));
      this.rulerGroup.add(widthLabel);
      for (const fraction of [0.25, 0.5, 0.75]) {
        const tick = Labels.create('across-label', `y = ${formatMetres(riverWidthMetres * fraction)}`);
        tick.position.set(dimX - 3.6, 0.35, -W_SCENE * fraction);
        if (fraction !== 0.5) this.rulerGroup.add(tick);
      }

      // Grid on the water surface (one cell = one ruler spacing)
      const gridPoints = [];
      const gridHalf = Math.min(majorCount, 40) * spacingScene;
      for (let i = -Math.min(majorCount, 40); i <= Math.min(majorCount, 40); i++) {
        const x = i * spacingScene;
        gridPoints.push(x, 0.05, 0, x, 0.05, -W_SCENE);
      }
      const rows = Math.round(riverWidthMetres / spacing);
      for (let k = 0; k <= rows; k++) {
        const z = -Math.min(W_SCENE, k * spacingScene);
        gridPoints.push(-gridHalf, 0.05, z, gridHalf, 0.05, z);
      }
      const gridGeometry = new THREE.BufferGeometry();
      gridGeometry.setAttribute('position', new THREE.Float32BufferAttribute(gridPoints, 3));
      const grid = new THREE.LineSegments(gridGeometry, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false }));
      grid.renderOrder = 1;
      this.gridGroup.add(grid);
    }

    // ----- per-frame updates -------------------------------------------------

    /**
     * Advance the water animation. `dt` is in simulated seconds, so the water
     * moves at exactly u (scaled) — the same scale used for the boat.
     */
    updateWater(dt, riverSpeed, displayDt) {
      const speedScene = riverSpeed * this.metresToScene;
      const dx = speedScene * dt;
      this.flowOffset = (this.flowOffset + dx) % FLOW_PERIOD;
      this.waterMaterial.uniforms.uFlow.value = this.flowOffset;
      this.displayTime += displayDt;

      if (!this.particleGroup.visible) return;
      const centre = this.controls.target.x;
      const range = this.particleRange;
      const streakLength = 0.5 + riverSpeed * 0.22; // longer streaks = faster flow
      const t = this.displayTime;
      const dummy = this.dummy;

      const advance = (p) => {
        p.x += dx;
        let rel = p.x - centre;
        if (rel > range) p.x -= 2 * range * Math.ceil((rel - range) / (2 * range));
        rel = p.x - centre;
        if (rel < -range) p.x += 2 * range * Math.ceil((-range - rel) / (2 * range));
      };

      this.streakData.forEach((p, i) => {
        advance(p);
        dummy.position.set(p.x, 0.06, p.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(riverSpeed > 0.01 ? streakLength : 0.25, 1, 1);
        dummy.updateMatrix();
        this.streaks.setMatrixAt(i, dummy.matrix);
      });
      this.floatData.forEach((p, i) => {
        advance(p);
        dummy.position.set(p.x, 0.04 + Math.sin(t * 2 + p.phase) * 0.04, p.z);
        dummy.rotation.set(Math.sin(t * 1.3 + p.phase) * 0.12, 0, Math.cos(t * 1.1 + p.phase) * 0.12);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        this.floats.setMatrixAt(i, dummy.matrix);
      });
      this.streaks.instanceMatrix.needsUpdate = true;
      this.floats.instanceMatrix.needsUpdate = true;
    }

    /**
     * Place the boat. Position follows the ground-frame motion; the nose
     * points along θ, the direction of the velocity relative to the WATER.
     */
    updateBoatPosition(positionMetres, headingDeg) {
      Geo.toScene(positionMetres.x, positionMetres.y, 0, this.metresToScene, this.boat.position);
      this.boat.rotation.y = RV.Physics.toRadians(headingDeg);
      const hull = this.boat.userData.hull;
      const t = this.displayTime;
      hull.position.y = Math.sin(t * 2.4) * 0.04;
      hull.rotation.x = Math.sin(t * 1.9) * 0.025;
      hull.rotation.z = Math.cos(t * 1.6) * 0.02;
    }

    setLandingMarker(landing) {
      if (!landing) {
        this.landingMarker.visible = false;
        return;
      }
      this.landingMarker.visible = true;
      Geo.toScene(landing.x, landing.y, 0, this.metresToScene, this.landingMarker.position);
      this.landingRing.scale.setScalar(1 + Math.sin(this.displayTime * 3) * 0.08);
    }

    // ----- camera ------------------------------------------------------------

    /** Horizontal extent (scene units) that should be in view. */
    computeFrame(xValuesMetres) {
      const xs = xValuesMetres.filter(Number.isFinite).map((x) => x * this.metresToScene);
      xs.push(0);
      let minX = Math.min(...xs) - 8;
      let maxX = Math.max(...xs) + 8;
      const cap = 600;
      minX = Math.max(minX, -cap);
      maxX = Math.min(maxX, cap);
      return { minX, maxX, centerX: (minX + maxX) / 2, spanX: Math.max(maxX - minX, 30) };
    }

    view3D(frame, immediate = false) {
      const span = Math.max(frame.spanX, W_SCENE * 1.1);
      const aspectBoost = THREE.MathUtils.clamp(1.6 / (this.camera.aspect || 1.6), 1, 1.8);
      const distance = THREE.MathUtils.clamp((span * 0.82 + 12) * aspectBoost, 50, 1100);
      const target = new THREE.Vector3(frame.centerX, 0, -W_SCENE * 0.42);
      const direction = new THREE.Vector3(-0.1, 0.6, 0.8).normalize();
      const position = target.clone().addScaledVector(direction, distance);
      this.moveCamera(position, target, immediate ? 0 : 1.0);
    }

    viewTop(frame, immediate = false) {
      const aspect = this.camera.aspect || 1.5;
      const spanZ = W_SCENE + 16;
      const spanX = frame.spanX + 12;
      const fov = THREE.MathUtils.degToRad(this.camera.fov);
      const height = THREE.MathUtils.clamp(Math.max(spanZ, spanX / aspect) / (2 * Math.tan(fov / 2)) * 1.08, 30, 1300);
      const target = new THREE.Vector3(frame.centerX, 0, -W_SCENE / 2);
      // A tiny z offset keeps OrbitControls stable and puts the far bank at the top of the screen.
      const position = new THREE.Vector3(frame.centerX, height, -W_SCENE / 2 + 0.01);
      this.moveCamera(position, target, immediate ? 0 : 1.0);
    }

    /** Top view centred on a point (used by the vector-addition demo). */
    viewTopAround(centerScene, size) {
      const fov = THREE.MathUtils.degToRad(this.camera.fov);
      const aspect = this.camera.aspect || 1.5;
      const height = THREE.MathUtils.clamp(Math.max(size, size / aspect) / (2 * Math.tan(fov / 2)) * 1.25, 25, 600);
      const target = new THREE.Vector3(centerScene.x, 0, centerScene.z);
      this.moveCamera(new THREE.Vector3(target.x, height, target.z + 0.01), target, 1.2);
    }

    moveCamera(position, target, duration) {
      if (duration <= 0) {
        this.camera.position.copy(position);
        this.controls.target.copy(target);
        this.controls.update();
        this.cameraTween = null;
        return;
      }
      this.cameraTween = {
        fromPosition: this.camera.position.clone(),
        fromTarget: this.controls.target.clone(),
        toPosition: position,
        toTarget: target,
        elapsed: 0,
        duration,
      };
    }

    updateCamera(realDt, boatScenePosition) {
      if (this.cameraTween) {
        const tween = this.cameraTween;
        tween.elapsed += realDt;
        const k = Math.min(1, tween.elapsed / tween.duration);
        const eased = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        this.camera.position.lerpVectors(tween.fromPosition, tween.toPosition, eased);
        this.controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
        if (k >= 1) this.cameraTween = null;
      } else if (this.followBoat && boatScenePosition) {
        // Glide the view sideways so the boat stays centred horizontally.
        const shift = (boatScenePosition.x - this.controls.target.x) * Math.min(1, realDt * 3);
        this.camera.position.x += shift;
        this.controls.target.x += shift;
      }
      this.controls.update();
    }

    /** Convert a pointer position to physics coordinates on the water plane. */
    pickWaterPoint(clientX, clientY) {
      const rect = this.renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      this.raycaster.setFromCamera(ndc, this.camera);
      const hit = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(this.waterPlane, hit)) return null;
      return { x: hit.x / this.metresToScene, y: -hit.z / this.metresToScene };
    }

    // ----- misc ----------------------------------------------------------------

    resize() {
      const width = Math.max(1, this.container.clientWidth);
      const height = Math.max(1, this.container.clientHeight);
      this.renderer.setSize(width, height);
      this.labelRenderer.setSize(width, height);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }

    render() {
      Labels.sync();
      this.renderer.render(this.scene, this.camera);
      this.labelRenderer.render(this.scene, this.camera);
    }
  }

  RV.RiverScene = RiverScene;
  RV.formatMetres = formatMetres;
})(window.RV);
