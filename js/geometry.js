/* =============================================================================
 * geometry.js — Reusable Three.js building blocks.
 *
 *   VectorArrow  : a large 3D arrow (cylinder shaft + cone head) with a label
 *   RibbonLine   : a flat, thick line on a horizontal plane (solid or dashed)
 *   ArcSector    : a flat circular sector used to draw angles (θ, φ)
 *   Labels       : registry for HTML labels (CSS2DObject) with proper
 *                  visibility handling and a global on/off switch
 *
 * Mapping from physics to the scene (see RV.Geo.toScene):
 *   physics x (downstream)  →  scene +X
 *   physics y (across)      →  scene −Z  (far bank is "into" the screen)
 *   scene +Y is "up" (height above the water)
 * ============================================================================= */
window.RV = window.RV || {};

(function (RV) {
  'use strict';

  const UP = new THREE.Vector3(0, 1, 0);

  /** Visual constants shared by all modules. */
  const Geo = {
    /** The river is always drawn this many scene units wide; metres are scaled to fit. */
    SCENE_RIVER_WIDTH: 40,
    /** Velocity arrows: scene units per (m/s). Arrows live in "velocity space". */
    ARROW_UNITS_PER_MPS: 1.8,
    /** Height above the water at which all velocity vectors are drawn. */
    VECTOR_HEIGHT: 1.7,
    /** Height of lines drawn on the water (trajectory, heading line). */
    WATER_LINE_HEIGHT: 0.09,
    BANK_HEIGHT: 0.6,

    COLORS: {
      boatWater: 0xff9a1f,   // V_bw  — boat relative to water (orange)
      river: 0x38d6ff,       // V_wg  — water relative to ground (cyan)
      resultant: 0xff4f9a,   // V_bg  — boat relative to ground (pink)
      across: 0xffe14d,      // V_y   — across-river component (yellow)
      boatX: 0xffc77a,       // v_x   — boat x component (light orange)
      resultantX: 0xff9cc6,  // V_x   — resultant x component (light pink)
      prediction: 0xa6ff4d,  // student's prediction (lime)
      axis: 0xe6edf6,
    },

    /** Convert physics coordinates (metres) to a scene position. */
    toScene(x, y, height, metresToScene, target = new THREE.Vector3()) {
      return target.set(x * metresToScene, height, -y * metresToScene);
    },

    /** Convert a physics velocity (m/s) to an arrow vector in the scene. */
    velocityToArrow(velocity, target = new THREE.Vector3()) {
      const k = Geo.ARROW_UNITS_PER_MPS;
      return target.set(velocity.x * k, 0, -velocity.y * k);
    },
  };

  const cssColor = (hex) => '#' + hex.toString(16).padStart(6, '0');
  Geo.cssColor = cssColor;

  // ---------------------------------------------------------------------------
  // Labels
  // ---------------------------------------------------------------------------

  /**
   * CSS2DRenderer only checks an object's own `visible` flag, not its parents'.
   * The registry stores each label's *desired* visibility and, once per frame,
   * combines it with its ancestors' visibility and the global "show labels"
   * switch before the labels are rendered.
   */
  const Labels = {
    all: new Set(),
    enabled: true,

    create(className, html = '') {
      const element = document.createElement('div');
      element.className = 'scene-label ' + className;
      element.innerHTML = html;
      const label = new THREE.CSS2DObject(element);
      label.userData.selfVisible = true;
      label.userData.html = html;
      label.userData.alwaysShow = false;
      this.all.add(label);
      return label;
    },

    setText(label, html) {
      if (label.userData.html !== html) {
        label.userData.html = html;
        label.element.innerHTML = html;
      }
    },

    setVisible(label, visible) {
      label.userData.selfVisible = visible;
    },

    dispose(label) {
      this.all.delete(label);
      if (label.parent) label.parent.remove(label);
    },

    /** Called right before the label renderer draws. */
    sync() {
      for (const label of this.all) {
        let visible = label.userData.selfVisible && (this.enabled || label.userData.alwaysShow);
        let node = label.parent;
        while (visible && node) {
          if (!node.visible) visible = false;
          node = node.parent;
        }
        if (!label.parent) visible = false;
        label.visible = visible;
      }
    },
  };

  // ---------------------------------------------------------------------------
  // VectorArrow
  // ---------------------------------------------------------------------------

  const shaftGeometry = new THREE.CylinderGeometry(1, 1, 1, 20, 1).translate(0, 0.5, 0);
  const headGeometry = new THREE.ConeGeometry(1, 1, 28, 1).translate(0, 0.5, 0);

  /**
   * A 3D arrow drawn from `origin` along `vector`. The group itself stays at
   * the world origin; an inner pivot is moved/rotated so the label (a sibling
   * of the pivot) can be placed in world coordinates.
   */
  class VectorArrow {
    constructor({
      color,
      shaftRadius = 0.22,
      headRadius = 0.62,
      headLength = 1.7,
      opacity = 1,
      labelClass = null,
      labelOffset = new THREE.Vector3(0, 0.9, 0),
      labelPosition = 0.55, // fraction along the arrow
    }) {
      this.group = new THREE.Group();
      this.pivot = new THREE.Group();
      this.group.add(this.pivot);

      this.baseColor = new THREE.Color(color);
      // Darkened diffuse + emissive keeps the hue saturated under bright light
      // (a plain bright colour would wash out towards yellow/white).
      this.material = new THREE.MeshStandardMaterial({
        color: this.baseColor.clone().multiplyScalar(0.6),
        emissive: this.baseColor,
        emissiveIntensity: 0.3,
        roughness: 0.42,
        metalness: 0.05,
        transparent: opacity < 1,
        opacity,
      });
      this.shaft = new THREE.Mesh(shaftGeometry, this.material);
      this.head = new THREE.Mesh(headGeometry, this.material);
      this.shaft.renderOrder = 2;
      this.head.renderOrder = 2;
      this.pivot.add(this.shaft, this.head);

      this.shaftRadius = shaftRadius;
      this.headRadius = headRadius;
      this.headLength = headLength;
      this.baseOpacity = opacity;
      this.labelOffset = labelOffset;
      this.labelFraction = labelPosition;
      this.length = 0;
      this.origin = new THREE.Vector3();
      this.vector = new THREE.Vector3();

      this.label = labelClass ? Labels.create('vec-label ' + labelClass) : null;
      if (this.label) this.group.add(this.label);
    }

    /** Place the arrow: tail at `origin`, tip at origin + vector. */
    set(origin, vector) {
      this.origin.copy(origin);
      this.vector.copy(vector);
      const length = vector.length();
      this.length = length;

      if (length < 1e-3) {
        this.pivot.visible = false;
        if (this.label) Labels.setVisible(this.label, false);
        return;
      }
      this.pivot.visible = true;
      if (this.label) Labels.setVisible(this.label, this.labelWanted !== false);

      const direction = vector.clone().divideScalar(length);
      this.pivot.position.copy(origin);
      this.pivot.quaternion.setFromUnitVectors(UP, direction);

      // Short vectors get a proportionally smaller head so they still read as arrows.
      const headLength = Math.min(this.headLength, length * 0.45);
      const headScale = Math.max(0.45, headLength / this.headLength);
      const headRadius = this.headRadius * headScale;
      const shaftRadius = this.shaftRadius * Math.max(0.6, headScale);
      const shaftLength = Math.max(1e-4, length - headLength);

      this.shaft.scale.set(shaftRadius, shaftLength, shaftRadius);
      this.head.position.set(0, shaftLength, 0);
      this.head.scale.set(headRadius, headLength, headRadius);

      if (this.label) {
        this.label.position
          .copy(origin)
          .addScaledVector(vector, this.labelFraction)
          .add(this.labelOffset);
      }
    }

    tip(target = new THREE.Vector3()) {
      return target.copy(this.origin).add(this.vector);
    }

    setLabel(html) {
      if (this.label) Labels.setText(this.label, html);
    }

    setLabelVisible(visible) {
      this.labelWanted = visible;
      if (this.label) Labels.setVisible(this.label, visible && this.length >= 1e-3);
    }

    setVisible(visible) {
      this.group.visible = visible;
    }

    /** 0..1 opacity multiplier (used to dim vectors in learning mode). */
    setOpacity(alpha) {
      const opacity = this.baseOpacity * alpha;
      this.material.opacity = opacity;
      this.material.transparent = opacity < 0.999;
      this.material.depthWrite = opacity > 0.5;
      if (this.label) this.label.element.style.opacity = String(Math.max(0.15, alpha));
    }

    /** Emphasis glow (0 = normal). */
    setEmphasis(amount) {
      this.material.emissiveIntensity = 0.3 + amount * 0.55;
      if (this.label) this.label.element.classList.toggle('emphasis', amount > 0.05);
    }
  }

  // ---------------------------------------------------------------------------
  // RibbonLine — a flat strip in a horizontal plane (thick, visible lines)
  // ---------------------------------------------------------------------------

  /**
   * WebGL ignores `linewidth`, so thick lines are drawn as flat triangle strips
   * lying in a horizontal plane. Supports polylines and dashed segments.
   */
  class RibbonLine {
    constructor({ color, width = 0.3, opacity = 1, dashed = false, dash = 1.2, gap = 0.8, additive = false, height = 0 }) {
      this.width = width;
      this.dashed = dashed;
      this.dash = dash;
      this.gap = gap;
      this.height = height;
      this.capacity = 0;
      this.geometry = new THREE.BufferGeometry();
      this.material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      this.baseOpacity = opacity;
      this.mesh = new THREE.Mesh(this.geometry, this.material);
      this.mesh.frustumCulled = false;
      this.mesh.renderOrder = 1;
      this.ensureCapacity(64);
    }

    ensureCapacity(quads) {
      if (quads <= this.capacity) return;
      this.capacity = Math.max(quads, this.capacity * 2);
      this.positions = new Float32Array(this.capacity * 6 * 3);
      this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    }

    /** Draw a connected polyline. points: THREE.Vector3[] (y is replaced by this.height). */
    setPoints(points) {
      const pairs = [];
      for (let i = 0; i < points.length - 1; i++) pairs.push([points[i], points[i + 1]]);
      this.setSegments(pairs);
    }

    /** Draw independent segments. pairs: [[a, b], ...] of THREE.Vector3. */
    setSegments(pairs) {
      const segments = [];
      for (const [a, b] of pairs) {
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        if (length < 1e-5) continue;
        if (!this.dashed) {
          segments.push([a.x, a.z, b.x, b.z]);
        } else {
          const period = this.dash + this.gap;
          const ux = (b.x - a.x) / length;
          const uz = (b.z - a.z) / length;
          for (let s = 0; s < length && segments.length < 20000; s += period) {
            const e = Math.min(length, s + this.dash);
            segments.push([a.x + ux * s, a.z + uz * s, a.x + ux * e, a.z + uz * e]);
          }
        }
      }

      this.ensureCapacity(segments.length + 1);
      const p = this.positions;
      const h = this.height;
      const halfWidth = this.width / 2;
      let i = 0;
      for (const [x0, z0, x1, z1] of segments) {
        const length = Math.hypot(x1 - x0, z1 - z0) || 1;
        // Perpendicular in the horizontal plane
        const nx = (-(z1 - z0) / length) * halfWidth;
        const nz = ((x1 - x0) / length) * halfWidth;
        // Extend solid segments slightly so joints overlap without gaps
        const ex = this.dashed ? 0 : ((x1 - x0) / length) * halfWidth * 0.9;
        const ez = this.dashed ? 0 : ((z1 - z0) / length) * halfWidth * 0.9;
        const ax = x0 - ex, az = z0 - ez, bx = x1 + ex, bz = z1 + ez;
        const quad = [
          ax + nx, h, az + nz,  ax - nx, h, az - nz,  bx + nx, h, bz + nz,
          bx + nx, h, bz + nz,  ax - nx, h, az - nz,  bx - nx, h, bz - nz,
        ];
        p.set(quad, i);
        i += 18;
      }
      this.geometry.setDrawRange(0, i / 3);
      this.geometry.attributes.position.needsUpdate = true;
    }

    setVisible(visible) {
      this.mesh.visible = visible;
    }

    setOpacity(alpha) {
      this.material.opacity = this.baseOpacity * alpha;
    }
  }

  // ---------------------------------------------------------------------------
  // ArcSector — draws an angle as a translucent wedge with a bright rim
  // ---------------------------------------------------------------------------

  class ArcSector {
    constructor({ color, radius = 4, rimWidth = 0.14, fillOpacity = 0.18, labelClass = null }) {
      this.group = new THREE.Group();
      this.radius = radius;
      this.rimWidth = rimWidth;
      this.fill = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: fillOpacity, side: THREE.DoubleSide, depthWrite: false })
      );
      this.rim = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false })
      );
      this.fill.renderOrder = 1;
      this.rim.renderOrder = 1;
      this.group.add(this.fill, this.rim);
      this.label = labelClass ? Labels.create('arc-label ' + labelClass) : null;
      if (this.label) this.group.add(this.label);
      this.lastKey = '';
    }

    /**
     * Draw the angle from +x (downstream) to `angleDeg` (towards +y, across),
     * centred at `center` (scene coordinates).
     */
    set(center, angleDeg) {
      const key = angleDeg.toFixed(3);
      if (key !== this.lastKey) {
        this.lastKey = key;
        const thetaLength = Math.max(0.0001, (Math.abs(angleDeg) * Math.PI) / 180);
        const start = angleDeg < 0 ? -thetaLength : 0;
        const segments = Math.max(4, Math.ceil(thetaLength * 24));
        this.fill.geometry.dispose();
        this.rim.geometry.dispose();
        // RingGeometry lies in the XY plane; rotating by −90° about X maps
        // (cos a, sin a, 0) → (cos a, 0, −sin a), i.e. physics +y → scene −z.
        this.fill.geometry = new THREE.RingGeometry(0.0, this.radius, segments, 1, start, thetaLength).rotateX(-Math.PI / 2);
        this.rim.geometry = new THREE.RingGeometry(this.radius - this.rimWidth, this.radius, segments, 1, start, thetaLength).rotateX(-Math.PI / 2);
      }
      this.group.position.copy(center);
      if (this.label) {
        const mid = ((angleDeg / 2) * Math.PI) / 180;
        const r = this.radius + 1.1;
        this.label.position.set(Math.cos(mid) * r, 0.2, -Math.sin(mid) * r);
      }
    }

    setLabel(html) {
      if (this.label) Labels.setText(this.label, html);
    }

    setVisible(visible) {
      this.group.visible = visible;
    }

    setOpacity(alpha) {
      this.fill.material.opacity = 0.18 * alpha;
      this.rim.material.opacity = 0.95 * alpha;
    }
  }

  RV.Geo = Geo;
  RV.Labels = Labels;
  RV.VectorArrow = VectorArrow;
  RV.RibbonLine = RibbonLine;
  RV.ArcSector = ArcSector;
})(window.RV);
