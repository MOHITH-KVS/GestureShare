// Background receiver. It runs in a hidden "offscreen" page (Chrome allows WebRTC there) and keeps
// this device findable, so files from devices under "My devices" arrive even when GestureShare is
// closed. Whenever a GestureShare window is open it steps aside, because that window does the job
// itself (and shows it on screen). Files from other devices are never accepted here: nobody is
// looking at the screen, so they are politely turned away.
(function () {
  "use strict";
  const BG_KEY = "gestureshare.background";      // "off" turns this whole thing off
  const bc = new BroadcastChannel("gestureshare-hub");
  const windows = new Map();                      // open GestureShare windows -> last time they said hello
  let link = null;

  const enabled = () => { try { return localStorage.getItem(BG_KEY) !== "off"; } catch { return true; } };
  const tell = message => { try { chrome.runtime.sendMessage(message).catch(() => {}); } catch { /* no extension messaging */ } };

  function begin() {
    if (link || !enabled() || windows.size) return;
    link = new GestureLink({
      onOffer: offer => {
        if (offer.auto) return;                   // already being received
        link.reject(offer.id, "asleep");
        tell({ t: "notify", title: `${offer.from ? offer.from.name : "A device"} tried to send a file`,
               message: `${offer.name}: open GestureShare, add that device to “My devices”, and send it again.`, open: true });
      },
      onReceived: (offer, blob) => {
        const url = URL.createObjectURL(blob);
        tell({ t: "save", url, name: offer.name, from: offer.from ? offer.from.name : "" });
        setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
      }
    });
    link.start().catch(() => {});
  }
  function end() {
    if (!link) return;
    try { link.stop(); } catch {}
    link = null;
  }
  function decide() { if (windows.size || !enabled()) end(); else begin(); }

  bc.onmessage = event => {
    const m = event.data || {};
    if (m.t === "ui-open" || m.t === "ui-alive") {
      windows.set(m.id, Date.now());
      const wasRunning = !!link;
      end();
      if (m.t === "ui-open") bc.postMessage({ t: "hub-ack", id: m.id, wasRunning });
    } else if (m.t === "ui-closed") {
      windows.delete(m.id);
      decide();
    } else if (m.t === "settings") {
      decide();
    } else if (m.t === "state") {                  // a status question (used by tests and support)
      bc.postMessage({ t: "state-reply", running: !!link, windows: windows.size, signal: link ? link.signal : null,
        presence: !!(link && link.presence && link.presence.open), devices: link ? link.list() : [] });
    }
  };

  // A window that crashed never says goodbye: forget it after a few seconds of silence.
  setInterval(() => {
    const now = Date.now();
    for (const [id, at] of windows) if (now - at > 9000) windows.delete(id);
    decide();
  }, 3000);

  window.hub = { running: () => !!link, link: () => link, windows: () => windows.size };   // for tests
  decide();
})();
