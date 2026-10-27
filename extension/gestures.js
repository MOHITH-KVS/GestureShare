
const video = document.getElementById("camera");
const canvas = document.getElementById("hand-canvas");
const ctx = canvas.getContext("2d");

const status = document.getElementById("gesture-status");
const startButton = document.getElementById("camera-start");
const stopButton = document.getElementById("camera-stop");

let stream = null;
let handLandmarker = null;
let animationId = null;
let running = false;
let lastPinch = false;

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function setStatus(message) {
  status.textContent = message;
}

async function startCamera() {
  if (running) return;

  try {
    setStatus("Requesting camera permission...");

    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
      audio: false
    });

    video.srcObject = stream;
    await video.play();

    setStatus("Loading hand tracking model...");

    const vision = await import(
      chrome.runtime.getURL("vendor/vision_bundle.mjs")
    );

    const files = await vision.FilesetResolver.forVisionTasks(
      chrome.runtime.getURL("vendor/wasm")
    );

    handLandmarker = await vision.HandLandmarker.createFromOptions(files, {
      baseOptions: {
        modelAssetPath: chrome.runtime.getURL(
          "vendor/hand_landmarker.task"
        ),
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      numHands: 1
    });

    running = true;
    lastPinch = false;
    startButton.disabled = true;
    stopButton.disabled = false;

    setStatus("Camera active. Show one hand.");
    detectFrame();
  } catch (error) {
    console.error("GestureShare camera error:", error);
    stopCamera();
    setStatus("Could not start: " + error.message);
  }
}

function detectFrame() {
  if (!running) return;

  if (video.readyState >= 2) {
    const results = handLandmarker.detectForVideo(video, performance.now());

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (results.landmarks && results.landmarks.length > 0) {
      const landmarks = results.landmarks[0];

      for (const point of landmarks) {
        ctx.beginPath();
        ctx.arc(
          point.x * canvas.width,
          point.y * canvas.height,
          4,
          0,
          Math.PI * 2
        );
        ctx.fillStyle = "#60a5fa";
        ctx.fill();
      }

      const thumbTip = landmarks[4];
      const indexTip = landmarks[8];

      const pinchDistance = distance(thumbTip, indexTip);
      const isPinching = pinchDistance < 0.055;

      if (isPinching && !lastPinch) {
        setStatus("Pinch detected — gesture recognized!");
      } else if (!isPinching) {
        setStatus("Hand detected. Pinch your thumb and index finger.");
      }

      lastPinch = isPinching;
    } else {
      lastPinch = false;
      setStatus("No hand detected. Show your hand to the camera.");
    }
  }

  animationId = requestAnimationFrame(detectFrame);
}

function stopCamera() {
  running = false;

  if (animationId !== null) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }

  if (handLandmarker) {
    handLandmarker.close();
    handLandmarker = null;
  }

  if (video) video.srcObject = null;

  if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (startButton) startButton.disabled = false;
  if (stopButton) stopButton.disabled = true;

  if (status) setStatus("Camera stopped.");
}

startButton.addEventListener("click", startCamera);
stopButton.addEventListener("click", stopCamera);

window.addEventListener("beforeunload", stopCamera);
