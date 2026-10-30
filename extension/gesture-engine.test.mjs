// Run with:  node --test gesture-engine.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { GestureEngine, directionOf } = createRequire(import.meta.url)("./gesture-engine.js");

const SIZE = { w: 640, h: 480 };
const FRAME = 33; // ~30 fps

// A synthetic hand pointing up. `open` = flat hand, otherwise a fist. Hand size = 120 px.
function hand({ open, cx = 0.5, cy = 0.7, k, pinch, thumbNearIndex }) {
  const size = 120;
  const lm = Array.from({ length: 21 }, () => ({ x: cx, y: cy }));
  const reach = k ?? (open ? 1.85 : 0.95);           // how far the fingertips are from the wrist
  const offsets = [-0.3, 0, 0.25, 0.5];
  [[5, 8], [9, 12], [13, 16], [17, 20]].forEach(([knuckle, tip], i) => {
    lm[knuckle] = { x: cx + (offsets[i] * size) / SIZE.w, y: cy - size / SIZE.h };
    lm[tip] = { x: cx + (offsets[i] * size) / SIZE.w, y: cy - (reach * size) / SIZE.h };
  });
  if (pinch) {                         // index bent down to meet the thumb, other fingers out
    const bent = { x: cx + (offsets[0] * size) / SIZE.w, y: cy - (1.3 * size) / SIZE.h };
    lm[8] = bent;
    lm[4] = { x: bent.x + 8 / SIZE.w, y: bent.y + 6 / SIZE.h };
  }
  if (thumbNearIndex) lm[4] = { x: lm[8].x + 10 / SIZE.w, y: lm[8].y + 6 / SIZE.h };   // fist with the thumb across
  return lm;
}

function run(engine, frames, t0 = 0) {
  const events = [];
  let t = t0;
  for (const f of frames) { events.push(...engine.update(f, t, SIZE)); t += FRAME; }
  return { events, t };
}
const rep = (lm, n) => Array.from({ length: n }, () => lm);
const types = events => events.map(e => e.type);
// A fist moving horizontally by `step` (fraction of image width) per frame.
const sweep = (dx, dy = 0, n = 5, open = false) =>
  Array.from({ length: n }, (_, i) => hand({ open, cx: 0.5 + dx * i, cy: 0.7 + dy * i }));

test("openness separates a fist from an open palm", () => {
  const e = new GestureEngine();
  run(e, rep(hand({ open: false }), 8));
  assert.equal(e.pose, "fist");
  const e2 = new GestureEngine();
  run(e2, rep(hand({ open: true }), 8));
  assert.equal(e2.pose, "open");
});

test("an open hand alone does nothing", () => {
  assert.deepEqual(run(new GestureEngine(), rep(hand({ open: true }), 80)).events, []);
});

test("fist: no grab before 0.3 s, grab after", () => {
  const e = new GestureEngine();
  const early = run(e, rep(hand({ open: false }), 5));
  assert.deepEqual(early.events, []);
  const later = run(e, rep(hand({ open: false }), 10), early.t);
  assert.deepEqual(types(later.events), ["grab"]);
  assert.equal(e.state, "holding");
});

test("a fist that flickers open/closed every frame never grabs", () => {
  const frames = Array.from({ length: 90 }, (_, i) => hand({ open: i % 2 === 0 }));
  assert.deepEqual(run(new GestureEngine(), frames).events, []);
});

test("without a file the fist reports 'blocked' once and does not grab", () => {
  const e = new GestureEngine();
  e.setGrabEnabled(false);
  const r = run(e, rep(hand({ open: false }), 40));
  assert.deepEqual(types(r.events), ["blocked"]);
  assert.equal(e.state, "idle");
});

test("throw: fast flick with the fist closed, direction is the user's left/right/up/down", () => {
  const cases = [
    ["left", 0.06, 0],     // moves to the image's right = the user's / screen's left
    ["right", -0.06, 0],
    ["up", 0, -0.08],
    ["down", 0, 0.08]
  ];
  for (const [want, dx, dy] of cases) {
    const e = new GestureEngine();
    let r = run(e, rep(hand({ open: false, cx: 0.5, cy: 0.7 }), 12));
    assert.deepEqual(types(r.events), ["grab"], `${want}: grab first`);
    r = run(e, sweep(dx, dy, 6), r.t);
    const throwEv = r.events.find(x => x.type === "throw");
    assert.ok(throwEv, `${want}: expected a throw`);
    assert.equal(throwEv.direction, want);
  }
});

