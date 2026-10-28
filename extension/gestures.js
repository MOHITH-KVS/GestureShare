const video = document.getElementById("camera");
const canvas = document.getElementById("hand-canvas");
const ctx = canvas.getContext("2d");
const frame = document.querySelector(".camera-frame");
const debugRatio = document.getElementById("debug-ratio");

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

// ---- Tuning values (change these while testing with your own hand) ----------------------------
// A pinch is measured as: distance(thumb tip, index tip) / hand size, so it works at any distance
// from the camera. Two thresholds (hysteresis) stop it flickering when you hover near the limit.
const PINCH_ON = 0.30;      // pinch STARTS when the ratio drops below this
const PINCH_OFF = 0.45;     // pinch ENDS when the ratio rises above this
const PINCH_FRAMES = 2;     // a change must hold for this many frames before it counts
const MISS_FRAMES = 6;      // frames without a hand before we say "no hand" (MediaPipe drops frames)
const SMOOTHING = 0.5;      // 1 = raw landmarks, lower = smoother but laggier

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
let smoothed = null;
let lastStatusKey = "";
let lastDebugAt = 0;

// Only touch the DOM when the text actually changes (it used to be rewritten on every frame).
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

function showPlaceholder(title, description) {
  placeholderTitle.textContent = title;
  placeholderDescription.textContent = description;
  placeholder.hidden = false;
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
  // wrist -> middle-finger knuckle
  return distance(landmarks[0], landmarks[9]) || 1;
}

// The canvas must have the same pixel size and aspect ratio as the video, otherwise the skeleton
// is drawn in the wrong place.
function sizeToVideo() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  frame.style.setProperty("--video-aspect", `${w} / ${h}`);
}
video.addEventListener("loadedmetadata", sizeToVideo);
video.addEventListener("resize", sizeToVideo);

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
  showPlaceholder("Loading hand tracking", "Preparing the local model…");

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
      numHands: 1
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
    "Allow camera access in Chrome to continue."
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
    pinching = false;
    pinchVotes = 0;
    missCount = 0;
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
      cameraError.message
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

// Handles one frame of MediaPipe results. Kept separate from the camera loop so it can be tested.
function handleLandmarks(rawLandmarks) {
  if (!rawLandmarks) {
    missCount++;

    // Ignore a few dropped frames instead of flashing "No hand detected".
    if (missCount >= MISS_FRAMES) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      smoothed = null;
      pinching = false;
      pinchVotes = 0;
      if (debugRatio) debugRatio.textContent = "";

      setStatus(
        "Camera active",
        "No hand detected yet. Hold one hand clearly in front of the camera.",
        "active"
      );
    }
    return;
  }

  missCount = 0;
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

  // Live number for tuning PINCH_ON / PINCH_OFF (updated at most 10 times per second).
  const now = performance.now();
  if (debugRatio && now - lastDebugAt > 100) {
    lastDebugAt = now;
    debugRatio.textContent = `pinch ratio ${ratio.toFixed(2)} (on < ${PINCH_ON}, off > ${PINCH_OFF})`;
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

      handleLandmarks(results.landmarks?.length ? results.landmarks[0] : null);
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
  pinching = false;
  pinchVotes = 0;
  missCount = 0;
  smoothed = null;
  if (debugRatio) debugRatio.textContent = "";

  if (updateStatus) {
    setStatus("Camera is off", "Start the camera whenever you're ready.");
    showPlaceholder("Your camera is off", "Enable camera access to recognize hand gestures.");
    hideHelp();
  }
}

startButton.addEventListener("click", startCamera);
stopButton.addEventListener("click", () => stopCamera());
retryButton.addEventListener("click", startCamera);

helpButton.addEventListener("click", () => {
  // Extension pages cannot open chrome:// links with window.open; use the tabs API.
  chrome.tabs.create({ url: "chrome://settings/content/camera" });
});

window.addEventListener("pagehide", () => stopCamera(false));

closeButton?.addEventListener("click", () => {
  stopCamera(false);
  window.close();
});
