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

const video = document.getElementById("camera");
const canvas = document.getElementById("hand-canvas");
const ctx = canvas.getContext("2d");
const frame = document.getElementById("camera-frame");
const liveBadge = document.getElementById("live-badge");

const status = document.getElementById("gesture-status");
const statusTitle = document.getElementById("status-title");
const statusDot = document.getElementById("status-dot");

const placeholder = document.getElementById("camera-placeholder");
const placeholderTitle = document.getElementById("placeholder-title");
const placeholderDescription = document.getElementById("placeholder-description");

const startButton = document.getElementById("camera-start");
const stopButton = document.getElementById("camera-stop");
const helpPanel = document.getElementById("permission-help");
const helpMessage = document.getElementById("permission-message");
const helpButton = document.getElementById("help-button");
const retryButton = document.getElementById("retry-button");
const closeButton = document.getElementById("close-button");

const chipHand = document.getElementById("chip-hand");
const chipPinch = document.getElementById("chip-pinch");
const meter = document.getElementById("meter");
const meterFill = document.getElementById("meter-fill");
const meterValue = document.getElementById("meter-value");
const meterMarkOn = document.getElementById("meter-mark-on");
const meterMarkOff = document.getElementById("meter-mark-off");
const debugText = document.getElementById("debug-ratio");

// ---- Tuning values (change these while testing with your own hand) ----------------------------
// Pinch = distance(thumb tip, index tip) / hand size, so it works at any distance from the camera.
// Two thresholds (hysteresis) stop it flickering when you hover near the limit.
const PINCH_ON = 0.30;       // pinch STARTS when the ratio drops below this
const PINCH_OFF = 0.45;      // pinch ENDS when the ratio rises above this
const PINCH_FRAMES = 2;      // a pinch change must hold this many frames before it counts

// Rejecting "ghost" hands. MediaPipe sometimes "sees" a hand in a face or background. In a test on a
// hand-free webcam frame it reported a hand on up to ~20% of frames, with 97% confidence, so a
// confidence score alone cannot remove them. What works is that a ghost almost never lasts: the
// longest run was 2 frames, so requiring CONFIRM_FRAMES in a row hides it completely.
const DETECTION_CONFIDENCE = 0.7; // MediaPipe's own threshold. Raise to 0.8-0.9 if ghosts remain,
                                  // lower to 0.5-0.6 if your real hand is not picked up.
const MIN_HAND_SCORE = 0.80; // ignore detections MediaPipe itself is less than 80% sure about
const MIN_HAND_SIZE = 0.06;  // hand (wrist -> middle knuckle) must be at least 6% of frame height
const MAX_HAND_SIZE = 0.70;  // ...and at most 70%
const CONFIRM_FRAMES = 4;    // a hand must be seen this many frames in a row before it is shown
                             // (about 0.15 s; raise to 5-6 if ghosts still flash)
const MISS_FRAMES = 6;       // frames without a hand before we say "no hand" (it drops frames)
const SMOOTHING = 0.5;       // 1 = raw landmarks, lower = smoother but laggier

const METER_RANGE = 0.8;     // pinch meter is empty at this ratio and full at 0

let stream = null;
let handLandmarker = null;
let animationId = null;
let videoFrameId = null;
let running = false;
let starting = false;
let startToken = 0;
let visionModule = null;
let lastVideoTime = -1;

let pinching = false;
let pinchVotes = 0;
let missCount = 0;
let seenFrames = 0;
let confirmed = false;
let smoothed = null;
let lastStatusKey = "";
let lastUiAt = 0;
let lastScore = 0;

// Only touch the DOM when the text actually changes.
function setStatus(title, message, type = "idle") {
  const key = `${title}|${message}|${type}`;
  if (key === lastStatusKey) return;
  lastStatusKey = key;

  statusTitle.textContent = title;
  status.textContent = message;
  statusDot.className = "status-dot";

  if (type === "active") statusDot.classList.add("active");
  if (type === "error") statusDot.classList.add("error");
}

// state: "off" (shows the Enable button), "loading" (spinner), "error" (shows the Try again button)
function showPlaceholder(title, description, state = "off") {
  placeholder.dataset.state = state;
  placeholderTitle.textContent = title;
  placeholderDescription.textContent = description;
  startButton.textContent = state === "error" ? "Try again" : "Enable Camera";
  placeholder.hidden = false;
  if (liveBadge) liveBadge.hidden = true;
}

function showHelp(message) {
  helpMessage.textContent = message;
  helpPanel.hidden = false;
}

function hideHelp() {
  helpPanel.hidden = true;
}

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

// Position of the two threshold marks on the pinch meter.
function placeMeterMarks() {
  const at = ratio => `${Math.round((1 - ratio / METER_RANGE) * 100)}%`;
  meterMarkOn.style.left = at(PINCH_ON);
  meterMarkOff.style.left = at(PINCH_OFF);
}
placeMeterMarks();

function setChip(chip, on) {
  chip.classList.toggle("on", on);
}