test("throw: the hand opens while moving fast (natural release-throw)", () => {
  const e = new GestureEngine();
  let r = run(e, rep(hand({ open: false }), 12));
  // fist moving fast for 2 frames (just under the speed limit), then the fingers open while still moving
  const frames = [
    hand({ open: false, cx: 0.5 }), hand({ open: false, cx: 0.53 }), hand({ open: false, cx: 0.56 }),
    hand({ open: true, cx: 0.59 }), hand({ open: true, cx: 0.62 }), hand({ open: true, cx: 0.65 }),
    hand({ open: true, cx: 0.68 }), hand({ open: true, cx: 0.71 })
  ];
  r = run(e, frames, r.t);
  assert.ok(r.events.some(x => x.type === "throw"), `expected throw, got ${JSON.stringify(types(r.events))}`);
});

test("slow drift while holding is not a throw", () => {
  const e = new GestureEngine();
  let r = run(e, rep(hand({ open: false }), 12));
  r = run(e, sweep(0.002, 0, 60), r.t);
  assert.equal(r.events.filter(x => x.type === "throw").length, 0);
  assert.equal(e.state, "holding");
});

test("opening the hand slowly while holding = release, nothing sent", () => {
  const e = new GestureEngine();
  let r = run(e, rep(hand({ open: false }), 12));
  r = run(e, rep(hand({ open: true }), 8), r.t);
  assert.deepEqual(types(r.events), ["release"]);
});

test("losing the hand for 0.6 s while holding = cancel", () => {
  const e = new GestureEngine();
  let r = run(e, rep(hand({ open: false }), 12));
  r = run(e, rep(null, 30), r.t);
  assert.deepEqual(types(r.events), ["cancel"]);
  assert.equal(e.state, "idle");
});

test("a short drop-out (3 frames) does not cancel the grab", () => {
  const e = new GestureEngine();
  let r = run(e, rep(hand({ open: false }), 12));
  r = run(e, [null, null, null, ...rep(hand({ open: false }), 5)], r.t);
  assert.deepEqual(r.events, []);
  assert.equal(e.state, "holding");
});

test("catch: only when armed, only after 0.3 s, only with a calm hand", () => {
  const unarmed = run(new GestureEngine(), rep(hand({ open: true }), 30));
  assert.deepEqual(unarmed.events, []);

  const e = new GestureEngine();
  e.setCatchArmed(true);
  const tooShort = run(e, rep(hand({ open: true }), 5));
  assert.deepEqual(tooShort.events, []);
  const ok = run(e, rep(hand({ open: true }), 12), tooShort.t);
  assert.deepEqual(types(ok.events), ["catch"]);
  assert.equal(e.catchArmed, false, "catch disarms itself, so one palm = one file");

  const waving = new GestureEngine();
  waving.setCatchArmed(true);
  const wave = run(waving, Array.from({ length: 30 }, (_, i) => hand({ open: true, cx: 0.4 + 0.12 * (i % 2) })));
  assert.deepEqual(wave.events, [], "a waving hand does not catch");
});

test("after a throw: cooldown, and the fist must open before the next grab", () => {
  const e = new GestureEngine();
  let r = run(e, rep(hand({ open: false }), 12));
  r = run(e, sweep(0.06, 0, 6), r.t);
  assert.ok(r.events.some(x => x.type === "throw"));
  r = run(e, rep(hand({ open: false, cx: 0.8 }), 60), r.t);        // fist stays closed for 2 s
  assert.equal(r.events.filter(x => x.type === "grab").length, 0, "no second grab while still fisted");
  r = run(e, rep(hand({ open: true, cx: 0.8 }), 6), r.t);          // open the hand...
  r = run(e, rep(hand({ open: false, cx: 0.8 }), 12), r.t);        // ...and make a new fist
  assert.deepEqual(types(r.events), ["grab"]);
});

test("hand size does not matter (far and near hands give the same result)", () => {
  for (const scale of [0.5, 1, 2]) {
    const big = (open, cx) => {
      const lm = hand({ open, cx });
      return lm.map(p => ({ x: 0.5 + (p.x - 0.5) * scale, y: 0.7 + (p.y - 0.7) * scale }));
    };
    const e = new GestureEngine();
    const r = run(e, Array.from({ length: 12 }, () => big(false, 0.5)));
    assert.deepEqual(types(r.events), ["grab"], `scale ${scale}`);
  }
});

