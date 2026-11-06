// ---------------------------------------------------------------------------------------------
// Hide MediaPipe's harmless internal log lines.
//
// MediaPipe's WebAssembly code prints its own messages ("Created TensorFlow Lite XNNPACK
// delegate", "OpenGL error checking is disabled", "Feedback manager requires a model with a
// single signature", "Using NORM_RECT without IMAGE_DIMENSIONS ..."). They are information, not
// bugs, but Chrome copies every console.warn / console.error from an extension into
// chrome://extensions -> Errors, which makes a working extension look broken.
//
// This must run BEFORE the wasm loads, because the wasm captures console.error when it starts.
// Only MediaPipe's INFO/WARNING lines are dropped; real errors (E…/F… lines, exceptions, and our
// own console.error calls) still show up.
// ---------------------------------------------------------------------------------------------
(function hideMediaPipeNoise() {
  const noise = [
    /^INFO: /,                                                       // INFO: Created TensorFlow Lite ...
    /^[WI]\d{4} \d\d:\d\d:\d\d\.\d+\s+\d+\s+[\w.]+\.(cc|h):\d+\]/    // W1028 09:38:05.9 1234 file.cc:12] ...
  ];

  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);

    console[level] = (...args) => {
      const first = typeof args[0] === "string" ? args[0] : "";
      if (noise.some(pattern => pattern.test(first))) return;
      original(...args);
    };
  }
})();

// ---------------------------------------------------------------------------------------------
// Where is this page running?
//   "panel"  Chrome's side panel (the default; stays open while you switch tabs)
//   "tab"    a normal browser tab (camera.html?mode=tab)
//   "setup"  a tab that only asks for camera permission once (camera.html?mode=setup)
// ---------------------------------------------------------------------------------------------
const MODE = new URLSearchParams(location.search).get("mode") || "panel";
document.documentElement.dataset.mode = MODE;

// ---------------------------------------------------------------------------------------------
// Page elements
// ---------------------------------------------------------------------------------------------
const video = document.getElementById("camera");
const canvas = document.getElementById("hand-canvas");
const ctx = canvas.getContext("2d");
const frame = document.getElementById("camera-frame");
const heldChip = document.getElementById("held-chip");
const heldName = document.getElementById("held-name");
const banner = document.getElementById("banner");

const camState = document.getElementById("cam-state");
const camStateText = document.getElementById("cam-state-text");
const coach = document.querySelector(".coach");
const coachTitle = document.getElementById("coach-title");
const coachSub = document.getElementById("coach-sub");
const gesturePill = document.getElementById("gesture-pill");
const gestureIcon = document.getElementById("gesture-icon");
const gestureLabel = document.getElementById("gesture-label");
const holdBar = document.getElementById("hold-bar");
const holdLabel = document.getElementById("hold-label");
const twoHandsEl = document.getElementById("two-hands");
const holdFill = document.getElementById("hold-fill");
const tabSend = document.getElementById("tab-send");
const tabReceive = document.getElementById("tab-receive");
const viewSend = document.getElementById("view-send");
const viewReceive = document.getElementById("view-receive");
const sendSteps = document.querySelectorAll("#send-steps li");
const receiveSteps = document.querySelectorAll("#receive-steps li");
const incomingBox = document.getElementById("incoming-box");
const incomingName = document.getElementById("incoming-name");
const incomingMeta = document.getElementById("incoming-meta");
const incomingActions = document.getElementById("incoming-actions");
const declineButton = document.getElementById("decline-incoming");
const demoBox = document.getElementById("demo");
const connectError = document.getElementById("connect-error");
const connectIdle = document.getElementById("connect-idle");
const connectWaiting = document.getElementById("connect-waiting");
const connectWaitLabel = document.getElementById("connect-wait-label");
const connectWaitText = document.getElementById("connect-wait-text");
const codeDisplay = document.getElementById("code-display");
const hostButton = document.getElementById("host-btn");
const joinForm = document.getElementById("join-form");
const joinInput = document.getElementById("join-input");
const cancelConnect = document.getElementById("cancel-connect");
const addDeviceButton = document.getElementById("add-device");
const pairPanel = document.getElementById("pair-panel");
const pairClose = document.getElementById("pair-close");
const pairConfirm = document.getElementById("pair-confirm");
const confirmTitle = document.getElementById("confirm-title");
const confirmAllow = document.getElementById("confirm-allow");
const confirmDeny = document.getElementById("confirm-deny");
const listMine = document.getElementById("list-mine");
const listOther = document.getElementById("list-other");
const secMine = document.getElementById("sec-mine");
const secOther = document.getElementById("sec-other");
const devicesNone = document.getElementById("devices-none");
const joinOpen = document.getElementById("join-open");
const pairChoices = document.getElementById("pair-choices");
const meName = document.getElementById("me-name");
const renameButton = document.getElementById("rename-btn");
const renameForm = document.getElementById("rename-form");
const renameInput = document.getElementById("rename-input");
const sendTo = document.getElementById("send-to");
const sendToLabel = document.getElementById("send-to-label");
const sendToChips = document.getElementById("send-to-chips");
const sendNowButton = document.getElementById("send-now");
const sendProgress = document.getElementById("send-progress");
const sendProgressText = document.getElementById("send-progress-text");
const sendProgressFill = document.getElementById("send-progress-fill");
const recvProgress = document.getElementById("recv-progress");
const recvProgressText = document.getElementById("recv-progress-text");
const recvProgressFill = document.getElementById("recv-progress-fill");

const placeholder = document.getElementById("camera-placeholder");
const placeholderTitle = document.getElementById("placeholder-title");
const placeholderDescription = document.getElementById("placeholder-description");

const startButton = document.getElementById("camera-start");
const stopButton = document.getElementById("camera-stop");
const helpPanel = document.getElementById("permission-help");
const helpMessage = document.getElementById("permission-message");
const helpButton = document.getElementById("help-button");
const closeButton = document.getElementById("close-button");
const tabButton = document.getElementById("tab-button");
const allowButton = document.getElementById("allow-button");

const debugText = document.getElementById("debug-ratio");

const filebox = document.getElementById("filebox");
const fileName = document.getElementById("file-name");
const fileMeta = document.getElementById("file-meta");
const fileInput = document.getElementById("file-input");
const chooseFileButton = document.getElementById("choose-file");
const sampleFileButton = document.getElementById("sample-file");
const chooseFolderButton = document.getElementById("choose-folder");
const folderInput = document.getElementById("folder-input");
const soundToggle = document.getElementById("sound-toggle");
const clearFileButton = document.getElementById("clear-file");

const simulateButton = document.getElementById("simulate-incoming");
const acceptButton = document.getElementById("accept-incoming");
const logList = document.getElementById("log");

// ---------------------------------------------------------------------------------------------
// Tuning values: change these while testing with your own hand.
// (The gesture thresholds themselves live at the top of gesture-engine.js, in DEFAULTS; the ones
// you are most likely to touch are repeated here and passed to the engine.)
// ---------------------------------------------------------------------------------------------

// Gestures
const FIST_BELOW = 1.40;           // openness under this = fist (your fist read about 1.1-1.25)
const OPEN_ABOVE = 1.58;          // openness over this = open palm (your open hand read about 1.7)
const HOLD_MS = 300;              // hold a fist / open palm this long
const THROW_SPEED = 1.3;          // hand sizes per second. Lower = easier to send, higher = harder
                                  // (your flicks peak at 1.0-1.7; a hand held still stays under 0.5)
const COOLDOWN_MS = 900;          // pause after a throw or catch

// Rejecting "ghost" hands. MediaPipe sometimes "sees" a hand in a face or background. In a test on
// a hand-free webcam frame it reported a hand on up to ~20% of frames, with 97% confidence, so a
// confidence score alone cannot remove them. What works is that a ghost almost never lasts: the
// longest run was 2 frames, so requiring CONFIRM_FRAMES in a row hides it completely. The engine
// only ever receives CONFIRMED hands, so a ghost can never grab, throw or catch anything.
const DETECTION_CONFIDENCE = 0.7; // MediaPipe's own threshold. Raise to 0.8-0.9 if ghosts remain,
                                  // lower to 0.5-0.6 if your real hand is not picked up.
const MIN_HAND_SCORE = 0.80;      // ignore detections MediaPipe itself is less than 80% sure about
const MIN_HAND_SIZE = 0.06;       // hand (wrist -> middle knuckle) at least 6% of the frame height
const MAX_HAND_SIZE = 0.70;       // ...and at most 70%
const TWO_HANDS_FRAMES = 4;       // two hands for this many frames in a row = warn "show one hand"
const CONFIRM_FRAMES = 4;         // frames in a row before a hand is shown (~0.15 s)
const MISS_FRAMES = 6;            // frames without a hand before we say "no hand"
const SMOOTHING = 0.5;            // skeleton smoothing: 1 = raw, lower = smoother but laggier

const INCOMING_TIMEOUT_MS = 20000; // a simulated incoming file expires after this long

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------
const engine = new GestureEngine({
  fistBelow: FIST_BELOW,
  openAbove: OPEN_ABOVE,
  holdMs: HOLD_MS,
  throwSpeed: THROW_SPEED,
  cooldownMs: COOLDOWN_MS
});    // pinch and open-palm rules use the defaults in gesture-engine.js

let stream = null;
let handLandmarker = null;
let animationId = null;
let videoFrameId = null;
let running = false;
let starting = false;
let startToken = 0;
let visionModule = null;
let lastVideoTime = -1;

let tab = "send";          // "send" | "receive": decides which gesture is active
let override = null;       // {title, sub, tone} shown instead of the coach (loading, errors, paused)
let missCount = 0;
let seenFrames = 0;
let confirmed = false;
let smoothed = null;
let lastStatusKey = "";
let lastUiAt = 0;
let lastScore = 0;
let handCount = 0;         // valid hands in the last frame
let validHands = [];       // their landmarks (to draw them when there are two)
let twoHandsFrames = 0;
let twoHands = false;
let lastPick = null;       // where the hand we follow was, so we keep following the same one

let stagedFile = null;     // { name, size, file? }  the file you will throw
let incoming = null;       // { name, size }         a file waiting to be caught
let incomingTimer = null;
let receiving = null;     // { id, name, size }       a file that is arriving right now
let outgoingName = "";
let outgoingTo = "";
let lastProgressAt = 0;
let bannerTimer = null;
let throwCount = 0;


// ---------------------------------------------------------------------------------------------
// Sounds (a short chime when something happens, so you do not have to watch the screen)
// ---------------------------------------------------------------------------------------------
let soundOn = true;
try { soundOn = localStorage.getItem("gestureshare.sound") !== "off"; } catch { /* storage blocked: keep the default */ }
soundToggle.checked = soundOn;
soundToggle.addEventListener("change", () => {
  soundOn = soundToggle.checked;
  try { localStorage.setItem("gestureshare.sound", soundOn ? "on" : "off"); } catch {}
  if (soundOn) playSound("sent");
});
let audioCtx = null;
const SOUNDS = { incoming: [660, 880], received: [523, 659, 784], sent: [784, 988], error: [300, 220] };
function playSound(kind) {
  if (!soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    let t = audioCtx.currentTime + 0.02;
    for (const freq of SOUNDS[kind] || []) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = kind === "error" ? "triangle" : "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t); osc.stop(t + 0.18);
      t += 0.11;
    }
  } catch { /* no audio available: silent is fine */ }
  try { if (navigator.vibrate) navigator.vibrate(kind === "error" ? [80, 60, 80] : 60); } catch {}
}

