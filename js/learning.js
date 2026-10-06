/* =============================================================================
 * learning.js — The three guided educational modes:
 *
 *   LearningMode          step-by-step explanation with highlighted vectors
 *   VectorAdditionDemo    slow-motion construction of V_bg = V_bw + V_wg
 *   PredictionExperiment  "where will the boat land?" mini-experiment
 *
 * Each mode only *requests* visual states (highlights, arrow scales, banner
 * text) from the app; none of them touches the physics.
 * ============================================================================= */
window.RV = window.RV || {};

(function (RV) {
  'use strict';

  const fmt = RV.fmt;
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const clamp01 = (t) => Math.min(1, Math.max(0, t));

  // ---------------------------------------------------------------------------
  // Learning mode
  // ---------------------------------------------------------------------------

  const LEARNING_STEPS = [
    {
      title: 'Velocity relative to the water',
      text: '<b>Step 1:</b> The boat has a velocity relative to the surrounding water. The engine pushes the boat the way its nose points, at angle θ. This is the <span class="c-bw">orange</span> vector <b>V<sub>bw</sub></b>. In still water, this is exactly how the boat would move.',
      equation: () => '\\Vbw = (v\\cos\\theta,\\ v\\sin\\theta)',
      highlight: ['bw', 'angles'],
      triangle: false,
    },
    {
      title: 'The water itself moves',
      text: '<b>Step 2:</b> But the water itself is moving relative to the ground. Watch the floating markers: the river carries them, and everything else in it, downstream. This is the <span class="c-wg">cyan</span> vector <b>V<sub>wg</sub></b>.',
      equation: () => '\\Vwg = (u,\\ 0)',
      highlight: ['wg'],
      triangle: false,
      particles: true,
    },
    {
      title: 'What an observer on the bank sees',
      text: '<b>Step 3:</b> So an observer standing on the river bank sees the two velocities combined. The boat moves through the water <i>and</i> the water carries the boat.',
      equation: () => '\\text{ground view} = (\\text{boat in water}) + (\\text{water on ground})',
      highlight: ['bw', 'wg'],
      triangle: false,
      observer: true,
    },
    {
      title: 'Add the vectors head-to-tail',
      text: '<b>Step 4:</b> The two vectors are added. Slide <b>V<sub>wg</sub></b> so that its tail starts at the head of <b>V<sub>bw</sub></b>. The dashed lines complete the parallelogram, and either way gives the same sum.',
      equation: () => '\\Vbg = \\Vbw + \\Vwg',
      highlight: ['bw', 'wg'],
      triangle: true,
    },
    {
      title: 'The resultant is the real motion',
      text: '<b>Step 5:</b> The resultant vector decides how the boat actually moves relative to the ground. The <span class="c-bg">pink</span> trail follows <b>V<sub>bg</sub></b>, not the direction the nose points. Press ▶ Play to watch it.',
      equation: (s) => {
        const n = RV.texNumber;
        return `\\Vbg = (${n(s.resultantVelocity.x)},\\ ${n(s.resultantVelocity.y)})\\,\\text{m/s},\\quad |\\Vbg| = ${n(s.groundSpeed)}\\,\\text{m/s}`;
      },
      highlight: ['bg', 'trail'],
      triangle: true,
    },
  ];

  class LearningMode {
    constructor(app) {
      this.app = app;
      this.active = false;
      this.index = 0;
    }

    get step() {
      return this.active ? LEARNING_STEPS[this.index] : null;
    }

    start() {
      this.active = true;
      this.index = 0;
      this.render();
      this.app.ui.setLearningActive(true);
    }

    stop() {
      this.active = false;
      this.app.ui.hideLearning();
      this.app.ui.setLearningActive(false);
    }

    go(delta) {
      if (!this.active) return;
      const next = this.index + delta;
      if (next >= LEARNING_STEPS.length) {
        this.stop();
        return;
      }
      this.index = Math.max(0, next);
      this.render();
    }

    /** Re-render the step (also called when numbers change). */
    render() {
      if (!this.active) return;
      const step = LEARNING_STEPS[this.index];
      this.app.ui.showLearningStep({ ...step, equation: step.equation(this.app.solution) }, this.index, LEARNING_STEPS.length);
    }
  }

  // ---------------------------------------------------------------------------
  // Slow-motion "Explain Vector Addition" demonstration
  // ---------------------------------------------------------------------------

  /**
   * Each phase lasts `duration` real seconds; `state(t)` returns the arrow
   * presentation for local progress t ∈ [0, 1].
   */
  const DEMO_PHASES = [
    {
      duration: 1.4,
      caption: 'The simulation is paused. We will build the boat\'s ground velocity one vector at a time.',
      state: () => ({ bwScale: 0, wgScale: 0, bgScale: 0, wgShift: 0, parallelogram: 0, highlight: [] }),
    },
    {
      duration: 2.6,
      caption: '<b>1.</b> Boat velocity relative to the water: <span class="c-bw">V<sub>bw</sub></span>',
      state: (t) => ({ bwScale: easeInOut(t), wgScale: 0, bgScale: 0, wgShift: 0, parallelogram: 0, highlight: ['bw'] }),
    },
    {
      duration: 2.6,
      caption: '<b>2.</b> River velocity relative to the ground: <span class="c-wg">V<sub>wg</sub></span>',
      state: (t) => ({ bwScale: 1, wgScale: easeInOut(t), bgScale: 0, wgShift: 0, parallelogram: 0, highlight: ['wg'] }),
    },
    {
      duration: 3.2,
      caption: '<b>3.</b> Move <span class="c-wg">V<sub>wg</sub></span> so its tail sits at the head of <span class="c-bw">V<sub>bw</sub></span> (head-to-tail)',
      state: (t) => ({ bwScale: 1, wgScale: 1, bgScale: 0, wgShift: easeInOut(t), parallelogram: 0, highlight: ['wg'] }),
    },
    {
      duration: 2.2,
      caption: '<b>4.</b> The two vectors form the sides of a triangle (the dashed lines complete the parallelogram)',
      state: (t) => ({ bwScale: 1, wgScale: 1, bgScale: 0, wgShift: 1, parallelogram: easeInOut(t), highlight: ['bw', 'wg'] }),
    },
    {
      duration: 2.8,
      caption: '<b>5.</b> Draw the resultant from the tail of <span class="c-bw">V<sub>bw</sub></span> to the head of <span class="c-wg">V<sub>wg</sub></span>',
      state: (t) => ({ bwScale: 1, wgScale: 1, bgScale: easeInOut(t), wgShift: 1, parallelogram: 1, highlight: ['bg'] }),
    },
    {
      duration: 4.2,
      caption: 'equation',
      state: () => ({ bwScale: 1, wgScale: 1, bgScale: 1, wgShift: 1, parallelogram: 1, highlight: ['bg'] }),
    },
  ];

  class VectorAdditionDemo {
    constructor(app) {
      this.app = app;
      this.active = false;
      this.presentation = null;
    }

    start() {
      const app = this.app;
      if (app.learning.active) app.learning.stop();
      app.prediction.cancel();
      app.ui.hideResult();
      if (app.status === 'finished') app.resetSimulation();
      if (app.status === 'running') app.pause();

      this.active = true;
      this.elapsed = 0;
      this.phaseIndex = -1;
      this.presentation = DEMO_PHASES[0].state(0);
      app.ui.setBusy('btn-explain', true);

      // Frame the vectors from above: they are easiest to read in top view
      const scene = app.riverScene;
      const boat = scene.boat.position;
      const arrowScale = RV.Geo.ARROW_UNITS_PER_MPS;
      const V = app.solution.resultantVelocity;
      const B = app.solution.boatVelocity;
      const xs = [0, B.x, V.x, app.solution.riverVelocity.x].map((x) => x * arrowScale);
      const zs = [0, -B.y, -V.y].map((y) => y * arrowScale);
      const center = new THREE.Vector3(boat.x + (Math.min(...xs) + Math.max(...xs)) / 2, 0, boat.z + (Math.min(...zs) + Math.max(...zs)) / 2);
      const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs), 12) + 10;
      scene.followBoat = false;
      app.ui.setFollow(false);
      scene.viewTopAround(center, size);
    }

    update(realDt) {
      if (!this.active) return;
      this.elapsed += realDt;
      let time = this.elapsed;
      let index = 0;
      while (index < DEMO_PHASES.length && time > DEMO_PHASES[index].duration) {
        time -= DEMO_PHASES[index].duration;
        index++;
      }
      if (index >= DEMO_PHASES.length) {
        this.finish(true);
        return;
      }
      const phase = DEMO_PHASES[index];
      const t = clamp01(time / phase.duration);
      this.presentation = phase.state(t);

      if (index !== this.phaseIndex) {
        this.phaseIndex = index;
        this.showCaption(phase);
      }
      const bar = document.getElementById('banner-progress');
      if (bar) {
        const total = DEMO_PHASES.reduce((sum, ph) => sum + ph.duration, 0);
        bar.style.width = `${(Math.min(1, this.elapsed / total) * 100).toFixed(1)}%`;
      }
    }

    showCaption(phase) {
      const app = this.app;
      let html = phase.caption;
      if (phase.caption === 'equation') {
        const s = app.solution;
        const n = RV.texNumber;
        html = `<div class="banner-eq">${RV.tex('\\Vbg = \\Vbw + \\Vwg', true)}</div>
          <div class="banner-eq small">${RV.tex(`(${n(s.resultantVelocity.x)},\\ ${n(s.resultantVelocity.y)}) = (${n(s.boatVelocity.x)},\\ ${n(s.boatVelocity.y)}) + (${n(s.riverVelocity.x)},\\ 0)\\ \\text{m/s}`)}</div>
          <div>Next, the boat resumes moving along the resultant.</div>`;
      }
      app.ui.showBanner(
        `<div class="banner-kicker">Explain vector addition</div>${html}<div class="banner-progress"><span id="banner-progress"></span></div>`,
        [{ label: 'Skip', onClick: () => this.finish(true) }, { label: 'Stop', onClick: () => this.finish(false) }],
        'demo'
      );
    }

    /** End the demonstration; optionally resume the simulation. */
    finish(resume) {
      if (!this.active) return;
      this.active = false;
      this.presentation = null;
      this.app.ui.hideBanner();
      this.app.ui.setBusy('btn-explain', false);
      if (resume) this.app.play();
    }

    cancel() {
      this.finish(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Prediction experiment
  // ---------------------------------------------------------------------------

  class PredictionExperiment {
    constructor(app) {
      this.app = app;
      this.phase = 'off'; // off → picking → placed → done
      this.predictedX = null;
    }

    /** While picking/placed, the answer (predicted path, landing x) is hidden. */
    get hidesAnswer() {
      return this.phase === 'picking' || this.phase === 'placed';
    }

    start() {
      const app = this.app;
      if (app.demo.active) app.demo.cancel();
      if (!app.solution.canCross) {
        app.ui.showBanner('With these settings the boat never reaches the opposite bank (V<sub>y</sub> = 0). Change the heading or boat speed first.', [{ label: 'OK', onClick: () => app.ui.hideBanner() }], 'warning');
        return;
      }
      app.resetSimulation();
      this.phase = 'picking';
      this.predictedX = null;
      app.riverScene.predictionMarker.visible = false;
      app.ui.setBusy('btn-predict', true);
      app.ui.showBanner(
        '<div class="banner-kicker">Prediction mode</div><b>Where do you think the boat will reach?</b><br>Look at the vectors, then click a point on the <b>opposite bank</b>.',
        [{ label: 'Cancel', onClick: () => this.cancel() }],
        'predict'
      );
      app.markMathDirty();
    }

    onPointerMove(event) {
      if (this.phase !== 'picking') return;
      const scene = this.app.riverScene;
      const point = scene.pickWaterPoint(event.clientX, event.clientY);
      if (!point) {
        scene.predictionGhost.visible = false;
        return;
      }
      const W = this.app.params.riverWidth;
      scene.predictionGhost.visible = true;
      RV.Geo.toScene(point.x, W, RV.Geo.BANK_HEIGHT, scene.metresToScene, scene.predictionGhost.position);
      scene.predictionGhost.position.z -= 1.4;
      RV.Labels.setText(scene.ghostLabel, `x = ${fmt(point.x, 1)} m?`);
      scene.renderer.domElement.style.cursor = 'crosshair';
    }

    onClick(event) {
      if (this.phase !== 'picking') return false;
      const app = this.app;
      const scene = app.riverScene;
      const point = scene.pickWaterPoint(event.clientX, event.clientY);
      if (!point) return false;
      this.predictedX = point.x;
      this.phase = 'placed';
      scene.predictionGhost.visible = false;
      scene.renderer.domElement.style.cursor = '';
      scene.predictionMarker.visible = true;
      RV.Geo.toScene(point.x, app.params.riverWidth, RV.Geo.BANK_HEIGHT, scene.metresToScene, scene.predictionMarker.position);
      scene.predictionMarker.position.z -= 1.4;
      RV.Labels.setText(scene.predictionLabel, `Your prediction<br>x = ${fmt(point.x, 1)} m`);
      app.ui.showBanner(
        `<div class="banner-kicker">Prediction mode</div>Your prediction: <b>x = ${fmt(point.x, 1)} m</b>. Now watch the boat…`,
        [{ label: 'Cancel', onClick: () => this.cancel() }],
        'predict'
      );
      setTimeout(() => {
        if (this.phase === 'placed') {
          app.ui.hideBanner();
          app.play();
        }
      }, 900);
      return true;
    }

    /** Called by the app when the boat lands. Returns HTML for the result card. */
    complete(actualX) {
      if (this.phase !== 'placed') return null;
      this.phase = 'done';
      this.app.ui.setBusy('btn-predict', false);
      const W = this.app.params.riverWidth;
      const error = actualX - this.predictedX;
      const relative = Math.abs(error) / W;
      let verdict;
      if (relative < 0.03) verdict = 'Excellent! You read the vectors perfectly.';
      else if (relative < 0.12) verdict = 'Close! Compare the slope of the pink resultant with your guess.';
      else verdict = 'Not quite. Remember that the current acts during the whole crossing time t = W / V<sub>y</sub>, so the drift is x = V<sub>x</sub> t.';
      this.app.markMathDirty();
      return `
        <div class="compare-grid">
          <div><span>Your prediction</span><b class="c-pred">${fmt(this.predictedX, 1)} m</b></div>
          <div><span>Actual landing</span><b class="c-bg">${fmt(actualX, 1)} m</b></div>
          <div><span>Prediction error</span><b>${fmt(Math.abs(error), 1)} m <small>(${fmt(relative * 100, 1)}% of W)</small></b></div>
        </div>
        <p class="verdict">${verdict}</p>`;
    }

    cancel() {
      if (this.phase === 'off') return;
      const scene = this.app.riverScene;
      this.phase = 'off';
      scene.predictionMarker.visible = false;
      scene.predictionGhost.visible = false;
      scene.renderer.domElement.style.cursor = '';
      this.app.ui.setBusy('btn-predict', false);
      this.app.ui.hideBanner();
      this.app.markMathDirty();
    }
  }

  RV.LearningMode = LearningMode;
  RV.VectorAdditionDemo = VectorAdditionDemo;
  RV.PredictionExperiment = PredictionExperiment;
})(window.RV);
