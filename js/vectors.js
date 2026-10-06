/* =============================================================================
 * vectors.js — Everything that visualises the vector mathematics:
 *
 *   • the three velocity arrows  V_bw (orange), V_wg (cyan), V_bg (pink)
 *   • head-to-tail triangle / parallelogram construction
 *   • components v_x, V_y, V_x with dashed projection lines
 *   • the heading angle θ and resultant angle φ as arcs
 *   • the boat-heading line, predicted path and actual trajectory
 *
 * Arrows are drawn in velocity space (ARROW_UNITS_PER_MPS scene units per m/s),
 * anchored at the boat. Paths are drawn in position space on the water.
 * Since both use the same direction mapping, the resultant arrow is always
 * exactly parallel to the trajectory.
 * ============================================================================= */
window.RV = window.RV || {};

(function (RV) {
  'use strict';

  const { Geo, Labels, VectorArrow, RibbonLine, ArcSector } = RV;
  const C = Geo.COLORS;
  const fmt = (value, digits = 2) => {
    if (!Number.isFinite(value)) return '∞';
    const v = Math.abs(value) < 0.5 * Math.pow(10, -digits) ? 0 : value;
    return v.toFixed(digits).replace('-', '−');
  };

  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();

  class VectorOverlay {
    constructor(riverScene) {
      this.riverScene = riverScene;
      this.group = new THREE.Group();
      riverScene.scene.add(this.group);

      const H = Geo.VECTOR_HEIGHT;
      const componentHeight = H - 0.55;
      this.componentHeight = componentHeight;

      // --- main velocity arrows ------------------------------------------------
      this.arrows = {
        bw: new VectorArrow({ color: C.boatWater, labelClass: 'bw' }),
        wg: new VectorArrow({ color: C.river, labelClass: 'wg' }),
        bg: new VectorArrow({ color: C.resultant, labelClass: 'bg', shaftRadius: 0.27, headRadius: 0.72, headLength: 1.9 }),
      };

      // --- components (thinner, drawn slightly lower) -------------------------
      const thin = { shaftRadius: 0.13, headRadius: 0.4, headLength: 1.05 };
      this.components = {
        vx: new VectorArrow({ color: C.boatX, labelClass: 'comp vx', ...thin }),
        vy: new VectorArrow({ color: C.across, labelClass: 'comp vy', ...thin, shaftRadius: 0.16, headRadius: 0.46 }),
        bgx: new VectorArrow({ color: C.resultantX, labelClass: 'comp bgx', ...thin }),
      };
      this.projections = new RibbonLine({ color: 0xffffff, width: 0.12, opacity: 0.85, dashed: true, dash: 0.55, gap: 0.4, height: componentHeight });

      // --- triangle / parallelogram ghost edges -------------------------------
      this.parallelogram = new RibbonLine({ color: 0xffffff, width: 0.14, opacity: 0.55, dashed: true, dash: 0.8, gap: 0.55, height: H });

      // --- angles ---------------------------------------------------------------
      this.headingArc = new ArcSector({ color: C.boatWater, radius: 4.4, labelClass: 'theta' });
      this.resultantArc = new ArcSector({ color: C.resultant, radius: 3.0, labelClass: 'phi' });
      this.angleBaseline = new RibbonLine({ color: 0xffffff, width: 0.1, opacity: 0.7, dashed: true, dash: 0.5, gap: 0.35, height: H - 0.6 });

      // --- paths on the water ---------------------------------------------------
      const water = Geo.WATER_LINE_HEIGHT;
      this.trailGlow = new RibbonLine({ color: C.resultant, width: 1.7, opacity: 0.28, additive: true, height: water });
      this.trail = new RibbonLine({ color: C.resultant, width: 0.42, opacity: 1, height: water + 0.01 });
      this.predicted = new RibbonLine({ color: C.resultant, width: 0.3, opacity: 0.85, dashed: true, dash: 1.4, gap: 0.9, height: water + 0.02 });
      this.headingLine = new RibbonLine({ color: C.boatWater, width: 0.3, opacity: 0.9, dashed: true, dash: 0.9, gap: 0.7, height: water + 0.03 });
      this.headingLabel = Labels.create('path-label heading', 'boat heading<br><small>where the nose points</small>');
      this.predictedLabel = Labels.create('path-label predicted', 'predicted path<br><small>where it actually goes</small>');
      this.group.add(this.headingLabel, this.predictedLabel);

      // Assemble
      for (const arrow of [...Object.values(this.arrows), ...Object.values(this.components)]) this.group.add(arrow.group);
      this.group.add(
        this.projections.mesh,
        this.parallelogram.mesh,
        this.headingArc.group,
        this.resultantArc.group,
        this.angleBaseline.mesh,
        this.trailGlow.mesh,
        this.trail.mesh,
        this.predicted.mesh,
        this.headingLine.mesh
      );
      this.lastPathKey = '';
    }

    /**
     * Rebuild all vector visuals for the current frame.
     *
     * @param {object} input
     *   solution      — result of Physics.solveCrossing (velocities etc.)
     *   boatPosition  — current boat position in metres
     *   pathVertices  — trajectory vertices (metres) recorded by the simulation
     *   predictedPath — {from, to, reaches} in metres
     *   toggles       — display switches
     *   presentation  — animation state (scales, triangle shift, highlights)
     *   time          — display time (for pulsing highlights)
     */
    update(input) {
      this.updateVectorArrows(input);
      this.updatePaths(input);
    }

    updateVectorArrows({ solution, boatPosition, toggles, presentation, time }) {
      const s = this.riverScene.metresToScene;
      const H = Geo.VECTOR_HEIGHT;
      const origin = Geo.toScene(boatPosition.x, boatPosition.y, H, s, new THREE.Vector3());

      // Arrow vectors in the scene (velocity space)
      const fullBW = Geo.velocityToArrow(solution.boatVelocity);
      const fullWG = Geo.velocityToArrow(solution.riverVelocity);
      const fullBG = Geo.velocityToArrow(solution.resultantVelocity);
      const p = presentation;

      // V_bw from the boat
      this.arrows.bw.set(origin, fullBW.clone().multiplyScalar(p.bwScale));
      // V_wg: from the boat (tail-to-tail) or slid to the head of V_bw (head-to-tail)
      const wgOrigin = origin.clone().addScaledVector(fullBW, p.wgShift);
      this.arrows.wg.set(wgOrigin, fullWG.clone().multiplyScalar(p.wgScale));
      // V_bg = V_bw + V_wg from the boat
      this.arrows.bg.set(origin, fullBG.clone().multiplyScalar(p.bgScale));

      const vectorsVisible = toggles.vectors || p.forceVectors;
      for (const key of ['bw', 'wg', 'bg']) this.arrows[key].setVisible(vectorsVisible);

      // Labels with magnitudes, placed beside each arrow
      const { boatSpeed, riverSpeed } = solution.params;
      this.arrows.bw.setLabel(this.vectorLabel('V', 'bw', boatSpeed, 'boat rel. to water'));
      this.arrows.wg.setLabel(this.vectorLabel('V', 'wg', riverSpeed, 'water rel. to ground'));
      this.arrows.bg.setLabel(this.vectorLabel('V', 'bg', solution.groundSpeed, 'boat rel. to ground'));
      this.placeLabelBeside(this.arrows.bw, +1, 0.62);
      this.placeLabelBeside(this.arrows.wg, -1, 0.5);
      this.placeLabelBeside(this.arrows.bg, -1, 0.66);

      // Parallelogram / triangle helper edges
      const ghostAlpha = vectorsVisible ? p.parallelogram : 0;
      this.parallelogram.setVisible(ghostAlpha > 0.01);
      if (ghostAlpha > 0.01) {
        const wgTipFromOrigin = origin.clone().add(fullWG);
        const bgTip = origin.clone().add(fullBG);
        // Dashed "ghost" of V_wg at the boat, and of V_bw from the tip of V_wg
        this.parallelogram.setSegments([
          [origin, wgTipFromOrigin],
          [wgTipFromOrigin, bgTip],
        ]);
        this.parallelogram.setOpacity(ghostAlpha);
      }

      // Components
      const showComponents = (toggles.components || p.forceComponents) && p.bwScale > 0.999;
      this.updateComponents(origin, fullBW, fullBG, solution, showComponents);

      // Angles: θ (heading, from +x) and φ (actual direction, from +x)
      const arcOrigin = origin.clone();
      arcOrigin.y = H - 0.6;
      const showArcs = vectorsVisible && p.bwScale > 0.999;
      this.headingArc.setVisible(showArcs && solution.params.boatSpeed > 0);
      this.headingArc.set(arcOrigin, solution.params.heading);
      this.headingArc.setLabel(`θ = ${fmt(solution.params.heading, 1)}°`);
      const phi = solution.resultantDirection;
      this.resultantArc.setVisible(showArcs && Number.isFinite(phi) && p.bgScale > 0.999);
      if (Number.isFinite(phi)) {
        this.resultantArc.set(arcOrigin, phi);
        this.resultantArc.setLabel(`φ = ${fmt(phi, 1)}°`);
      }
      this.angleBaseline.setVisible(showArcs);
      this.angleBaseline.setPoints([arcOrigin, arcOrigin.clone().add(new THREE.Vector3(6.2, 0, 0))]);

      // Highlighting (learning mode, case presets, demo)
      this.applyHighlight(p.highlight, time);
    }

    vectorLabel(symbol, subscript, value, description) {
      return `<div class="lbl-inner"><span class="sym">${symbol}<sub>${subscript}</sub></span> = ${fmt(value)} m/s<small>${description}</small></div>`;
    }

    /**
     * Put a label beside an arrow (perpendicular offset) and tell CSS which way
     * the text should extend, so labels never sit on top of their own arrow.
     * side: +1 = left of the arrow direction, −1 = right.
     */
    placeLabelBeside(arrow, side, fraction) {
      if (!arrow.label || arrow.length < 1e-3) return;
      const v = arrow.vector;
      const length = arrow.length;
      // Left normal of (sx, 0, sz) in the horizontal plane is (sz, 0, −sx) / |v|
      const normal = new THREE.Vector3(v.z / length, 0, -v.x / length).multiplyScalar(side);
      const anchor = arrow.origin.clone().addScaledVector(v, fraction);
      arrow.label.position.copy(anchor).addScaledVector(normal, 1.15).add(new THREE.Vector3(0, 0.25, 0));

      // Which way is "away from the arrow" on screen?
      const camera = this.riverScene.camera;
      const a = tmpA.copy(anchor).project(camera);
      const b = tmpB.copy(arrow.label.position).project(camera);
      const element = arrow.label.element;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      let side2 = 'center';
      if (Math.abs(dx) > Math.abs(dy) * 0.35) side2 = dx < 0 ? 'left' : 'right';
      else side2 = dy > 0 ? 'up' : 'down';
      if (element.dataset.side !== side2) element.dataset.side = side2;
    }

    updateComponents(origin, fullBW, fullBG, solution, visible) {
      const comps = this.components;
      for (const arrow of Object.values(comps)) arrow.setVisible(visible);
      this.projections.setVisible(visible);
      if (!visible) return;

      const low = origin.clone();
      low.y = this.componentHeight;
      const bwTip = low.clone().add(fullBW);
      const bgTip = low.clone().add(fullBG);

      // v_x along the x-axis from the boat
      comps.vx.set(low, new THREE.Vector3(fullBW.x, 0, 0));
      // V_y = v_y along the y-axis (the same for V_bw and V_bg!)
      comps.vy.set(low, new THREE.Vector3(0, 0, fullBW.z));
      // V_x drawn from the head of V_y so that V_y + V_x = V_bg (head-to-tail)
      comps.bgx.set(low.clone().add(new THREE.Vector3(0, 0, fullBG.z)), new THREE.Vector3(fullBG.x, 0, 0));

      const v = solution.boatVelocity;
      const V = solution.resultantVelocity;
      comps.vx.setLabel(`<div class="lbl-inner">v<sub>x</sub> = ${fmt(v.x)} m/s</div>`);
      comps.vy.setLabel(`<div class="lbl-inner">V<sub>y</sub> = v<sub>y</sub> = ${fmt(V.y)} m/s<small>across component</small></div>`);
      comps.bgx.setLabel(`<div class="lbl-inner">V<sub>x</sub> = v<sub>x</sub> + u = ${fmt(V.x)} m/s</div>`);
      this.placeLabelBeside(comps.vx, -1, 0.5);
      this.placeLabelBeside(comps.vy, fullBW.x >= 0 ? +1 : -1, 0.5);
      this.placeLabelBeside(comps.bgx, +1, 0.5);

      // Dashed projection lines from the arrow tips onto the axes
      this.projections.setSegments([
        [bwTip, new THREE.Vector3(bwTip.x, low.y, low.z)],
        [bwTip, new THREE.Vector3(low.x, low.y, bwTip.z)],
        [bgTip, new THREE.Vector3(bgTip.x, low.y, low.z)],
        [new THREE.Vector3(low.x, low.y, low.z), new THREE.Vector3(bgTip.x, low.y, low.z)],
      ]);
    }

    /** Dim everything that is not highlighted and make highlighted items pulse. */
    applyHighlight(highlight, time) {
      const items = {
        bw: this.arrows.bw,
        wg: this.arrows.wg,
        bg: this.arrows.bg,
        vx: this.components.vx,
        vy: this.components.vy,
        bgx: this.components.bgx,
      };
      const pulse = 0.55 + 0.45 * Math.sin(time * 5);
      for (const [key, arrow] of Object.entries(items)) {
        if (!highlight || highlight.length === 0) {
          arrow.setOpacity(key.length > 2 || key === 'vx' || key === 'vy' ? 0.92 : 1);
          arrow.setEmphasis(0);
        } else if (highlight.includes(key)) {
          arrow.setOpacity(1);
          arrow.setEmphasis(pulse);
        } else {
          arrow.setOpacity(0.16);
          arrow.setEmphasis(0);
        }
      }
      const dimArcs = highlight && highlight.length > 0 && !highlight.includes('bw') && !highlight.includes('angles');
      this.headingArc.setOpacity(dimArcs ? 0.2 : 1);
      this.resultantArc.setOpacity(highlight && highlight.length > 0 && !highlight.includes('bg') ? 0.2 : 1);
      const dimPaths = highlight && highlight.length > 0 && !highlight.includes('trail');
      this.trail.setOpacity(dimPaths ? 0.35 : 1);
      this.trailGlow.setOpacity(dimPaths ? 0.3 : 1);
      this.predicted.setOpacity(dimPaths ? 0.35 : 1);
    }

    updatePaths({ boatPosition, pathVertices, predictedPath, toggles, solution, hidePrediction }) {
      const s = this.riverScene.metresToScene;
      const toScene = (p) => Geo.toScene(p.x, p.y, 0, s, new THREE.Vector3());

      // Actual trajectory: recorded vertices + the current position
      this.trail.setVisible(toggles.trajectory);
      this.trailGlow.setVisible(toggles.trajectory);
      if (toggles.trajectory) {
        const points = pathVertices.map(toScene);
        points.push(toScene(boatPosition));
        this.trail.setPoints(points);
        this.trailGlow.setPoints(points);
      }

      // Predicted path from where the velocity last changed (straight line r₀ + V t)
      const showPredicted = toggles.predicted && !hidePrediction && predictedPath;
      this.predicted.setVisible(!!showPredicted);
      Labels.setVisible(this.predictedLabel, !!showPredicted);
      if (showPredicted) {
        const from = toScene(predictedPath.from);
        const to = toScene(predictedPath.to);
        this.predicted.setPoints([from, to]);
        this.predictedLabel.position.copy(from).lerp(to, 0.72).add(new THREE.Vector3(0, 0.6, 0));
        // Offset so the label does not cover the line: to the downstream side
        this.predictedLabel.position.x += 2.2;
      }

      // Boat heading direction: where the boat would go in still water
      const showHeading = toggles.heading && solution.params.boatSpeed > 0;
      this.headingLine.setVisible(showHeading);
      Labels.setVisible(this.headingLabel, showHeading);
      if (showHeading) {
        const start = toScene(boatPosition);
        const theta = RV.Physics.toRadians(solution.params.heading);
        const dir = new THREE.Vector3(Math.cos(theta), 0, -Math.sin(theta));
        // Extend to the far bank (z = −W_SCENE), but never absurdly far
        const toFarBank = dir.z < -0.05 ? (start.z + Geo.SCENE_RIVER_WIDTH) / -dir.z : 60;
        const length = THREE.MathUtils.clamp(toFarBank, 4, 90);
        const end = start.clone().addScaledVector(dir, length);
        this.headingLine.setPoints([start, end]);
        this.headingLabel.position.copy(start).lerp(end, 0.8).add(new THREE.Vector3(-2.0, 0.6, 0));
      }
    }
  }

  RV.VectorOverlay = VectorOverlay;
  RV.fmt = fmt;
})(window.RV);