// ---------------------------------------------------------------------------------------------
// Device link: pairing code + direct file transfer (see transfer.js)
// ---------------------------------------------------------------------------------------------
// Free public PeerJS server by default. For testing or your own server: camera.html?signal=host:port
const SIGNAL = (() => {
  const value = new URLSearchParams(location.search).get("signal");
  if (!value) return undefined;
  const [host, port] = value.split(":");
  return { host, port: Number(port), path: "/", secure: false };
})();

const link = new GestureLink({
  signal: SIGNAL,
  onDevices: list => renderDevices(list),
  onPairing: (state, info) => renderPairing(state, info),
  onEvent: event => {
    const who = event.device ? event.device.name : "device";
    if (event.type === "connected") { log(`${who} is online`); }
    else if (event.type === "disconnected") {
      log(`${who} went offline`);
      queue = null;
      receiving = null; hideProgress(recvProgress); hideProgress(sendProgress);
      renderIncoming();
    }
    else if (event.type === "paired") {
      if (pairTrust !== null && event.device) { link.setAuto(event.device.id, pairTrust); devTab = pairTrust ? "mine" : "other"; pairTrust = null; }
      showBanner(`Linked with ${who} ✓`, "ok", 2200); log(`Linked with ${who}`); }
    else if (event.type === "refused" && event.message) log(event.message);
    updateCoach();
  },
  onOffer: offer => {
    const from = offer.from ? offer.from.name : "the other device";
    if (offer.auto) {
      // A device you trust: the file starts arriving by itself, nothing to press.
      receiving = { id: offer.id, name: offer.name, size: offer.size, from, batch: offer.batch };
      renderIncoming();
      recvProgress.hidden = false; recvProgress.dataset.done = "false";
      recvProgressText.textContent = "Starting…";
      recvProgressFill.style.width = "0%";
      showBanner(`Receiving from ${from}: ${offer.name}`, "info", 2200);
      log(`${offer.name} from ${from} is arriving (${fmtSize(offer.size)})`);
      updateCoach();
      return;
    }
    setIncoming({ ...offer, from }, 60000);
    playSound("incoming");
    showBanner(`${from} wants to send: ${offer.name}`, "info", 2600);
    log(`${offer.name} from ${from} is incoming (${fmtSize(offer.size)})`);
  },
  onOfferGone: (id, reason) => {
    if (incoming && incoming.id === id) {
      setIncoming(null);
      log("The other device cancelled the file");
    }
    if (receiving && receiving.id === id) {
      const name = receiving.name;
      receiving = null;
      hideProgress(recvProgress);
      renderIncoming();
      showBanner("Transfer interrupted: nothing saved", "warn", 2600);
      log(`${name} did not arrive (${reason})`);
    }
    updateCoach();
  },
  onProgress: (direction, id, bytes, total) => {
    const now = performance.now();
    if (bytes < total && now - lastProgressAt < 80) return;       // update the bar ~12 times a second
    lastProgressAt = now;
    const [box, text, fill] = direction === "send"
      ? [sendProgress, sendProgressText, sendProgressFill]
      : [recvProgress, recvProgressText, recvProgressFill];
    xferShow(direction === "send" ? "send" : "receive", direction === "send" ? `Sending to ${outgoingTo || "device"}` : "Receiving…",
      direction === "send" ? outgoingName : (receiving ? receiving.name : ""), Math.round((bytes / total) * 100));
    box.hidden = false;
    box.dataset.done = "false";
    text.textContent = `${direction === "send" ? "Sending" : "Receiving"}  ${fmtSize(bytes)} of ${fmtSize(total)}`;
    fill.style.width = `${Math.round((bytes / total) * 100)}%`;
  },
  onReceived: (offer, blob) => {
    receiving = null;
    burstAt(engine.palm || { x: .5, y: .5 }, "#3ef08a");
    xferDone("Received", offer.name);
    saveBlob(blob, offer.name);
    showProgressDone(recvProgress, recvProgressText, recvProgressFill, "Saved to your Downloads folder");
    renderIncoming();
    showBanner(`Received ✓  ${offer.name}${offer.batch ? ` (${offer.batch.i + 1} of ${offer.batch.n})` : ""}`, "ok", 2600);
    if (!offer.batch || offer.batch.i >= offer.batch.n - 1) playSound("received");
    log(`Received ${offer.name}${offer.from ? " from " + offer.from.name : ""} (${fmtSize(offer.size)}), saved to Downloads`);
    updateCoach();
  },
  onSendState: (id, state, detail) => {
    switch (state) {
      case "waiting":
        xferShow("send", `Waiting for ${outgoingTo || "the other device"}…`, outgoingName, 0);
        sendProgress.hidden = false; sendProgress.dataset.done = "false";
        sendProgressText.textContent = `Waiting for ${outgoingTo || "the other device"} to accept ${outgoingName}…`;
        sendProgressFill.style.width = "0%";
        break;
      case "sending":
        sendProgressText.textContent = `Sending ${outgoingName}…`;
        break;
      case "delivered":
        if (queue && queue.index < queue.items.length - 1) {          // more files to go
          log(`Delivered ${outgoingName}`);
          queue.index++;
          setTimeout(sendNext, 0);                                     // after this send has fully ended
          break;
        }
        queue = null;
        xferDone("Delivered", outgoingName);
        showProgressDone(sendProgress, sendProgressText, sendProgressFill, `Delivered ✓  ${outgoingName}`);
        showBanner(`Delivered ✓  ${outgoingName}`, "ok", 2600);
        log(`Delivered ${outgoingName}`);
        playSound("sent");
        break;
      case "declined":
        xferHide();
        queue = null;
        hideProgress(sendProgress);
        showBanner("They declined the file", "warn", 2600);
        log(`${outgoingName} was declined`);
        break;
      case "expired":
        xferHide();
        queue = null;
        hideProgress(sendProgress);
        showBanner("Nobody caught it in time", "warn", 2600);
        log(`${outgoingName} expired: not caught within a minute`);
        break;
      case "failed":
        xferHide();
        queue = null;
        hideProgress(sendProgress);
        playSound("error");
        showBanner("Sending failed", "warn", 2600);
        log(`${outgoingName} failed: ${detail || "connection problem"}`);
        break;
    }
    updateCoach();
  }
});

// The throw gesture: send the staged file(s) to the chosen device, one after the other.
let queue = null;          // { items: File[], index, toId, batch }
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, "0")).join("");

function sendNext() {
  const q = queue;
  if (!q) return;
  const f = q.items[q.index];
  outgoingName = q.items.length > 1 ? `${f.name} (${q.index + 1} of ${q.items.length})` : f.name;
  try {
    link.sendFile(f, q.toId, q.batch ? { id: q.batch, i: q.index, n: q.items.length } : undefined);
  } catch (error) {
    queue = null;
    showBanner("Could not send", "warn");
    log(`Could not send ${f.name}: ${error.message}`);
    updateCoach();
  }
}

function onThrow(file, direction) {
  const arrow = direction ? ARROWS[direction] : "";       // no direction = the "Send now" button
  if (!link.connected) {
    showBanner("No device is online: add one first", "warn", 2800);
    log(`Not sent: no device online (${file.name})`);
    return;
  }
  if (link.outgoing || queue) {
    showBanner("Still sending the last file", "warn", 2200);
    return;
  }
  const toId = link.target();
  const to = (link.list().find(d => d.id === toId) || {}).label || "";
  const items = file.files ? file.files : [file.file || makeSampleFile(file)];
  outgoingTo = to;
  queue = { items, index: 0, toId, batch: items.length > 1 ? randomId() : null };
  showBanner(`${direction ? "Thrown" : "Sending"} ${arrow}  ${file.name}${to ? " to " + to : ""}`, "ok");
  log(direction ? `Threw ${file.name} ${arrow}${to ? " to " + to : ""}` : `Sending ${file.name}${to ? " to " + to : ""}`);
  sendNext();
}

// "Use a sample file" has no real file behind it, so make real bytes of that size.
function makeSampleFile(file) {
  const bytes = new Uint8Array(file.size);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 8)) & 255;
  return new File([bytes], file.name, { type: "image/jpeg" });
}

