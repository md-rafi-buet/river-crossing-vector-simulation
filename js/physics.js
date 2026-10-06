/* =============================================================================
 * physics.js — Pure physics of the river-crossing problem.
 *
 * Nothing in this file knows about Three.js, the DOM or the screen. Every
 * function takes plain numbers / {x, y} objects and returns plain values, so
 * the mathematics can be read, tested and trusted on its own.
 *
 * Coordinate convention (ground frame, metres and metres per second):
 *   +x  = downstream (the direction in which the river flows)
 *   +y  = directly across the river, from the start bank (y = 0)
 *         to the opposite bank (y = W)
 *
 * Heading angle θ is measured from +x (downstream) towards +y (across):
 *   θ =   0°  → boat points straight downstream
 *   θ =  90°  → boat points straight across
 *   θ = 180°  → boat points straight upstream
 *
 * Vector relation (relative velocity):
 *   V_bg = V_bw + V_wg
 *   (boat w.r.t. ground) = (boat w.r.t. water) + (water w.r.t. ground)
 * ============================================================================= */
window.RV = window.RV || {};

(function (RV) {
  'use strict';

  /** Velocities smaller than this are treated as zero (prevents division by ~0). */
  const EPSILON = 1e-9;

  /** Allowed parameter ranges. The UI reads these so they live in one place. */
  const LIMITS = Object.freeze({
    riverWidth: { min: 20, max: 500, step: 1 },   // m
    riverSpeed: { min: 0, max: 10, step: 0.1 },   // m/s
    boatSpeed:  { min: 0, max: 15, step: 0.1 },   // m/s
    heading:    { min: 0, max: 180, step: 0.5 },  // degrees from +x
  });

  /** The textbook default scenario (Case 1). */
  const DEFAULT_PARAMETERS = Object.freeze({
    riverWidth: 100,
    riverSpeed: 3,
    boatSpeed: 5,
    heading: 90,
  });

  /** A crossing longer than this (in simulated seconds) is stopped automatically. */
  const MAX_SIMULATION_TIME = 3600;

  // ---------------------------------------------------------------------------
  // Small numeric helpers
  // ---------------------------------------------------------------------------
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const toDegrees = (radians) => (radians * 180) / Math.PI;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  /** Snap floating-point noise to exactly zero (e.g. cos 90° = 6.1e-17). */
  const cleanZero = (value) => (Math.abs(value) < 1e-12 ? 0 : value);

  const vector = (x, y) => ({ x: cleanZero(x), y: cleanZero(y) });
  const addVectors = (a, b) => vector(a.x + b.x, a.y + b.y);
  const magnitude = (v) => Math.hypot(v.x, v.y);

  /**
   * Make user input safe: non-numbers fall back to the previous value and
   * everything is clamped into its physical range.
   */
  function sanitizeParameters(raw, fallback = DEFAULT_PARAMETERS) {
    const result = {};
    const map = {
      riverWidth: LIMITS.riverWidth,
      riverSpeed: LIMITS.riverSpeed,
      boatSpeed: LIMITS.boatSpeed,
      heading: LIMITS.heading,
    };
    for (const key of Object.keys(map)) {
      const value = Number(raw[key]);
      const safe = Number.isFinite(value) ? value : Number(fallback[key]);
      result[key] = clamp(safe, map[key].min, map[key].max);
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Core vector physics
  // ---------------------------------------------------------------------------

  /**
   * Boat velocity relative to the water, V_bw = (v cos θ, v sin θ).
   * @param {number} speed       |V_bw| in m/s
   * @param {number} headingDeg  θ in degrees, measured from +x (downstream)
   */
  function calculateVelocityComponents(speed, headingDeg) {
    const theta = toRadians(headingDeg);
    return vector(speed * Math.cos(theta), speed * Math.sin(theta));
  }

  /** River (water) velocity relative to the ground, V_wg = (u, 0). */
  function calculateRiverVelocity(riverSpeed) {
    return vector(riverSpeed, 0);
  }

  /** Relative-velocity addition: V_bg = V_bw + V_wg. */
  function calculateResultantVelocity(boatVelocity, riverVelocity) {
    return addVectors(boatVelocity, riverVelocity);
  }

  /** Direction φ = atan2(V_y, V_x) in degrees from +x, or NaN for a zero vector. */
  function calculateDirection(velocity) {
    if (magnitude(velocity) < EPSILON) return NaN;
    return toDegrees(Math.atan2(velocity.y, velocity.x));
  }

  /**
   * Time to cover a distance across the river, t = distance / V_y.
   * Only the across-river component V_y brings the boat closer to the far bank.
   * Returns Infinity when V_y ≤ 0 (the boat never arrives) — no division by zero.
   */
  function calculateCrossingTime(distanceAcross, acrossSpeed) {
    if (!(acrossSpeed > EPSILON)) return Infinity;
    return Math.max(0, distanceAcross) / acrossSpeed;
  }

  /**
   * Where the boat reaches the far bank when moving with constant velocity
   * from `start`: r(t) = r₀ + V t, with t chosen so that y(t) = W.
   * @returns {{x:number, y:number, time:number} | null}  null if never reached
   */
  function calculateLandingPosition(start, velocity, riverWidth) {
    const time = calculateCrossingTime(riverWidth - start.y, velocity.y);
    if (!Number.isFinite(time)) return null;
    return { x: cleanZero(start.x + velocity.x * time), y: riverWidth, time };
  }

  /**
   * Heading that lands directly opposite the start (zero net drift):
   *   v cos θ + u = 0   ⇒   θ = arccos(−u / v)
   * Requires v > u. If v ≤ u, the boat cannot cancel the current.
   */
  function calculateDirectOppositeHeading(boatSpeed, riverSpeed, riverWidth) {
    if (boatSpeed <= EPSILON) {
      return { possible: false, reason: 'The boat has no speed relative to the water.' };
    }
    if (riverSpeed <= EPSILON) {
      return { possible: true, heading: 90, time: riverWidth / boatSpeed };
    }
    if (boatSpeed <= riverSpeed + EPSILON) {
      return {
        possible: false,
        reason: 'The boat is not faster than the current (v ≤ u), so its upstream component can never cancel the river velocity.',
      };
    }
    const heading = toDegrees(Math.acos(-riverSpeed / boatSpeed));
    // V_y = v sin θ = √(v² − u²)
    const acrossSpeed = Math.sqrt(boatSpeed * boatSpeed - riverSpeed * riverSpeed);
    return { possible: true, heading, time: riverWidth / acrossSpeed };
  }

  /**
   * When direct-opposite is impossible (v < u), the heading that minimises the
   * downstream drift is found from d/dθ[(v cos θ + u)/(v sin θ)] = 0:
   *   cos θ = −v / u,   drift_min = W √(u² − v²) / v
   */
  function calculateMinimumDriftHeading(boatSpeed, riverSpeed, riverWidth) {
    if (boatSpeed <= EPSILON || riverSpeed <= boatSpeed) return null;
    const heading = toDegrees(Math.acos(-boatSpeed / riverSpeed));
    const drift = (riverWidth * Math.sqrt(riverSpeed * riverSpeed - boatSpeed * boatSpeed)) / boatSpeed;
    return { heading, drift };
  }

  /**
   * Solve the whole problem for one set of parameters. Every number shown
   * anywhere in the app (panel, HUD, markers, arrows) comes from this object,
   * so the displays can never disagree with each other.
   */
  function solveCrossing(params) {
    const { riverWidth, riverSpeed, boatSpeed, heading } = params;

    const boatVelocity = calculateVelocityComponents(boatSpeed, heading);         // V_bw
    const riverVelocity = calculateRiverVelocity(riverSpeed);                     // V_wg
    const resultantVelocity = calculateResultantVelocity(boatVelocity, riverVelocity); // V_bg

    const groundSpeed = magnitude(resultantVelocity);
    const resultantDirection = calculateDirection(resultantVelocity);
    const crossingTime = calculateCrossingTime(riverWidth, resultantVelocity.y);
    const canCross = Number.isFinite(crossingTime);
    const landing = canCross ? calculateLandingPosition({ x: 0, y: 0 }, resultantVelocity, riverWidth) : null;

    return {
      params: { ...params },
      boatVelocity,
      riverVelocity,
      resultantVelocity,
      groundSpeed,
      resultantDirection,                                   // φ, degrees from +x
      // Angle between the actual motion and "straight across" (+ = downstream)
      driftAngle: Number.isFinite(resultantDirection) ? 90 - resultantDirection : NaN,
      canCross,
      crossingTime,
      landing,
      displacementX: landing ? landing.x : NaN,
      pathLength: canCross ? groundSpeed * crossingTime : Infinity,
      shortestTime: {
        heading: 90,
        time: calculateCrossingTime(riverWidth, boatSpeed),
        drift: boatSpeed > EPSILON ? (riverSpeed * riverWidth) / boatSpeed : Infinity,
      },
      directOpposite: calculateDirectOppositeHeading(boatSpeed, riverSpeed, riverWidth),
      minimumDrift: calculateMinimumDriftHeading(boatSpeed, riverSpeed, riverWidth),
    };
  }

  // ---------------------------------------------------------------------------
  // Time integration
  // ---------------------------------------------------------------------------

  /**
   * Integrates the boat's position in the ground frame.
   *
   *   r(t + Δt) = r(t) + V_bg Δt
   *
   * For a constant velocity this update is exact, so the simulated path is a
   * true straight line and agrees with r(t) = r₀ + V t. Δt is real elapsed
   * time × playback speed, so the frame rate never changes the solution.
   *
   * The path is stored as the vertices where the velocity changed (it is
   * piecewise straight), which is exact and very cheap to draw.
   */
  class CrossingSimulation {
    constructor(riverWidth) {
      this.reset(riverWidth);
    }

    reset(riverWidth) {
      this.riverWidth = riverWidth;
      this.time = 0;
      this.position = { x: 0, y: 0 };
      this.velocity = null;
      this.finished = false;
      this.timedOut = false;
      this.velocityChangedDuringRun = false;
      this.pathVertices = [{ x: 0, y: 0 }];
    }

    get remainingDistance() {
      return Math.max(0, this.riverWidth - this.position.y);
    }

    get hasStarted() {
      return this.time > 0;
    }

    /** Record a path vertex whenever the velocity is changed mid-crossing. */
    setVelocity(velocity) {
      const previous = this.velocity;
      const changed = !previous || previous.x !== velocity.x || previous.y !== velocity.y;
      if (!changed) return;
      if (previous && this.hasStarted) {
        this.velocityChangedDuringRun = true;
        const last = this.pathVertices[this.pathVertices.length - 1];
        if (last.x !== this.position.x || last.y !== this.position.y) {
          if (this.pathVertices.length < 4000) this.pathVertices.push({ ...this.position });
          else this.pathVertices[this.pathVertices.length - 1] = { ...this.position };
        }
      }
      this.velocity = { x: velocity.x, y: velocity.y };
    }

    /**
     * Advance the simulation by dt seconds with ground velocity `velocity`.
     * If the far bank is reached inside this step we only advance to the exact
     * moment of arrival, so the landing point is exact (not frame-dependent).
     * @returns {boolean} true if the crossing completed during this step
     */
    step(dt, velocity) {
      if (this.finished || !(dt > 0)) return false;
      this.setVelocity(velocity);

      let stepTime = dt;
      let arrives = false;
      if (velocity.y > EPSILON) {
        const timeToFarBank = (this.riverWidth - this.position.y) / velocity.y;
        if (timeToFarBank <= dt) {
          stepTime = Math.max(0, timeToFarBank);
          arrives = true;
        }
      }

      // r = r + V Δt
      this.position.x += velocity.x * stepTime;
      this.position.y += velocity.y * stepTime;
      this.time += stepTime;

      if (arrives) {
        this.position.y = this.riverWidth; // snap exactly onto the bank
        this.finished = true;
      } else if (this.time >= MAX_SIMULATION_TIME) {
        this.finished = true;
        this.timedOut = true;
      }
      return this.finished;
    }
  }

  RV.Physics = {
    EPSILON,
    LIMITS,
    DEFAULT_PARAMETERS,
    MAX_SIMULATION_TIME,
    toRadians,
    toDegrees,
    clamp,
    magnitude,
    sanitizeParameters,
    calculateVelocityComponents,
    calculateRiverVelocity,
    calculateResultantVelocity,
    calculateDirection,
    calculateCrossingTime,
    calculateLandingPosition,
    calculateDirectOppositeHeading,
    calculateMinimumDriftHeading,
    solveCrossing,
    CrossingSimulation,
  };
})(window.RV);
