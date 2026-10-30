// ---------------------------------------------------------------------------------------------
// GestureShare: device-to-device connection and file transfer
//
// How it works (no file ever touches a server):
//   1. One device calls host(): it gets a 6-digit code and waits.
//   2. The other device calls join(code). A tiny "matchmaker" server (PeerJS) only introduces the
//      two browsers to each other.
//   3. They then talk directly (WebRTC data channel). The file travels straight from one device
//      to the other, in big pieces, with back-pressure so a slow receiver is never flooded.
//   4. The receiver must accept (the open-palm "catch") before any bytes are sent.
//
// Messages on the channel (text = JSON control message, binary = a piece of the file):
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
//     onOffer({id, name, size}),                // the other device wants to send you a file
//     onOfferGone(id, reason),                  // ...and then cancelled / the connection dropped
//     onProgress(direction, id, bytes, total),  // direction: "send" | "receive"
//     onReceived(offer, blob),                  // a whole file arrived and its size checks out
//     onSendState(id, state, detail)            // "waiting" | "sending" | "delivered" | "declined" | "expired" | "failed"
//   });
//   link.host() / link.join("123456") / link.sendFile(file) / link.accept(id) / link.reject(id) / link.disconnect()
//
// Loads PeerJS from vendor/peerjs.min.js (a classic script, so window.Peer exists).
// ---------------------------------------------------------------------------------------------
(function (root) {
  "use strict";

  // The matchmaker. The free public PeerJS server is fine for trying things out; before launch,
  // run your own and put its address here (or pass `signal` to the constructor).
  const SIGNALING = { host: "0.peerjs.com", port: 443, path: "/", secure: true };

  const ID_PREFIX = "gestureshare-";
  const CHUNK = 256 * 1024;            // size of one piece on the wire (lowered if the other side only allows less)
  const READ_BLOCK = 1024 * 1024;      // how much of the file we read from disk at once
  const BUFFER_HIGH = 4 * 1024 * 1024; // pause sending when this much is waiting to go out
  const BUFFER_LOW = 1024 * 1024;      // ...and resume below this
  const OFFER_TIMEOUT_MS = 60000;      // how long the sender waits for the other device to accept
  const CONNECT_TIMEOUT_MS = 20000;

  const randomId = () => Math.random().toString(36).slice(2, 10);
  const randomCode = () => String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
  const cleanName = name => String(name || "file").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 200) || "file";
  const noop = () => {};

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
      this.peer = null;
      this.conn = null;
      this.code = null;
      this.state = "idle";
      this.outgoing = null;       // {id, file, resolveAnswer, rejectAnswer, ack, timer}   (while sending)
      this.incoming = null;       // {id, name, size, mime, chunks, got, accepted}          (while receiving)
    }

    get connected() { return this.state === "connected"; }

    _set(state, info = {}) {
      this.state = state;
      try { this.cb.status(state, info); } catch (e) { console.error(e); }
    }

    _newPeer(id) {
      if (typeof root.Peer !== "function") throw new Error("PeerJS did not load (vendor/peerjs.min.js).");
      const s = this.signal;
      const options = { host: s.host, port: s.port, path: s.path || "/", secure: !!s.secure, debug: 0 };
      if (this.iceServers) options.config = { iceServers: this.iceServers };
      return id ? new root.Peer(id, options) : new root.Peer(options);
    }

    // ---- connecting --------------------------------------------------------------------------

    /** Show a code on this device and wait for the other one to enter it. Resolves with the code. */
    host() {
      this.disconnect(true);
      return new Promise((resolve, reject) => {
        const attempt = tries => {
          const code = randomCode();
          let peer;
          try { peer = this._newPeer(ID_PREFIX + code); } catch (error) { this._fail(error, reject); return; }
          this.peer = peer;
          peer.on("open", () => {
            this.code = code;
            this._set("waiting", { code });
            resolve(code);
          });
          peer.on("connection", conn => {
            if (this.conn) { conn.close(); return; }                 // one device at a time
            this.conn = conn;
            conn.on("open", () => this._attach(conn));
          });
          peer.on("error", err => {
            if (err.type === "unavailable-id" && tries < 5) { peer.destroy(); attempt(tries + 1); return; }
            this._fail(err, reject);
          });
          peer.on("disconnected", () => {
            if (this.state === "waiting") this._fail({ type: "network" });
          });
        };
        attempt(0);
      });
    }

    /** Enter the code shown on the other device. Resolves when connected. */
    join(code) {
      this.disconnect(true);
      code = String(code || "").replace(/\D/g, "");
      return new Promise((resolve, reject) => {
        if (code.length !== 6) { this._fail({ message: "The code has 6 digits." }, reject); return; }
        this._set("connecting");
        let peer;
        try { peer = this._newPeer(); } catch (error) { this._fail(error, reject); return; }
        this.peer = peer;
        const timer = setTimeout(() => this._fail({ type: "timeout" }, reject), CONNECT_TIMEOUT_MS);
        peer.on("open", () => {
          const conn = peer.connect(ID_PREFIX + code, { serialization: "raw", reliable: true });
          conn.on("open", () => { clearTimeout(timer); this.code = code; this._attach(conn); resolve(); });
          conn.on("error", err => { clearTimeout(timer); this._fail(err, reject); });
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
      this.disconnect(true);
      this._set("error", { message });
      if (reject) reject(new Error(message));
    }

    _attach(conn) {
      this.conn = conn;
      conn.on("data", data => this._onData(data));
      conn.on("close", () => this._onClosed());
      conn.on("error", () => this._onClosed());
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

    /** Close everything. `silent` = do not tell the page (used when starting a new connection). */
    disconnect(silent = false) {
      const was = this.state;
      this._stopTransfers("disconnected");
      if (this.conn) { try { this.conn.close(); } catch {} this.conn = null; }
      if (this.peer) { try { this.peer.destroy(); } catch {} this.peer = null; }
      this.code = null;
      this.state = "idle";
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