function saveBlob(blob, name) {
  const safe = String(name).replace(/[\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 200) || "file";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safe;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function hideProgress(box) { box.hidden = true; }
function showProgressDone(box, text, fill, message) {
  box.hidden = false;
  box.dataset.done = "true";
  text.textContent = message;
  fill.style.width = "100%";
  setTimeout(() => { if (box.dataset.done === "true") box.hidden = true; }, 5000);
}

// ---- My devices -----------------------------------------------------------------------------
function showConnectError(message) {
  connectError.textContent = message || "";
  connectError.hidden = !message;
}

let devices = [];
let pairOpen = false;          // the "Add a device" panel is open
let pairingState = "idle";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function smallButton(text, handler, cls = "link-button") {
  const b = el("button", cls, text);
  b.type = "button";
  b.addEventListener("click", handler);
  return b;
}

function deviceRow(d, mine) {
  const li = el("li", "device");
  li.dataset.online = String(d.online);
  const text = el("span", "d-text");
  text.append(el("b", "", d.label));
  text.append(el("span", "", d.stale ? "Not linked any more" : d.online ? "Online" : "Offline"));
  const actions = el("span", "d-actions");
  if (!d.stale) {
    if (mine) actions.append(smallButton("Ask first", () => link.setAuto(d.id, false), "chip-btn"));
    else actions.append(smallButton("Trust", () => link.setAuto(d.id, true), "chip-btn yes"));
  }
  if (d.source !== "account") actions.append(smallButton("Remove", () => { link.remove(d.id); log(`Removed ${d.label}`); }, "chip-btn quiet"));
  li.append(el("span", "dot"), text, actions);
  return li;
}

let pairTrust = null;   // true = the device being added is mine
function renderDevices(list) {
  devices = list;
  meName.textContent = link.name;
  const online = list.filter(d => d.online);
  const mine = list.filter(d => d.auto === true && !d.stale);
  const other = list.filter(d => !(d.auto === true && !d.stale));
  listMine.replaceChildren(...mine.map(d => deviceRow(d, true)));
  listOther.replaceChildren(...other.map(d => deviceRow(d, false)));
  document.getElementById("count-mine").textContent = mine.length;
  document.getElementById("count-other").textContent = other.length;
  applyDevTab(mine.length, other.length);
  renderSendTo();
  renderIncoming();
  demoBox.hidden = online.length > 0;
  updateCoach();
}

// My devices | Others switch. "Add" uses the trust level of the tab you are on.
let devTab = "mine";
function applyDevTab(nMine, nOther) {
  const isMine = devTab === "mine";
  document.getElementById("tab-mine").setAttribute("aria-selected", String(isMine));
  document.getElementById("tab-other").setAttribute("aria-selected", String(!isMine));
  secMine.hidden = !isMine || nMine === 0;
  secOther.hidden = isMine || nOther === 0;
  devicesNone.hidden = (isMine ? nMine : nOther) > 0;
  document.getElementById("devices-none-text").textContent = isMine
    ? "None yet. Same Google account in Chrome on another computer? It appears here by itself."
    : "None yet. Add a friend's device or any phone or computer you don't own.";
  document.getElementById("tab-hint").textContent = isMine
    ? "Your own devices. Files arrive by themselves."
    : "Friends and other people. They are asked before anything is received.";
  addDeviceButton.textContent = isMine ? "+ Add my device" : "+ Add someone else's device";
}
document.getElementById("tab-mine").addEventListener("click", () => { devTab = "mine"; renderDevices(devices); });
document.getElementById("tab-other").addEventListener("click", () => { devTab = "other"; renderDevices(devices); });

// "Send to": nothing to choose with one device, a row of buttons with more.
function renderSendTo() {
  const online = devices.filter(d => d.online);
  sendTo.hidden = online.length === 0;
  if (!online.length) return;
  const chosen = link.target();
  if (online.length === 1) {
    sendToLabel.textContent = "Sending to";
    sendToChips.replaceChildren(el("span", "chip fixed", online[0].label));
    return;
  }
  sendToLabel.textContent = "Send to";
  sendToChips.replaceChildren(...online.map(d => {
    const b = el("button", "chip", d.label);
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(d.id === chosen));
    b.addEventListener("click", () => { link.setTarget(d.id); });
    return b;
  }));
}

function renderPairing(state, info = {}) {
  pairingState = state;
  const busy = state === "waiting" || state === "connecting" || state === "confirm";
  if (busy) pairOpen = true;
  if (state === "idle" && info.paired) pairOpen = false;
  pairPanel.hidden = !pairOpen;
  addDeviceButton.hidden = pairOpen;
  connectIdle.hidden = busy;
  connectWaiting.hidden = !(state === "waiting" || state === "connecting");
  pairConfirm.hidden = state !== "confirm";
  if (!busy && !pairOpen) { joinForm.hidden = true; pairChoices.hidden = false; }
  if (state !== "waiting" && qrBox) qrBox.hidden = true;
  showConnectError(state === "error" ? info.message : "");
  if (state === "waiting") {
    connectWaitLabel.textContent = "Your code";
    codeDisplay.textContent = `${info.code.slice(0, 3)} ${info.code.slice(3)}`;
    connectWaitText.textContent = "Type this on the other device within 2 minutes.";
    if (typeof drawQr === "function") drawQr(qrPayload(info.code));
  } else if (state === "connecting") {
    connectWaitLabel.textContent = "Connecting…";
    codeDisplay.textContent = "• • •";
    connectWaitText.textContent = "Looking for the other device.";
  } else if (state === "confirm") {
    confirmTitle.textContent = `Allow “${info.name}” to link?`;
    confirmAllow.onclick = () => info.allow();
    confirmDeny.onclick = () => info.deny();
  }
  updateCoach();
}

joinOpen.addEventListener("click", () => { pairChoices.hidden = true; joinForm.hidden = false; joinInput.focus(); });
addDeviceButton.addEventListener("click", () => { pairTrust = devTab === "mine"; pairOpen = true; renderPairing(pairingState, {}); });
pairClose.addEventListener("click", () => { pairOpen = false; link.cancelPairing(); renderPairing("idle", {}); });
hostButton.addEventListener("click", () => { link.host().catch(() => {}); });
sendNowButton.addEventListener("click", () => { if (stagedFile) onThrow(stagedFile, null); });
cancelConnect.addEventListener("click", () => { link.cancelPairing(); });

renameButton.addEventListener("click", () => {
  renameInput.value = link.name;
  renameForm.hidden = false; renameButton.hidden = true; meName.hidden = true;
  renameInput.focus(); renameInput.select();
});
renameForm.addEventListener("submit", event => {
  event.preventDefault();
  link.setName(renameInput.value);
  renameForm.hidden = true; renameButton.hidden = false; meName.hidden = false;
  meName.textContent = link.name;
});
renameInput.addEventListener("keydown", event => {
  if (event.key === "Escape") { renameForm.hidden = true; renameButton.hidden = false; meName.hidden = false; }
});

joinInput.addEventListener("input", () => {
  const digits = joinInput.value.replace(/\D/g, "").slice(0, 6);
  joinInput.value = digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
  if (digits.length === 6) joinForm.requestSubmit();               // 6 digits typed: connect straight away
});
joinForm.addEventListener("submit", event => {
  event.preventDefault();
  const digits = joinInput.value.replace(/\D/g, "");
  if (digits.length !== 6) { showConnectError("Type the 6-digit code shown on the other device."); return; }
  link.join(digits).catch(() => {});
});

// ---------------------------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------------------------
const fmtSize = bytes =>
  bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

const ARROWS = { left: "←", right: "→", up: "↑", down: "↓" };

// Camera problems, loading and pauses. While the camera runs normally, the coach (updateCoach)
// decides the message. Only touches the DOM when something changed.
function setStatus(title, message, type = "idle") {
  const key = `${title}|${message}|${type}`;
  if (key === lastStatusKey) return;
  lastStatusKey = key;

  const busy = /loading|waiting|starting/i.test(title);
  camState.dataset.state = type === "error" ? "error" : busy ? "busy" : type === "active" ? "on" : "off";
  camStateText.textContent = type === "error" ? "Camera problem" : busy ? "Starting…" : type === "active" ? "Camera on" : "Camera off";

  override = type === "active" && title === "Camera active" ? null : { title, sub: message, tone: type === "error" ? "error" : "info" };
  updateCoach(true);
}

// state: "off" (shows the Enable button), "loading" (spinner), "error" (shows the Try again button)
function showPlaceholder(title, description, state = "off") {
  placeholder.dataset.state = state;
  placeholderTitle.textContent = title;
  placeholderDescription.textContent = description;
  startButton.textContent = state === "error" ? "Try again" : "Enable Camera";
  placeholder.hidden = false;
}

function showHelp(message) {
  helpMessage.textContent = message;
  helpPanel.hidden = false;
}

function hideHelp() {
  helpPanel.hidden = true;
  allowButton.hidden = true;
}

// Ring on the camera while a file is on its way. dir: "send" | "receive"
const xferEl = document.getElementById("xfer"), xferRing = document.getElementById("xfer-ring");
const xferTitle = document.getElementById("xfer-title"), xferSub = document.getElementById("xfer-sub"), xferIcon = document.getElementById("xfer-icon");
let xferHideTimer = null;
function xferShow(dir, title, sub, pct) {
  clearTimeout(xferHideTimer);
  const me = "You", other = dir === "send" ? (outgoingTo || "Device") : ((receiving && receiving.from && (receiving.from.name || receiving.from)) || "Device");
  document.getElementById("flow-a").textContent = dir === "send" ? me : other;
  document.getElementById("flow-b").textContent = dir === "send" ? other : me;
  xferEl.hidden = false; xferEl.dataset.dir = dir; xferEl.dataset.done = "false";
  xferIcon.textContent = dir === "send" ? "📤" : "📥";
  xferTitle.textContent = title; xferSub.textContent = sub || "";
  if (pct !== undefined) xferRing.style.setProperty("--p", pct);
}
function xferDone(title, sub) {
  clearTimeout(xferHideTimer);
  xferEl.hidden = false; xferEl.dataset.done = "true";
  xferTitle.textContent = title; xferSub.textContent = sub || "";
  confettiBurst();
  try { navigator.vibrate && navigator.vibrate(60); } catch {}
  xferHideTimer = setTimeout(() => { xferEl.hidden = true; }, 2600);
}
function confettiBurst() {
  const box = document.getElementById("confetti");
  box.replaceChildren();
  const colors = ["#34d399", "#5b9bff", "#ffd84a", "#f472b6", "#a78bfa"];
  for (let i = 0; i < 22; i++) {
    const s = document.createElement("s");
    const a = Math.random() * Math.PI * 2, r = 50 + Math.random() * 60;
    s.style.background = colors[i % colors.length];
    s.style.setProperty("--dx", `${Math.cos(a) * r}px`);
    s.style.setProperty("--dy", `${Math.sin(a) * r}px`);
    s.style.setProperty("--rot", `${Math.round(Math.random() * 540 - 270)}deg`);
    box.append(s);
  }
  setTimeout(() => box.replaceChildren(), 1100);
}
function xferHide() { clearTimeout(xferHideTimer); xferEl.hidden = true; }

// Big message in the middle of the camera. kind: "info" | "ok" | "warn"
function showBanner(text, kind = "info", ms = 1400) {
  banner.textContent = text;
  banner.dataset.kind = kind;
  banner.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { banner.hidden = true; }, ms);
}

function log(text) {
  const first = logList.firstElementChild;
  if (first && first.classList.contains("muted")) first.remove();

  const li = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString([], { hour12: false });
  const message = document.createElement("span");
  message.textContent = text;
  li.append(time, message);
  logList.prepend(li);

  while (logList.children.length > 8) logList.lastElementChild.remove();
}

// ---------------------------------------------------------------------------------------------
// The file you will throw
// ---------------------------------------------------------------------------------------------
function setStagedFile(file) {
  stagedFile = file;

  filebox.classList.toggle("has-file", !!file);
  fileName.textContent = file ? file.name : "No file chosen";
  fileMeta.textContent = file ? (file.meta || fmtSize(file.size)) : "Choose files or a folder, or drop them here.";
  clearFileButton.hidden = !file;
  heldName.textContent = file ? file.name : "file";
  applyMode();
}

// One or many things to send: [{ name, size, file }]
function stageList(items) {
  if (!items.length) return;
  if (items.length === 1) {
    const it = items[0];
    setStagedFile({ name: it.name, size: it.size, file: it.file });
    log(`Chose ${it.name}`);
  } else {
    const names = items.map(i => i.name);
    const total = items.reduce((n, i) => n + i.size, 0);
    setStagedFile({
      name: `${items.length} files`, size: total, files: items.map(i => i.file),
      meta: `${names.slice(0, 2).join(", ")}${names.length > 2 ? `, +${names.length - 2} more` : ""} · ${fmtSize(total)}`
    });
    log(`Chose ${items.length} files (${fmtSize(total)})`);
  }
  selectTab("send");
}
const asItem = f => ({ name: f.name, size: f.size, file: f });

