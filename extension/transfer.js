// ---------------------------------------------------------------------------------------------
// GestureShare: device-to-device connection and file transfer
//
// How it works (no file ever touches a server):
//   FIRST TIME   One device calls host() and shows a 6-digit code; the other calls join(code).
//                Both devices then remember each other (a long secret is exchanged on the way).
//   AFTER THAT   Every GestureShare page stays "findable" under the device's own private id.
//                start() / reconnect() connect to the remembered device with no code at all, and
//                the remembered secret proves it really is the same device.
//   TRANSFER     A tiny matchmaker server (PeerJS) only introduces the two browsers. After that
//                they talk directly (WebRTC): the file travels straight from one device to the
//                other in big pieces, with back-pressure so a slow receiver is never flooded.
//                The receiver must accept (the open-palm "catch") before any bytes are sent.
//
// Messages on the channel (text = JSON control message, binary = a piece of the file):
//   {t:"hello", kind:"pair"|"resume", deviceId, name, secret?}   joiner -> listener, first message
//   {t:"welcome", kind, deviceId, name, secret?} | {t:"refuse", reason}                 the answer
//   {t:"offer", id, name, size, mime}   sender  -> receiver   "I want to send you this"
//   {t:"accept", id} | {t:"decline", id, reason}               receiver's answer
//   <binary pieces...>
//   {t:"done", id}                      sender  -> receiver   "that was the last piece"
//   {t:"ack", id, ok, bytes}            receiver -> sender    "got it" (checks the byte count)
//   {t:"cancel", id}                    either side, stops the transfer
//
// Usage (callbacks are all optional):
//   const link = new GestureLink({
//     signal,                                   // {host, port, path, secure}; default: public PeerJS
//     onStatus(state, info),                    // "idle" | "waiting" {code} | "connecting" | "connected" | "error" {message}
//                                               // info.paired = {name} when a device is remembered; info.offline = true
//                                               // when it could not be found (not an error, it just is not open)
//     onOffer({id, name, size}),                // the other device wants to send you a file
//     onOfferGone(id, reason),                  // ...and then cancelled / the connection dropped
//     onProgress(direction, id, bytes, total),  // direction: "send" | "receive"
//     onReceived(offer, blob),                  // a whole file arrived and its size checks out
//     onSendState(id, state, detail)            // "waiting" | "sending" | "delivered" | "declined" | "expired" | "failed"
//   });
//   link.start()                                // call once when the page opens: stay findable + reconnect
//   link.host() / link.join("123456")           // first-time pairing
//   link.reconnect() / link.forget()            // remembered device
//   link.sendFile(file) / link.accept(id) / link.reject(id) / link.disconnect()
//
// Loads PeerJS from vendor/peerjs.min.js (a classic script, so window.Peer exists).
// ---------------------------------------------------------------------------------------------
(function (root) {
  "use strict";

  // The matchmaker. The free public PeerJS server is fine for trying things out; before launch,
  // run your own and put its address here (or pass `signal` to the constructor).
  const SIGNALING = { host: "0.peerjs.com", port: 443, path: "/", secure: true };

  const CODE_PREFIX = "gestureshare-";           // temporary ids used while a code is shown
  const DEVICE_PREFIX = "gestureshare-d-";       // a device's permanent private id
  const CHUNK = 256 * 1024;            // size of one piece on the wire (lowered if the other side only allows less)
  const READ_BLOCK = 1024 * 1024;      // how much of the file we read from disk at once
  const BUFFER_HIGH = 4 * 1024 * 1024; // pause sending when this much is waiting to go out
  const BUFFER_LOW = 1024 * 1024;      // ...and resume below this
  const OFFER_TIMEOUT_MS = 60000;      // how long the sender waits for the other device to accept
  const CONNECT_TIMEOUT_MS = 15000;
  const HANDSHAKE_TIMEOUT_MS = 10000;
  const KEY_ME = "gestureshare.me";
  const KEY_PAIR = "gestureshare.pair";

  const noop = () => {};
  const randomHex = bytes => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, "0")).join("");
  const randomId = () => randomHex(4);
  const randomCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
  const cleanName = name => String(name || "file").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 200) || "file";

  // Small storage helper: localStorage when it works, memory when it does not.
  const memory = {};
  const store = {
    get(key) { try { const v = root.localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return memory[key] || null; } },
    set(key, value) { try { root.localStorage.setItem(key, JSON.stringify(value)); } catch { memory[key] = value; } },
    remove(key) { try { root.localStorage.removeItem(key); } catch { delete memory[key]; } }
  };

  function deviceName() {
    const platform = (root.navigator && ((root.navigator.userAgentData && root.navigator.userAgentData.platform) || root.navigator.platform)) || "";
    if (/win/i.test(platform)) return "Windows computer";
    if (/mac/i.test(platform)) return "Mac";
    if (/cros|chrome os/i.test(platform)) return "Chromebook";
    if (/android/i.test(platform)) return "Android phone";
    if (/iphone|ipad|ios/i.test(platform)) return "iPhone";
    if (/linux/i.test(platform)) return "Linux computer";
    return "other device";
  }

  class GestureLink {
    constructor(options = {}) {
      const test = root.GESTURE_LINK_CONFIG || {};          // only used by automated tests
      this.signal = options.signal || test.signaling || SIGNALING;
      this.iceServers = options.iceServers || test.iceServers;
      this.cb = {
        status: options.onStatus || noop,
        offer: options.onOffer || noop,
        offerGone: options.onOfferGone || noop,
        progress: options.onProgress || noop,
        received: options.onReceived || noop,
        sendState: options.onSendState || noop
      };

      this.me = store.get(KEY_ME);
      if (!this.me || !this.me.id) { this.me = { id: randomHex(16) }; store.set(KEY_ME, this.me); }
      this.name = deviceName();
      this.paired = store.get(KEY_PAIR);                    // {id, name, secret} or null

      this.presence = null;       // stays open while the page is open, so the paired device can find us
      this.peer = null;           // temporary peer: shows a code (host) or dials out (join / reconnect)
      this.conn = null;           // the trusted connection to the other device
      this.pending = null;        // a connection that is still doing the hello/welcome check
      this.outKind = null;        // "pair" | "resume" while we are dialling out
      this.code = null;
      this.state = "idle";
      this.outgoing = null;       // {id, file, resolveAnswer, rejectAnswer, ack, timer}   (while sending)
      this.incoming = null;       // {id, name, size, mime, chunks, got, accepted}          (while receiving)
    }

    get connected() { return this.state === "connected"; }

    _set(state, info = {}) {
      this.state = state;
      const extra = { paired: this.paired ? { name: this.paired.name } : null };
      try { this.cb.status(state, Object.assign(extra, info)); } catch (e) { console.error(e); }
    }

    _newPeer(id) {
      if (typeof root.Peer !== "function") throw new Error("A file is missing: put peerjs.min.js inside the vendor folder, then reload the extension on chrome://extensions.");
      const s = this.signal;
      const options = { host: s.host, port: s.port, path: s.path || "/", secure: !!s.secure, debug: 0 };
      if (this.iceServers) options.config = { iceServers: this.iceServers };
      return id ? new root.Peer(id, options) : new root.Peer(options);
    }

    // ---- staying findable + remembered device -------------------------------------------------

    /** Call once when the page opens. Stays findable, and reconnects to the remembered device. */
    async start() {
      await this._startPresence();
      if (this.paired && this.state === "idle") this.reconnect(true).catch(noop);
      else if (this.state === "idle") this._set("idle", {});
    }

    _startPresence() {
      if (this.presence) return Promise.resolve(true);
      return new Promise(resolve => {
        let peer;
        try { peer = this._newPeer(DEVICE_PREFIX + this.me.id); } catch { resolve(false); return; }
        this.presence = peer;
        const timer = setTimeout(() => resolve(false), 8000);
        peer.on("open", () => { clearTimeout(timer); resolve(true); });
        peer.on("connection", conn => { conn.gsMode = "resume"; this._wire(conn); });
        peer.on("error", err => {
          clearTimeout(timer);
          // Another page of this same extension (same browser profile) already owns this device id.
          // That page does the listening; this one can still pair with a code.
          if (err.type === "unavailable-id") { try { peer.destroy(); } catch {} if (this.presence === peer) this.presence = null; }
          resolve(false);
        });
        peer.on("disconnected", () => { try { peer.reconnect(); } catch {} });
      });
    }

    /** Forget the remembered device (it will need a code again). */
    forget() {
      this.paired = null;
      store.remove(KEY_PAIR);
      this._set(this.state, {});
    }

    /** Connect to the remembered device, no code needed. `auto` = quiet: not finding it is not an error. */
    reconnect(auto = false) {
      if (!this.paired) return Promise.reject(new Error("No device is remembered yet."));
      this._closeEverything();
      return new Promise((resolve, reject) => {
        this.outKind = "resume";
        this._set("connecting", { reconnect: true });
        let peer;
        try { peer = this._newPeer(); } catch (error) { this._fail(error, reject); return; }
        this.peer = peer;
        const timer = setTimeout(() => finish({ type: "timeout" }), CONNECT_TIMEOUT_MS);
        const finish = err => {
          clearTimeout(timer);
          if (this.peer !== peer) return;                      // we were replaced (the other device dialled us first)
          const name = this.paired ? this.paired.name : "other device";
          if (auto) {
            this._closeEverything();
            this._set("idle", { offline: true });
            resolve(false);
          } else {
            this._fail(err.type === "peer-unavailable" || err.type === "timeout"
              ? { message: `Your ${name} is not open right now. Open GestureShare on it, then try again.` } : err, reject);
          }
        };
        peer.on("open", () => {
          if (this.peer !== peer) return;
          const conn = peer.connect(DEVICE_PREFIX + this.paired.id, { serialization: "raw", reliable: true });
          conn.gsMode = "out-resume";
          conn.gsDone = ok => { clearTimeout(timer); resolve(ok); };
          conn.gsFail = finish;
          this._wire(conn);
        });
        peer.on("error", finish);
      });
    }

    // ---- first-time pairing with a code -----------------------------------------------------

    /** Show a code on this device and wait for the other one to enter it. Resolves with the code. */
    host() {
      this._closeEverything();
      return new Promise((resolve, reject) => {
        const attempt = tries => {
          const code = randomCode();
          let peer;
          try { peer = this._newPeer(CODE_PREFIX + code); } catch (error) { this._fail(error, reject); return; }
          this.peer = peer;
          peer.on("open", () => {
            this.code = code;
            this._set("waiting", { code });
            resolve(code);
          });
          peer.on("connection", conn => { conn.gsMode = "pair"; this._wire(conn); });
          peer.on("error", err => {
            if (err.type === "unavailable-id" && tries < 5) { peer.destroy(); attempt(tries + 1); return; }
            this._fail(err, reject);
          });
          peer.on("disconnected", () => { if (this.state === "waiting") this._fail({ type: "network" }); });
        };
        attempt(0);
      });
    }

    /** Enter the code shown on the other device. Resolves when connected. */
    join(code) {
      this._closeEverything();
      code = String(code || "").replace(/\D/g, "");
      return new Promise((resolve, reject) => {
        if (code.length !== 6) { this._fail({ message: "The code has 6 digits." }, reject); return; }
        this.outKind = "pair";
        this._set("connecting");
        let peer;
        try { peer = this._newPeer(); } catch (error) { this._fail(error, reject); return; }
        this.peer = peer;
        const timer = setTimeout(() => this._fail({ type: "timeout" }, reject), CONNECT_TIMEOUT_MS);
        peer.on("open", () => {
          const conn = peer.connect(CODE_PREFIX + code, { serialization: "raw", reliable: true });
          conn.gsMode = "out-pair";
          conn.gsDone = ok => { clearTimeout(timer); resolve(ok); };
          conn.gsFail = err => { clearTimeout(timer); this._fail(err, reject); };
          this._wire(conn);
        });
        peer.on("error", err => { clearTimeout(timer); this._fail(err, reject); });
      });
    }

    _fail(err, reject) {
      const type = err && err.type;
      const message =
        type === "peer-unavailable" ? "No device has that code. Check the code and try again."
        : type === "timeout" ? "Could not reach the other device. Check that both are online."
        : type === "network" || type === "server-error" || type === "socket-error" || type === "socket-closed"
          ? "Could not reach the connection server. Check your internet connection."
        : (err && err.message) || "Could not connect.";
      this._closeEverything();
      this._set("error", { message });
      if (reject) reject(new Error(message));
    }

    // ---- one connection: hello / welcome check, then it becomes THE connection ----------------

    _wire(conn) {
      conn.on("open", () => {
        if (conn.gsMode === "out-pair") this._rawSend(conn, { t: "hello", kind: "pair", deviceId: this.me.id, name: this.name });
        else if (conn.gsMode === "out-resume") this._rawSend(conn, { t: "hello", kind: "resume", deviceId: this.me.id, secret: this.paired && this.paired.secret, name: this.name });
        else {
          // we are the listener: the other side must say hello soon
          conn.gsTimer = setTimeout(() => { try { conn.close(); } catch {} }, HANDSHAKE_TIMEOUT_MS);
        }
        if (conn.gsMode && conn.gsMode.startsWith("out-")) {
          conn.gsTimer = setTimeout(() => { if (!conn.gsTrusted && conn.gsFail) conn.gsFail({ type: "timeout" }); }, HANDSHAKE_TIMEOUT_MS);
        }
      });
      conn.on("data", data => this._connData(conn, data));
      conn.on("close", () => { clearTimeout(conn.gsTimer); if (conn === this.conn) this._onClosed(); else if (!conn.gsTrusted && conn.gsFail && !conn.gsEnded) conn.gsFail({ type: "peer-unavailable" }); });
      conn.on("error", err => { clearTimeout(conn.gsTimer); if (conn === this.conn) this._onClosed(); else if (!conn.gsTrusted && conn.gsFail && !conn.gsEnded) conn.gsFail(err); });
    }

    _rawSend(conn, obj) { try { conn.dataChannel.send(JSON.stringify(obj)); } catch {} }

    _connData(conn, data) {
      if (conn.gsTrusted) { if (conn === this.conn) this._onData(data); return; }
      if (typeof data !== "string") return;
      let m; try { m = JSON.parse(data); } catch { return; }

      // ---- we are the listener -------------------------------------------------------------
      if (m.t === "hello" && (conn.gsMode === "pair" || conn.gsMode === "resume")) {
        clearTimeout(conn.gsTimer);
        const refuse = reason => { this._rawSend(conn, { t: "refuse", reason }); conn.gsEnded = true; setTimeout(() => { try { conn.close(); } catch {} }, 300); };
        if (m.kind !== conn.gsMode) { refuse("wrong"); return; }

        if (m.kind === "resume") {
          if (!this.paired || m.deviceId !== this.paired.id || !m.secret || m.secret !== this.paired.secret) { refuse("unknown"); return; }
          const racing = this.state === "connecting" && this.outKind === "resume";
          if (this.state === "connected" || (this.state !== "idle" && this.state !== "error" && !racing)) { refuse("busy"); return; }
          // Both devices dialled each other at the same moment: the smaller id wins.
          if (racing) { if (m.deviceId < this.me.id) this._closeOutgoing(); else { refuse("busy"); return; } }
          this._rawSend(conn, { t: "welcome", kind: "resume", deviceId: this.me.id, name: this.name });
          this.paired.name = m.name || this.paired.name; store.set(KEY_PAIR, this.paired);
          this._become(conn);
          return;
        }

        // first-time pairing through the code
        if (this.state !== "waiting") { refuse("busy"); return; }
        if (m.deviceId === this.me.id) {
          // The same browser profile on both sides (e.g. two tabs of one computer): fine for a
          // test, but there is nothing to remember.
          this._rawSend(conn, { t: "welcome", kind: "pair", deviceId: this.me.id, name: this.name, secret: "" });
        } else {
          const secret = randomHex(24);
          this._rawSend(conn, { t: "welcome", kind: "pair", deviceId: this.me.id, name: this.name, secret });
          this.paired = { id: m.deviceId, name: m.name || "other device", secret };
          store.set(KEY_PAIR, this.paired);
        }
        this._become(conn);
        return;
      }

      // ---- we are the one who dialled ------------------------------------------------------
      if (m.t === "welcome" && conn.gsMode && conn.gsMode.startsWith("out-")) {
        clearTimeout(conn.gsTimer);
        if (m.kind === "pair" && m.secret && m.deviceId !== this.me.id) {
          this.paired = { id: m.deviceId, name: m.name || "other device", secret: m.secret };
          store.set(KEY_PAIR, this.paired);
        } else if (m.kind === "resume" && this.paired) {
          this.paired.name = m.name || this.paired.name; store.set(KEY_PAIR, this.paired);
        }
        this._become(conn);
        if (conn.gsDone) conn.gsDone(true);
        return;
      }
      if (m.t === "refuse" && conn.gsMode && conn.gsMode.startsWith("out-")) {
        clearTimeout(conn.gsTimer);
        conn.gsEnded = true;
        if (m.reason === "busy" && conn.gsMode === "out-resume") {
          // The other device is dialling us at the same time (or already connected to someone):
          // stay quiet and wait for its connection to arrive.
          if (conn.gsDone) conn.gsDone(false);
          this._closeOutgoing();
          if (this.state === "connecting") this._set("idle", { offline: false });
        } else if (m.reason === "unknown" && conn.gsMode === "out-resume") {
          const name = this.paired ? this.paired.name : "other device";
          this.forget();
          if (conn.gsFail) conn.gsFail({ message: `Your ${name} no longer remembers this device. Pair them again with a code.` });
        } else if (conn.gsFail) conn.gsFail({ message: "The other device refused the connection." });
      }
    }

    _become(conn) {
      conn.gsTrusted = true;
      clearTimeout(conn.gsTimer);
      this.conn = conn;
      this.outKind = null;
      const dc = conn.dataChannel;
      if (dc) { dc.binaryType = "arraybuffer"; dc.bufferedAmountLowThreshold = BUFFER_LOW; }
      this._set("connected");
    }

    _onClosed() {
      if (this.state === "idle" || this.state === "error") return;
      const hadTransfer = !!(this.outgoing || this.incoming);
      this._stopTransfers("disconnected");
      this.conn = null;
      if (this.peer) { try { this.peer.destroy(); } catch {} this.peer = null; }
      this.code = null;
      this._set("idle", { message: hadTransfer ? "The other device disconnected during the transfer." : "The other device disconnected." });
    }

    _closeOutgoing() {
      if (this.peer) { try { this.peer.destroy(); } catch {} this.peer = null; }
      this.outKind = null;
    }

    // Stop whatever connection or attempt exists, without telling the page.
    _closeEverything() {
      this._stopTransfers("disconnected");
      if (this.conn) { const c = this.conn; this.conn = null; c.gsEnded = true; try { c.close(); } catch {} }
      this._closeOutgoing();
      this.code = null;
      this.state = "idle";
    }

    /** Close the connection. `silent` = do not tell the page. The remembered device stays remembered. */
    disconnect(silent = false) {
      const was = this.state;
      this._closeEverything();
      if (!silent && was !== "idle") this._set("idle", {});
    }

    // ---- sending -----------------------------------------------------------------------------

    _send(obj) { this.conn.dataChannel.send(JSON.stringify(obj)); }

    /**
     * Offer a File to the other device and, once they catch it, send it. Progress and the result
     * are reported through onSendState / onProgress; this never throws after it has started.
     */
    sendFile(file) {
      // Problems we can see right now are thrown straight away (the page catches them).
      if (!this.connected) throw new Error("No device connected.");
      if (this.outgoing) throw new Error("Another file is still being sent.");
      return this._sendFile(file);
    }

    async _sendFile(file) {
      const id = randomId();
      const out = { id, file, ack: null, timer: null };
      this.outgoing = out;
      const state = (s, detail) => { try { this.cb.sendState(id, s, detail); } catch (e) { console.error(e); } };
      const alive = () => this.outgoing === out;

      try {
        // 1) ask, and wait for the other device to catch it
        const answer = new Promise((resolve, reject) => {
          out.resolveAnswer = resolve;
          out.rejectAnswer = reject;
          out.timer = setTimeout(() => reject(Object.assign(new Error("not caught in time"), { kind: "expired" })), OFFER_TIMEOUT_MS);
        });
        answer.catch(noop);
        this._send({ t: "offer", id, name: cleanName(file.name), size: file.size, mime: file.type || "" });
        state("waiting");
        await answer;
        clearTimeout(out.timer);

        // 2) send the pieces
        const ack = new Promise((resolve, reject) => { out.ack = { resolve, reject }; });
        ack.catch(noop);
        state("sending");
        const dc = this.conn.dataChannel;
        const piece = Math.min(CHUNK, (this.conn.peerConnection && this.conn.peerConnection.sctp && this.conn.peerConnection.sctp.maxMessageSize) || CHUNK);
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
        this._send({ t: "done", id });

        // 3) wait for "got it"
        await ack;
        this.cb.progress("send", id, file.size, file.size);
        state("delivered");
      } catch (error) {
        const kind = error.kind;
        if (out.ended === "disconnected") {
          state("failed", "the other device disconnected");
          return;
        }
        if (this.connected && kind !== "declined" && kind !== "cancelled-by-peer") { try { this._send({ t: "cancel", id }); } catch {} }
        if (kind === "declined") state("declined", error.message);
        else if (kind === "expired") state("expired");
        else if (kind === "cancelled") state("failed", "cancelled");
        else if (kind === "cancelled-by-peer") state("failed", "the other device cancelled");
        else if (/readyState|not open|InvalidState/i.test(error.message)) state("failed", "the other device disconnected");
        else state("failed", error.message);
      } finally {
        clearTimeout(out.timer);
        if (this.outgoing === out) this.outgoing = null;
      }
    }

    _drain(dc) {
      return new Promise(resolve => {
        const done = () => { dc.removeEventListener("bufferedamountlow", done); clearInterval(poll); resolve(); };
        dc.addEventListener("bufferedamountlow", done);
        const poll = setInterval(() => { if (dc.bufferedAmount <= BUFFER_LOW || dc.readyState !== "open") done(); }, 50);
      });
    }

    /** Stop the file that is being sent (a no-op if nothing is). */
    cancelSend() {
      const out = this.outgoing;
      if (!out) return;
      this.outgoing = null;
      if (this.connected) { try { this._send({ t: "cancel", id: out.id }); } catch {} }
      clearTimeout(out.timer);
      if (out.rejectAnswer) out.rejectAnswer(Object.assign(new Error("cancelled"), { kind: "cancelled" }));
      if (out.ack) out.ack.reject(Object.assign(new Error("cancelled"), { kind: "cancelled" }));
    }

    // ---- receiving ---------------------------------------------------------------------------

    /** Say yes to the offered file; it starts arriving straight away. Returns false if the offer is gone. */
    accept(id) {
      const inc = this.incoming;
      if (!inc || inc.id !== id || inc.accepted || !this.connected) return false;
      inc.accepted = true;
      try { this._send({ t: "accept", id }); } catch { return false; }
      this.cb.progress("receive", id, 0, inc.size);
      return true;
    }

    /** Say no (or stop receiving). */
    reject(id) {
      const inc = this.incoming;
      if (!inc || inc.id !== id) return;
      this.incoming = null;
      if (this.connected) { try { this._send(inc.accepted ? { t: "cancel", id } : { t: "decline", id, reason: "declined" }); } catch {} }
    }

    _onData(data) {
      if (typeof data === "string") {
        let msg; try { msg = JSON.parse(data); } catch { return; }
        this._onMessage(msg);
        return;
      }
      const inc = this.incoming;                      // a piece of the file
      if (!inc || !inc.accepted) return;
      inc.chunks.push(data);
      inc.got += data.byteLength;
      this.cb.progress("receive", inc.id, inc.got, inc.size);
    }

    _onMessage(msg) {
      switch (msg.t) {
        case "offer": {
          if (this.incoming || this.outgoing) {
            try { this._send({ t: "decline", id: msg.id, reason: "busy" }); } catch {}
            return;
          }
          this.incoming = { id: msg.id, name: cleanName(msg.name), size: Number(msg.size) || 0, mime: msg.mime || "",
                            chunks: [], got: 0, accepted: false };
          this.cb.offer({ id: msg.id, name: this.incoming.name, size: this.incoming.size, mime: this.incoming.mime });
          break;
        }
        case "accept":
          if (this.outgoing && this.outgoing.id === msg.id && this.outgoing.resolveAnswer) this.outgoing.resolveAnswer();
          break;
        case "decline":
          if (this.outgoing && this.outgoing.id === msg.id && this.outgoing.rejectAnswer) {
            this.outgoing.rejectAnswer(Object.assign(
              new Error(msg.reason === "busy" ? "the other device is busy with another file" : "declined"), { kind: "declined" }));
          }
          break;
        case "done": {
          const inc = this.incoming;
          if (!inc || inc.id !== msg.id) return;
          const ok = inc.got === inc.size;
          try { this._send({ t: "ack", id: inc.id, ok, bytes: inc.got }); } catch {}
          this.incoming = null;
          if (ok) {
            this.cb.progress("receive", inc.id, inc.size, inc.size);
            this.cb.received({ id: inc.id, name: inc.name, size: inc.size }, new Blob(inc.chunks, { type: inc.mime }));
          } else {
            this.cb.offerGone(inc.id, "the file arrived incomplete");
          }
          break;
        }
        case "ack":
          if (this.outgoing && this.outgoing.id === msg.id && this.outgoing.ack) {
            if (msg.ok) this.outgoing.ack.resolve(msg);
            else this.outgoing.ack.reject(new Error("The other device did not get the whole file."));
          }
          break;
        case "cancel": {
          if (this.incoming && this.incoming.id === msg.id) {
            const inc = this.incoming; this.incoming = null;
            this.cb.offerGone(inc.id, "cancelled");
          }
          if (this.outgoing && this.outgoing.id === msg.id) {
            const out = this.outgoing;
            const error = Object.assign(new Error("cancelled"), { kind: "cancelled-by-peer" });
            clearTimeout(out.timer);
            if (out.rejectAnswer) out.rejectAnswer(error);
            if (out.ack) out.ack.reject(error);
          }
          break;
        }
      }
    }

    // The connection is gone (or being closed): end whatever was in progress.
    _stopTransfers(reason) {
      const out = this.outgoing;
      if (out) {
        this.outgoing = null;
        out.ended = "disconnected";                // sendFile() reports this as "failed" by itself
        clearTimeout(out.timer);
        const error = Object.assign(new Error("the other device disconnected"), { kind: "cancelled-by-peer" });
        if (out.rejectAnswer) out.rejectAnswer(error);
        if (out.ack) out.ack.reject(error);
      }
      const inc = this.incoming;
      if (inc) {
        this.incoming = null;
        try { this.cb.offerGone(inc.id, reason); } catch {}
      }
    }
  }

  root.GestureLink = GestureLink;
})(typeof window !== "undefined" ? window : globalThis);
