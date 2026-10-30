// ---------------------------------------------------------------------------------------------
// GestureShare: device-to-device link and file transfer.
//
// Two devices pair with a 6-digit code. After that the files go DIRECTLY between the two browsers
// (WebRTC data channel): nothing is uploaded to a server. A small public "matchmaker" server
// (PeerJS cloud) is only used for the first few seconds, to introduce the two devices.
//
//   const link = new GestureLink({ onStatus, onOffer, ... });
//   const code = await link.host();      // device A: shows the code
//   link.join("482913");                 // device B: types the code
//   link.sendFile(file);                 // either device, once connected
//
// How one file moves:
//   sender   --offer {name,size}-->      receiver  (shows "incoming", waits for the catch gesture)
//   sender   <--accept--                 receiver  (the catch)
//   sender   --64 KB chunks...-->        receiver  (fast: the channel is kept full, never overflowed)
//   sender   --end-->                    receiver  (checks every byte arrived, then saves the file)
//   sender   <--done--                   receiver  ("Delivered")
// ---------------------------------------------------------------------------------------------
(function (root) {
  "use strict";

  const CHUNK = 64 * 1024;             // bytes per message
  const HIGH_WATER = 8 * 1024 * 1024;  // pause sending when this much is queued in the channel
  const LOW_WATER = 2 * 1024 * 1024;   // ...and continue when it drains to this
  const OFFER_TIMEOUT_MS = 60000;      // the other device has this long to catch the file
  const JOIN_TIMEOUT_MS = 15000;
  const ID_PREFIX = "gestureshare-";

  const randomCode = () => String(Math.floor(Math.random() * 900000) + 100000);   // 100000..999999
  const makeId = () => Math.random().toString(36).slice(2, 10);

  class GestureLink {
    /**
     * options.signal: undefined for the free PeerJS cloud, or {host, port, secure, path} for your own server.
     * Callbacks (all optional):
     *   onStatus(state, info)      state: "idle" | "waiting" | "connecting" | "connected" | "error"
     *                              info: {code} when waiting, {message} on error
     *   onOffer(offer)             the other device wants to send you a file {id,name,size}
     *   onOfferGone(id, reason)    the offer was withdrawn
     *   onProgress(direction, id, bytes, total)   direction "send" | "receive"
     *   onReceived(offer, blob)    a whole file arrived and was checked
     *   onSendState(id, state, detail)  "waiting" | "sending" | "delivered" | "declined" | "expired" | "failed"
     */
    constructor(options = {}) {
      this.o = options;
      this.peer = null;
      this.conn = null;
      this.state = "idle";
      this.code = null;
      this.outgoing = null;     // {id, file, ...}
      this.incoming = null;     // {id, name, size, chunks, got, accepted}
      this._offerTimer = null;
    }

    // ---- connection ------------------------------------------------------------------------
    _status(state, info = {}) {
      this.state = state;
      if (this.o.onStatus) this.o.onStatus(state, info);
    }

    _peerOptions() {
      return this.o.signal ? { ...this.o.signal, debug: 0 } : { debug: 0 };
    }

    /** Device A: get a code and wait for the other device. Resolves with the code. */
    host() {
      this.disconnect(true);
      return new Promise((resolve, reject) => {
        const tryOnce = attempt => {
          const code = randomCode();
          const peer = new root.Peer(ID_PREFIX + code, this._peerOptions());
          this.peer = peer;
          peer.on("open", () => {
            this.code = code;
            this._status("waiting", { code });
            resolve(code);
          });
          peer.on("connection", conn => {
            if (this.conn && this.conn.open) { conn.close(); return; }       // one device at a time
            this._attach(conn);
          });
          peer.on("error", err => {
            if (err.type === "unavailable-id" && attempt < 5) { peer.destroy(); tryOnce(attempt + 1); return; }
            this._status("error", { message: this._explain(err) });
            reject(err);
          });
          peer.on("disconnected", () => { try { peer.reconnect(); } catch { /* peer already gone */ } });
        };
        tryOnce(0);
      });
    }

    /** Device B: connect with the code shown on device A. */
    join(rawCode) {
      const code = String(rawCode).replace(/\D/g, "");
      this.disconnect(true);
      this._status("connecting", {});
      return new Promise((resolve, reject) => {
        const peer = new root.Peer(this._peerOptions());
        this.peer = peer;
        const fail = message => {
          clearTimeout(timer);
          this._status("error", { message });
          reject(new Error(message));
        };
        const timer = setTimeout(() => fail("Couldn't find that code. Check it and try again."), JOIN_TIMEOUT_MS);
        peer.on("open", () => {
          const conn = peer.connect(ID_PREFIX + code, { serialization: "raw", reliable: true });
          conn.on("open", () => { clearTimeout(timer); this._attach(conn); resolve(); });
          conn.on("error", err => fail(this._explain(err)));
        });
        peer.on("error", err => fail(this._explain(err)));
      });
    }

    _explain(err) {
      switch (err && err.type) {
        case "peer-unavailable": return "Couldn't find that code. Check it and try again.";
        case "network": case "server-error": case "socket-error": case "socket-closed":
          return "Couldn't reach the pairing server. Check your internet connection.";
        default: return (err && err.message) || "Connection failed.";
      }
    }

    _attach(conn) {
      this.conn = conn;
      conn.on("data", data => this._onData(data));
      conn.on("close", () => this._lost("The other device disconnected."));
      conn.on("error", () => this._lost("The connection was interrupted."));
      if (conn.open) this._status("connected", {});
      else conn.on("open", () => this._status("connected", {}));
      if (conn.open) return;
    }

    _lost(message) {
      if (this.state === "idle") return;
      this._failTransfers("failed", message);
      this.conn = null;
      if (this.peer) { try { this.peer.destroy(); } catch { /* ignore */ } this.peer = null; }
      this._status("idle", { message });
    }

    disconnect(silent = false) {
      this._failTransfers("failed", "Disconnected.");
      if (this.conn) { try { this.conn.close(); } catch { /* ignore */ } this.conn = null; }
      if (this.peer) { try { this.peer.destroy(); } catch { /* ignore */ } this.peer = null; }
      this.code = null;
      if (!silent && this.state !== "idle") this._status("idle", {});
      else this.state = "idle";
    }

    get connected() { return this.state === "connected" && !!this.conn && this.conn.open; }

    // ---- sending ---------------------------------------------------------------------------
    _json(msg) { this.conn.send(JSON.stringify(msg)); }

    /** Offer a file. It is only sent once the other device accepts (catches) it. */
    sendFile(file) {
      if (!this.connected) throw new Error("Not connected");
      if (this.outgoing) throw new Error("Another file is still being sent");
      const id = makeId();
      this.outgoing = { id, file, cancelled: false };
      this._json({ t: "offer", id, name: file.name, size: file.size, type: file.type || "" });
      this._sendState(id, "waiting");
      this._offerTimer = setTimeout(() => {
        if (this.outgoing && this.outgoing.id === id && !this.outgoing.started) {
          this._json({ t: "cancel", id });
          this.outgoing = null;
          this._sendState(id, "expired");
        }
      }, OFFER_TIMEOUT_MS);
      return id;
    }

    _sendState(id, state, detail) { if (this.o.onSendState) this.o.onSendState(id, state, detail); }

    async _stream(out) {
      out.started = true;
      this._sendState(out.id, "sending");
      const dc = this.conn.dataChannel;
      dc.bufferedAmountLowThreshold = LOW_WATER;
      const file = out.file;
      try {
        for (let offset = 0; offset < file.size; offset += CHUNK) {
          if (out.cancelled || !this.connected) throw new Error("cancelled");
          const buffer = await file.slice(offset, offset + CHUNK).arrayBuffer();
          if (dc.bufferedAmount > HIGH_WATER) {
            await new Promise(resolve => {
              const done = () => { dc.removeEventListener("bufferedamountlow", done); resolve(); };
              dc.addEventListener("bufferedamountlow", done);
            });
          }
          this.conn.send(buffer);
          if (this.o.onProgress) this.o.onProgress("send", out.id, Math.min(offset + CHUNK, file.size), file.size);
        }
        this._json({ t: "end", id: out.id });
      } catch (error) {
        if (this.outgoing === out) {
          this.outgoing = null;
          this._sendState(out.id, "failed", error.message);
        }
      }
    }

    // ---- receiving -------------------------------------------------------------------------
    /** The catch: start receiving the offered file. */
    accept(id) {
      const inc = this.incoming;
      if (!this.connected || !inc || inc.id !== id || inc.accepted) return false;
      inc.accepted = true;
      this._json({ t: "accept", id });
      return true;
    }

    /** Say no to the offered file. */
    reject(id) {
      const inc = this.incoming;
      if (!inc || inc.id !== id) return;
      this.incoming = null;
      if (this.connected) this._json({ t: "reject", id });
    }

    _onData(data) {
      if (typeof data === "string") { this._onMessage(JSON.parse(data)); return; }
      const inc = this.incoming;                                   // a chunk of file data
      if (!inc || !inc.accepted) return;
      inc.chunks.push(data);
      inc.got += data.byteLength;
      if (this.o.onProgress) this.o.onProgress("receive", inc.id, inc.got, inc.size);
    }

    _onMessage(m) {
      switch (m.t) {
        case "offer":
          if (this.incoming && this.incoming.accepted) { this._json({ t: "reject", id: m.id }); return; }   // busy
          this.incoming = { id: m.id, name: m.name, size: m.size, type: m.type, chunks: [], got: 0, accepted: false };
          if (this.o.onOffer) this.o.onOffer({ id: m.id, name: m.name, size: m.size, type: m.type });
          break;
        case "cancel":                                              // sender gave up
          if (this.incoming && this.incoming.id === m.id) {
            this.incoming = null;
            if (this.o.onOfferGone) this.o.onOfferGone(m.id, "cancelled");
          }
          break;
        case "accept":
          if (this.outgoing && this.outgoing.id === m.id && !this.outgoing.started) {
            clearTimeout(this._offerTimer);
            this._stream(this.outgoing);
          }
          break;
        case "reject":
          if (this.outgoing && this.outgoing.id === m.id) {
            clearTimeout(this._offerTimer);
            this.outgoing = null;
            this._sendState(m.id, "declined");
          }
          break;
        case "end": {
          const inc = this.incoming;
          if (!inc || inc.id !== m.id) return;
          this.incoming = null;
          if (inc.got !== inc.size) {                                // every byte must be there
            this._json({ t: "failed", id: inc.id });
            if (this.o.onOfferGone) this.o.onOfferGone(inc.id, "incomplete");
            return;
          }
          const blob = new Blob(inc.chunks, { type: inc.type || "application/octet-stream" });
          this._json({ t: "done", id: inc.id });
          if (this.o.onReceived) this.o.onReceived({ id: inc.id, name: inc.name, size: inc.size }, blob);
          break;
        }
        case "done":
          if (this.outgoing && this.outgoing.id === m.id) {
            const id = this.outgoing.id;
            this.outgoing = null;
            this._sendState(id, "delivered");
          }
          break;
        case "failed":
          if (this.outgoing && this.outgoing.id === m.id) {
            const id = this.outgoing.id;
            this.outgoing = null;
            this._sendState(id, "failed", "The other device did not get the whole file.");
          }
          break;
      }
    }

    _failTransfers(state, detail) {
      clearTimeout(this._offerTimer);
      if (this.outgoing) { const id = this.outgoing.id; this.outgoing.cancelled = true; this.outgoing = null; this._sendState(id, state, detail); }
      if (this.incoming) { const id = this.incoming.id; this.incoming = null; if (this.o.onOfferGone) this.o.onOfferGone(id, "disconnected"); }
    }
  }

  root.GestureLink = GestureLink;
  if (typeof module !== "undefined" && module.exports) module.exports = { GestureLink };
})(typeof window !== "undefined" ? window : globalThis);
