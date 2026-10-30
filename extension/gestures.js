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
const connectBox = document.getElementById("connect");
const connectIdle = document.getElementById("connect-idle");
const connectWaiting = document.getElementById("connect-waiting");
const connectConnected = document.getElementById("connect-connected");
const connectError = document.getElementById("connect-error");
const connectWaitLabel = document.getElementById("connect-wait-label");
const connectWaitText = document.getElementById("connect-wait-text");
const codeDisplay = document.getElementById("code-display");
const hostButton = document.getElementById("host-btn");
const joinForm = document.getElementById("join-form");
const joinInput = document.getElementById("join-input");
const cancelConnect = document.getElementById("cancel-connect");
const disconnectButton = document.getElementById("disconnect-btn");
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
let lastProgressAt = 0;
let bannerTimer = null;
let throwCount = 0;

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
  onStatus: (state, info) => renderConnect(state, info),
  onOffer: offer => {
    setIncoming({ ...offer }, 60000);
    showBanner(`Incoming: ${offer.name}`, "info", 2200);
    log(`${offer.name} is incoming (${fmtSize(offer.size)})`);
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
    box.hidden = false;
    box.dataset.done = "false";
    text.textContent = `${direction === "send" ? "Sending" : "Receiving"}  ${fmtSize(bytes)} of ${fmtSize(total)}`;
    fill.style.width = `${Math.round((bytes / total) * 100)}%`;
  },
  onReceived: (offer, blob) => {
    receiving = null;
    saveBlob(blob, offer.name);
    showProgressDone(recvProgress, recvProgressText, recvProgressFill, "Saved to your Downloads folder");
    renderIncoming();
    showBanner(`Received ✓  ${offer.name}`, "ok", 2600);
    log(`Received ${offer.name} (${fmtSize(offer.size)}), saved to Downloads`);
    updateCoach();
  },
  onSendState: (id, state, detail) => {
    switch (state) {
      case "waiting":
        sendProgress.hidden = false; sendProgress.dataset.done = "false";
        sendProgressText.textContent = `Waiting for the other device to catch ${outgoingName}…`;
        sendProgressFill.style.width = "0%";
        break;
      case "sending":
        sendProgressText.textContent = `Sending ${outgoingName}…`;
        break;
      case "delivered":
        showProgressDone(sendProgress, sendProgressText, sendProgressFill, `Delivered ✓  ${outgoingName}`);
        showBanner(`Delivered ✓  ${outgoingName}`, "ok", 2600);
        log(`Delivered ${outgoingName}`);
        break;
      case "declined":
        hideProgress(sendProgress);
        showBanner("They declined the file", "warn", 2600);
        log(`${outgoingName} was declined`);
        break;
      case "expired":
        hideProgress(sendProgress);
        showBanner("Nobody caught it in time", "warn", 2600);
        log(`${outgoingName} expired: not caught within a minute`);
        break;
      case "failed":
        hideProgress(sendProgress);
        showBanner("Sending failed", "warn", 2600);
        log(`${outgoingName} failed: ${detail || "connection problem"}`);
        break;
    }
    updateCoach();
  }
});

// The throw gesture: send the staged file to the connected device.
function onThrow(file, direction) {
  const arrow = ARROWS[direction];
  if (!link.connected) {
    showBanner("Not connected: pair a device first", "warn", 2800);
    log(`Not sent: no device connected (${file.name})`);
    return;
  }
  if (link.outgoing) {
    showBanner("Still sending the last file", "warn", 2200);
    return;
  }
  try {
    outgoingName = file.name;
    link.sendFile(file.file || makeSampleFile(file));
    showBanner(`Thrown ${arrow}  ${file.name}`, "ok");
    log(`Threw ${file.name} ${arrow}`);
  } catch (error) {
    showBanner("Could not send", "warn");
    log(`Could not send ${file.name}: ${error.message}`);
  }
}

// "Use a sample file" has no real file behind it, so make real bytes of that size.
function makeSampleFile(file) {
  const bytes = new Uint8Array(file.size);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 8)) & 255;
  return new File([bytes], file.name, { type: "image/jpeg" });
}

function saveBlob(blob, name) {
  const safe = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 200) || "file";
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

// ---- Connect card -------------------------------------------------------------------------
let lastLinkState = "idle";
function showConnectError(message) {
  connectError.textContent = message || "";
  connectError.hidden = !message;
}