function resetIndicators() {
  setChip(chipHand, false);
  setChip(chipPinch, false);
  meter.classList.remove("pinched");
  meterFill.style.transform = "scaleX(0)";
  meterValue.textContent = "–";
  debugText.textContent = "";
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
      numHands: 1,
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
    if (liveBadge) liveBadge.hidden = false;

    running = true;
    pinching = false;
    pinchVotes = 0;
    missCount = 0;
    seenFrames = 0;
    confirmed = false;
    smoothed = null;
    lastVideoTime = -1;
    stopButton.disabled = false;

    setStatus(
      "Camera active",
      "Show one hand to the camera.",
      "active"
    );

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

function drawHand(landmarks) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw connecting lines first.
  ctx.lineWidth = Math.max(2, canvas.width / 180);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = pinching ? "#22c55e" : "#22d3ee";

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

// Decides whether MediaPipe's answer is a real hand. Returns the landmarks, or null for "no hand".
// `results` is exactly what handLandmarker.detectForVideo() returns.
function pickHand(results) {
  const landmarks = results?.landmarks?.[0];
  if (!landmarks) {
    lastScore = 0;
    return null;
  }

  // How sure MediaPipe is that this is a hand (0..1). Ghost hands on faces usually score low.
  const category = (results.handedness ?? results.handednesses)?.[0]?.[0];
  lastScore = category?.score ?? 1;
  if (lastScore < MIN_HAND_SCORE) return null;

  // A real hand has a believable size relative to the frame.
  const sizeFraction = handSize(landmarks) / (video.videoHeight || 1);
  if (sizeFraction < MIN_HAND_SIZE || sizeFraction > MAX_HAND_SIZE) return null;

  return landmarks;
}

function resetTracking() {
  confirmed = false;
  seenFrames = 0;
  missCount = 0;
  smoothed = null;
  pinching = false;
  pinchVotes = 0;
}

// Handles one frame (a hand, or null). Kept separate from the camera loop so it can be tested.
function handleLandmarks(rawLandmarks) {
  if (!rawLandmarks) {
    missCount++;

    // A "hand" that keeps appearing and vanishing never builds up to CONFIRM_FRAMES.
    if (!confirmed) seenFrames = 0;

    // Ignore a few dropped frames instead of flashing "No hand detected".
    if (missCount >= MISS_FRAMES) {
      const hadHand = confirmed;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      resetTracking();
      resetIndicators();

      if (hadHand || statusTitle.textContent !== "Camera active") {
        setStatus(
          "Camera active",
          "No hand detected yet. Hold one hand clearly in front of the camera.",
          "active"
        );
      }
    }
    return;
  }

  missCount = 0;

  // Wait until the same hand has been seen several frames in a row before showing anything.
  if (!confirmed) {
    seenFrames++;
    if (seenFrames < CONFIRM_FRAMES) return;
    confirmed = true;
  }

  const landmarks = smooth(rawLandmarks);

  // Pinch = thumb tip (4) close to index tip (8), relative to the size of the hand.
  const ratio = distance(landmarks[4], landmarks[8]) / handSize(landmarks);
  const wantPinch = pinching ? ratio < PINCH_OFF : ratio < PINCH_ON;

  if (wantPinch !== pinching) {
    pinchVotes++;
    if (pinchVotes >= PINCH_FRAMES) {
      pinching = wantPinch;
      pinchVotes = 0;
    }
  } else {
    pinchVotes = 0;
  }

  drawHand(landmarks);

  if (pinching) {
    setStatus(
      "Pinch detected!",
      "Your thumb and index finger are touching. Gesture recognized.",
      "active"
    );
  } else {
    setStatus(
      "Hand detected",
      "Hand tracking is active. Pinch your thumb and index finger to test.",
      "active"
    );
  }

  setChip(chipHand, true);
  setChip(chipPinch, pinching);
  meter.classList.toggle("pinched", pinching);

  // Meter + numbers: at most ~20 updates per second.
  const now = performance.now();
  if (now - lastUiAt > 50) {
    lastUiAt = now;
    const strength = Math.min(1, Math.max(0, 1 - ratio / METER_RANGE));
    meterFill.style.transform = `scaleX(${strength.toFixed(3)})`;
    meterValue.textContent = pinching ? "Pinched" : `${Math.round(strength * 100)}%`;
    debugText.textContent =
      `pinch ratio ${ratio.toFixed(2)} (on < ${PINCH_ON}, off > ${PINCH_OFF}) · hand confidence ${Math.round(lastScore * 100)}%`;
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

      handleLandmarks(pickHand(results));
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
  if (liveBadge) liveBadge.hidden = true;
  stopButton.disabled = true;
  startButton.disabled = false;
  resetTracking();
  resetIndicators();

  if (updateStatus) {
    setStatus("Camera is off", "Start the camera whenever you're ready.");
    showPlaceholder("Your camera is off", "Turn on the camera to recognize hand gestures.", "off");
    hideHelp();
  }
}

startButton.addEventListener("click", startCamera);
stopButton.addEventListener("click", () => stopCamera());
retryButton?.addEventListener("click", startCamera);   // "Try again" is the big button in the camera view

helpButton.addEventListener("click", () => {
  // Extension pages cannot open chrome:// links with window.open; use the tabs API.
  chrome.tabs.create({ url: "chrome://settings/content/camera" });
});

window.addEventListener("pagehide", () => stopCamera(false));

closeButton?.addEventListener("click", () => {
  stopCamera(false);
  window.close();
});