// A folder becomes one .zip, so its structure arrives intact.
let packing = false;
async function packFolders(folders) {
  const out = [];
  packing = true;
  for (const folder of folders) {
    if (!folder.entries.length) { showBanner(`“${folder.name}” is empty`, "warn", 2400); continue; }
    fileName.textContent = `Packing “${folder.name}”…`;
    fileMeta.textContent = `${folder.entries.length} files`;
    try {
      const zip = await GSZip.build(folder.entries, `${folder.name}.zip`, (done, total) => {
        fileMeta.textContent = `${folder.entries.length} files · ${Math.round((done / Math.max(total, 1)) * 100)}%`;
      });
      out.push(asItem(zip));
      log(`Packed folder ${folder.name} (${folder.entries.length} files)`);
    } catch (error) {
      showBanner(error.message, "warn", 4000);
      log(`Could not pack ${folder.name}: ${error.message}`);
    }
  }
  packing = false;
  return out;
}
async function stageFilesAndFolders(files, folders) {
  const packed = folders.length ? await packFolders(folders) : [];
  const items = [...files.map(asItem), ...packed];
  if (items.length) stageList(items); else setStagedFile(stagedFile);
}

chooseFileButton.addEventListener("click", () => fileInput.click());
chooseFolderButton.addEventListener("click", () => folderInput.click());
fileInput.addEventListener("change", () => {
  const files = Array.from(fileInput.files || []);
  fileInput.value = "";
  if (files.length) stageList(files.map(asItem));
});
folderInput.addEventListener("change", () => {
  const files = Array.from(folderInput.files || []);
  folderInput.value = "";
  if (!files.length) return;
  const name = (files[0].webkitRelativePath || "folder").split("/")[0] || "folder";
  stageFilesAndFolders([], [{ name, entries: files.map(f => ({ path: f.webkitRelativePath || f.name, file: f })) }]);
});
sampleFileButton.addEventListener("click", () => {
  setStagedFile({ name: "sample-photo.jpg", size: 2_400_000 });
  log("Chose sample-photo.jpg");
});
clearFileButton.addEventListener("click", () => {
  setStagedFile(null);
  hideHeldChip();
});

// Drop files or folders ANYWHERE on the page. (If the page ignores a drop, Chrome opens the file in
// this tab and the user loses GestureShare, so the whole window has to accept it.)
const readEntry = entry => new Promise(resolve => entry.file(resolve, () => resolve(null)));
async function walkDirectory(dir, prefix) {
  const out = [];
  const reader = dir.createReader();
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const e of batch) {
      if (e.isFile) { const f = await readEntry(e); if (f) out.push({ path: `${prefix}/${e.name}`, file: f }); }
      else if (e.isDirectory) out.push(...await walkDirectory(e, `${prefix}/${e.name}`));
    }
  }
  return out;
}
async function stageDrop(dt) {
  const plain = Array.from(dt.files || []);
  const entries = Array.from(dt.items || []).map(i => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);   // read now: the list empties after the first await
  if (!entries.some(e => e.isDirectory)) { if (plain.length) stageList(plain.map(asItem)); return; }
  const files = [], folders = [];
  for (const e of entries) {
    if (e.isFile) { const f = await readEntry(e); if (f) files.push(f); }
    else folders.push({ name: e.name, entries: await walkDirectory(e, e.name) });
  }
  await stageFilesAndFolders(files, folders);
}
window.addEventListener("dragover", e => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  filebox.classList.add("dragover");
});
window.addEventListener("dragleave", e => {
  if (!e.relatedTarget) filebox.classList.remove("dragover");
});
window.addEventListener("drop", e => {
  e.preventDefault();
  filebox.classList.remove("dragover");
  if (e.dataTransfer) stageDrop(e.dataTransfer).catch(error => log(`Could not read the drop: ${error.message}`));
});

// ---------------------------------------------------------------------------------------------
// An incoming file: a real offer from the other device, or the demo
// ---------------------------------------------------------------------------------------------
function renderIncoming() {
  incomingBox.classList.toggle("waiting", !!incoming || !!receiving);
  if (incoming) {
    incomingName.textContent = incoming.name;
    incomingMeta.textContent = incoming.batch
      ? `File 1 of ${incoming.batch.n} · from ${incoming.from} · catch it to receive all ${incoming.batch.n}`
      : `${fmtSize(incoming.size)}${incoming.from ? " · from " + incoming.from : ""} · waiting for you to catch it`;
  } else if (receiving) {
    incomingName.textContent = receiving.name;
    incomingMeta.textContent = `${receiving.batch ? `File ${receiving.batch.i + 1} of ${receiving.batch.n} · ` : ""}${fmtSize(receiving.size)}${receiving.from ? " · from " + receiving.from : ""} · arriving now`;
  } else {
    incomingName.textContent = "Nothing incoming";
    incomingMeta.textContent = link.connected
      ? "Files the other device throws to you show up here."
      : "Connect a device to receive files.";
  }
  incomingActions.hidden = !incoming;
  simulateButton.disabled = !!incoming || !!receiving;
}

function setIncoming(file, timeoutMs = INCOMING_TIMEOUT_MS) {
  incoming = file;
  clearTimeout(incomingTimer);
  renderIncoming();
  if (file) selectTab("receive");      // show the place where the catch happens
  else applyMode();

  if (file) {
    incomingTimer = setTimeout(() => {
      if (incoming !== file) return;
      log(`${file.name} expired`);
      if (file.id) link.reject(file.id);
      setIncoming(null);
    }, timeoutMs);
  }
}

// The catch (open palm, or the Accept button).
function catchIncoming(how) {
  if (!incoming) return;
  const file = incoming;
  if (file.id) {                                   // a real file from the other device
    if (!link.accept(file.id)) { setIncoming(null); return; }
    setIncoming(null);
    receiving = file;
    renderIncoming();
    recvProgress.hidden = false; recvProgress.dataset.done = "false";
    recvProgressText.textContent = "Starting…";
    recvProgressFill.style.width = "0%";
    showBanner(`Caught ✋  ${file.name}`, "ok");
    log(`Caught ${file.name} (${how})`);
  } else {                                         // the demo
    setIncoming(null);
    showBanner(`Caught ✋  ${file.name}`, "ok");
    log(`Caught ${file.name} (${how}): demo only`);
  }
}

simulateButton.addEventListener("click", () => {
  setIncoming({ name: "holiday-photo.jpg", size: 3_100_000 });
  log("Demo: holiday-photo.jpg is incoming");
});
acceptButton.addEventListener("click", () => catchIncoming("button"));
declineButton.addEventListener("click", () => {
  if (!incoming) return;
  if (incoming.id) link.reject(incoming.id);
  log(`Declined ${incoming.name}`);
  setIncoming(null);
});

// ---------------------------------------------------------------------------------------------
// Gesture events from the engine
// ---------------------------------------------------------------------------------------------
function showHeldChip() {
  heldChip.classList.remove("fly");
  heldChip.hidden = false;
}

function hideHeldChip() {
  heldChip.hidden = true;
  heldChip.classList.remove("fly");
}

function flyHeldChip(direction) {
  const far = { left: ["-240px", "0px"], right: ["240px", "0px"], up: ["0px", "-240px"], down: ["0px", "240px"] }[direction];
  heldChip.style.setProperty("--fly-x", far[0]);
  heldChip.style.setProperty("--fly-y", far[1]);
  heldChip.style.setProperty("--fly-spin", direction === "left" || direction === "up" ? "-540deg" : "540deg");
  heldChip.style.setProperty("--fly-rot", direction === "left" ? "-18deg" : direction === "right" ? "18deg" : "0deg");
  heldChip.classList.add("fly");
  setTimeout(hideHeldChip, 600);   // also covers "reduce motion", where the animation does not run
}

function onGesture(event) {
  switch (event.type) {
    case "grab":
      burstAt(engine.palm, "#ffd84a");
      showHeldChip();
      showBanner("Picked up ✊  now flick to send", "info", 1800);
      log(`Picked up ${stagedFile ? stagedFile.name : "file"}`);
      break;

    case "blocked":
      if (tab === "send") showBanner("Choose a file first", "warn");
      break;

    case "throw": {
      const file = stagedFile;
      burstAt(engine.palm, "#ffd84a", event.direction);
      flyHeldChip(event.direction);
      throwCount++;
      if (file) onThrow(file, event.direction);
      break;
    }

    case "release":
      hideHeldChip();
      showBanner("Put down: nothing sent", "info");
      log("Put the file down without sending");
      break;

    case "cancel":
      hideHeldChip();
      showBanner("Lost your hand: cancelled", "warn");
      log("Cancelled: your hand left the camera");
      break;

    case "catch":
      burstAt(engine.palm, "#3ef08a");
      catchIncoming("open palm");
      break;
  }
  updateCoach();
}

// ---- Send / Receive tabs. Only the gesture that belongs to the open tab is active, so a fist can
// never do something on the Receive tab, and an open palm can never do something on the Send tab.
function selectTab(name) {
  tab = name;
  const send = name === "send";
  tabSend.setAttribute("aria-selected", String(send));
  tabReceive.setAttribute("aria-selected", String(!send));
  viewSend.hidden = !send;
  viewReceive.hidden = send;
  applyMode();
}
tabSend.addEventListener("click", () => selectTab("send"));
tabReceive.addEventListener("click", () => selectTab("receive"));

function applyMode() {
  engine.setGrabEnabled(tab === "send" && !!stagedFile);
  engine.setCatchArmed(tab === "receive" && !!incoming);
  updateCoach();
}

let lastCoach = "";
function setCoach(title, sub, tone = "info") {
  const key = `${title}|${sub}|${tone}`;
  if (key === lastCoach) return;
  lastCoach = key;
  coach.hidden = false;
  coachTitle.textContent = title;
  coachSub.textContent = sub;
  coach.dataset.tone = tone;
}