function renderConnect(state, info = {}) {
  const connected = state === "connected";
  connectBox.dataset.state = connected ? "connected" : "idle";
  connectIdle.hidden = !(state === "idle" || state === "error");
  connectWaiting.hidden = !(state === "waiting" || state === "connecting");
  connectConnected.hidden = !connected;
  showConnectError(state === "error" ? info.message : "");

  if (state === "waiting") {
    connectWaitLabel.textContent = "Your code";
    codeDisplay.textContent = `${info.code.slice(0, 3)} ${info.code.slice(3)}`;
    connectWaitText.textContent = "On the other device, open GestureShare and type this code. It connects by itself.";
  } else if (state === "connecting") {
    connectWaitLabel.textContent = "Connecting…";
    codeDisplay.textContent = "• • •";
    connectWaitText.textContent = "Looking for the other device.";
  }

  if (connected && lastLinkState !== "connected") {
    showBanner("Connected ✓", "ok", 1800);
    log("Connected to the other device");
  } else if (!connected && lastLinkState === "connected" && info.message) {
    showBanner("Disconnected", "warn", 2200);
    log(info.message);
    receiving = null; hideProgress(recvProgress); hideProgress(sendProgress);
    renderIncoming();
  }
  lastLinkState = state;

  demoBox.hidden = connected;
  updateCoach();
}

hostButton.addEventListener("click", () => { link.host().catch(() => {}); });
cancelConnect.addEventListener("click", () => link.disconnect());
disconnectButton.addEventListener("click", () => { link.disconnect(); log("Disconnected"); });

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
  fileMeta.textContent = file ? fmtSize(file.size) : "Choose a file, or drop one here.";
  clearFileButton.hidden = !file;
  heldName.textContent = file ? file.name : "file";
  applyMode();
}

chooseFileButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const f = fileInput.files[0];
  if (f) {
    setStagedFile({ name: f.name, size: f.size, file: f });
    log(`Chose ${f.name}`);
  }
  fileInput.value = "";
});
sampleFileButton.addEventListener("click", () => {
  setStagedFile({ name: "sample-photo.jpg", size: 2_400_000 });
  log("Chose sample-photo.jpg");
});
clearFileButton.addEventListener("click", () => {
  setStagedFile(null);
  hideHeldChip();
});

// Drop a file ANYWHERE on the page. (If the page ignores a drop, Chrome opens the file in this tab
// and the user loses GestureShare, so the whole window has to accept it.)
function stageDropped(file) {
  setStagedFile({ name: file.name, size: file.size, file });
  selectTab("send");
  log(`Chose ${file.name}`);
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
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f) stageDropped(f);
});

