/* =============================================================================
 * script.js — Application entry point.
 *
 * Owns the state (parameters, playback, toggles, modes) and runs the
 * animation loop. Physics (js/physics.js), drawing (js/scene.js,
 * js/vectors.js) and DOM (js/ui.js) are kept separate; this file connects
 * them.
 *
 * Every frame:
 *   1. Δt_sim = Δt_real × playback speed   (frame-rate independent)
 *   2. simulation.step(Δt_sim, V_bg)       r ← r + V_bg Δt
 *   3. draw the boat, vectors, paths and HUD from the same solution object
 * ============================================================================= */
(function (RV) {
  'use strict';

  const { Physics, Geo } = RV;
  const $ = (id) => document.getElementById(id);
  const fmt = RV.fmt;
  const tex = RV.tex;
  const n = RV.texNumber;

  class RiverCrossingApp {
    constructor() {
      this.params = { ...Physics.DEFAULT_PARAMETERS };
      this.solution = Physics.solveCrossing(this.params);
      this.status = 'ready';
      this.playbackSpeed = 1;
      this.activeCase = 'perpendicular';
      this.caseHighlight = null;
      this.simulationCheck = null;
      this.mathDirty = true;
      this.lastFrameTime = performance.now();
      this.displayTime = 0;

      this.toggles = {
        vectors: true,
        components: false,
        triangle: false,
        trajectory: true,
        predicted: true,
        heading: true,
        axes: true,
        equations: true,
        labels: true,
        particles: true,
        grid: false,
      };
      // Smoothly animated presentation values (triangle slide-in)
      this.wgShift = 0;
      this.parallelogramAlpha = 0;

      this.simulation = new Physics.CrossingSimulation(this.params.riverWidth);
      this.riverScene = new RV.RiverScene($('scene-host'));
      this.riverScene.setRiverWidth(this.params.riverWidth);
      this.overlay = new RV.VectorOverlay(this.riverScene);

      this.ui = new RV.UIController(this.createHandlers());
      this.learning = new RV.LearningMode(this);
      this.demo = new RV.VectorAdditionDemo(this);
      this.prediction = new RV.PredictionExperiment(this);

      this.bindScenePointer();
      this.applyToggles();
      this.ui.setParameters(this.params);
      this.ui.setSpeed(this.playbackSpeed);
      this.ui.setStatus(this.status);
      this.ui.setFollow(false);
      this.refreshCaseInfo();
      this.riverScene.view3D(this.cameraFrame(), true);
      // Keep the legend collapsed when the 3D view is narrow
      if ($('viewport').clientWidth < 1100) $('hud-legend').querySelector('details').open = false;
      this.showWelcome();

      this.loop = this.loop.bind(this);
      requestAnimationFrame(this.loop);
    }

    // -------------------------------------------------------------------------
    // UI handlers
    // -------------------------------------------------------------------------
    createHandlers() {
      return {
        onParameterInput: (partial) => this.setParameters(partial, 'user'),
        onHeadingNudge: (delta) => this.setParameters({ heading: this.params.heading + delta }, 'user'),
        onPlayPause: () => (this.status === 'running' ? this.pause() : this.play()),
        onReset: () => this.resetSimulation(),
        onReplay: () => {
          this.resetSimulation();
          this.play();
        },
        onSpeed: (speed) => {
          // Playback speed only scales how fast time is *displayed*; the physics
          // (velocities, crossing time, landing point) are unchanged.
          this.playbackSpeed = speed;
          this.ui.setSpeed(speed);
        },
        onToggle: (name, value) => {
          this.toggles[name] = value;
          this.applyToggles();
        },
        onCase: (caseId) => this.applyCase(caseId),
        onCamera: (action) => this.handleCamera(action),
        onLearningToggle: (force) => {
          const enable = typeof force === 'boolean' ? force : !this.learning.active;
          if (enable) {
            if (this.demo.active) this.demo.cancel();
            this.learning.start();
          } else {
            this.learning.stop();
          }
        },
        onLearningStep: (delta) => this.learning.go(delta),
        onExplain: () => (this.demo.active ? this.demo.cancel() : this.demo.start()),
        onPredict: () => (this.prediction.phase === 'picking' ? this.prediction.cancel() : this.prediction.start()),
        onEscape: () => {
          if (this.demo.active) this.demo.cancel();
          else if (this.prediction.phase === 'picking') this.prediction.cancel();
          else if (this.learning.active) this.learning.stop();
          else this.ui.hideResult();
        },
      };
    }

    bindScenePointer() {
      const canvas = this.riverScene.renderer.domElement;
      let downX = 0;
      let downY = 0;
      canvas.addEventListener('pointerdown', (event) => {
        downX = event.clientX;
        downY = event.clientY;
      });
      canvas.addEventListener('pointermove', (event) => this.prediction.onPointerMove(event));
      canvas.addEventListener('pointerup', (event) => {
        // A click (not an orbit drag) places the prediction.
        if (Math.hypot(event.clientX - downX, event.clientY - downY) < 6) this.prediction.onClick(event);
      });
    }

    // -------------------------------------------------------------------------
    // Parameters and cases
    // -------------------------------------------------------------------------

    /**
     * Validate and apply new parameters, then re-solve the problem. Velocity
     * changes during a crossing take effect immediately (the trajectory bends);
     * a width change restarts the crossing because the geometry changes.
     */
    setParameters(partial, source = 'user') {
      const previous = this.params;
      const next = Physics.sanitizeParameters({ ...previous, ...partial }, previous);
      const changedKeys = Object.keys(next).filter((key) => next[key] !== previous[key]);

      // Case 3 keeps "aim for the opposite point" while speeds change.
      if (source === 'user' && this.activeCase === 'opposite' && !changedKeys.includes('heading') && changedKeys.length > 0) {
        const target = Physics.calculateDirectOppositeHeading(next.boatSpeed, next.riverSpeed, next.riverWidth);
        if (target.possible) next.heading = Math.round(target.heading * 100) / 100;
      }
      // A manual heading change leaves the textbook presets.
      if (source === 'user' && changedKeys.includes('heading')) {
        const stillPerpendicular = next.heading === 90 && (this.activeCase === 'perpendicular' || this.activeCase === 'shortest');
        if (!stillPerpendicular && this.activeCase !== 'custom') {
          this.activeCase = 'custom';
          this.caseHighlight = null;
        }
      }

      this.params = next;
      this.solution = Physics.solveCrossing(next);

      if (changedKeys.includes('riverWidth')) {
        this.riverScene.setRiverWidth(next.riverWidth);
        this.resetSimulation();
      } else if (this.status === 'finished' && changedKeys.length > 0) {
        this.resetSimulation();
      }

      this.ui.setParameters(next);
      this.refreshCaseInfo();
      this.markMathDirty();
    }

    markMathDirty() {
      this.mathDirty = true;
    }

    applyCase(caseId) {
      if (this.demo.active) this.demo.cancel();
      this.prediction.cancel();
      this.ui.hideResult();
      this.activeCase = caseId;
      const p = this.params;
      const boatSpeed = p.boatSpeed > 0 ? p.boatSpeed : Physics.DEFAULT_PARAMETERS.boatSpeed;

      switch (caseId) {
        case 'perpendicular':
          this.setParameters({ heading: 90, boatSpeed }, 'case');
          this.caseHighlight = { keys: ['bw', 'bg', 'trail'], until: this.displayTime + 6 };
          break;
        case 'shortest':
          this.setParameters({ heading: 90, boatSpeed }, 'case');
          this.setToggle('components', true);
          this.caseHighlight = { keys: ['vy'], until: this.displayTime + 7 };
          break;
        case 'opposite': {
          const target = Physics.calculateDirectOppositeHeading(boatSpeed, p.riverSpeed, p.riverWidth);
          if (target.possible) this.setParameters({ heading: Math.round(target.heading * 100) / 100, boatSpeed }, 'case');
          else this.setParameters({ boatSpeed }, 'case');
          this.setToggle('components', true);
          this.setToggle('triangle', false);
          this.caseHighlight = target.possible ? { keys: ['vx', 'wg'], until: this.displayTime + 8 } : null;
          break;
        }
        default:
          this.caseHighlight = null;
          break;
      }
      this.resetSimulation();
      this.refreshCaseInfo();
      this.riverScene.view3D(this.cameraFrame());
    }

    setToggle(name, value) {
      this.toggles[name] = value;
      this.applyToggles();
    }

    /** Explanation shown under the case buttons, with live numbers. */
    refreshCaseInfo() {
      const s = this.solution;
      const { riverWidth: W, riverSpeed: u, boatSpeed: v, heading } = s.params;
      let html = '';
      switch (this.activeCase) {
        case 'perpendicular': {
          const x = s.displacementX;
          html = `<h4>Case 1 · Point straight across</h4>
            <p>The nose (<span class="c-bw">orange</span>) points at the red flag directly opposite, but the current adds <span class="c-wg">V<sub>wg</sub></span>. The actual motion (<span class="c-bg">pink</span>) is diagonal.</p>
            <p class="key-idea">Boat direction ≠ actual motion direction</p>
            ${s.canCross ? `<p>It lands <b>${fmt(Math.abs(x), 2)} m ${x >= 0 ? 'downstream' : 'upstream'}</b> after <b>${fmt(s.crossingTime, 2)} s</b>.</p>` : ''}`;
          break;
        }
        case 'shortest':
          html = `<h4>Case 2 · Shortest-time crossing</h4>
            <p>Only the across component <span class="c-across">V<sub>y</sub> = v sin θ</span> carries the boat to the other bank. It is largest at θ = 90°, so pointing straight across is fastest. The current only adds drift.</p>
            <div class="info-eq">${tex(`t_{cross} = \\dfrac{W}{V_{across}} = \\dfrac{${n(W, 0)}}{${n(v)}} = ${n(s.shortestTime.time)}\\,\\text{s}`)}</div>`;
          break;
        case 'opposite': {
          const d = s.directOpposite;
          if (d.possible) {
            html = `<h4>Case 3 · Reach the point directly opposite</h4>
              <p>Point upstream so the boat's upstream component cancels the current:</p>
              <div class="info-eq">${tex(`v_x + u = 0 \\;\\Rightarrow\\; \\theta = \\arccos\\!\\left(-\\tfrac{u}{v}\\right) = ${n(d.heading, 2)}^\\circ`)}</div>
              <p><span class="c-boatx">v<sub>x</sub> = ${fmt(s.boatVelocity.x)} m/s</span> and <span class="c-wg">u = +${fmt(u)} m/s</span> are equal and opposite, so the resultant's horizontal velocity is <b>0</b>. Crossing takes <b>${fmt(d.time, 2)} s</b>, longer than the shortest ${fmt(s.shortestTime.time, 2)} s.</p>`;
          } else {
            html = `<h4>Case 3 · Reach the point directly opposite</h4>
              <div class="callout warning"><b>Direct-opposite crossing is impossible for these parameters.</b><br>${d.reason}</div>
              ${s.minimumDrift ? `<p>Best possible: θ = ${fmt(s.minimumDrift.heading, 1)}° gives the least drift, ${fmt(s.minimumDrift.drift, 1)} m downstream.</p>` : ''}`;
          }
          break;
        }
        case 'custom':
          html = `<h4>Case 4 · User defined</h4>
            <p>Set any speeds and heading (θ = ${fmt(heading, 1)}°). Before pressing Play, try <b>Predict Landing</b>: click where you think the boat will reach, then check.</p>`;
          break;
      }
      this.ui.setActiveCase(this.activeCase, html);
    }

    // -------------------------------------------------------------------------
    // Playback
    // -------------------------------------------------------------------------
    play() {
      if (this.demo.active) return;
      if (this.prediction.phase === 'picking') this.prediction.cancel();
      if (this.status === 'finished') this.resetSimulation();
      if (this.welcomeVisible) {
        this.ui.hideBanner();
        this.welcomeVisible = false;
      }
      this.ui.hideResult();
      this.status = 'running';
      this.ui.setStatus(this.status);
    }

    pause() {
      if (this.status !== 'running') return;
      this.status = 'paused';
      this.ui.setStatus(this.status);
    }

    resetSimulation() {
      this.simulation.reset(this.params.riverWidth);
      this.status = 'ready';
      this.simulationCheck = null;
      this.ui.setStatus(this.status);
      this.ui.hideResult();
      if (this.prediction.phase === 'placed' || this.prediction.phase === 'done') this.prediction.cancel();
      this.markMathDirty();
    }

    /** The boat reached the far bank (or the run timed out). */
    onCrossingComplete() {
      const sim = this.simulation;
      this.status = 'finished';
      this.ui.setStatus(this.status);

      if (sim.timedOut) {
        this.ui.showBanner(`Stopped after ${fmt(Physics.MAX_SIMULATION_TIME, 0)} s. With V<sub>y</sub> = ${fmt(this.solution.resultantVelocity.y)} m/s the boat cannot reach the opposite bank in a reasonable time.`, [{ label: 'OK', onClick: () => this.ui.hideBanner() }], 'warning');
        return;
      }

      // Length of the actual (possibly bent) path
      const vertices = [...sim.pathVertices, sim.position];
      let pathLength = 0;
      for (let i = 1; i < vertices.length; i++) pathLength += Math.hypot(vertices[i].x - vertices[i - 1].x, vertices[i].y - vertices[i - 1].y);

      const x = sim.position.x;
      const direction = Math.abs(x) < 0.005 ? 'Displacement along the bank' : x > 0 ? 'Downstream displacement' : 'Upstream displacement';
      const agrees = !sim.velocityChangedDuringRun && Math.abs(sim.time - this.solution.crossingTime) < 1e-6 * Math.max(1, this.solution.crossingTime);
      this.simulationCheck = { time: sim.time, x, agrees };

      const comparison = this.prediction.complete(x);
      this.ui.showResult({
        title: 'Crossing completed ✓',
        rows: [
          ['Crossing time', `${fmt(sim.time, 2)} s`],
          [direction, `${fmt(Math.abs(x), 2)} m`],
          ['Resultant speed |V<sub>bg</sub>|', `${fmt(this.solution.groundSpeed, 2)} m/s`],
          ['Distance travelled', `${fmt(pathLength, 2)} m`],
        ],
        comparison,
        note: sim.velocityChangedDuringRun ? 'You changed the velocities during the crossing, so the path is made of straight pieces.' : `Exactly as predicted by t = W / V<sub>y</sub> and x = V<sub>x</sub> t.`,
      });
      this.markMathDirty();
    }

    // -------------------------------------------------------------------------
    // Camera
    // -------------------------------------------------------------------------
    cameraFrame() {
      const xs = [this.simulation.position.x];
      if (this.solution.landing) xs.push(this.solution.landing.x);
      return this.riverScene.computeFrame(xs);
    }

    handleCamera(action) {
      const scene = this.riverScene;
      if (action === 'follow') {
        scene.followBoat = !scene.followBoat;
        this.ui.setFollow(scene.followBoat);
        return;
      }
      if (action === 'top') scene.viewTop(this.cameraFrame());
      else {
        if (action === 'reset') {
          scene.followBoat = false;
          this.ui.setFollow(false);
        }
        scene.view3D(this.cameraFrame());
      }
    }

    // -------------------------------------------------------------------------
    // Display toggles
    // -------------------------------------------------------------------------
    applyToggles() {
      const scene = this.riverScene;
      const t = this.toggles;
      scene.axesGroup.visible = t.axes;
      scene.rulerGroup.visible = t.axes;
      scene.directionLabels.visible = t.axes;
      scene.gridGroup.visible = t.grid;
      RV.Labels.enabled = t.labels;
      this.ui.setToggles(t);
    }

    showWelcome() {
      this.welcomeVisible = true;
      this.ui.showBanner(
        '<div class="banner-kicker">Start here</div>The boat <b>points straight across</b> the river. Where will it actually go? Press <b>▶ Play</b> and watch the pink trail.',
        [
          { label: '▶ Play', primary: true, onClick: () => this.play() },
          { label: 'Dismiss', onClick: () => { this.ui.hideBanner(); this.welcomeVisible = false; } },
        ],
        'info'
      );
    }

    // -------------------------------------------------------------------------
    // Animation loop
    // -------------------------------------------------------------------------

    /** Combine toggles, learning mode, case highlights and the demo into one visual state. */
    computePresentation(realDt) {
      const step = this.learning.step;
      const triangleOn = step ? step.triangle : this.toggles.triangle;
      const approach = (current, target) => current + (target - current) * Math.min(1, realDt * 4);
      this.wgShift = approach(this.wgShift, triangleOn ? 1 : 0);
      this.parallelogramAlpha = approach(this.parallelogramAlpha, triangleOn ? 1 : 0);

      const presentation = {
        bwScale: 1,
        wgScale: 1,
        bgScale: 1,
        wgShift: this.wgShift,
        parallelogram: this.parallelogramAlpha,
        highlight: null,
        forceVectors: false,
        forceComponents: false,
      };
      if (step) {
        presentation.highlight = step.highlight;
        presentation.forceVectors = true;
      } else if (this.caseHighlight) {
        if (this.displayTime < this.caseHighlight.until) presentation.highlight = this.caseHighlight.keys;
        else this.caseHighlight = null;
      }
      if (this.demo.active && this.demo.presentation) {
        Object.assign(presentation, this.demo.presentation);
        presentation.forceVectors = true;
      }
      return presentation;
    }

    /** Predicted straight-line path from where the velocity last changed. */
    computePredictedPath() {
      const sim = this.simulation;
      const V = this.solution.resultantVelocity;
      const lastVertex = sim.pathVertices[sim.pathVertices.length - 1];
      const velocityUnchanged = sim.velocity && sim.velocity.x === V.x && sim.velocity.y === V.y;
      const from = sim.hasStarted && !velocityUnchanged ? { ...sim.position } : { ...lastVertex };
      const landing = Physics.calculateLandingPosition(from, V, this.params.riverWidth);
      if (landing) return { from, to: landing, reaches: true };
      const speed = Physics.magnitude(V);
      if (speed < Physics.EPSILON) return null;
      const reach = 400 / this.riverScene.metresToScene; // a long ray, in metres
      return { from, to: { x: from.x + (V.x / speed) * reach, y: from.y + (V.y / speed) * reach }, reaches: false };
    }

    loop(now) {
      requestAnimationFrame(this.loop);
      // Real elapsed time, clamped so a background tab does not cause a huge jump
      const realDt = Math.min(0.1, Math.max(0, (now - this.lastFrameTime) / 1000));
      this.lastFrameTime = now;
      this.displayTime += realDt;
      const simDt = realDt * this.playbackSpeed;

      // 1. Physics: r ← r + V_bg Δt
      if (this.status === 'running') {
        const completed = this.simulation.step(simDt, this.solution.resultantVelocity);
        if (completed) this.onCrossingComplete();
      }

      // 2. Educational modes
      this.demo.update(realDt);
      const presentation = this.computePresentation(realDt);
      const step = this.learning.step;

      // 3. Scene. The water flows with simulated time, so it freezes when paused.
      const scene = this.riverScene;
      scene.particleGroup.visible = this.toggles.particles || !!(step && step.particles);
      scene.observer.visible = !!(step && step.observer);
      const waterDt = this.status === 'paused' ? 0 : simDt;
      scene.updateWater(waterDt, this.params.riverSpeed, realDt);
      this.updateBoatPosition();

      const hideAnswer = this.prediction.hidesAnswer;
      const predictedPath = this.computePredictedPath();
      this.overlay.update({
        solution: this.solution,
        boatPosition: this.simulation.position,
        pathVertices: this.simulation.pathVertices,
        predictedPath,
        toggles: this.toggles,
        presentation,
        time: this.displayTime,
        hidePrediction: hideAnswer,
      });
      const showLanding = this.toggles.predicted && !hideAnswer && predictedPath && predictedPath.reaches;
      scene.setLandingMarker(showLanding ? predictedPath.to : null);
      // Avoid two overlapping labels when the landing point is the opposite point
      RV.Labels.setVisible(scene.oppositeLabel, !(showLanding && Math.abs(predictedPath.to.x * scene.metresToScene) < 5));
      if (showLanding) {
        const x = predictedPath.to.x;
        const where = Math.abs(x) < 0.05 ? 'directly opposite' : `${fmt(Math.abs(x), 1)} m ${x > 0 ? 'downstream' : 'upstream'}`;
        RV.Labels.setText(scene.landingLabel, `Predicted landing<br><b>x = ${fmt(x, 1)} m</b><small>${where}</small>`);
      }

      // 4. Numbers
      this.ui.updateLiveInfo({
        time: this.simulation.time,
        position: this.simulation.position,
        riverWidth: this.params.riverWidth,
        solution: this.solution,
        hidden: false,
      });
      if (this.mathDirty) {
        this.mathDirty = false;
        this.updateMathPanel();
      }

      // 5. Camera and render
      scene.updateCamera(realDt, scene.boat.position);
      scene.render();
    }

    /** Boat position follows V_bg (ground frame); its nose follows θ (V_bw). */
    updateBoatPosition() {
      this.riverScene.updateBoatPosition(this.simulation.position, this.params.heading);
    }

    updateMathPanel() {
      this.ui.updateMathPanel(this.solution, this.simulationCheck, this.prediction.hidesAnswer);
      this.ui.updateEquationHud(this.solution);
      this.ui.setDialSolution(this.solution);
      if (this.learning.active) this.learning.render();
    }
  }

  // Start once the DOM and libraries are ready
  window.addEventListener('DOMContentLoaded', () => {
    if (!window.THREE || !THREE.OrbitControls || !THREE.CSS2DRenderer) {
      document.body.classList.add('load-error');
      const box = document.getElementById('load-error');
      if (box) box.hidden = false;
      return;
    }
    try {
      window.app = new RiverCrossingApp();
    } catch (error) {
      console.error(error);
      const box = document.getElementById('load-error');
      if (box) {
        box.hidden = false;
        box.querySelector('p').textContent = 'The 3D view could not start: ' + error.message;
      }
    }
  });
})(window.RV);
