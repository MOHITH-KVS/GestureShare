// ---------------------------------------------------------------------------------------------
// GestureShare — gesture engine
//
// This file decides WHICH gesture the hand is making. It does not touch the camera or the page:
// it only looks at the 21 hand points MediaPipe gives you plus the clock. Because of that it can
// be tested on its own (see gesture-engine.test.mjs).
//
//   ✊ grab    hold a FIST for ~0.3 s                       (the file is "in your hand")
//   ➜ throw   while holding the fist, flick your hand       (this is the "send" trigger)
//   ✋ catch   hold an OPEN PALM for ~0.3 s, only when a file is incoming
//   ✋ release open your hand slowly while holding            (cancels, nothing is sent)
//   🤏 pinch   thumb and index fingertip touching, other fingers out. Recognised so it is never
//              mistaken for a fist or an open palm; it does not trigger anything yet.
//
// A hand is always in exactly ONE pose: "fist", "open", "pinch" or "other".
//
// State machine:
//
//   idle ──fist held──▶ holding ──fast flick──────────▶ throw   (then idle + cooldown)
//     │                    ├──hand opens while moving fast ▶ throw
//     │                    ├──hand opens slowly ──────────▶ release
//     │                    └──hand lost for 0.6 s ────────▶ cancel
//     └──open palm held, only if catchArmed ──▶ catch
//
// Everything is measured relative to the size of the hand, so it works at any distance from the
// camera, and it uses hysteresis (different on/off thresholds) so it does not flicker.
// ---------------------------------------------------------------------------------------------
(function (root) {
  "use strict";

  const WRIST = 0;
  const MIDDLE_KNUCKLE = 9;
  const FINGERTIPS = [8, 12, 16, 20];   // index, middle, ring, little finger tips
  const OTHER_TIPS = [12, 16, 20];      // the fingers that are NOT part of a pinch
  const THUMB_TIP = 4;
  const INDEX_TIP = 8;
  const PALM_POINTS = [0, 5, 9, 13, 17];

  const DEFAULTS = {
    // "openness" = average distance from wrist to the four fingertips, divided by hand size.
    // A fist is about 0.9–1.2, a flat open hand about 1.7–2.0.
    fistBelow: 1.40,        // openness under this = fist
    openAbove: 1.58,        // openness over this = open palm (between the two: keep the last pose)
    holdMs: 300,            // a fist (or open palm) must be held this long to count
    releaseMs: 120,         // opening the hand must last this long to count as "release"
    throwSpeed: 1.3,        // hand sizes per second needed to send (measured: a calm hand is < 0.5)
    vanishMs: 120,          // hand disappears this long right after a fast move = it was thrown
    vanishSpeed: 0.8,       // ...if it was moving at least this fraction of throwSpeed
    throwWindowMs: 160,     // speed is measured over this window
    cooldownMs: 900,        // pause after a throw or catch so it can't fire twice
    lostMs: 600,            // hand missing this long while holding = cancel
    catchMaxSpeed: 1.5,     // a catch needs a calm hand (waving does not catch)
    smoothing: 0.5,         // 1 = raw openness, lower = smoother but slower
    openMinTip: 1.3,        // an open palm needs EVERY finger out (the shortest finger must reach this)
    pinchOn: 0.30,          // thumb-to-index distance / hand size below this = pinch starts
    pinchOff: 0.45,         // ...and ends above this (hysteresis)
    pinchOthersMin: 1.35,   // a pinch needs the other three fingers out (a fist is not a pinch)
    pinchFrames: 2          // frames in a row before a pinch starts or ends
  };

  function pixelDistance(a, b, size) {
    return Math.hypot((a.x - b.x) * size.w, (a.y - b.y) * size.h);
  }

  // Direction as the USER sees it. The camera preview is mirrored like a mirror, so a hand moving
  // to the left of the screen is also moving to the user's left. Landmarks come from the raw
  // (un-mirrored) camera image, where that same movement is towards the image's RIGHT (dx > 0).
  function directionOf(dx, dy) {
    if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "left" : "right";
    return dy > 0 ? "down" : "up";
  }

  class GestureEngine {
    constructor(options = {}) {
      this.o = Object.assign({}, DEFAULTS, options);
      this.catchArmed = false;
      this.grabEnabled = true;
      this.reset();
    }

    /** Receiver side: only recognise an open-palm "catch" while a file is actually incoming. */
    setCatchArmed(value) {
      this.catchArmed = !!value;
      if (!value && this.pose === "open") this.poseSince = null;
    }

    /** Sender side: a fist only grabs when there is a file to throw. */
    setGrabEnabled(value) {
      this.grabEnabled = !!value;
      this.blockedShown = false;
    }

    reset() {
      this.state = "idle";        // "idle" | "holding"
      this.pose = "other";        // "fist" | "open" | "pinch" | "other"  (exactly one at a time)
      this.pinching = false;
      this.pinchVotes = 0;
      this.pinchRatio = null;     // thumb-index distance / hand size, for display
      this.minTip = null;         // shortest finger, for display
      this.target = null;         // what the hold bar is counting towards: "grab" | "catch" | "throw" | null
      this.progress = 0;          // 0..1 towards that target
      this.poseSince = null;
      this.openness = null;       // smoothed, for display and tuning
      this.speed = 0;             // flick speed (start-to-end), hand sizes per second
      this.pathSpeed = 0;         // total distance travelled per second (catches waving back and forth)
      this.peakSpeed = 0;         // fastest speed since the last grab
      this.palm = null;           // palm centre, 0..1 in the raw camera image
      this.track = [];            // recent palm positions {t, x, y, size} (pixels)
      this.speedHistory = [];     // recent {t, speed, dx, dy}
      this.lastSeen = -Infinity;
      this.cooldownUntil = 0;
      this.needRelax = false;     // after a throw the fist must open before another grab
      this.blockedShown = false;
      this.holdingSince = null;
    }

    /**
     * Feed one camera frame.
     *   landmarks: array of 21 {x, y} in 0..1, or null when there is no (confirmed) hand
     *   t:         time in milliseconds
     *   size:      {w, h} pixel size of the camera image
     * Returns the events that happened on this frame:
     *   {type:"grab"} {type:"blocked"} {type:"throw", direction, speed}
     *   {type:"release"} {type:"cancel", reason} {type:"catch"}
     */
    update(landmarks, t, size) {
      const o = this.o;
      const events = [];

      // ---- no hand -------------------------------------------------------------------------
      if (!landmarks) {
        // A real flick is fast and blurry, and the camera often loses the hand for a moment. If the
        // hand vanishes right after moving fast, that is a throw, not a cancel.
        const gap = t - this.lastSeen;
        if (this.state === "holding" && gap >= o.vanishMs && gap <= o.lostMs) {
          const best = this.speedHistory.reduce(
            (a, h) => (t - h.t <= 400 && h.speed > (a ? a.speed : 0) ? h : a), null);
          if (best && best.speed >= o.throwSpeed * o.vanishSpeed) {
            events.push(this._throw(t, best.dx, best.dy, best.speed));
            return events;
          }
        }
        if (t - this.lastSeen > o.lostMs) {
          if (this.state === "holding") {
            this.state = "idle";
            events.push({ type: "cancel", reason: "hand-lost" });
          }
          this.pose = "other";
          this.pinching = false;
          this.pinchVotes = 0;
          this.pinchRatio = null;
          this.minTip = null;
          this.target = null;
          this.progress = 0;
          this.poseSince = null;
          this.openness = null;
          this.speed = 0;
          this.pathSpeed = 0;
          this.palm = null;
          this.track = [];
          this.speedHistory = [];
          this.needRelax = false;
          this.blockedShown = false;
        }
        return events;
      }
      this.lastSeen = t;

      const handSize = pixelDistance(landmarks[WRIST], landmarks[MIDDLE_KNUCKLE], size);
      if (!handSize) return events;

      // ---- pose: fist / open palm / pinch / other, with smoothing and hysteresis ------------
      const tips = FINGERTIPS.map(i => pixelDistance(landmarks[i], landmarks[WRIST], size) / handSize);
      const raw = tips.reduce((a, b) => a + b, 0) / tips.length;
      this.openness = this.openness == null ? raw : this.openness + o.smoothing * (raw - this.openness);
      this.minTip = Math.min(...tips);

      // Pinch: thumb tip touches index tip while the other three fingers are out.
      // (In a fist the thumb also ends up near the index finger, so the other fingers must be out.)
      const others = OTHER_TIPS.reduce(
        (a, i) => a + pixelDistance(landmarks[i], landmarks[WRIST], size) / handSize, 0) / OTHER_TIPS.length;
      this.pinchRatio = pixelDistance(landmarks[THUMB_TIP], landmarks[INDEX_TIP], size) / handSize;
      const wantPinch = this.pinching
        ? this.pinchRatio < o.pinchOff && others >= o.pinchOthersMin * 0.9
        : this.pinchRatio < o.pinchOn && others >= o.pinchOthersMin;
      if (wantPinch !== this.pinching) {
        if (++this.pinchVotes >= o.pinchFrames) { this.pinching = wantPinch; this.pinchVotes = 0; }
      } else {
        this.pinchVotes = 0;
      }

      let next = this.pose;
      if (this.pinching) next = "pinch";
      else if (this.openness < o.fistBelow) next = "fist";
      else if (this.openness > o.openAbove) next = this.minTip >= o.openMinTip ? "open" : "other";
      else if (this.pose === "pinch") next = "other";
      if (next !== this.pose) {
        this.pose = next;
        this.poseSince = t;
        if (next !== "fist") this.blockedShown = false;
      }
      const held = this.poseSince == null ? 0 : t - this.poseSince;

      // ---- hand speed (in hand sizes per second) -----------------------------------------
      const cx = PALM_POINTS.reduce((s, i) => s + landmarks[i].x, 0) / PALM_POINTS.length;
      const cy = PALM_POINTS.reduce((s, i) => s + landmarks[i].y, 0) / PALM_POINTS.length;
      this.palm = { x: cx, y: cy };
      this.track.push({ t, x: cx * size.w, y: cy * size.h, size: handSize });
      while (this.track.length && t - this.track[0].t > o.throwWindowMs * 2) this.track.shift();

      const v = this._velocity(t);
      this.speed = v ? v.speed : 0;
      this.pathSpeed = v ? v.pathSpeed : 0;
      if (v) {
        this.speedHistory.push({ t, speed: v.speed, dx: v.dx, dy: v.dy });
        while (this.speedHistory.length && t - this.speedHistory[0].t > 250) this.speedHistory.shift();
      }

      // ---- state machine -----------------------------------------------------------------
      if (this.state === "idle") {
        if (t < this.cooldownUntil) { this._updateProgress(held, t); return events; }

        if (this.needRelax) {
          if (this.pose !== "fist") this.needRelax = false;
          else { this._updateProgress(held, t); return events; }
        }

        if (this.pose === "fist" && held >= o.holdMs) {
          if (!this.grabEnabled) {
            if (!this.blockedShown) {
              this.blockedShown = true;
              events.push({ type: "blocked" });
            }
          } else {
            this.state = "holding";
            this.holdingSince = t;
            this.peakSpeed = 0;
            this.speedHistory = [];
            this.track = [this.track[this.track.length - 1]];   // start measuring from the grab
            events.push({ type: "grab" });
          }
        } else if (
          this.pose === "open" && held >= o.holdMs && this.catchArmed && this.pathSpeed <= o.catchMaxSpeed
        ) {
          this.catchArmed = false;
          this.cooldownUntil = t + o.cooldownMs;
          this.poseSince = t;
          events.push({ type: "catch" });
        }
      } else if (this.state === "holding") {
        this.peakSpeed = Math.max(this.peakSpeed, this.speed);

        // 1) a fast flick while the fist is still closed
        if (v && v.speed >= o.throwSpeed) {
          events.push(this._throw(t, v.dx, v.dy, v.speed));
          this._updateProgress(0, t);
          return events;
        }

        // 2) the hand opens: a natural throw releases the fingers while moving fast
        if (this.pose === "open" && held >= o.releaseMs) {
          const best = this.speedHistory.reduce((a, b) => (b.speed > (a ? a.speed : 0) ? b : a), null);
          if (best && best.speed >= o.throwSpeed * 0.8) {
            events.push(this._throw(t, best.dx, best.dy, best.speed));
          } else {
            this.state = "idle";
            this.poseSince = t;
            events.push({ type: "release" });
          }
        }
      }
      this._updateProgress(held, t);
      return events;
    }

    // What the hold bar shows: how close the current gesture is to doing something.
    _updateProgress(held, t) {
      const o = this.o;
      this.target = null;
      this.progress = 0;
      if (this.state === "holding") {
        this.target = "throw";
        const best = this.speedHistory.reduce((m, h) => Math.max(m, h.speed), this.speed);
        this.progress = Math.min(1, best / o.throwSpeed);
      } else if (t >= this.cooldownUntil && !this.needRelax) {
        if (this.pose === "fist" && this.grabEnabled) {
          this.target = "grab";
          this.progress = Math.min(1, held / o.holdMs);
        } else if (this.pose === "open" && this.catchArmed && this.pathSpeed <= o.catchMaxSpeed) {
          this.target = "catch";
          this.progress = Math.min(1, held / o.holdMs);
        }
      }
    }

    _throw(t, dx, dy, speed) {
      this.state = "idle";
      this.cooldownUntil = t + this.o.cooldownMs;
      this.needRelax = true;
      this.poseSince = null;
      this.track = [];
      this.speedHistory = [];
      return { type: "throw", direction: directionOf(dx, dy), speed };
    }

    /** Hand movement over the last throwWindowMs, in hand sizes per second (null if too few samples). */
    _velocity(t) {
      const recent = this.track.filter(p => t - p.t <= this.o.throwWindowMs);
      if (recent.length < 2) return null;
      const a = recent[0];
      const b = recent[recent.length - 1];
      const seconds = (b.t - a.t) / 1000;
      if (seconds <= 0) return null;
      const unit = (a.size + b.size) / 2 || 1;
      const dx = (b.x - a.x) / unit;
      const dy = (b.y - a.y) / unit;
      let path = 0;
      for (let i = 1; i < recent.length; i++) {
        path += Math.hypot(recent[i].x - recent[i - 1].x, recent[i].y - recent[i - 1].y) / unit;
      }
      return { dx, dy, speed: Math.hypot(dx, dy) / seconds, pathSpeed: path / seconds };
    }
  }

  root.GestureEngine = GestureEngine;
  root.GESTURE_DEFAULTS = DEFAULTS;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { GestureEngine, DEFAULTS, directionOf };
  }
})(typeof window !== "undefined" ? window : globalThis);