// ---------------------------------------------------------------------------------------------
// An incoming file: a real offer from the other device, or the demo
// ---------------------------------------------------------------------------------------------
function renderIncoming() {
  incomingBox.classList.toggle("waiting", !!incoming || !!receiving);
  if (incoming) {
    incomingName.textContent = incoming.name;
    incomingMeta.textContent = `${fmtSize(incoming.size)} · waiting for you to catch it`;
  } else if (receiving) {
    incomingName.textContent = receiving.name;
    incomingMeta.textContent = `${fmtSize(receiving.size)} · arriving now`;
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
  heldChip.style.setProperty("--fly-rot", direction === "left" ? "-18deg" : direction === "right" ? "18deg" : "0deg");
  heldChip.classList.add("fly");
  setTimeout(hideHeldChip, 600);   // also covers "reduce motion", where the animation does not run
}

function onGesture(event) {
  switch (event.type) {
    case "grab":
      showHeldChip();
      showBanner("Picked up ✊  now flick to send", "info", 1800);
      log(`Picked up ${stagedFile ? stagedFile.name : "file"}`);
      break;

    case "blocked":
      if (tab === "send") showBanner("Choose a file first", "warn");
      break;

    case "throw": {
      const file = stagedFile;
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
  coachTitle.textContent = title;
  coachSub.textContent = sub;
  coach.dataset.tone = tone;
}

// One instruction at a time: what to do next.
function updateCoach(force = false) {
  if (force) lastCoach = "";
  if (override) { setCoach(override.title, override.sub, override.tone); return; }
  if (!running) {
    if (incoming) setCoach("Incoming file", `${incoming.name} is waiting. Turn on the camera to catch it, or select Accept.`, "warn");
    else if (stagedFile && tab === "send") setCoach("File ready", `Turn on the camera, then make a fist to pick up ${stagedFile.name}.`, "ok");
    else setCoach("Turn on the camera", "GestureShare uses your camera to see your hand. Nothing is recorded.");
    return;
  }
  if (document.hidden) { setCoach("Paused", "This window is hidden. Bring it back to continue.", "warn"); return; }

  if (twoHands) { setCoach("Two hands detected", "Please show only one hand for smooth and reliable file sharing.", "warn"); return; }

  const holding = engine.state === "holding";
  const file = stagedFile ? stagedFile.name : "";
  const handOn = confirmed;

  if (tab === "send") {
    if (!stagedFile) setCoach("Choose a file to send", "Pick one below, or drop it on the box.");
    else if (!link.connected && !holding) setCoach("Connect a device to send", "You can practise the gesture now, but nothing is sent until a device is connected.", "warn");
    else if (holding) setCoach("Now flick to send", `Move your hand quickly sideways. Holding ${file}.`, "ok");
    else if (!handOn) setCoach("Show your hand", `Then make a fist to pick up ${file}.`);
    else setCoach("Make a fist", `Hold it for half a second to pick up ${file}.`);
  } else {
    if (!incoming && link.connected) setCoach("Waiting for a file", "Ask the other device to throw you one.");
    else if (!incoming) setCoach("Connect a device to receive", "Pair with the code at the top, or use the demo to practise catching.");
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
  pinch: ["🤏", "Pinch"],
  other: ["🖐️", "Hand"]
};
const TARGETS = { grab: "Hold to pick up", catch: "Hold to catch", throw: "Flick to send" };

// Exactly one gesture is shown at a time, and the bar only appears when that gesture is about to
// DO something (pick up, send, catch). A pinch or an in-between hand never shows a bar.
function showGesture() {
  const [icon, label] = POSES[engine.pose] || POSES.other;
  gesturePill.hidden = false;
  gesturePill.dataset.pose = engine.pose;
  if (gestureIcon.textContent !== icon) gestureIcon.textContent = icon;
  if (gestureLabel.textContent !== label) gestureLabel.textContent = label;

  if (engine.target) {
    holdBar.hidden = false;
    holdBar.dataset.target = engine.target;
    if (holdLabel.textContent !== TARGETS[engine.target]) holdLabel.textContent = TARGETS[engine.target];
    holdFill.style.width = `${Math.round(engine.progress * 100)}%`;
  } else {
    holdBar.hidden = true;
  }
}

function resetIndicators() {
  gesturePill.hidden = true;
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

function drawHand(landmarks, forceColour, keep = false) {
  if (!keep) ctx.clearRect(0, 0, canvas.width, canvas.height);

  // The skeleton changes colour with the gesture, so you can see what the app thinks you are doing.
  const colour = forceColour || engine.state === "holding" ? "#fbbf24" : engine.pose === "open" ? "#34d399" : "#4f8cff";

  // Draw connecting lines first.
  ctx.lineWidth = Math.max(2, canvas.width / 180);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = colour;

  for (const [start, end] of connections) {
    const a = landmarks[start];
    const b = landmarks[end];

    ctx.beginPath();
    ctx.moveTo(a.x * canvas.width, a.y * canvas.height);
    ctx.lineTo(b.x * canvas.width, b.y * canvas.height);
    ctx.stroke();
  }

  // Draw clearly visible joints.
  for (let i = 0; i < landmarks.length; i++) {
    const point = landmarks[i];
    const radius = [4, 8, 12, 16, 20].includes(i) ? 5 : 3.5;

    ctx.beginPath();
    ctx.arc(point.x * canvas.width, point.y * canvas.height, radius, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#2563eb";
    ctx.stroke();
  }
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
  heldChip.style.left = `${((1 - engine.palm.x) * 100).toFixed(1)}%`;
  heldChip.style.top = `${(engine.palm.y * 100).toFixed(1)}%`;
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

  const landmarks = smooth(rawLandmarks);

  drawHand(landmarks);
  moveHeldChip();
  showGesture();
  updateCoach();

  // Numbers: at most ~20 updates per second.
  if (now - lastUiAt > 50) {
    lastUiAt = now;
    debugText.textContent =
      `pose ${engine.pose} · openness ${engine.openness.toFixed(2)} (fist < ${FIST_BELOW}, open > ${OPEN_ABOVE}) · ` +
      `shortest finger ${engine.minTip.toFixed(2)} · pinch ${engine.pinchRatio.toFixed(2)} · ` +
      `speed ${engine.speed.toFixed(1)} (send ≥ ${THROW_SPEED}, peak ${engine.peakSpeed.toFixed(1)}) · ` +
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

window.addEventListener("pagehide", () => { stopCamera(false); link.disconnect(true); });

closeButton?.addEventListener("click", () => {
  stopCamera(false);
  window.close();
});

renderIncoming();
updateCoach();