// One instruction at a time: what to do next.
function updateCoach(force = false) {
  sendNowButton.disabled = !(stagedFile && link.connected && !link.outgoing && !queue && !packing);
  if (force) lastCoach = "";
  if (override) { setCoach(override.title, override.sub, override.tone); return; }
  if (!running) {
    if (incoming) setCoach("Incoming file", `${incoming.name} is waiting. Turn on the camera to catch it, or select Accept.`, "warn");
    else if (stagedFile && tab === "send") setCoach("File ready", `Turn on the camera, then make a fist to pick up ${stagedFile.name}.`, "ok");
    else { lastCoach = ""; coach.hidden = true; }      // the camera box already says this
    return;
  }
  if (document.hidden) { setCoach("Paused", "This window is hidden. Bring it back to continue.", "warn"); return; }

  if (twoHands) { setCoach("Two hands detected", "Please show only one hand for smooth and reliable file sharing.", "warn"); return; }

  const holding = engine.state === "holding";
  const file = stagedFile ? stagedFile.name : "";
  const handOn = confirmed;

  if (tab === "send") {
    if (!stagedFile) setCoach("Choose a file to send", "Pick one below, or drop it on the box.");
    else if (!link.connected && !holding) setCoach("No device is online", "You can practise the gesture now. Open GestureShare on your other device, or add one above.", "warn");
    else if (holding) setCoach("Now flick to send", `Move your hand quickly sideways. Holding ${file}.`, "ok");
    else if (!handOn) setCoach("Show your hand", `Then make a fist to pick up ${file}.`);
    else setCoach("Make a fist", `Hold it for half a second to pick up ${file}.`);
  } else {
    if (!incoming && link.connected) setCoach("Waiting for a file", "Ask the other device to throw you one.");
    else if (!incoming) setCoach("No device is online", "Open GestureShare on your other device, or add one above. You can also use the demo to practise catching.");
    else if (!handOn) setCoach("Show your hand", `Then hold an open palm to catch ${incoming.name}.`, "warn");
    else setCoach("Hold an open palm", `Keep all five fingers out for half a second to catch ${incoming.name}.`, "warn");
  }

  // Light up the current step in the "how to" list
  sendSteps.forEach(li => {
    const step = li.dataset.step;
    li.classList.toggle("active", tab === "send" && !!stagedFile && (step === "grab" ? !holding : holding));
    li.classList.toggle("done", step === "grab" && holding);
  });
  receiveSteps.forEach(li => li.classList.toggle("active", !!incoming));
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

// Distance in real pixels. Landmarks are 0..1 on each axis, but a 4:3 frame is wider than it is
// tall, so measuring in 0..1 units would squash horizontal distances.
function distance(a, b) {
  const w = video.videoWidth || 1;
  const h = video.videoHeight || 1;
  return Math.hypot((a.x - b.x) * w, (a.y - b.y) * h);
}

function handSize(landmarks) {
  // wrist -> middle-finger knuckle, in pixels
  return distance(landmarks[0], landmarks[9]) || 1;
}

// The canvas must have the same pixel size and aspect ratio as the video, otherwise the skeleton
// is drawn in the wrong place. The frame takes the camera's own shape (see camera.css).
function sizeToVideo() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  frame.style.setProperty("--video-aspect", `${w} / ${h}`);
  frame.style.setProperty("--video-ratio", (w / h).toFixed(4));
}
video.addEventListener("loadedmetadata", sizeToVideo);
video.addEventListener("resize", sizeToVideo);

const POSES = {
  fist: ["✊", "Fist"],
  open: ["✋", "Open palm"],
  pinch: ["🖐️", "Hand"],
  other: ["🖐️", "Hand"]
};
const TARGETS = { grab: "Hold to pick up", catch: "Hold to catch", throw: "Flick to send" };

// Exactly one gesture is shown at a time, and the bar only appears when that gesture is about to
// DO something (pick up, send, catch). A pinch or an in-between hand never shows a bar.
let palmNoticeShown = false;
function showGesture() {
  const pose = engine.pose;
  const shown = pose === "fist" || pose === "open";          // nothing is said about any other hand shape
  gesturePill.hidden = !shown;
  if (!shown) { palmNoticeShown = false; holdBar.hidden = true; hideIncomingChip(); return; }

  let icon, label, state = "ok";
  if (pose === "fist") {
    icon = "✊";
    if (stagedFile && tab === "send") label = "Pick up your file";
    else { label = "Choose a file first"; state = "none"; }
  } else {
    icon = "✋";
    if (incoming) label = "Collect your file";
    else { label = "No file for you yet"; state = "none"; }
  }
  gesturePill.dataset.pose = pose;
  gesturePill.dataset.state = state;
  if (gestureIcon.textContent !== icon) gestureIcon.textContent = icon;
  if (gestureLabel.textContent !== label) gestureLabel.textContent = label;

  // Open palm with nothing to collect: say so once, like "Choose a file first" for the fist.
  if (pose === "open") {
    if (!incoming && !receiving && !palmNoticeShown) { palmNoticeShown = true; showBanner("No file has been sent to you yet", "info", 1800); }
  } else palmNoticeShown = false;

  if (engine.target) {
    holdBar.hidden = false;
    holdBar.dataset.target = engine.target;
    const text = engine.target === "catch" ? "Hold to collect" : TARGETS[engine.target];
    if (holdLabel.textContent !== text) holdLabel.textContent = text;
    holdFill.style.width = `${Math.round(engine.progress * 100)}%`;
  } else {
    holdBar.hidden = true;
  }
  moveIncomingChip();
}

// The incoming file drifts down into your palm while you hold it open.
const incomingChipEl = document.getElementById("incoming-chip");
function hideIncomingChip() { incomingChipEl.hidden = true; }
function moveIncomingChip() {
  if (!(engine.pose === "open" && incoming && engine.palm)) { hideIncomingChip(); return; }
  document.getElementById("incoming-chip-name").textContent = incoming.name;
  incomingChipEl.hidden = false;
  const p = Math.min(1, engine.progress || 0);
  const x = (1 - engine.palm.x) * 100, y = engine.palm.y * 100;
  incomingChipEl.style.left = `${x.toFixed(1)}%`;
  incomingChipEl.style.top = `${(y - (1 - p) * 28).toFixed(1)}%`;
  incomingChipEl.style.setProperty("--tx", `${(1 - p) * 35}deg`);
  incomingChipEl.style.opacity = String(.55 + .45 * p);
  incomingChipEl.style.transform = `translate(-50%, -50%) scale(${(1.1 - .3 * p).toFixed(2)}) rotateX(${(1 - p) * 35}deg)`;
}

function resetIndicators() {
  gesturePill.hidden = true; hideIncomingChip(); palmNoticeShown = false;
  twoHandsEl.hidden = true;
  holdBar.hidden = true;
  holdFill.style.width = "0%";
  debugText.textContent = "Show your hand to see live numbers.";
  hideHeldChip();
}

function smooth(raw) {
  if (!smoothed || smoothed.length !== raw.length) {
    smoothed = raw.map(p => ({ x: p.x, y: p.y, z: p.z }));
  } else {
    for (let i = 0; i < raw.length; i++) {
      smoothed[i].x += SMOOTHING * (raw[i].x - smoothed[i].x);
      smoothed[i].y += SMOOTHING * (raw[i].y - smoothed[i].y);
      smoothed[i].z += SMOOTHING * (raw[i].z - smoothed[i].z);
    }
  }
  return smoothed;
}

// ---------------------------------------------------------------------------------------------
// Camera + MediaPipe
// ---------------------------------------------------------------------------------------------
function classifyCameraError(error) {
  if (
    error.name === "NotAllowedError" ||
    error.name === "PermissionDeniedError"
  ) {
    return {
      title: "Camera permission needed",
      message:
        "Chrome did not grant camera access. Allow camera access for this extension, then select Try again.",
      help:
        "Open Chrome Settings → Privacy and security → Site settings → Camera. Make sure camera access is allowed and your webcam is selected. Also check Windows Settings → Privacy & security → Camera."
    };
  }

  if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
    return {
      title: "No camera found",
      message: "We couldn't find a webcam connected to this device.",
      help:
        "Connect or enable a webcam, close other camera applications, and select Try again."
    };
  }

  if (error.name === "NotReadableError" || error.name === "TrackStartError") {
    return {
      title: "Camera is busy",
      message: "Another application may be using your webcam.",
      help:
        "Close other applications using the camera, then select Try again."
    };
  }

  return {
    title: "Could not start camera",
    message: error.message || "An unexpected camera error occurred.",
    help:
      "Check Chrome and Windows camera permissions, make sure your webcam is available, and try again."
  };
}

async function loadHandLandmarker() {
  if (handLandmarker) return handLandmarker;

  setStatus("Loading hand tracking", "Preparing the local model…");
  showPlaceholder("Loading hand tracking", "Preparing the local model…", "loading");

  if (!visionModule) {
    visionModule = await import(
      chrome.runtime.getURL("vendor/vision_bundle.mjs")
    );
  }

  const files = await visionModule.FilesetResolver.forVisionTasks(
    chrome.runtime.getURL("vendor/wasm")
  );

  handLandmarker = await visionModule.HandLandmarker.createFromOptions(
    files,
    {
      baseOptions: {
        modelAssetPath: chrome.runtime.getURL(
          "vendor/models/hand_landmarker.task"
        ),
        delegate: "CPU"
      },
      runningMode: "VIDEO",
      numHands: 2,        // we look for two so we can tell the user "show only one hand"
      // MediaPipe's defaults are 0.5.
      minHandDetectionConfidence: DETECTION_CONFIDENCE,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6
    }
  );

  return handLandmarker;
}

async function startCamera() {
  if (starting || running) return;

  starting = true;
  const token = ++startToken;
  startButton.disabled = true;
  hideHelp();

  setStatus(
    "Waiting for camera permission",
    "If Chrome asks, choose Allow. The camera is used only while gesture mode is active."
  );

  showPlaceholder(
    "Waiting for camera permission",
    "Allow camera access in Chrome to continue.",
    "loading"
  );

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "Camera access is unavailable in this extension context. Reload the extension and try again."
      );
    }

    // Ask for a modest size. Many webcams default to 720p/1080p, which makes CPU hand tracking
    // slow and choppy; 640x480 at 30 fps is plenty for hand landmarks.
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 }
      },
      audio: false
    });

    video.srcObject = stream;
    await video.play();
    sizeToVideo();

    await loadHandLandmarker();

    // Stop was pressed (or the page closed) while the model was loading.
    if (token !== startToken || !stream) return;

    placeholder.hidden = true;

    running = true;
    resetTracking();
    lastVideoTime = -1;
    stopButton.disabled = false;

    setStatus("Camera active", "", "active");
    applyMode();

    scheduleNext();
  } catch (error) {
    console.error("GestureShare startup error:", {
      name: error.name,
      message: error.message,
      stack: error.stack
    });

    stopCamera(false);

    const cameraError = classifyCameraError(error);

    setStatus(cameraError.title, cameraError.message, "error");

    showPlaceholder(
      cameraError.title,
      cameraError.message,
      "error"
    );

    showHelp(cameraError.help);

    // The side panel often cannot show Chrome's "Allow camera?" prompt. A normal tab can, and the
    // permission then applies to the side panel too, so offer a one-time tab for it.
    allowButton.hidden = !(MODE === "panel" && cameraError.title === "Camera permission needed");
  } finally {
    starting = false;
    startButton.disabled = running;
  }
}

// Hand connections: wrist, palm, fingers and fingertips.
const connections = [
  // Thumb
  [0, 1], [1, 2], [2, 3], [3, 4],

  // Index finger
  [0, 5], [5, 6], [6, 7], [7, 8],

  // Middle finger
  [5, 9], [9, 10], [10, 11], [11, 12],

  // Ring finger
  [9, 13], [13, 14], [14, 15], [15, 16],

  // Little finger
  [13, 17], [17, 18], [18, 19], [19, 20],

  // Palm
  [0, 17], [5, 9], [9, 13], [13, 17]
];

