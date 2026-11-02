// ---------------------------------------------------------------------------------------------
// GestureShare: many devices, direct file transfer
//
// How it works (no file ever touches a server):
//   YOUR DEVICES   Every device has a private id and stays "findable" while GestureShare is open.
//                  Devices signed into the same Chrome account find each other by themselves: the
//                  extension keeps a shared link key in chrome.storage.sync (Chrome's own sync).
//   OTHER DEVICES  Link once with a 6-digit code (a friend's laptop, or a computer without Chrome
//                  sync). The host must allow the new device. After that they find each other too.
//   PROOF          Two linked devices prove who they are with a challenge/response (HMAC), so
//                  nobody can pretend to be a device, even if it is offline when they try.
//   TRANSFER       A tiny matchmaker server (PeerJS) only introduces browsers. After that they talk
//                  directly (WebRTC). The receiver must accept before any bytes move, unless the
//                  sender is a device the person marked "accept automatically".
//
// Messages on a channel (text = JSON control message, binary = a piece of the file):
//   {t:"hello", kind:"pair"|"resume", deviceId, name, nonce?}   dialler -> listener, first message
//   {t:"challenge", nonce, proof, name}   listener -> dialler  (resume only: proves the listener first)
//   {t:"auth", proof}                     dialler -> listener  (resume only)
//   {t:"welcome", kind, deviceId, name, secret?} | {t:"refuse", reason}
//   {t:"name", name}                      a device was renamed
//   {t:"offer", id, name, size, mime} / {t:"accept", id} / {t:"decline", id, reason}
//   <binary pieces...> / {t:"done", id} / {t:"ack", id, ok, bytes} / {t:"cancel", id}
//
// Usage (all callbacks are optional):
//   const link = new GestureLink({
//     signal,                                  // {host, port, path, secure}; default: public PeerJS
//     onDevices(list),                         // [{id, name, online, auto, source, stale, label}] after every change
//     onPairing(state, info),                  // "idle" | "waiting" {code} | "confirm" {name, allow(), deny()} | "connecting" | "error" {message}
//     onEvent({type, device, message}),        // "connected" | "disconnected" | "paired" | "refused"
//     onOffer({id, from, name, size, mime, auto}),
//     onOfferGone(id, reason),
//     onProgress(direction, id, bytes, total),
//     onReceived(offer, blob),
//     onSendState(id, state, detail)           // "waiting" | "sending" | "delivered" | "declined" | "expired" | "failed"
//   });
//   link.start()                               // once, when the page opens
//   link.host() / link.join("123456") / link.cancelPairing()
//   link.sendFile(file, toDeviceId?) / link.accept(id) / link.reject(id) / link.cancelSend()
//   link.setAuto(id, true|false) / link.remove(id) / link.setName(text) / link.setTarget(id)
//
// Loads PeerJS from vendor/peerjs.min.js (a classic script, so window.Peer exists).
// ---------------------------------------------------------------------------------------------
(function (root) {
  "use strict";

  const SIGNALING = { host: "0.peerjs.com", port: 443, path: "/", secure: true };

  const CODE_PREFIX = "gestureshare-";
  const DEVICE_PREFIX = "gestureshare-d-";
  const CHUNK = 256 * 1024;
  const READ_BLOCK = 1024 * 1024;
  const BUFFER_HIGH = 4 * 1024 * 1024;
  const BUFFER_LOW = 1024 * 1024;
  const OFFER_TIMEOUT_MS = 60000;
  const CONNECT_TIMEOUT_MS = 15000;
  const HANDSHAKE_TIMEOUT_MS = 10000;
  const CODE_LIFETIME_MS = 120000;
  const CONFIRM_TIMEOUT_MS = 60000;
  const REDIAL_MS = 20000;
  const PING_MS = 5000;               // keep-alive: a device that vanishes without saying goodbye is noticed
  const DEAD_MS = 16000;

  const KEY_ME = "gestureshare.me";
  const KEY_NAME = "gestureshare.name";
  const KEY_DEVICES = "gestureshare.devices";
  const KEY_TARGET = "gestureshare.target";
  const KEY_PAIR_OLD = "gestureshare.pair";     // the single remembered device of earlier versions
  const KEY_ACCOUNT = "gs.account";             // in chrome.storage.sync

  const noop = () => {};
  const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
  const randomCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
  const cleanName = name => String(name || "file").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 200) || "file";
  const cleanLabel = name => String(name || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 40);

  const memory = {};
  const store = {
    get(key) { try { const v = root.localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return memory[key] || null; } },
    set(key, value) { try { root.localStorage.setItem(key, JSON.stringify(value)); } catch { memory[key] = value; } },
    remove(key) { try { root.localStorage.removeItem(key); } catch { delete memory[key]; } }
  };

  function defaultDeviceName() {
    const platform = (root.navigator && ((root.navigator.userAgentData && root.navigator.userAgentData.platform) || root.navigator.platform)) || "";
    if (/win/i.test(platform)) return "Windows computer";
    if (/mac/i.test(platform)) return "Mac";
    if (/cros|chrome os/i.test(platform)) return "Chromebook";
    if (/android/i.test(platform)) return "Android phone";
    if (/iphone|ipad|ios/i.test(platform)) return "iPhone";
    if (/linux/i.test(platform)) return "Linux computer";
    return "Other device";
  }

  // Chrome's own sync keeps a small record for the signed-in account. Works as a plain local store
  // when Chrome is not signed in (then devices simply do not appear on each other).
  function chromeAccountStore() {
    const area = root.chrome && root.chrome.storage && root.chrome.storage.sync;
    if (!area) return null;
    return {
      get: () => new Promise(resolve => { try { area.get(KEY_ACCOUNT, r => resolve((!root.chrome.runtime.lastError && r && r[KEY_ACCOUNT]) || null)); } catch { resolve(null); } }),
      set: value => new Promise(resolve => { try { area.set({ [KEY_ACCOUNT]: value }, () => { void root.chrome.runtime.lastError; resolve(); }); } catch { resolve(); } }),
      onChange: cb => { try { root.chrome.storage.onChanged.addListener((changes, areaName) => { if (areaName === "sync" && changes[KEY_ACCOUNT]) cb(changes[KEY_ACCOUNT].newValue || null); }); } catch {} }
    };
  }

  const encoder = new TextEncoder();
  async function hmac(secret, text) {
    const key = await crypto.subtle.importKey("raw", encoder.encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text))));
  }
  function sameText(a, b) {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
  }

  class GestureLink {
    constructor(options = {}) {
      const test = root.GESTURE_LINK_CONFIG || {};
      this.signal = options.signal || test.signaling || SIGNALING;
      this.iceServers = options.iceServers || test.iceServers;
      this.accountStore = "accountStore" in test ? test.accountStore : chromeAccountStore();
      this.cb = {
        devices: options.onDevices || noop,
        pairing: options.onPairing || noop,
        event: options.onEvent || noop,
        offer: options.onOffer || noop,
        offerGone: options.onOfferGone || noop,
        progress: options.onProgress || noop,
        received: options.onReceived || noop,
        sendState: options.onSendState || noop
      };

      this.me = store.get(KEY_ME);
      if (!this.me || !this.me.id) { this.me = { id: randomHex(16) }; store.set(KEY_ME, this.me); }
      this.name = cleanLabel(store.get(KEY_NAME)) || defaultDeviceName();

      this.devices = new Map();          // id -> {id, name, secret, auto, source, stale}
      for (const d of store.get(KEY_DEVICES) || []) if (d && d.id && d.secret) this.devices.set(d.id, d);
      const old = store.get(KEY_PAIR_OLD);                // move the single device of earlier versions
      if (old && old.id && old.secret && !this.devices.has(old.id)) {
        this.devices.set(old.id, { id: old.id, name: old.name || "Other device", secret: old.secret, auto: null, source: "code" });
        this._saveDevices();
      }
      if (old) store.remove(KEY_PAIR_OLD);

      this.accountKey = null;
      this.sessions = new Map();         // id -> {conn, dev, outgoing, incoming}   trusted connections
      this.dialing = new Map();          // id -> conn   outgoing attempts that are not trusted yet
      this.failers = new Map();          // remote peer id -> fn(err)   for "peer-unavailable"
      this.presence = null;              // our permanent peer: others find us through it
      this.dialPeer = null;              // used for dialling when we do not own the presence peer
      this.hostPeer = null;
      this.hostTimer = null;
      this.pairState = "idle";
      this.stopped = false;
      this.redialTimer = null;
    }

    // ---- what the page can read ---------------------------------------------------------------

    get connected() { return this.sessions.size > 0; }

    /** The devices, newest state first for the page: online ones first. */
    list() {
      const names = new Map();
      for (const d of this.devices.values()) names.set(d.name, (names.get(d.name) || 0) + 1);
      const out = [];
      for (const d of this.devices.values()) {
        out.push({
          id: d.id, name: d.name, auto: d.auto, source: d.source, stale: !!d.stale,
          online: this.sessions.has(d.id),
          label: names.get(d.name) > 1 ? `${d.name} (${d.id.slice(0, 4).toUpperCase()})` : d.name
        });
      }
      out.sort((a, b) => (b.online - a.online) || a.label.localeCompare(b.label));
      return out;
    }

    /** Where a file goes: the chosen device if it is online, else the only online device, else null. */
    target() {
      const online = this.list().filter(d => d.online);
      const chosen = store.get(KEY_TARGET);
      if (chosen && online.some(d => d.id === chosen)) return chosen;
      return online.length ? online[0].id : null;
    }
    setTarget(id) { if (this.sessions.has(id)) { store.set(KEY_TARGET, id); this._emitDevices(); } }

    /** The file being sent to the target device, if any. */
    get outgoing() { const s = this.sessions.get(this.target()); return s ? s.outgoing : null; }

    _emitDevices() { try { this.cb.devices(this.list()); } catch (e) { console.error(e); } }
    _event(type, dev, message) { try { this.cb.event({ type, device: dev ? { id: dev.id, name: dev.name } : null, message }); } catch (e) { console.error(e); } }
    _setPair(state, info = {}) { this.pairState = state; try { this.cb.pairing(state, info); } catch (e) { console.error(e); } }
    _saveDevices() { store.set(KEY_DEVICES, Array.from(this.devices.values())); }

    // ---- lifecycle ----------------------------------------------------------------------------

    /** Call once when the page opens: join the account, stay findable, connect to every known device. */
    async start() {
      this.stopped = false;
      this._emitDevices();
      await this._startPresence();
      this._syncAccount().catch(noop);
      if (this.accountStore && this.accountStore.onChange) this.accountStore.onChange(value => this._syncAccount(value).catch(noop));
      this._redialAll();
      clearInterval(this.redialTimer);
      this.redialTimer = setInterval(() => this._redialAll(), REDIAL_MS);
    }

    /** Close everything (the page is closing). Linked devices stay linked. */
    stop() {
      this.stopped = true;
      clearInterval(this.redialTimer);
      this.cancelPairing(true);
      for (const s of Array.from(this.sessions.values())) this._dropSession(s, "disconnected", true);
      for (const c of Array.from(this.dialing.values())) { try { c.gs.done = true; c.close(); } catch {} }
      this.dialing.clear();
      for (const p of [this.presence, this.dialPeer]) { try { p && p.destroy(); } catch {} }
      this.presence = this.dialPeer = null;
    }

    _newPeer(id) {
      if (typeof root.Peer !== "function") throw new Error("A file is missing: put peerjs.min.js inside the vendor folder, then reload the extension on chrome://extensions.");
      const s = this.signal;
      const options = { host: s.host, port: s.port, path: s.path || "/", secure: !!s.secure, debug: 0 };
      if (this.iceServers) options.config = { iceServers: this.iceServers };
      return id ? new root.Peer(id, options) : new root.Peer(options);
    }

    _peerError(err) {
      if (err && err.type === "peer-unavailable") {
        const m = /peer\s+(\S+)/.exec(err.message || "");
        const fail = m && this.failers.get(m[1]);
        if (fail) fail({ type: "peer-unavailable" });
      }
    }

    _startPresence() {
      if (this.presence) return Promise.resolve(true);
      return new Promise(resolve => {
        let peer;
        try { peer = this._newPeer(DEVICE_PREFIX + this.me.id); } catch { resolve(false); return; }
        this.presence = peer;
        const timer = setTimeout(() => resolve(false), 8000);
        peer.on("open", () => { clearTimeout(timer); resolve(true); });
        peer.on("connection", conn => this._wire(conn, { role: "listener", mode: "device" }));
        peer.on("error", err => {
          this._peerError(err);
          if (err.type === "unavailable-id") {       // another page of this profile already listens; that one does the listening
            clearTimeout(timer);
            try { peer.destroy(); } catch {}
            if (this.presence === peer) this.presence = null;
            resolve(false);
          }
        });
        peer.on("disconnected", () => { try { peer.reconnect(); } catch {} });
      });
    }

    // A peer we can dial from: the presence peer when it is open, else a separate one.
    _dialer() {
      if (this.presence && this.presence.open) return Promise.resolve(this.presence);
      if (this.dialPeer && this.dialPeer.open) return Promise.resolve(this.dialPeer);
      return new Promise((resolve, reject) => {
        if (!this.dialPeer) {
          let peer;
          try { peer = this._newPeer(); } catch (e) { reject(e); return; }
          this.dialPeer = peer;
          peer.on("error", err => { this._peerError(err); if (!peer.open && this.dialPeer === peer) { this.dialPeer = null; } });
          peer.on("disconnected", () => { try { peer.reconnect(); } catch {} });
          peer.on("connection", conn => this._wire(conn, { role: "listener", mode: "device" }));
        }
        const peer = this.dialPeer;
        const timer = setTimeout(() => reject(new Error("timeout")), CONNECT_TIMEOUT_MS);
        const check = () => { clearTimeout(timer); resolve(peer); };
        if (peer.open) check(); else peer.once("open", check);
      });
    }

    // ---- your account's devices (Chrome sync) -------------------------------------------------

    async _syncAccount(remote) {
      const acc = this.accountStore;
      if (!acc) return;
      let rec = remote !== undefined ? remote : await acc.get();
      let write = false;
      if (!rec || typeof rec.key !== "string" || !rec.key) { rec = { key: randomHex(24), devices: {} }; write = true; }
      rec.devices = rec.devices && typeof rec.devices === "object" ? rec.devices : {};
      if (this.accountKey && this.accountKey !== rec.key && this.accountKey < rec.key) { rec.key = this.accountKey; write = true; }   // two keys created at once: the smaller wins everywhere
      const mine = rec.devices[this.me.id];
      if (!mine || mine.name !== this.name) { rec.devices[this.me.id] = { name: this.name }; write = true; }
      this.accountKey = rec.key;

      let changed = false;
      for (const [id, info] of Object.entries(rec.devices)) {
        if (id === this.me.id || !info) continue;
        const name = cleanLabel(info.name) || "Other device";
        const d = this.devices.get(id);
        if (!d || d.source !== "account" || d.secret !== rec.key || d.name !== name) {
          this.devices.set(id, { id, name, secret: rec.key, auto: d && d.auto !== null && d.auto !== undefined ? d.auto : true, source: "account" });
          changed = true;
        }
      }
      if (write) await acc.set(rec);
      if (changed) { this._saveDevices(); this._emitDevices(); this._redialAll(); }
    }

    // ---- names, trust, forgetting -------------------------------------------------------------

    setName(text) {
      const name = cleanLabel(text);
      if (!name || name === this.name) return;
      this.name = name;
      store.set(KEY_NAME, name);
      for (const s of this.sessions.values()) { try { this._send(s, { t: "name", name }); } catch {} }
      this._syncAccount().catch(noop);
      this._emitDevices();
    }

    /** true = accept this device's files automatically, false = ask every time. */
    setAuto(id, value) {
      const d = this.devices.get(id);
      if (!d) return;
      d.auto = !!value;
      this._saveDevices();
      this._emitDevices();
    }

    /** Forget a device linked with a code. (Devices from your Chrome account come back by themselves.) */
    remove(id) {
      const d = this.devices.get(id);
      if (!d || d.source === "account") return false;
      const s = this.sessions.get(id);
      if (s) this._dropSession(s, "disconnected", true);
      this.devices.delete(id);
      this._saveDevices();
      this._emitDevices();
      return true;
    }

    // ---- connecting to the devices we know ------------------------------------------------------

    _redialAll() {
      if (this.stopped) return;
      for (const d of this.devices.values()) if (!d.stale) this._dialDevice(d).catch(noop);
    }

    async _dialDevice(dev) {
      if (this.stopped || this.sessions.has(dev.id) || this.dialing.has(dev.id) || dev.id === this.me.id) return;
      let peer;
      try { peer = await this._dialer(); } catch { return; }
      if (this.stopped || this.sessions.has(dev.id) || this.dialing.has(dev.id)) return;
      const remoteId = DEVICE_PREFIX + dev.id;
      const conn = peer.connect(remoteId, { serialization: "raw", reliable: true });
      const gs = { role: "dialer", kind: "resume", dev, nonce: randomHex(16), done: false };
      gs.onFail = () => {};
      this.dialing.set(dev.id, conn);
      this.failers.set(remoteId, err => this._handshakeFail(conn, err));
      this._wire(conn, gs);
    }

    // ---- first-time linking with a code --------------------------------------------------------

    /** Show a code on this device. The other device types it; this device then confirms. */
    host() {
      this.cancelPairing(true);
      return new Promise((resolve, reject) => {
        const attempt = tries => {
          const code = randomCode();
          let peer;
          try { peer = this._newPeer(CODE_PREFIX + code); } catch (error) { this._pairFail(error.message); reject(error); return; }
          this.hostPeer = peer;
          peer.on("open", () => {
            this.hostCode = code;
            this.hostClaimed = false;
            this._setPair("waiting", { code });
            clearTimeout(this.hostTimer);
            this.hostTimer = setTimeout(() => {
              if (this.hostPeer === peer && !this.hostClaimed) { this.cancelPairing(true); this._setPair("error", { message: "The code expired. Press “Show my code” for a new one." }); }
            }, CODE_LIFETIME_MS);
            resolve(code);
          });
          peer.on("connection", conn => this._wire(conn, { role: "listener", mode: "pair" }));
          peer.on("error", err => {
            if (this.hostPeer !== peer) return;
            if (err.type === "unavailable-id" && tries < 5) { try { peer.destroy(); } catch {} attempt(tries + 1); return; }
            this._pairFail(this._explain(err)); reject(new Error("pairing failed"));
          });
          peer.on("disconnected", () => { if (this.hostPeer === peer && !this.hostClaimed) { try { peer.reconnect(); } catch {} } });
        };
        attempt(0);
      });
    }

    /** Type the code shown on the other device. */
    async join(code) {
      this.cancelPairing(true);
      code = String(code || "").replace(/\D/g, "");
      if (code.length !== 6) { this._pairFail("The code has 6 digits."); throw new Error("code"); }
      this._setPair("connecting");
      let peer;
      try { peer = await this._dialer(); } catch (e) { this._pairFail(this._explain({ type: "network" })); throw e; }
      const remoteId = CODE_PREFIX + code;
      const conn = peer.connect(remoteId, { serialization: "raw", reliable: true });
      const gs = { role: "dialer", kind: "pair", done: false };
      gs.onFail = err => this._pairFail(this._explain(err));
      this.pairConn = conn;
      this.failers.set(remoteId, err => this._handshakeFail(conn, err));
      this._wire(conn, gs);
    }

    /** Stop showing a code / stop an attempt. `silent` = do not tell the page. */
    cancelPairing(silent = false) {
      clearTimeout(this.hostTimer);
      clearTimeout(this.confirmTimer);
      if (this.hostPeer) { try { this.hostPeer.destroy(); } catch {} this.hostPeer = null; }
      if (this.pairConn) { try { this.pairConn.gs.done = true; this.pairConn.close(); } catch {} this.pairConn = null; }
      if (this.waitingConfirm) { try { this._refuse(this.waitingConfirm, "denied"); } catch {} this.waitingConfirm = null; }
      this.hostCode = null;
      if (!silent && this.pairState !== "idle") this._setPair("idle", {});
      else this.pairState = "idle";
    }

    _pairFail(message) {
      this.cancelPairing(true);
      this._setPair("error", { message });
    }

    _explain(err) {
      const type = err && err.type;
      return type === "peer-unavailable" ? "No device has that code. Check the code and try again."
        : type === "timeout" ? "Could not reach the other device. Check that both are online."
        : type === "network" || type === "server-error" || type === "socket-error" || type === "socket-closed" ? "Could not reach the connection server. Check your internet connection."
        : (err && err.message) || "Could not connect.";
    }

    // ---- one connection: handshake, then it becomes a session ---------------------------------

    _wire(conn, gs) {
      conn.gs = gs;
      gs.trusted = false;
      conn.on("open", () => {
        gs.timer = setTimeout(() => {
          if (gs.trusted) return;
          if (gs.role === "dialer") this._handshakeFail(conn, { type: "timeout" });
          else { try { conn.close(); } catch {} }
        }, HANDSHAKE_TIMEOUT_MS);
        if (gs.role === "dialer") {
          if (gs.kind === "pair") this._raw(conn, { t: "hello", kind: "pair", deviceId: this.me.id, name: this.name });
          else this._raw(conn, { t: "hello", kind: "resume", deviceId: this.me.id, name: this.name, nonce: gs.nonce });
        }
      });
      conn.on("data", data => this._connData(conn, data));
      conn.on("close", () => this._connClosed(conn));
      conn.on("error", err => this._connClosed(conn, err));
    }

    _raw(conn, obj) { try { conn.dataChannel.send(JSON.stringify(obj)); } catch {} }
    _refuse(conn, reason) {
      this._raw(conn, { t: "refuse", reason });
      conn.gs.ended = true;
      setTimeout(() => { try { conn.close(); } catch {} }, 300);
    }

    _connClosed(conn, err) {
      const gs = conn.gs;
      if (!gs) return;
      clearTimeout(gs.timer);
      if (gs.trusted) {
        const s = gs.session;
        if (s && this.sessions.get(s.dev.id) === s) this._dropSession(s, "disconnected", false);
      } else if (gs.role === "dialer" && !gs.done && !gs.ended) {
        this._handshakeFail(conn, err && err.type ? err : { type: "peer-unavailable" });
      }
    }

    _handshakeFail(conn, err) {
      const gs = conn.gs;
      if (!gs || gs.done || gs.trusted) return;
      gs.done = true;
      clearTimeout(gs.timer);
      try { conn.close(); } catch {}
      if (gs.dev) { if (this.dialing.get(gs.dev.id) === conn) this.dialing.delete(gs.dev.id); this.failers.delete(DEVICE_PREFIX + gs.dev.id); }
      if (this.pairConn === conn) { this.pairConn = null; }
      if (gs.onFail) gs.onFail(err);
    }

    async _connData(conn, data) {
      const gs = conn.gs;
      if (gs.trusted) { if (gs.session && this.sessions.get(gs.session.dev.id) === gs.session) this._onData(gs.session, data); return; }
      if (typeof data !== "string") return;
      let m; try { m = JSON.parse(data); } catch { return; }
      if (gs.busy) return;                       // one handshake step at a time
      gs.busy = true;
      try { await this._handshake(conn, gs, m); } catch (e) { console.error(e); try { conn.close(); } catch {} } finally { gs.busy = false; }
    }

    async _handshake(conn, gs, m) {
      // ---------------- we are the listener ----------------
      if (gs.role === "listener") {
        if (m.t === "hello" && gs.mode === "pair" && m.kind === "pair") { this._onPairHello(conn, gs, m); return; }
        if (m.t === "hello" && gs.mode === "device" && m.kind === "resume") {
          if (gs.stage) return;
          clearTimeout(gs.timer);
          const dev = this.devices.get(m.deviceId);
          if (!dev || dev.stale || typeof m.nonce !== "string" || m.nonce.length < 16) { this._refuse(conn, "unknown"); return; }
          const racing = this.dialing.get(dev.id);
          if (racing) { if (dev.id < this.me.id) { racing.gs.done = true; this.dialing.delete(dev.id); try { racing.close(); } catch {} } else { this._refuse(conn, "busy"); return; } }
          gs.stage = "challenged"; gs.dev = dev; gs.nonceA = m.nonce; gs.nonceB = randomHex(16);
          gs.timer = setTimeout(() => { try { conn.close(); } catch {} }, HANDSHAKE_TIMEOUT_MS);
          const proof = await hmac(dev.secret, `L|${gs.nonceA}|${gs.nonceB}|${this.me.id}|${dev.id}`);
          this._raw(conn, { t: "challenge", nonce: gs.nonceB, proof, name: this.name });
          return;
        }
        if (m.t === "auth" && gs.stage === "challenged") {
          const dev = gs.dev;
          const expect = await hmac(dev.secret, `D|${gs.nonceB}|${gs.nonceA}|${dev.id}|${this.me.id}`);
          if (!sameText(expect, m.proof)) { this._refuse(conn, "unknown"); return; }
          this._raw(conn, { t: "welcome", kind: "resume", deviceId: this.me.id, name: this.name });
          this._become(conn, dev);
          return;
        }
        return;
      }

      // ---------------- we are the dialler ----------------
      if (m.t === "refuse") {
        gs.ended = true;
        const reason = m.reason;
        if (gs.kind === "pair") {
          this._handshakeFail(conn, { message: reason === "denied" ? "The other device did not allow the connection." : reason === "used" ? "That code was already used. Ask for a new one." : reason === "same" ? "That is this same browser profile. Use a different device or browser profile." : "The other device refused the connection." });
        } else if (reason === "unknown") {
          gs.dev.stale = true; this._saveDevices();
          this._event("refused", gs.dev, `${gs.dev.name} no longer recognises this device.`);
          this._handshakeFail(conn, { message: "unknown" }); this._emitDevices();
        } else { this._handshakeFail(conn, { message: "busy" }); }
        return;
      }
      if (gs.kind === "resume" && m.t === "challenge") {
        const dev = gs.dev;
        const expect = await hmac(dev.secret, `L|${gs.nonce}|${m.nonce}|${dev.id}|${this.me.id}`);
        if (!sameText(expect, m.proof)) { this._handshakeFail(conn, { message: "impostor" }); return; }   // whoever answered does not know the secret
        if (m.name) { const n = cleanLabel(m.name); if (n && n !== dev.name) { dev.name = n; this._saveDevices(); } }
        const proof = await hmac(dev.secret, `D|${m.nonce}|${gs.nonce}|${this.me.id}|${dev.id}`);
        this._raw(conn, { t: "auth", proof });
        return;
      }
      if (m.t === "welcome") {
        if (gs.kind === "pair") {
          if (!m.secret || !m.deviceId || m.deviceId === this.me.id) { this._handshakeFail(conn, { message: "The other device sent an invalid reply." }); return; }
          const old = this.devices.get(m.deviceId);
          const dev = { id: m.deviceId, name: cleanLabel(m.name) || "Other device", secret: m.secret, auto: old && old.auto !== undefined ? old.auto : null, source: "code" };
          this.devices.set(dev.id, dev); this._saveDevices();
          this.pairConn = null;
          this._become(conn, dev);
          this._setPair("idle", { paired: dev.name });
          this._event("paired", dev);
        } else {
          this._become(conn, gs.dev);
        }
      }
    }

    // We are the host and someone typed our code.
    _onPairHello(conn, gs, m) {
      clearTimeout(gs.timer);
      if (!m.deviceId || typeof m.deviceId !== "string") { this._refuse(conn, "wrong"); return; }
      if (m.deviceId === this.me.id) { this._refuse(conn, "same"); return; }
      if (this.pairState !== "waiting" || this.hostClaimed) { this._refuse(conn, "used"); return; }
      this.hostClaimed = true;
      const name = cleanLabel(m.name) || "Other device";
      this.waitingConfirm = conn;
      gs.pending = true;
      const finish = ok => {
        clearTimeout(this.confirmTimer);
        if (this.waitingConfirm !== conn) return;
        this.waitingConfirm = null;
        if (!ok) { this._refuse(conn, "denied"); this.cancelPairing(true); this._setPair("idle", {}); return; }
        const secret = randomHex(24);
        const old = this.devices.get(m.deviceId);
        const dev = { id: m.deviceId, name, secret, auto: old && old.auto !== undefined ? old.auto : null, source: "code" };
        this.devices.set(dev.id, dev); this._saveDevices();
        this._raw(conn, { t: "welcome", kind: "pair", deviceId: this.me.id, name: this.name, secret });
        this._become(conn, dev);
        // The code's peer carries this very connection, so it lives until the connection ends.
        const peer = this.hostPeer; this.hostPeer = null; this.hostCode = null; clearTimeout(this.hostTimer);
        if (peer && conn.gs.session) conn.gs.session.carrier = peer;
        this._setPair("idle", { paired: dev.name });
        this._event("paired", dev);
      };
      this.confirmTimer = setTimeout(() => finish(false), CONFIRM_TIMEOUT_MS);
      this._setPair("confirm", { name, allow: () => finish(true), deny: () => finish(false) });
    }

    _become(conn, dev) {
      const gs = conn.gs;
      gs.trusted = true;
      gs.done = true;
      clearTimeout(gs.timer);
      if (this.dialing.get(dev.id) === conn) this.dialing.delete(dev.id);
      this.failers.delete(DEVICE_PREFIX + dev.id);
      dev.stale = false;
      const old = this.sessions.get(dev.id);
      if (old && old.conn !== conn) this._dropSession(old, "replaced", true);
      const s = { conn, dev, outgoing: null, incoming: null, lastSeen: Date.now() };
      gs.session = s;
      s.pinger = setInterval(() => {
        if (!this._live(s)) { clearInterval(s.pinger); return; }
        if (Date.now() - s.lastSeen > DEAD_MS) { this._dropSession(s, "disconnected", true); return; }
        try { this._send(s, { t: "ping" }); } catch {}
      }, PING_MS);
      this.sessions.set(dev.id, s);
      const dc = conn.dataChannel;
      if (dc) { dc.binaryType = "arraybuffer"; dc.bufferedAmountLowThreshold = BUFFER_LOW; }
      this._saveDevices();
      this._emitDevices();
      this._event("connected", dev);
    }

    _dropSession(s, reason, closeConn) {
      if (this.sessions.get(s.dev.id) === s) this.sessions.delete(s.dev.id);
      clearInterval(s.pinger);
      this._stopTransfers(s, reason);
      if (closeConn) { s.conn.gs.ended = true; try { s.conn.close(); } catch {} }
      if (s.carrier) { const c = s.carrier; s.carrier = null; setTimeout(() => { try { c.destroy(); } catch {} }, 300); }
      this._emitDevices();
      if (reason !== "replaced") this._event("disconnected", s.dev);
    }

    _live(s) { return this.sessions.get(s.dev.id) === s; }
    _send(s, obj) { s.conn.dataChannel.send(JSON.stringify(obj)); }

    // ---- sending -----------------------------------------------------------------------------

    /** Offer a File to a device (default: the chosen one) and send it once they accept. */
    sendFile(file, toId) {
      const id = toId || this.target();
      const s = id && this.sessions.get(id);
      if (!s) throw new Error("No device connected.");
      if (s.outgoing) throw new Error("Another file is still being sent.");
      return this._sendFile(s, file);
    }

    async _sendFile(s, file) {
      const id = randomHex(4);
      const out = { id, file, ack: null, timer: null };
      s.outgoing = out;
      const state = (st, detail) => { try { this.cb.sendState(id, st, detail, { id: s.dev.id, name: s.dev.name }); } catch (e) { console.error(e); } };
      const alive = () => s.outgoing === out;

      try {
        const answer = new Promise((resolve, reject) => {
          out.resolveAnswer = resolve;
          out.rejectAnswer = reject;
          out.timer = setTimeout(() => reject(Object.assign(new Error("not caught in time"), { kind: "expired" })), OFFER_TIMEOUT_MS);
        });
        answer.catch(noop);
        this._send(s, { t: "offer", id, name: cleanName(file.name), size: file.size, mime: file.type || "" });
        state("waiting");
        await answer;
        clearTimeout(out.timer);

        const ack = new Promise((resolve, reject) => { out.ack = { resolve, reject }; });
        ack.catch(noop);
        state("sending");
        const dc = s.conn.dataChannel;
        const piece = Math.min(CHUNK, (s.conn.peerConnection && s.conn.peerConnection.sctp && s.conn.peerConnection.sctp.maxMessageSize) || CHUNK);
        let sent = 0;
        this.cb.progress("send", id, 0, file.size);
        for (let offset = 0; offset < file.size; offset += READ_BLOCK) {
          const block = await file.slice(offset, Math.min(offset + READ_BLOCK, file.size)).arrayBuffer();
          for (let i = 0; i < block.byteLength; i += piece) {
            if (!alive()) throw Object.assign(new Error("cancelled"), { kind: "cancelled" });
            if (dc.readyState !== "open") throw new Error("The other device disconnected.");
            if (dc.bufferedAmount > BUFFER_HIGH) await this._drain(dc);
            const part = block.slice(i, i + piece);
            dc.send(part);
            sent += part.byteLength;
            this.cb.progress("send", id, sent, file.size);
          }
        }
        if (!alive()) throw Object.assign(new Error("cancelled"), { kind: "cancelled" });
        this._send(s, { t: "done", id });

        await ack;
        this.cb.progress("send", id, file.size, file.size);
        state("delivered");
      } catch (error) {
        const kind = error.kind;
        if (out.ended === "disconnected") { state("failed", "the other device disconnected"); return; }
        if (this._live(s) && kind !== "declined" && kind !== "cancelled-by-peer") { try { this._send(s, { t: "cancel", id }); } catch {} }
        if (kind === "declined") state("declined", error.message);
        else if (kind === "expired") state("expired");
        else if (kind === "cancelled") state("failed", "cancelled");
        else if (kind === "cancelled-by-peer") state("failed", "the other device cancelled");
        else if (/readyState|not open|InvalidState/i.test(error.message)) state("failed", "the other device disconnected");
        else state("failed", error.message);
      } finally {
        clearTimeout(out.timer);
        if (s.outgoing === out) { s.outgoing = null; this._emitDevices(); }   // lets the page enable "Send now" again
      }
    }

    _drain(dc) {
      return new Promise(resolve => {
        const done = () => { dc.removeEventListener("bufferedamountlow", done); clearInterval(poll); resolve(); };
        dc.addEventListener("bufferedamountlow", done);
        const poll = setInterval(() => { if (dc.bufferedAmount <= BUFFER_LOW || dc.readyState !== "open") done(); }, 50);
      });
    }

    /** Stop the file being sent (to any device). */
    cancelSend() {
      for (const s of this.sessions.values()) {
        const out = s.outgoing;
        if (!out) continue;
        s.outgoing = null;
        try { this._send(s, { t: "cancel", id: out.id }); } catch {}
        clearTimeout(out.timer);
        const error = Object.assign(new Error("cancelled"), { kind: "cancelled" });
        if (out.rejectAnswer) out.rejectAnswer(error);
        if (out.ack) out.ack.reject(error);
      }
    }

    // ---- receiving ---------------------------------------------------------------------------

    _sessionOfOffer(id) {
      for (const s of this.sessions.values()) if (s.incoming && s.incoming.id === id) return s;
      return null;
    }

    /** Say yes to an offered file; it starts arriving straight away. Returns false if the offer is gone. */
    accept(id) {
      const s = this._sessionOfOffer(id);
      const inc = s && s.incoming;
      if (!inc || inc.accepted) return false;
      inc.accepted = true;
      try { this._send(s, { t: "accept", id }); } catch { return false; }
      this.cb.progress("receive", id, 0, inc.size);
      return true;
    }

    /** Say no (or stop receiving). */
    reject(id) {
      const s = this._sessionOfOffer(id);
      const inc = s && s.incoming;
      if (!inc) return;
      s.incoming = null;
      try { this._send(s, inc.accepted ? { t: "cancel", id } : { t: "decline", id, reason: "declined" }); } catch {}
    }

    _onData(s, data) {
      s.lastSeen = Date.now();
      if (typeof data === "string") {
        let msg; try { msg = JSON.parse(data); } catch { return; }
        this._onMessage(s, msg);
        return;
      }
      const inc = s.incoming;
      if (!inc || !inc.accepted) return;
      inc.chunks.push(data);
      inc.got += data.byteLength;
      this.cb.progress("receive", inc.id, inc.got, inc.size);
    }

    _anyIncoming() { for (const s of this.sessions.values()) if (s.incoming) return true; return false; }

    _onMessage(s, msg) {
      switch (msg.t) {
        case "name": {
          const n = cleanLabel(msg.name);
          if (n && n !== s.dev.name && s.dev.source !== "account") { s.dev.name = n; this._saveDevices(); this._emitDevices(); }
          break;
        }
        case "offer": {
          if (s.incoming || s.outgoing || this._anyIncoming()) {
            try { this._send(s, { t: "decline", id: msg.id, reason: "busy" }); } catch {}
            return;
          }
          s.incoming = { id: msg.id, name: cleanName(msg.name), size: Number(msg.size) || 0, mime: msg.mime || "", chunks: [], got: 0, accepted: false };
          const auto = s.dev.auto === true;
          this.cb.offer({ id: msg.id, from: { id: s.dev.id, name: s.dev.name }, name: s.incoming.name, size: s.incoming.size, mime: s.incoming.mime, auto });
          if (auto) this.accept(msg.id);
          break;
        }
        case "accept":
          if (s.outgoing && s.outgoing.id === msg.id && s.outgoing.resolveAnswer) s.outgoing.resolveAnswer();
          break;
        case "decline":
          if (s.outgoing && s.outgoing.id === msg.id && s.outgoing.rejectAnswer) {
            s.outgoing.rejectAnswer(Object.assign(new Error(msg.reason === "busy" ? "the other device is busy with another file" : "declined"), { kind: "declined" }));
          }
          break;
        case "done": {
          const inc = s.incoming;
          if (!inc || inc.id !== msg.id) return;
          const ok = inc.got === inc.size;
          try { this._send(s, { t: "ack", id: inc.id, ok, bytes: inc.got }); } catch {}
          s.incoming = null;
          if (ok) {
            this.cb.progress("receive", inc.id, inc.size, inc.size);
            this.cb.received({ id: inc.id, name: inc.name, size: inc.size, from: { id: s.dev.id, name: s.dev.name } }, new Blob(inc.chunks, { type: inc.mime }));
          } else {
            this.cb.offerGone(inc.id, "the file arrived incomplete");
          }
          break;
        }
        case "ack":
          if (s.outgoing && s.outgoing.id === msg.id && s.outgoing.ack) {
            if (msg.ok) s.outgoing.ack.resolve(msg);
            else s.outgoing.ack.reject(new Error("The other device did not get the whole file."));
          }
          break;
        case "cancel": {
          if (s.incoming && s.incoming.id === msg.id) {
            const inc = s.incoming; s.incoming = null;
            this.cb.offerGone(inc.id, "cancelled");
          }
          if (s.outgoing && s.outgoing.id === msg.id) {
            const out = s.outgoing;
            const error = Object.assign(new Error("cancelled"), { kind: "cancelled-by-peer" });
            clearTimeout(out.timer);
            if (out.rejectAnswer) out.rejectAnswer(error);
            if (out.ack) out.ack.reject(error);
          }
          break;
        }
      }
    }

    _stopTransfers(s, reason) {
      const out = s.outgoing;
      if (out) {
        s.outgoing = null;
        out.ended = "disconnected";
        clearTimeout(out.timer);
        const error = Object.assign(new Error("the other device disconnected"), { kind: "cancelled-by-peer" });
        if (out.rejectAnswer) out.rejectAnswer(error);
        if (out.ack) out.ack.reject(error);
      }
      const inc = s.incoming;
      if (inc) {
        s.incoming = null;
        try { this.cb.offerGone(inc.id, reason); } catch {}
      }
    }
  }

  root.GestureLink = GestureLink;
})(typeof window !== "undefined" ? window : globalThis);
