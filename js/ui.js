/* =============================================================================
 * ui.js — DOM side of the app: parameter controls, heading dial, playback
 * buttons, toggles, the "Live Vector Mathematics" panel, the HUD, banners
 * and result cards.
 *
 * The UI never computes physics itself. It displays a `solution` object
 * produced by RV.Physics.solveCrossing() and reports user input back to the
 * app through handler callbacks.
 * ============================================================================= */
window.RV = window.RV || {};

(function (RV) {
  'use strict';

  const { Physics, Geo } = RV;
  const $ = (id) => document.getElementById(id);
  const fmt = RV.fmt;

  // ---------------------------------------------------------------------------
  // KaTeX helpers
  // ---------------------------------------------------------------------------
  const COLOR = {
    bw: Geo.cssColor(Geo.COLORS.boatWater),
    wg: Geo.cssColor(Geo.COLORS.river),
    bg: Geo.cssColor(Geo.COLORS.resultant),
    across: Geo.cssColor(Geo.COLORS.across),
  };

  /**
   * Shorthands expanded before rendering. (Done as plain string substitution
   * because '#' in hex colours is not allowed inside KaTeX macro bodies.)
   */
  const SHORTHANDS = [
    [/\\Vbw/g, `\\textcolor{${COLOR.bw}}{\\vec{V}_{bw}}`],
    [/\\Vwg/g, `\\textcolor{${COLOR.wg}}{\\vec{V}_{wg}}`],
    [/\\Vbg/g, `\\textcolor{${COLOR.bg}}{\\vec{V}_{bg}}`],
    [/\\unit\{([^}]*)\}/g, '\\,\\text{$1}'],
  ];

  function tex(source, displayMode = false) {
    const expanded = SHORTHANDS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), source);
    if (!window.katex) return `<code>${expanded}</code>`;
    try {
      return katex.renderToString(expanded, { throwOnError: false, displayMode });
    } catch (error) {
      return `<code>${source}</code>`;
    }
  }

  /** Number for TeX: fixed digits, no "-0.00", minus sign handled by KaTeX. */
  const n = (value, digits = 2) => {
    if (!Number.isFinite(value)) return '\\infty';
    const v = Math.abs(value) < 0.5 * Math.pow(10, -digits) ? 0 : value;
    return v.toFixed(digits);
  };
  /** Parenthesise negative numbers when they appear inside a sum or product. */
  const p = (value, digits = 2) => (Number.isFinite(value) && value < -0.5 * Math.pow(10, -digits) ? `(${n(value, digits)})` : n(value, digits));

  // ---------------------------------------------------------------------------
  // Heading dial — drag to rotate the boat heading θ ∈ [0°, 180°]
  // ---------------------------------------------------------------------------
  class HeadingDial {
    constructor(svg, onChange) {
      this.svg = svg;
      this.onChange = onChange;
      this.cx = 120;
      this.cy = 112;
      this.radius = 86;
      this.build();
      this.bind();
    }

    point(angleDeg, radius) {
      const a = (angleDeg * Math.PI) / 180;
      return [this.cx + radius * Math.cos(a), this.cy - radius * Math.sin(a)];
    }

    arcPath(fromDeg, toDeg, radius) {
      const [x0, y0] = this.point(fromDeg, radius);
      const [x1, y1] = this.point(toDeg, radius);
      const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
      const sweep = toDeg > fromDeg ? 0 : 1;
      return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${radius} ${radius} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    }

    build() {
      const { cx, cy, radius } = this;
      let ticks = '';
      for (let a = 0; a <= 180; a += 15) {
        const major = a % 45 === 0;
        const [x0, y0] = this.point(a, radius - (major ? 9 : 5));
        const [x1, y1] = this.point(a, radius);
        ticks += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" class="dial-tick${major ? ' major' : ''}"/>`;
      }
      this.svg.innerHTML = `
        <defs>
          <marker id="dial-head-river" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${COLOR.wg}"/></marker>
          <marker id="dial-head-boat" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${COLOR.bw}"/></marker>
          <marker id="dial-head-res" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${COLOR.bg}"/></marker>
        </defs>
        <path d="${this.arcPath(0, 180, radius)}" class="dial-track"/>
        ${ticks}
        <line x1="${cx - radius - 6}" y1="${cy}" x2="${cx + radius + 6}" y2="${cy}" class="dial-axis"/>
        <text x="${cx + radius + 4}" y="${cy + 15}" class="dial-text" text-anchor="end">0° downstream</text>
        <text x="${cx - radius - 4}" y="${cy + 15}" class="dial-text" text-anchor="start">180° upstream</text>
        <text x="${cx}" y="${cy - radius - 17}" class="dial-text" text-anchor="middle">90° across</text>
        <line x1="${cx - 54}" y1="${cy + 30}" x2="${cx + 54}" y2="${cy + 30}" stroke="${COLOR.wg}" stroke-width="3" marker-end="url(#dial-head-river)"/>
        <text x="${cx}" y="${cy + 44}" class="dial-text river" text-anchor="middle">river current (+x)</text>
        <path class="dial-theta-arc" id="dial-theta-arc"/>
        <line id="dial-result" class="dial-result" x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy}" marker-end="url(#dial-head-res)"/>
        <line id="dial-heading" class="dial-heading" x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy}" marker-end="url(#dial-head-boat)"/>
        <circle cx="${cx}" cy="${cy}" r="4" class="dial-center"/>
        <circle id="dial-handle" class="dial-handle" r="9" cx="${cx}" cy="${cy}"/>
        <text id="dial-theta-label" class="dial-theta-label" x="${cx}" y="${cy}" text-anchor="middle">θ</text>
      `;
      this.headingLine = this.svg.querySelector('#dial-heading');
      this.resultLine = this.svg.querySelector('#dial-result');
      this.handle = this.svg.querySelector('#dial-handle');
      this.thetaArc = this.svg.querySelector('#dial-theta-arc');
      this.thetaLabel = this.svg.querySelector('#dial-theta-label');
    }

    bind() {
      let dragging = false;
      const angleFromEvent = (event) => {
        const rect = this.svg.getBoundingClientRect();
        const viewBox = this.svg.viewBox.baseVal;
        const x = ((event.clientX - rect.left) / rect.width) * viewBox.width;
        const y = ((event.clientY - rect.top) / rect.height) * viewBox.height;
        let angle = (Math.atan2(this.cy - y, x - this.cx) * 180) / Math.PI;
        if (angle < 0) angle = angle < -90 ? 180 : 0; // below the axis: snap to the nearest end
        const step = event.shiftKey ? 5 : Physics.LIMITS.heading.step;
        return Math.round(angle / step) * step;
      };
      this.svg.addEventListener('pointerdown', (event) => {
        dragging = true;
        this.svg.setPointerCapture(event.pointerId);
        this.onChange(angleFromEvent(event));
        event.preventDefault();
      });
      this.svg.addEventListener('pointermove', (event) => {
        if (dragging) this.onChange(angleFromEvent(event));
      });
      const stop = () => (dragging = false);
      this.svg.addEventListener('pointerup', stop);
      this.svg.addEventListener('pointercancel', stop);
    }

    /** Show heading θ and the actual direction φ (normalised length). */
    update(headingDeg, resultantDeg) {
      const [hx, hy] = this.point(headingDeg, this.radius - 14);
      this.headingLine.setAttribute('x2', hx);
      this.headingLine.setAttribute('y2', hy);
      const [kx, ky] = this.point(headingDeg, this.radius);
      this.handle.setAttribute('cx', kx);
      this.handle.setAttribute('cy', ky);
      this.thetaArc.setAttribute('d', headingDeg > 0.2 ? this.arcPath(0, headingDeg, 26) : '');
      const [lx, ly] = this.point(headingDeg / 2, 38);
      this.thetaLabel.setAttribute('x', lx);
      this.thetaLabel.setAttribute('y', ly + 4);
      if (Number.isFinite(resultantDeg)) {
        const [rx, ry] = this.point(resultantDeg, this.radius - 30);
        this.resultLine.setAttribute('x2', rx);
        this.resultLine.setAttribute('y2', ry);
        this.resultLine.style.display = '';
      } else {
        this.resultLine.style.display = 'none';
      }
    }
  }

  // ---------------------------------------------------------------------------
  // UIController
  // ---------------------------------------------------------------------------
  const PARAMETER_INPUTS = [
    { key: 'riverWidth', range: 'in-width', number: 'num-width', digits: 0 },
    { key: 'riverSpeed', range: 'in-river', number: 'num-river', digits: 1 },
    { key: 'boatSpeed', range: 'in-boat', number: 'num-boat', digits: 1 },
    { key: 'heading', range: 'in-heading', number: 'num-heading', digits: 1 },
  ];

  const TOGGLES = ['vectors', 'components', 'triangle', 'trajectory', 'predicted', 'heading', 'axes', 'equations', 'labels', 'particles', 'grid'];

  class UIController {
    constructor(handlers) {
      this.handlers = handlers;
      this.cache = {};
      this.bindParameters();
      this.bindPlayback();
      this.bindToggles();
      this.bindCases();
      this.bindCamera();
      this.bindTopbar();
      this.bindKeyboard();
      this.headingDial = new HeadingDial($('heading-dial'), (angle) => handlers.onParameterInput({ heading: angle }));
    }

    // ----- binding -----------------------------------------------------------

    bindParameters() {
      const limits = { riverWidth: Physics.LIMITS.riverWidth, riverSpeed: Physics.LIMITS.riverSpeed, boatSpeed: Physics.LIMITS.boatSpeed, heading: Physics.LIMITS.heading };
      for (const def of PARAMETER_INPUTS) {
        const range = $(def.range);
        const number = $(def.number);
        const limit = limits[def.key];
        for (const el of [range, number]) {
          el.min = limit.min;
          el.max = limit.max;
          el.step = limit.step;
        }
        range.addEventListener('input', () => this.handlers.onParameterInput({ [def.key]: Number(range.value) }));
        const commit = () => {
          const value = Number(number.value);
          if (number.value.trim() === '' || !Number.isFinite(value)) {
            number.classList.add('invalid');
            setTimeout(() => number.classList.remove('invalid'), 600);
            this.handlers.onParameterInput({}); // re-sync to the last valid value
            return;
          }
          this.handlers.onParameterInput({ [def.key]: value });
        };
        number.addEventListener('change', commit);
        number.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            commit();
            number.blur();
          }
        });
      }
      document.querySelectorAll('[data-heading-nudge]').forEach((button) => {
        button.addEventListener('click', () => this.handlers.onHeadingNudge(Number(button.dataset.headingNudge)));
      });
    }

    bindPlayback() {
      $('btn-play').addEventListener('click', () => this.handlers.onPlayPause());
      $('btn-reset').addEventListener('click', () => this.handlers.onReset());
      document.querySelectorAll('[data-speed]').forEach((button) => {
        button.addEventListener('click', () => this.handlers.onSpeed(Number(button.dataset.speed)));
      });
    }

    bindToggles() {
      for (const name of TOGGLES) {
        const input = $('tg-' + name);
        if (input) input.addEventListener('change', () => this.handlers.onToggle(name, input.checked));
      }
    }

    bindCases() {
      document.querySelectorAll('[data-case]').forEach((button) => {
        button.addEventListener('click', () => this.handlers.onCase(button.dataset.case));
      });
    }

    bindCamera() {
      $('cam-reset').addEventListener('click', () => this.handlers.onCamera('reset'));
      $('cam-3d').addEventListener('click', () => this.handlers.onCamera('3d'));
      $('cam-top').addEventListener('click', () => this.handlers.onCamera('top'));
      $('cam-follow').addEventListener('click', () => this.handlers.onCamera('follow'));
    }

    bindTopbar() {
      $('btn-learning').addEventListener('click', () => this.handlers.onLearningToggle());
      $('btn-explain').addEventListener('click', () => this.handlers.onExplain());
      $('btn-predict').addEventListener('click', () => this.handlers.onPredict());
      $('learn-prev').addEventListener('click', () => this.handlers.onLearningStep(-1));
      $('learn-next').addEventListener('click', () => this.handlers.onLearningStep(+1));
      $('learn-close').addEventListener('click', () => this.handlers.onLearningToggle(false));
      $('result-close').addEventListener('click', () => this.hideResult());
      $('result-replay').addEventListener('click', () => {
        this.hideResult();
        this.handlers.onReplay();
      });
    }

    bindKeyboard() {
      window.addEventListener('keydown', (event) => {
        const tag = (event.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || event.ctrlKey || event.metaKey || event.altKey) return;
        const key = event.key.toLowerCase();
        if (key === ' ' && tag !== 'button') {
          event.preventDefault();
          this.handlers.onPlayPause();
        } else if (key === 'r') this.handlers.onReset();
        else if (key === 't') this.handlers.onCamera('top');
        else if (key === 'v') this.handlers.onCamera('3d');
        else if (key === 'escape') this.handlers.onEscape();
      });
    }

    // ----- state → DOM ---------------------------------------------------------

    setParameters(params) {
      for (const def of PARAMETER_INPUTS) {
        const value = params[def.key];
        const range = $(def.range);
        const number = $(def.number);
        if (Number(range.value) !== value) range.value = value;
        if (document.activeElement !== number) number.value = value.toFixed(def.digits);
        range.style.setProperty('--fill', `${((value - range.min) / (range.max - range.min)) * 100}%`);
      }
      const heading = params.heading;
      const offset = heading - 90;
      let description = 'pointing straight across';
      if (Math.abs(offset) >= 0.05) {
        description = `${fmt(Math.abs(offset), 1)}° ${offset > 0 ? 'upstream' : 'downstream'} of straight across`;
      }
      this.setText('heading-description', description);
    }

    setDialSolution(solution) {
      this.headingDial.update(solution.params.heading, solution.resultantDirection);
    }

    setStatus(status) {
      const play = $('btn-play');
      const running = status === 'running';
      play.classList.toggle('is-playing', running);
      play.setAttribute('aria-label', running ? 'Pause' : 'Play');
      play.querySelector('.label').textContent = running ? 'Pause' : status === 'finished' ? 'Replay' : status === 'paused' ? 'Resume' : 'Play';
      const statusText = { ready: 'Ready', running: 'Running', paused: 'Paused', finished: 'Crossing completed' }[status] || status;
      const pill = $('hud-status');
      pill.textContent = statusText;
      pill.dataset.status = status;
    }

    setSpeed(speed) {
      document.querySelectorAll('[data-speed]').forEach((button) => {
        button.classList.toggle('active', Number(button.dataset.speed) === speed);
        button.setAttribute('aria-pressed', Number(button.dataset.speed) === speed ? 'true' : 'false');
      });
    }

    setToggles(toggles) {
      for (const name of TOGGLES) {
        const input = $('tg-' + name);
        if (input) input.checked = !!toggles[name];
      }
      $('hud-equation').classList.toggle('hidden', !toggles.equations);
      document.body.classList.toggle('hide-scene-labels', !toggles.labels);
    }

    setFollow(active) {
      $('cam-follow').classList.toggle('active', active);
      $('cam-follow').setAttribute('aria-pressed', active ? 'true' : 'false');
    }

    setActiveCase(caseId, html) {
      document.querySelectorAll('[data-case]').forEach((button) => button.classList.toggle('active', button.dataset.case === caseId));
      const info = $('case-info');
      info.innerHTML = html || '';
      info.hidden = !html;
    }

    setLearningActive(active) {
      $('btn-learning').classList.toggle('active', active);
      $('btn-learning').setAttribute('aria-pressed', active ? 'true' : 'false');
    }

    setText(id, text) {
      if (this.cache[id] === text) return;
      this.cache[id] = text;
      const el = $(id);
      if (el) el.textContent = text;
    }

    /** Real-time numbers in the viewport HUD (called every frame; cheap). */
    updateLiveInfo({ time, position, riverWidth, solution, hidden }) {
      const mask = (text) => (hidden ? '?' : text);
      this.setText('hud-time', `${fmt(time, 2)} s`);
      this.setText('hud-across', `${fmt(position.y, 1)} m`);
      const x = position.x;
      this.setText('hud-down-label', x < -0.05 ? 'Upstream displacement' : 'Downstream displacement');
      this.setText('hud-down', `${fmt(Math.abs(x) < 0.05 ? 0 : Math.abs(x), 1)} m`);
      this.setText('hud-vbw', `${fmt(solution.params.boatSpeed)} m/s`);
      this.setText('hud-vwg', `${fmt(solution.params.riverSpeed)} m/s`);
      this.setText('hud-vbg', mask(`${fmt(solution.groundSpeed)} m/s`));
      this.setText('hud-remaining', `${fmt(Math.max(0, riverWidth - position.y), 1)} m`);
      const progress = Math.min(1, Math.max(0, position.y / riverWidth));
      const bar = $('hud-progress');
      const width = `${(progress * 100).toFixed(1)}%`;
      if (bar.style.width !== width) bar.style.width = width;
    }

    /** Vector equation overlay: V_bg = V_bw + V_wg with live numbers. */
    updateEquationHud(solution) {
      const b = solution.boatVelocity;
      const r = solution.riverVelocity;
      const v = solution.resultantVelocity;
      const col = (x, y) => `\\begin{pmatrix} ${n(x)} \\\\ ${n(y)} \\end{pmatrix}`;
      const phi = Number.isFinite(solution.resultantDirection) ? `${n(solution.resultantDirection, 1)}^\\circ` : '\\text{—}';
      $('hud-equation').innerHTML = `
        <div class="eq-main">${tex('\\Vbg = \\Vbw + \\Vwg')}</div>
        <div class="eq-numbers">${tex(`${col(v.x, v.y)} = ${col(b.x, b.y)} + ${col(r.x, r.y)} \\unit{m/s}`)}</div>
        <div class="eq-sub">${tex(`|\\Vbg| = ${n(solution.groundSpeed)}\\unit{m/s}, \\quad \\varphi = ${phi}`)}</div>`;
    }

    // ----- Live Vector Mathematics ----------------------------------------------

    /**
     * Rebuild the derivation with the current numbers. Called whenever a
     * parameter changes (throttled to once per animation frame by the app).
     */
    updateMathPanel(solution, simulationCheck, hidden) {
      const { riverWidth: W, riverSpeed: u, boatSpeed: v, heading: theta } = solution.params;
      const bv = solution.boatVelocity;
      const V = solution.resultantVelocity;
      const row = (source, note = '') => `<div class="eq-row">${tex(source)}${note ? `<span class="eq-note">${note}</span>` : ''}</div>`;
      const section = (num, title, body, extraClass = '') => `
        <section class="math-section ${extraClass}">
          <h3><span class="step-num">${num}</span>${title}</h3>${body}
        </section>`;

      const parts = [];
      parts.push(section(1, 'Given', [
        row(`W = ${n(W, 0)}\\unit{m}`, 'river width'),
        row(`v = |\\Vbw| = ${n(v)}\\unit{m/s}`, 'boat speed relative to water'),
        row(`u = |\\Vwg| = ${n(u)}\\unit{m/s}`, 'river speed relative to ground'),
        row(`\\theta = ${n(theta, 1)}^\\circ`, 'heading, measured from +x (downstream)'),
      ].join('')));

      parts.push(section(2, 'Boat velocity relative to water', [
        row(`v_x = v\\cos\\theta = ${n(v)}\\cos ${n(theta, 1)}^\\circ = ${n(bv.x)}\\unit{m/s}`),
        row(`v_y = v\\sin\\theta = ${n(v)}\\sin ${n(theta, 1)}^\\circ = ${n(bv.y)}\\unit{m/s}`),
        row(`\\Vbw = (v_x,\\ v_y) = (${n(bv.x)},\\ ${n(bv.y)})\\unit{m/s}`),
      ].join('')));

      parts.push(section(3, 'River velocity relative to ground', [
        row(`u_x = u = ${n(u)}\\unit{m/s}, \\qquad u_y = 0`),
        row(`\\Vwg = (u,\\ 0) = (${n(u)},\\ 0)\\unit{m/s}`),
      ].join('')));

      parts.push(section(4, 'Resultant: vector addition', [
        row('\\Vbg = \\Vbw + \\Vwg', 'boat relative to ground'),
        row(`V_x = v\\cos\\theta + u = ${p(bv.x)} + ${n(u)} = ${n(V.x)}\\unit{m/s}`),
        row(`\\textcolor{${COLOR.across}}{V_y} = v\\sin\\theta = ${n(V.y)}\\unit{m/s}`, 'the river adds nothing across'),
        row(`\\Vbg = (${n(V.x)},\\ ${n(V.y)})\\unit{m/s}`),
      ].join('')));

      const phi = solution.resultantDirection;
      let directionRows;
      if (Number.isFinite(phi)) {
        const drift = solution.driftAngle;
        const driftText = Math.abs(drift) < 0.05 ? 'moving straight across' : `${n(Math.abs(drift), 2)}° ${drift > 0 ? 'downstream' : 'upstream'} of straight across`;
        directionRows = [
          row(`\\varphi = \\operatorname{atan2}(V_y,\\ V_x) = \\operatorname{atan2}(${n(V.y)},\\ ${n(V.x)}) = ${n(phi, 2)}^\\circ`),
          `<div class="eq-note block">Actual motion is ${driftText}; the boat points at θ = ${fmt(theta, 1)}°.</div>`,
        ].join('');
      } else {
        directionRows = `<div class="eq-note block">The resultant is zero: the boat does not move relative to the ground.</div>`;
      }
      parts.push(section(5, 'Magnitude and direction', [
        row(`|\\Vbg| = \\sqrt{V_x^2 + V_y^2} = \\sqrt{${p(V.x)}^2 + ${p(V.y)}^2} = ${n(solution.groundSpeed)}\\unit{m/s}`),
        directionRows,
      ].join(''), hidden ? 'spoiler' : ''));

      let crossingBody;
      if (solution.canCross) {
        const x = solution.displacementX;
        const word = Math.abs(x) < 0.005 ? 'directly opposite' : x > 0 ? 'downstream' : 'upstream';
        crossingBody = [
          row(`t = \\dfrac{W}{\\textcolor{${COLOR.across}}{V_y}} = \\dfrac{${n(W, 0)}}{${n(V.y)}} = ${n(solution.crossingTime)}\\unit{s}`, 'only V_y carries the boat across'),
          row(`x = V_x\\, t = ${p(V.x)} \\times ${n(solution.crossingTime)} = ${n(x)}\\unit{m}`, `${word}`),
          row(`\\text{landing point } = (${n(x)}\\unit{m},\\ ${n(W, 0)}\\unit{m})`),
          row(`s = |\\Vbg|\\, t = ${n(solution.groundSpeed)} \\times ${n(solution.crossingTime)} = ${n(solution.pathLength)}\\unit{m}`, 'distance actually travelled'),
        ].join('');
      } else {
        crossingBody = [
          row(`t = \\dfrac{W}{V_y} = \\dfrac{${n(W, 0)}}{${n(V.y)}} \\to \\infty`),
          `<div class="callout danger">V<sub>y</sub> = 0, so the boat never reaches the opposite bank. Point the boat (at least partly) across the river and give it some speed.</div>`,
        ].join('');
      }
      parts.push(section(6, 'Crossing time and displacement', crossingBody, hidden ? 'spoiler' : ''));

      // Special textbook cases for the current speeds
      const st = solution.shortestTime;
      const d = solution.directOpposite;
      const specialRows = [];
      if (v > 0) {
        specialRows.push(row(`\\text{Shortest time: } \\theta = 90^\\circ,\\ t_{min} = \\dfrac{W}{v} = ${n(st.time)}\\unit{s},\\ x = \\dfrac{uW}{v} = ${n(st.drift)}\\unit{m}`));
      }
      if (d.possible) {
        specialRows.push(row(`\\text{Directly opposite: } v\\cos\\theta + u = 0 \\Rightarrow \\theta = \\arccos\\!\\left(-\\dfrac{u}{v}\\right) = ${n(d.heading, 2)}^\\circ`));
        specialRows.push(row(`t = \\dfrac{W}{\\sqrt{v^2 - u^2}} = ${n(d.time)}\\unit{s}`));
      } else {
        specialRows.push(`<div class="callout warning"><b>Direct-opposite crossing is impossible for these parameters.</b> ${d.reason || ''}</div>`);
        if (solution.minimumDrift) {
          const md = solution.minimumDrift;
          specialRows.push(row(`\\text{Least drift: } \\cos\\theta = -\\dfrac{v}{u} \\Rightarrow \\theta = ${n(md.heading, 2)}^\\circ,\\ x_{min} = \\dfrac{W\\sqrt{u^2 - v^2}}{v} = ${n(md.drift)}\\unit{m}`));
        }
      }
      parts.push(section(7, 'Special cases for these speeds', specialRows.join(''), hidden ? 'spoiler' : ''));

      if (simulationCheck) {
        const ok = simulationCheck.agrees;
        parts.push(section('✓', 'Simulation check', `
          <div class="eq-note block">Integrated with <b>r ← r + V<sub>bg</sub>Δt</b> (Δt from real elapsed time × playback speed):</div>
          ${row(`t_{sim} = ${n(simulationCheck.time, 3)}\\unit{s}, \\quad x_{sim} = ${n(simulationCheck.x, 3)}\\unit{m}`)}
          <div class="callout ${ok ? 'success' : 'warning'}">${ok ? 'Matches the formulas above.' : 'Parameters were changed during the crossing, so the path is no longer one straight line. The formulas describe a crossing with the current values from the start bank.'}</div>`));
      }

      $('math-content').innerHTML = parts.join('');
      $('math-content').classList.toggle('is-hidden', !!hidden);
    }

    // ----- banners and cards -------------------------------------------------

    showBanner(html, actions = [], tone = '') {
      const banner = $('banner');
      $('banner-text').innerHTML = html;
      const container = $('banner-actions');
      container.innerHTML = '';
      for (const action of actions) {
        const button = document.createElement('button');
        button.className = 'btn small' + (action.primary ? ' primary' : '');
        button.textContent = action.label;
        button.addEventListener('click', action.onClick);
        container.appendChild(button);
      }
      banner.dataset.tone = tone;
      banner.hidden = false;
    }

    hideBanner() {
      $('banner').hidden = true;
    }

    showResult({ title, rows, comparison, note }) {
      $('result-title').textContent = title;
      $('result-rows').innerHTML = rows.map(([label, value]) => `<div class="result-row"><span>${label}</span><b>${value}</b></div>`).join('');
      $('result-comparison').innerHTML = comparison || '';
      $('result-comparison').hidden = !comparison;
      $('result-note').innerHTML = note || '';
      $('result-note').hidden = !note;
      $('result-card').hidden = false;
    }

    hideResult() {
      $('result-card').hidden = true;
    }

    showLearningStep(step, index, total) {
      const card = $('learning-card');
      card.hidden = false;
      $('learn-progress').textContent = `Step ${index + 1} of ${total}`;
      $('learn-title').textContent = step.title;
      $('learn-text').innerHTML = step.text;
      $('learn-eq').innerHTML = step.equation ? tex(step.equation, true) : '';
      $('learn-prev').disabled = index === 0;
      $('learn-next').textContent = index === total - 1 ? 'Finish' : 'Next →';
      $('learn-dots').innerHTML = Array.from({ length: total }, (_, i) => `<span class="${i === index ? 'on' : i < index ? 'done' : ''}"></span>`).join('');
    }

    hideLearning() {
      $('learning-card').hidden = true;
    }

    setBusy(name, busy) {
      const el = $(name);
      if (el) el.classList.toggle('active', busy);
    }
  }

  RV.UIController = UIController;
  RV.tex = tex;
  RV.texNumber = n;
})(window.RV);