// ---- Neon look (after the HandConnect reference): glowing line with a white core, plus sparks ----
let sparks = [];
function addSpark(x, y, color, power = 6, dx = 0, dy = 0) {
  sparks.push({ x, y, life: 1, c: color, vx: (Math.random() - .5) * power + dx, vy: (Math.random() - .5) * power + dy });
  if (sparks.length > 240) sparks.shift();
}
function drawSparks() {
  sparks = sparks.filter(s => (s.life -= 0.04) > 0);
  ctx.lineWidth = 2; ctx.lineCap = "round";
  for (const s of sparks) {
    s.x += s.vx; s.y += s.vy;
    ctx.globalAlpha = s.life; ctx.strokeStyle = s.c;
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - s.vx * 2, s.y - s.vy * 2); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
function neonLine(ax, ay, bx, by, color, width) {
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.shadowColor = color; ctx.shadowBlur = 16;
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  ctx.strokeStyle = "#fff"; ctx.lineWidth = width / 3; ctx.shadowBlur = 0;
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
}
// Burst of sparks from the palm when a file is sent or caught.
function burstAt(palm, color, dir) {
  if (!palm) return;
  const x = palm.x * canvas.width, y = palm.y * canvas.height;
  const d = { left: [-5, 0], right: [5, 0], up: [0, -5], down: [0, 5] }[dir] || [0, 0];
  for (let i = 0; i < 46; i++) addSpark(x, y, i % 3 ? color : "#fff", 9, d[0] * (dir ? -1 : 0), d[1] * (dir ? -1 : 0));
}

function drawHand(landmarks, forceColour, keep = false) {
  if (!keep) ctx.clearRect(0, 0, canvas.width, canvas.height);
  const now = performance.now();
  const W = canvas.width, H = canvas.height;
  const holding = engine.state === "holding";
  const catching = engine.pose === "open" && !!incoming;
  // Colour tells what the app thinks you are doing: amber = file in hand, green = ready to collect.
  const colour = forceColour || (holding ? "#ffd84a" : catching ? "#3ef08a" : engine.pose === "open" ? "#7dd3fc" : "#5b9bff");
  const width = Math.max(3, W / 150);
  ctx.lineCap = "round"; ctx.lineJoin = "round";

  for (const [start, end] of connections) {
    const a = landmarks[start], b = landmarks[end];
    neonLine(a.x * W, a.y * H, b.x * W, b.y * H, colour, width);
  }
  ctx.shadowBlur = 0;

  // Fingertip sparks while something is happening
  const rate = holding || catching ? 0.3 : 0.02;
  for (const i of [4, 8, 12, 16, 20]) {
    const p = landmarks[i];
    if (Math.random() < rate) addSpark(p.x * W, p.y * H, colour);
  }

  // Palm aura: pulses around a held file, ripples outward while waiting to collect
  const pm = engine.palm;
  if (pm && (holding || catching)) {
    const cx = pm.x * W, cy = pm.y * H, base = Math.max(24, W / 9);
    ctx.lineWidth = 3; ctx.strokeStyle = colour; ctx.shadowColor = colour; ctx.shadowBlur = 14;
    if (holding) {
      ctx.globalAlpha = .6 + .3 * Math.sin(now / 120);
      ctx.beginPath(); ctx.arc(cx, cy, base * (1 + .08 * Math.sin(now / 120)), 0, Math.PI * 2); ctx.stroke();
    } else {
      for (let k = 0; k < 3; k++) {
        const t = ((now / 1400) + k / 3) % 1;
        ctx.globalAlpha = (1 - t) * .8;
        ctx.beginPath(); ctx.arc(cx, cy, base * (0.6 + t * 1.6), 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  }

  // Joints
  for (let i = 0; i < landmarks.length; i++) {
    const point = landmarks[i];
    const tip = [4, 8, 12, 16, 20].includes(i);
    ctx.beginPath();
    ctx.arc(point.x * W, point.y * H, tip ? 5 : 3, 0, Math.PI * 2);
    ctx.fillStyle = "#fff"; ctx.fill();
  }
  drawSparks();
}

// Decides which of MediaPipe's hands are real, and returns the one to follow (or null for "no hand").
// `results` is exactly what handLandmarker.detectForVideo() returns. Sets `handCount`.
function pickHand(results) {
  const all = results?.landmarks ?? [];
  const scores = results?.handedness ?? results?.handednesses ?? [];
  const h = video.videoHeight || 1;
  const valid = [];

  all.forEach((landmarks, i) => {
    // How sure MediaPipe is that this is a hand (0..1). Ghost hands on faces usually score low.
    const score = scores[i]?.[0]?.score ?? 1;
    if (score < MIN_HAND_SCORE) return;
    // A real hand has a believable size relative to the frame.
    const sizeFraction = handSize(landmarks) / h;
    if (sizeFraction < MIN_HAND_SIZE || sizeFraction > MAX_HAND_SIZE) return;
    valid.push({ landmarks, score, size: sizeFraction });
  });

  handCount = valid.length;
  validHands = valid.map(v => v.landmarks);
  if (!valid.length) {
    lastScore = all.length ? (scores[0]?.[0]?.score ?? 0) : 0;
    return null;
  }

  // Follow the hand we followed before (closest to where it was); otherwise the biggest one.
  // This stops the tracker jumping to a short-lived ghost hand.
  let best = valid[0];
  if (lastPick) {
    const dist = v => Math.hypot(v.landmarks[9].x - lastPick.x, v.landmarks[9].y - lastPick.y);
    best = valid.reduce((a, b) => (dist(b) < dist(a) ? b : a));
  } else {
    best = valid.reduce((a, b) => (b.size > a.size ? b : a));
  }
  lastPick = { x: best.landmarks[9].x, y: best.landmarks[9].y };
  lastScore = best.score;
  return best.landmarks;
}

// One camera frame from MediaPipe -> everything. Two hands for a few frames in a row = warning,
// and no gesture is recognised until only one hand is left.
function handleResults(results, now = performance.now()) {
  const hand = pickHand(results);
  if (!hand) lastPick = null;

  twoHandsFrames = handCount >= 2 ? twoHandsFrames + 1 : 0;
  const was = twoHands;
  twoHands = twoHandsFrames >= TWO_HANDS_FRAMES;

  if (twoHands) {
    handleLandmarks(null, now);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    validHands.forEach(h => drawHand(h, "#fbbf24", true));     // show both hands in amber
    twoHandsEl.hidden = false;
    gesturePill.hidden = true;
    holdBar.hidden = true;
    if (!was) log("Two hands detected: show only one hand");
    updateCoach();
    return;
  }

  twoHandsEl.hidden = true;
  handleLandmarks(hand, now);
  if (was) updateCoach();
}

function resetTracking() {
  twoHands = false;
  twoHandsFrames = 0;
  lastPick = null;
  confirmed = false;
  seenFrames = 0;
  missCount = 0;
  smoothed = null;
  engine.reset();
  applyMode();
}

// Move the "file in your hand" with your palm. The preview is mirrored, so x is flipped.
function moveHeldChip() {
  if (engine.state !== "holding" || !engine.palm) {
    if (!heldChip.hidden && !heldChip.classList.contains("fly")) hideHeldChip();
    return;
  }
  if (heldChip.hidden) showHeldChip();
  const px = (1 - engine.palm.x) * 100, py = engine.palm.y * 100;
  // Tilt the card in the direction the hand moves, like a card held in the air.
  if (moveHeldChip.lx !== undefined) {
    const dx = px - moveHeldChip.lx, dy = py - moveHeldChip.ly;
    const clamp = (v, m) => Math.max(-m, Math.min(m, v));
    heldChip.style.setProperty("--ty", `${clamp(dx * 6, 40)}deg`);
    heldChip.style.setProperty("--tx", `${clamp(-dy * 6, 30)}deg`);
    heldChip.style.setProperty("--tz", `${clamp(dx * 2, 12)}deg`);
  }
  moveHeldChip.lx = px; moveHeldChip.ly = py;
  heldChip.style.left = `${px.toFixed(1)}%`;
  heldChip.style.top = `${py.toFixed(1)}%`;
}

// Handles one frame (a hand, or null). Kept separate from the camera loop so it can be tested.
// `now` is in milliseconds; tests pass their own clock.
function handleLandmarks(rawLandmarks, now = performance.now()) {
  const size = { w: video.videoWidth || 640, h: video.videoHeight || 480 };

  if (!rawLandmarks) {
    missCount++;

    // A "hand" that keeps appearing and vanishing never builds up to CONFIRM_FRAMES.
    if (!confirmed) seenFrames = 0;

    for (const event of engine.update(null, now, size)) onGesture(event);

    // Ignore a few dropped frames instead of flashing "No hand detected".
    if (missCount >= MISS_FRAMES) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      confirmed = false;
      seenFrames = 0;
      smoothed = null;
      resetIndicators();
      updateCoach();
    }
    return;
  }

  missCount = 0;

  // Wait until the same hand has been seen several frames in a row before showing anything.
  if (!confirmed) {
    seenFrames++;
    if (seenFrames < CONFIRM_FRAMES) {
      engine.update(null, now, size);     // not a confirmed hand yet: the engine must not see it
      return;
    }
    confirmed = true;
  }

  // Gestures: only confirmed hands reach the engine, and it gets the raw (un-smoothed) points.
  for (const event of engine.update(rawLandmarks, now, size)) onGesture(event);
  calibFeed(now);

  const landmarks = smooth(rawLandmarks);

  drawHand(landmarks);
  moveHeldChip();
  showGesture();
  updateCoach();

  // Numbers: at most ~20 updates per second.
  if (now - lastUiAt > 50) {
    lastUiAt = now;
    debugText.textContent =
      `pose ${engine.pose} · openness ${engine.openness.toFixed(2)} (fist < ${engine.o.fistBelow.toFixed(2)}, open > ${engine.o.openAbove.toFixed(2)}) · ` +
      `shortest finger ${engine.minTip.toFixed(2)} · pinch ${engine.pinchRatio.toFixed(2)} · ` +
      `speed ${engine.speed.toFixed(1)} (send ≥ ${engine.o.throwSpeed.toFixed(2)}, peak ${engine.peakSpeed.toFixed(1)}) · ` +
      `confidence ${Math.round(lastScore * 100)}%`;
  }
}

function scheduleNext() {
  if (!running) return;

  // requestVideoFrameCallback fires once per NEW camera frame, so we never run the detector twice
  // on the same image. Fall back to requestAnimationFrame on older browsers.
  if (typeof video.requestVideoFrameCallback === "function") {
    videoFrameId = video.requestVideoFrameCallback(detectFrame);
  } else {
    animationId = requestAnimationFrame(detectFrame);
  }
}

function detectFrame() {
  if (!running || !handLandmarker) return;

  const isNewFrame = video.currentTime !== lastVideoTime;

  if (isNewFrame && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    lastVideoTime = video.currentTime;

    try {
      const results = handLandmarker.detectForVideo(
        video,
        performance.now()
      );

      handleResults(results);
    } catch (error) {
      console.error("GestureShare detection error:", error);
      stopCamera();

      setStatus(
        "Hand detection stopped",
        "An error occurred during detection. Try starting the camera again.",
        "error"
      );

      showHelp("If this continues, reload the extension and try again.");
      return;
    }
  }

  scheduleNext();
}

function stopCamera(updateStatus = true) {
  running = false;
  startToken++;   // cancels a start that is still loading

  if (animationId !== null) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  if (videoFrameId !== null && typeof video.cancelVideoFrameCallback === "function") {
    video.cancelVideoFrameCallback(videoFrameId);
    videoFrameId = null;
  }

  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }

  if (handLandmarker) {
    handLandmarker.close();
    handLandmarker = null;
  }

  video.srcObject = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  placeholder.hidden = false;
  stopButton.disabled = true;
  startButton.disabled = false;
  resetTracking();
  resetIndicators();
  updateCoach();

  if (updateStatus) {
    setStatus("Camera is off", "Start the camera whenever you're ready.");
    showPlaceholder("Your camera is off", "Turn on the camera to recognize hand gestures.", "off");
    hideHelp();
  }
}

// One-time permission tab (opened by the side panel's "Allow camera in a tab" button)
async function grantCameraPermission() {
  startButton.disabled = true;
  hideHelp();
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    probe.getTracks().forEach(track => track.stop());     // we only needed the permission
    setStatus("Camera allowed", "You can close this tab and go back to GestureShare.", "active");
    showPlaceholder("Camera allowed ✔", "Close this tab, then open GestureShare from the toolbar icon.", "off");
    startButton.hidden = true;
  } catch (error) {
    const cameraError = classifyCameraError(error);
    setStatus(cameraError.title, cameraError.message, "error");
    showPlaceholder(cameraError.title, cameraError.message, "error");
    showHelp(cameraError.help);
  } finally {
    startButton.disabled = false;
  }
}

if (MODE === "setup") {
  document.title = "GestureShare: allow camera";
  setStatus("Allow the camera", "GestureShare needs your permission once. Select the button and choose Allow.");
  showPlaceholder("Allow camera access", "Select the button, then choose Allow in Chrome's prompt.", "off");
  startButton.textContent = "Allow camera";
  startButton.addEventListener("click", grantCameraPermission);
} else {
  startButton.addEventListener("click", startCamera);
}
stopButton.addEventListener("click", () => stopCamera());

allowButton.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("camera.html?mode=setup") });
});