test("directionOf follows the mirrored preview", () => {
  assert.equal(directionOf(1, 0), "left");
  assert.equal(directionOf(-1, 0), "right");
  assert.equal(directionOf(0, -1), "up");
  assert.equal(directionOf(0, 1), "down");
});

test("a hand is in exactly one pose: a pinch is not an open palm or a fist", () => {
  const e = new GestureEngine();
  run(e, rep(hand({ open: true, pinch: true }), 10));
  assert.equal(e.pose, "pinch");
  assert.equal(e.pinching, true);
  // an open hand whose index finger is bent to the thumb is NOT an open palm any more
  const e2 = new GestureEngine();
  e2.setCatchArmed(true);
  const r = run(e2, rep(hand({ open: true, pinch: true }), 40));
  assert.deepEqual(r.events, [], "a pinch must never catch");
});

test("a fist with the thumb across the fingers is still a fist, never a pinch", () => {
  const e = new GestureEngine();
  run(e, rep(hand({ open: false, thumbNearIndex: true }), 12));
  assert.equal(e.pose, "fist");
  assert.equal(e.pinching, false);
});

test("pinch flicker does not change the pose (2-frame debounce), release goes back to open", () => {
  const e = new GestureEngine();
  run(e, rep(hand({ open: true }), 8));
  run(e, [hand({ open: true, pinch: true }), hand({ open: true }), hand({ open: true, pinch: true }), hand({ open: true })]);
  assert.equal(e.pose, "open");
  run(e, rep(hand({ open: true, pinch: true }), 6));
  assert.equal(e.pose, "pinch");
  run(e, rep(hand({ open: true }), 6));
  assert.equal(e.pose, "open");
});

test("an open palm needs every finger out (one finger curled = other)", () => {
  const e = new GestureEngine();
  e.setCatchArmed(true);
  const lm = hand({ open: true });
  lm[20] = { x: lm[20].x, y: 0.7 - (0.9 * 120) / SIZE.h };   // little finger curled, others out
  const r = run(e, rep(lm, 30));
  assert.equal(e.pose, "other");
  assert.deepEqual(r.events, []);
});

test("progress: grows while the fist is held, then tracks flick speed, then resets", () => {
  const e = new GestureEngine();
  let q = run(e, rep(hand({ open: false }), 4));
  assert.equal(e.target, "grab");
  assert.ok(e.progress > 0 && e.progress < 1, `grab progress ${e.progress}`);
  q = run(e, rep(hand({ open: false }), 8), q.t);
  assert.equal(e.state, "holding");
  assert.equal(e.target, "throw");
  const r = run(e, sweep(0.06, 0, 6), q.t);
  assert.ok(r.events.some(x => x.type === "throw"));
  assert.equal(e.target, null);
  assert.equal(e.progress, 0);
});

test("progress targets 'catch' only while a file is incoming", () => {
  const e = new GestureEngine();
  const q = run(e, rep(hand({ open: true }), 4));
  assert.equal(e.target, null);
  e.setCatchArmed(true);
  run(e, rep(hand({ open: true }), 4), q.t);
  assert.equal(e.target, "catch");
});

test("hand vanishes right after a fast move = thrown, not cancelled (motion blur)", () => {
  const e = new GestureEngine();
  let r = run(e, rep(hand({ open: false }), 12));
  r = run(e, [...sweep(0.03, 0, 4), null, null, null, null, null], r.t);   // fast-ish move, then lost
  const t = r.events.find(x => x.type === "throw");
  assert.ok(t, `expected throw, got ${JSON.stringify(types(r.events))}`);
  assert.equal(t.direction, "left");
  assert.ok(!r.events.some(x => x.type === "cancel"));
});

test("hand leaving slowly is still a cancel", () => {
  const e = new GestureEngine();
  let r = run(e, rep(hand({ open: false }), 12));
  r = run(e, [...sweep(0.002, 0, 4), ...rep(null, 30)], r.t);
  assert.deepEqual(types(r.events), ["cancel"]);
});

test("a measured flick (peak 1.7 hand sizes/s) now sends", () => {
  const e = new GestureEngine();
  let r = run(e, rep(hand({ open: false }), 12));
  // 120 px hand: 1.7 sizes/s = 6.2 px/frame = 0.0097 of the image width per frame
  r = run(e, sweep(0.0097 * 1.25, 0, 10), r.t);
  assert.ok(r.events.some(x => x.type === "throw"));
});
