// First-time "How it works" guide. Plain words, one idea per page.
(() => {
  "use strict";
  const KEY = "gestureshare.guideSeen";
  const el = (id) => document.getElementById(id);
  const root = el("guide");
  if (!root) return;

  const PAGES = [
    {
      visual: '<span class="gv big">✋</span>',
      title: "Send files with your hand",
      text: "No cables. No sign-ups. Pick a file, wave your hand, and it appears on your other device.",
      list: ["Link your two devices (only once)", "Send: make a fist, then flick", "Receive: open your palm"],
      listClass: "numbered",
    },
    {
      visual: '<span class="gv">💻</span><span class="gv arrow">⇄</span><span class="gv">💻</span>',
      title: "Step 1: Link your two devices",
      text: "You only do this one time. After that they find each other by themselves.",
      list: [
        "On the first device, press “Show my code”. A 6-digit number appears.",
        "On the second device, type that number and press “Connect”.",
        "When you see a green dot and “Connected”, you are done.",
      ],
      listClass: "numbered",
    },
    {
      visual: '<span class="gv fist">✊</span><span class="gv arrow">→</span><span class="gv flick">👉</span>',
      title: "Step 2: To send, make a fist, then flick",
      text: "Do this on the device that has the file.",
      list: [
        "Choose a file.",
        "Show your hand to the camera and close it into a fist for half a second. The file is now “in your hand”.",
        "Quickly flick your hand sideways. The file is sent.",
      ],
      listClass: "numbered",
      or: "Easier: just press the blue “Send now” button. It does the same thing.",
    },
    {
      visual: '<span class="gv">📥</span><span class="gv arrow">←</span><span class="gv palm">✋</span>',
      title: "Step 3: To receive, open your palm",
      text: "Do this on the other device, the one getting the file.",
      list: [
        "Open the “Receive” tab. You will see the file name appear.",
        "Hold your hand open, with all five fingers spread out, for half a second.",
        "The file saves to your Downloads folder.",
      ],
      listClass: "numbered",
      or: "Easier: just press the “Accept” button.",
    },
    {
      visual: '<span class="gv">☝️</span>',
      title: "A few tips so it works well",
      text: "",
      list: [
        "Show only one hand at a time.",
        "Keep your hand where the camera can see it, with good light.",
        "Keep GestureShare open and visible on both devices.",
        "Your camera is only used on your own device. Nothing is recorded or uploaded.",
      ],
      listClass: "bullets",
    },
  ];

  const q = {
    visual: el("guide-visual"), title: el("guide-title"), text: el("guide-text"),
    list: el("guide-list"), or: el("guide-or"), dots: el("guide-dots"),
    back: el("guide-back"), next: el("guide-next"), skip: el("guide-skip"),
  };
  let page = 0;
  let opener = null;

  function seen(set) {
    try {
      if (set) localStorage.setItem(KEY, "1");
      else return localStorage.getItem(KEY) === "1";
    } catch { /* storage can be blocked; guide then just shows each time */ }
    return false;
  }

  function render() {
    const p = PAGES[page];
    q.visual.innerHTML = p.visual;
    q.title.textContent = p.title;
    q.text.textContent = p.text;
    q.text.hidden = !p.text;
    q.list.className = "guide-list " + p.listClass;
    q.list.replaceChildren(...p.list.map((t) => { const li = document.createElement("li"); li.textContent = t; return li; }));
    q.or.textContent = p.or || "";
    q.or.hidden = !p.or;
    q.dots.replaceChildren(...PAGES.map((_, i) => { const d = document.createElement("i"); if (i === page) d.className = "on"; return d; }));
    q.back.hidden = page === 0;
    const last = page === PAGES.length - 1;
    q.next.textContent = last ? "Got it, let’s start" : "Next";
    q.skip.hidden = last;
  }

  function open(from) {
    page = 0;
    opener = from || document.activeElement;
    render();
    root.hidden = false;
    q.next.focus();
  }
  function close() {
    root.hidden = true;
    seen(true);
    if (opener && opener.focus) try { opener.focus(); } catch {}
  }

  q.next.addEventListener("click", () => { if (page === PAGES.length - 1) close(); else { page++; render(); q.next.focus(); } });
  q.back.addEventListener("click", () => { if (page > 0) { page--; render(); q.next.focus(); } });
  q.skip.addEventListener("click", close);
  root.addEventListener("click", (e) => { if (e.target === root) close(); });
  document.addEventListener("keydown", (e) => {
    if (root.hidden) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight") q.next.click();
    else if (e.key === "ArrowLeft") q.back.click();
    else if (e.key === "Tab") { // keep focus inside the dialog
      const f = [...root.querySelectorAll("button:not([hidden])")];
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  const btn = el("guide-button");
  btn?.addEventListener("click", () => open(btn));

  const mode = new URLSearchParams(location.search).get("mode");
  if (mode !== "setup" && !seen()) open(null);
})();