tabButton.addEventListener("click", async () => {
  stopCamera(false);     // only one page should use the camera
  await chrome.tabs.create({ url: chrome.runtime.getURL("camera.html?mode=tab") });
  window.close();        // closes the side panel, so the user does not have to
});

// When the permission is granted in the set-up tab, tell the side panel straight away.
if (MODE !== "setup" && navigator.permissions?.query) {
  navigator.permissions.query({ name: "camera" }).then(permission => {
    permission.onchange = () => {
      if (permission.state === "granted" && !running && !starting) {
        hideHelp();
        setStatus("Camera allowed", "Select Enable Camera to start.");
        showPlaceholder("Camera allowed ✔", "Select Enable Camera to start.", "off");
      }
    };
  }).catch(() => {});
}

// Chrome stops delivering camera frames while the window is hidden (minimised, or the browser is
// covered by another app). Say so, and forget any half-finished gesture instead of resuming it
// with stale data.
document.addEventListener("visibilitychange", () => {
  if (!running) return;
  if (document.hidden) {
    resetTracking();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    resetIndicators();
  } else {
    lastStatusKey = "";
  }
  updateCoach();
});

helpButton.addEventListener("click", () => {
  // Extension pages cannot open chrome:// links with window.open; use the tabs API.
  chrome.tabs.create({ url: "chrome://settings/content/camera" });
});

window.addEventListener("pagehide", () => { stopCamera(false); link.stop(); try { hubChannel && hubChannel.postMessage({ t: "ui-closed", id: WINDOW_ID }); } catch {} });

// Stay findable for the remembered device, and reconnect to it without a code.
// ---- "Send with GestureShare" from the right-click menu ---------------------------------------
// background.js leaves a note ({url}) in session storage; this page fetches it and stages it as the
// file to send. If Chrome blocks the download (the site does not allow it), one tap on "Allow" asks
// for permission to read that single site.
const fetchBox = document.getElementById("fetch-box");
const fetchTitle = document.getElementById("fetch-title");
const fetchText = document.getElementById("fetch-text");
const fetchActions = document.getElementById("fetch-actions");
const fetchAllow = document.getElementById("fetch-allow");
const fetchCancel = document.getElementById("fetch-cancel");
const PENDING_KEY = "gs.pending";
const extStore = typeof chrome !== "undefined" && chrome.storage && chrome.storage.session ? chrome.storage.session : null;
let pendingFetch = null;

function fileNameFromResponse(url, response, blob) {
  const cd = response.headers.get("content-disposition") || "";
  let name = (/filename\*=UTF-8''([^;]+)/i.exec(cd) || [])[1];
  if (name) { try { name = decodeURIComponent(name); } catch {} }
  if (!name) name = (/filename="?([^";]+)"?/i.exec(cd) || [])[1];
  if (!name) { try { name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || ""); } catch { name = ""; } }
  name = (name || "download").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120);
  if (!/\.[a-z0-9]{1,6}$/i.test(name)) {
    const ext = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "video/mp4": "mp4", "video/webm": "webm", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/wav": "wav", "application/pdf": "pdf" }[(blob.type || "").split(";")[0]];
    if (ext) name += "." + ext;
  }
  return name;
}

function showFetch(title, text, askPermission) {
  fetchBox.hidden = false;
  fetchTitle.textContent = title;
  fetchText.textContent = text || "";
  fetchActions.hidden = !askPermission;
  selectTab("send");
}
function hideFetch() { fetchBox.hidden = true; pendingFetch = null; }

async function runFetch(url) {
  let host = url;
  try { host = new URL(url).host; } catch {}
  showFetch("Getting the file…", host, false);
  try {
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) throw new Error(`The site answered ${response.status}`);
    const blob = await response.blob();
    const file = new File([blob], fileNameFromResponse(url, response, blob), { type: blob.type });
    hideFetch();
    stageList([asItem(file)]);
    showBanner(`Ready to send ${file.name}`, "ok", 2200);
    log(`Took ${file.name} from ${host} (${fmtSize(file.size)})`);
  } catch (error) {
    const canAsk = typeof chrome !== "undefined" && chrome.permissions && /^https?:/i.test(url);
    pendingFetch = { url, host };
    if (canAsk) showFetch("Chrome needs your OK", `To send this file, GestureShare must read it from ${host}. Allow it for that site only?`, true);
    else showFetch("Could not get the file", error.message, false);
    log(`Could not get the file from ${host}: ${error.message}`);
  }
}

fetchAllow.addEventListener("click", async () => {
  if (!pendingFetch) return;
  const { url } = pendingFetch;
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: [new URL(url).origin + "/*"] }); } catch {}
  if (granted) runFetch(url);
  else showFetch("Not allowed", "No problem. Nothing was downloaded.", false);
});
fetchCancel.addEventListener("click", hideFetch);

async function takePending() {
  if (!extStore) return;
  try {
    const got = await extStore.get(PENDING_KEY);
    const note = got && got[PENDING_KEY];
    if (!note || !note.url || Date.now() - note.at > 60000) return;
    await extStore.remove(PENDING_KEY);
    runFetch(note.url);
  } catch { /* nothing waiting */ }
}
if (extStore) {
  try { chrome.storage.onChanged.addListener((changes, area) => { if (area === "session" && changes[PENDING_KEY] && changes[PENDING_KEY].newValue) takePending(); }); } catch {}
  takePending();
}

// ---- Hand over to / take back from the hidden background receiver (hub.js) --------------------
// While no GestureShare window is open, a hidden page keeps this device findable so files from
// "My devices" still arrive. When a window opens, the hidden page steps aside (two pages cannot be
// the same device at once) and takes over again when the last window closes.
const BG_KEY = "gestureshare.background";
var hubChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("gestureshare-hub") : null;
var WINDOW_ID = randomId();
function startLink() {
  if (MODE === "setup") return;
  if (!hubChannel) { link.start().catch(() => {}); return; }
  let started = false;
  const go = () => { if (started) return; started = true; link.start().catch(() => {}); };
  hubChannel.addEventListener("message", event => {
    const m = event.data || {};
    if (m.t === "hub-ack" && m.id === WINDOW_ID) setTimeout(go, m.wasRunning ? 500 : 0);
  });
  hubChannel.postMessage({ t: "ui-open", id: WINDOW_ID });
  setTimeout(go, 1500);                                           // nobody answered: carry on alone
  setInterval(() => { try { hubChannel.postMessage({ t: "ui-alive", id: WINDOW_ID }); } catch {} }, 3000);
}
const bgToggle = document.getElementById("bg-toggle");
if (bgToggle) {
  try { bgToggle.checked = localStorage.getItem(BG_KEY) !== "off"; } catch {}
  bgToggle.addEventListener("change", () => {
    try { localStorage.setItem(BG_KEY, bgToggle.checked ? "on" : "off"); } catch {}
    try { hubChannel && hubChannel.postMessage({ t: "settings" }); } catch {}
    log(bgToggle.checked ? "Files from My devices will arrive even when GestureShare is closed" : "Files will only arrive while GestureShare is open");
  });
}

renderDevices(link.list());
renderPairing("idle", {});
startLink();

closeButton?.addEventListener("click", () => {
  stopCamera(false);
  window.close();
});

renderIncoming();
updateCoach();

// ---------------------------------------------------------------------------------------------
// Tune gestures to this person's hand: measure a fist, an open palm and three flicks, then set
// the thresholds halfway between what this hand actually does.
// ---------------------------------------------------------------------------------------------
const CALIB_KEY = "gestureshare.calib";
const calibEl = document.getElementById("calib");
const calibVisual = document.getElementById("calib-visual");
const calibText = document.getElementById("calib-text");
const calibFill = document.getElementById("calib-fill");
const calibGo = document.getElementById("calib-go");
const calibCancel = document.getElementById("calib-cancel");
const calibReset = document.getElementById("calib-reset");
const calibButton = document.getElementById("calibrate-btn");
const DEFAULT_TUNING = { fistBelow: engine.o.fistBelow, openAbove: engine.o.openAbove, throwSpeed: engine.o.throwSpeed };

function applyTuning(t) {
  engine.o.fistBelow = t.fistBelow; engine.o.openAbove = t.openAbove; engine.o.throwSpeed = t.throwSpeed;
}
try {
  const saved = JSON.parse(localStorage.getItem(CALIB_KEY) || "null");
  if (saved && saved.openAbove > saved.fistBelow && saved.throwSpeed > 0.4) applyTuning(saved);
} catch { /* nothing saved */ }

const median = list => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
let calib = null;     // { step: "intro"|"fist"|"open"|"flick"|"done", samples, ... }

function calibShow(step, visual, text, goLabel) {
  calibVisual.textContent = visual;
  calibText.textContent = text;
  calibGo.textContent = goLabel || "";
  calibGo.hidden = !goLabel;
  calibFill.style.width = "0%";
}

