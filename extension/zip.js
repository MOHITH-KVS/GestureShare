// Packs a folder into one .zip file in the browser (no compression: fast, and photos/videos are
// already compressed). Used when a whole folder is chosen or dropped.
(function (root) {
  "use strict";
  const TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; TABLE[n] = c >>> 0; }

  async function crcOf(file, onBytes) {
    let c = 0xFFFFFFFF;
    const reader = file.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let i = 0; i < value.length; i++) c = TABLE[(c ^ value[i]) & 255] ^ (c >>> 8);
      if (onBytes) onBytes(value.length);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosTime(ms) {
    const d = new Date(ms || Date.now());
    const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  /** entries: [{path: "folder/sub/a.txt", file: File}] -> Promise<File> (a .zip) */
  async function build(entries, zipName, onProgress) {
    const enc = new TextEncoder();
    const total = entries.reduce((n, e) => n + e.file.size, 0);
    if (entries.length > 65535 || total >= 0xFFFFFFFF) throw new Error("This folder is too big to pack (over 4 GB). Send it in smaller parts.");
    let done = 0;
    const parts = [], central = [];
    let offset = 0;
    for (const { path, file } of entries) {
      const name = enc.encode(String(path).replace(/\\/g, "/").replace(/^\/+/, ""));
      const crc = await crcOf(file, n => { done += n; if (onProgress) onProgress(done, total); });
      const { time, date } = dosTime(file.lastModified);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
      local.setUint16(10, time, true); local.setUint16(12, date, true); local.setUint32(14, crc, true);
      local.setUint32(18, file.size, true); local.setUint32(22, file.size, true); local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
      parts.push(local.buffer, name, file);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true);
      c.setUint32(20, file.size, true); c.setUint32(24, file.size, true); c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(c.buffer, name);
      offset += 30 + name.length + file.size;
    }
    const centralSize = central.reduce((n, p) => n + (p.byteLength !== undefined ? p.byteLength : p.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
    return new File([...parts, ...central, end.buffer], zipName, { type: "application/zip" });
  }

  root.GSZip = { build };
})(typeof window !== "undefined" ? window : globalThis);