function calibOpen() {
  if (!running) { showBanner("Turn on the camera first", "warn", 2400); return; }
  calib = { step: "intro" };
  calibEl.hidden = false;
  calibShow("intro", "🖐️", "We will measure your hand in three short steps: a fist, an open palm, and three flicks. Keep your hand in view of the camera.", "Start");
  calibGo.focus();
}
function calibClose() { calib = null; calibEl.hidden = true; calibButton.focus(); }

function calibBegin(step) {
  calib = { step, samples: [], started: 0, peaks: [], burst: 0, quiet: 0, fist: calib.fist, open: calib.open };
  if (step === "fist") calibShow(step, "✊", "Make a fist and hold it still.");
  if (step === "open") calibShow(step, "✋", "Now open your hand wide, all five fingers out, and hold it still.");
  if (step === "flick") calibShow(step, "👉", "Now flick your hand sideways, quickly, three times. Pause a moment between flicks.");
  calibGo.hidden = true;
}

function calibFeed(now) {
  if (!calib || !calib.step || calib.step === "intro" || calib.step === "done") return;
  if (!confirmed) { calib.started = 0; calib.samples.length = 0; calibFill.style.width = "0%"; return; }   // wait for a steady hand
  if (calib.step === "fist" || calib.step === "open") {
    if (!calib.started) calib.started = now;
    calib.samples.push(engine.openness);
    const progress = Math.min((now - calib.started) / 2500, 1);
    calibFill.style.width = `${Math.round(progress * 100)}%`;
    if (progress >= 1) {
      const value = median(calib.samples);
      calibBegin(calib.step === "fist" ? "open" : "flick");
      if (calib.step === "open") calib.fist = value; else calib.open = value;
      // keep the earlier readings through the step change
    }
    return;
  }
  if (calib.step === "flick") {
    if (!calib.started) calib.started = now;
    const speed = engine.speed;
    if (speed > 0.6) { calib.burst = Math.max(calib.burst, speed); calib.quiet = 0; }
    else if (calib.burst) {
      if (++calib.quiet >= 5) { if (calib.burst > 0.8) calib.peaks.push(calib.burst); calib.burst = 0; calib.quiet = 0; }
    }
    calibFill.style.width = `${Math.round(Math.min(calib.peaks.length / 3, 1) * 100)}%`;
    if (calib.peaks.length >= 3) calibFinish();
    else if (now - calib.started > 15000) calibFinish();
  }
}

function calibFinish() {
  const { fist, open, peaks } = calib;
  calib.step = "done";
  const gap = open - fist;
  if (!(gap > 0.25)) {
    calibShow("done", "⚠️", "Your fist and open hand looked too alike, so nothing was changed. Try again with your whole hand in view and good light.", "");
    calibGo.hidden = false; calibGo.textContent = "Try again"; calib.retry = true;
    return;
  }
  const tuning = {
    fistBelow: +(fist + 0.32 * gap).toFixed(2),
    openAbove: +(open - 0.30 * gap).toFixed(2),
    throwSpeed: peaks.length >= 2 ? +Math.min(Math.max(0.75 * median(peaks), 0.8), 2.2).toFixed(2) : DEFAULT_TUNING.throwSpeed
  };
  applyTuning(tuning);
  try { localStorage.setItem(CALIB_KEY, JSON.stringify(tuning)); } catch {}
  log(`Tuned: fist < ${tuning.fistBelow}, open > ${tuning.openAbove}, flick ≥ ${tuning.throwSpeed}`);
  calibShow("done", "✅", peaks.length >= 2 ? "Done. GestureShare now matches your hand." : "Fist and open palm are tuned. We could not measure your flicks, so the standard flick setting stays.", "Done");
  calibFill.style.width = "100%";
  playSound("sent");
}

calibGo.addEventListener("click", () => {
  if (!calib) return;
  if (calib.step === "intro" || calib.retry) { calib = { step: "intro" }; calibBegin("fist"); }
  else if (calib.step === "done") calibClose();
});
calibCancel.addEventListener("click", calibClose);
calibReset.addEventListener("click", () => {
  applyTuning(DEFAULT_TUNING);
  try { localStorage.removeItem(CALIB_KEY); } catch {}
  log("Gesture settings are back to standard");
  calibClose();
});
calibButton.addEventListener("click", calibOpen);
document.addEventListener("keydown", e => { if (e.key === "Escape" && calib) calibClose(); });



// ---------------------------------------------------------------------------------------------
// Settings: use your own connection (pairing) server
// ---------------------------------------------------------------------------------------------
const SERVER_KEY = "gestureshare.server";
const serverInput = document.getElementById("server-input");
const serverSave = document.getElementById("server-save");
const serverHint = document.getElementById("server-hint");

// "https://pair.example.com", "pair.example.com", "pair.example.com:9000", "http://192.168.1.5:9000/"
function parseServer(text) {
  let t = String(text || "").trim();
  if (!t) return null;
  let secure = null;
  const m = /^(https?):\/\//i.exec(t);
  if (m) { secure = m[1].toLowerCase() === "https"; t = t.slice(m[0].length); }
  const slash = t.indexOf("/");
  let path = "/";
  if (slash >= 0) { path = t.slice(slash) || "/"; t = t.slice(0, slash); }
  if (!path.endsWith("/")) path += "/";
  const [host, portText] = t.split(":");
  if (!/^[a-z0-9.-]+$/i.test(host || "")) return undefined;
  let port = portText ? Number(portText) : (secure === false ? 80 : 443);
  if (!(port > 0 && port < 65536)) return undefined;
  if (secure === null) secure = !portText || port === 443;
  return { host: host.toLowerCase(), port, path, secure };
}
function showServer() {
  try {
    const s = JSON.parse(localStorage.getItem(SERVER_KEY) || "null");
    serverInput.value = s ? `${s.secure ? "https" : "http"}://${s.host}${(s.secure && s.port === 443) || (!s.secure && s.port === 80) ? "" : ":" + s.port}${s.path && s.path !== "/" ? s.path : ""}` : "";
  } catch { serverInput.value = ""; }
}
showServer();
serverSave.addEventListener("click", () => {
  const parsed = parseServer(serverInput.value);
  if (parsed === undefined) { serverHint.textContent = "That address does not look right. Example: https://pair.example.com"; return; }
  try {
    if (parsed) localStorage.setItem(SERVER_KEY, JSON.stringify(parsed)); else localStorage.removeItem(SERVER_KEY);
  } catch {}
  serverHint.textContent = "Saved. Reloading…";
  setTimeout(() => location.reload(), 400);
});


// ---------------------------------------------------------------------------------------------
// Link with a QR code: this device shows one, and the other device's camera can read it. The
// camera is already on for gestures, so scanning needs no extra step.
// ---------------------------------------------------------------------------------------------
var qrCanvas = document.getElementById("qr-canvas");   // var: renderPairing runs once before this point
var qrBox = document.getElementById("qr-box");
var scanHint = document.getElementById("scan-hint");
const phoneInput = document.getElementById("phone-input");
const phoneSave = document.getElementById("phone-save");
const PHONE_KEY = "gestureshare.phone";

function phoneAddress() { try { return localStorage.getItem(PHONE_KEY) || ""; } catch { return ""; } }

// A phone opens the link and is filled in by itself; another GestureShare reads "gestureshare:123456".
function qrPayload(code) {
  const phone = phoneAddress();
  if (!phone) return `gestureshare:${code}`;
  // If this computer uses its own pairing server, the phone must use the same one.
  let server = "";
  try {
    const s = JSON.parse(localStorage.getItem("gestureshare.server") || "null");
    if (s && s.host) server = `${s.secure ? "https" : "http"}://${s.host}${(s.secure && s.port === 443) || (!s.secure && s.port === 80) ? "" : ":" + s.port}${s.path && s.path !== "/" ? s.path : ""}`;
  } catch {}
  return `${phone.replace(/#.*$/, "")}#c=${code}${server ? "&s=" + encodeURIComponent(server) : ""}`;
}
function parseQr(text) {
  const m = /(?:#c=|gestureshare:)(\d{6})(?!\d)/.exec(String(text || ""));
  return m ? m[1] : null;
}

function drawQr(text) {
  qrBox.hidden = false;
  try {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 4;
    const scale = Math.max(3, Math.floor(qrCanvas.width / (n + quiet * 2)));
    const size = (n + quiet * 2) * scale;
    qrCanvas.width = qrCanvas.height = size;
    const ctx = qrCanvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#000";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
  } catch { qrBox.hidden = true; }
}

const scanCanvas = document.createElement("canvas");
const scanCtx = scanCanvas.getContext("2d", { willReadFrequently: true });
function scanActive() { return !pairPanel.hidden && (pairingState === "idle" || pairingState === "error") && running && !document.hidden; }
const lastScan = { code: "", at: 0 };
function updateScanHint() {
  if (!scanHint) return;
  if (pairPanel.hidden || pairingState !== "idle") { scanHint.hidden = true; return; }
  scanHint.hidden = false;
  scanHint.textContent = running
    ? "The camera is looking for a QR code. Show one from the other device."
    : "Turn on the camera and you can also link by showing a QR code to it.";
}
setInterval(() => {
  updateScanHint();
  if (!scanActive() || video.readyState < 2 || !video.videoWidth) return;
  const w = Math.min(480, video.videoWidth);
  const h = Math.round(w * video.videoHeight / video.videoWidth);
  scanCanvas.width = w; scanCanvas.height = h;
  scanCtx.drawImage(video, 0, 0, w, h);
  let found = null;
  try { found = jsQR(scanCtx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" }); } catch {}
  const code = found && parseQr(found.data);
  if (code && !(code === lastScan.code && Date.now() - lastScan.at < 10000)) {
    lastScan.code = code; lastScan.at = Date.now();
    log("Read a QR code: connecting…");
    link.join(code).catch(() => {});
  }
}, 400);

phoneInput.value = phoneAddress();
phoneSave.addEventListener("click", () => {
  const v = phoneInput.value.trim();
  try { if (/^https:\/\/[^\s]+$/i.test(v)) localStorage.setItem(PHONE_KEY, v); else if (!v) localStorage.removeItem(PHONE_KEY); else { phoneInput.value = ""; phoneInput.placeholder = "Must start with https://"; return; } } catch {}
  phoneSave.textContent = "Saved ✓"; setTimeout(() => { phoneSave.textContent = "Save"; }, 1500);
});


// ---- Settings sheet ----
(() => {
  const sheet = document.getElementById("settings");
  const open = () => { sheet.hidden = false; document.getElementById("settings-done").focus(); };
  const close = () => { sheet.hidden = true; document.getElementById("settings-button").focus(); };
  document.getElementById("settings-button").addEventListener("click", open);
  document.getElementById("settings-done").addEventListener("click", close);
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) close(); });
  // Tuning needs the camera picture, so leave the sheet when it starts.
  document.getElementById("calibrate-btn").addEventListener("click", () => { sheet.hidden = true; });
})();
