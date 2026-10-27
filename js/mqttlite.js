/* Минимальный MQTT 3.1.1 клиент поверх WebSocket.
   Нужен только для сигнализации и передачи ходов через публичный брокер:
   CONNECT, SUBSCRIBE (QoS 0), PUBLISH (QoS 0), PINGREQ. Без внешних зависимостей. */
(function (global) {
  'use strict';

  function varint(n) {
    const out = [];
    do {
      let b = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) b |= 0x80;
      out.push(b);
    } while (n > 0);
    return out;
  }

  function utf8(s) {
    const bytes = new TextEncoder().encode(s);
    const out = new Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i];
    return out;
  }

  function field(s) {
    const b = utf8(s);
    return [(b.length >> 8) & 255, b.length & 255].concat(b);
  }

  function packet(first, body) {
    return new Uint8Array([first].concat(varint(body.length), body));
  }

  class MqttClient {
    constructor(opts) {
      opts = opts || {};
      this.url = opts.url;
      this.clientId = opts.clientId || 'ct' + Math.random().toString(36).slice(2, 12);
      this.keepalive = opts.keepalive || 45;
      this.onMessage = opts.onMessage || null;
      this.onClose = opts.onClose || null;

      this.ws = null;
      this.buf = new Uint8Array(0);
      this.pid = 0;
      this.connected = false;
      this.closedByUs = false;
      this._pingTimer = null;
      this._connack = null;
      this._subWait = null;
    }

    connect() {
      return new Promise((resolve, reject) => {
        let ws;
        try {
          ws = new WebSocket(this.url, ['mqtt']);
        } catch (e) {
          reject(new Error('websocket: ' + (e && e.message)));
          return;
        }
        ws.binaryType = 'arraybuffer';
        this.ws = ws;

        let settled = false;
        const timer = setTimeout(() => fail('таймаут подключения'), 9000);

        const cleanup = () => {
          clearTimeout(timer);
          ws.onopen = null;
          ws.onerror = null;
        };
        const fail = (reason) => {
          if (settled) return;
          settled = true;
          cleanup();
          try { ws.close(); } catch (e) { /* ignore */ }
          this.connected = false;
          reject(new Error(reason));
        };
        const ok = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };

        this._connack = { ok: ok, fail: fail };

        ws.onopen = () => {
          const body = [0x00, 0x04].concat(utf8('MQTT'), [0x04, 0x02, 0x00, this.keepalive]).concat(field(this.clientId));
          try { ws.send(packet(0x10, body)); } catch (e) { fail('не удалось отправить CONNECT'); }
        };
        ws.onmessage = (ev) => {
          const data = ev.data;
          if (data instanceof ArrayBuffer) this._data(data);
          else if (data && data.buffer) this._data(data.buffer);
        };
        ws.onerror = () => {
          if (!settled) fail('ошибка сети');
        };
        ws.onclose = () => {
          this.connected = false;
          this._stopPing();
          if (!settled) { fail('соединение закрыто'); return; }
          if (!this.closedByUs && this.onClose) this.onClose();
        };
      });
    }

    subscribe(topic) {
      return new Promise((resolve, reject) => {
        if (!this.connected) { reject(new Error('нет соединения')); return; }
        const id = ++this.pid;
        const timer = setTimeout(() => {
          this._subWait = null;
          reject(new Error('нет ответа на подписку'));
        }, 9000);
        this._subWait = {
          id,
          resolve: () => { clearTimeout(timer); this._subWait = null; resolve(); },
        };
        const body = [(id >> 8) & 255, id & 255].concat(field(topic), [0x00]);
        this._send(packet(0x82, body));
      });
    }

    publish(topic, text) {
      if (!this.connected || !this.ws || this.ws.readyState !== 1) return false;
      this._send(packet(0x30, field(topic).concat(utf8(text))));
      return true;
    }

    end() {
      this.closedByUs = true;
      this._stopPing();
      try {
        if (this.ws && this.ws.readyState === 1) this.ws.send(new Uint8Array([0xe0, 0x00]));
      } catch (e) { /* ignore */ }
      try { if (this.ws) this.ws.close(); } catch (e) { /* ignore */ }
    }

    _send(bytes) {
      try {
        if (this.ws && this.ws.readyState === 1) this.ws.send(bytes);
      } catch (e) {
        if (this.onClose) this.onClose();
      }
    }

    _startPing() {
      this._stopPing();
      this._pingTimer = setInterval(() => {
        if (!this.ws || this.ws.readyState !== 1) return;
        this._send(new Uint8Array([0xc0, 0x00]));
      }, Math.max(10000, this.keepalive * 600));
    }

    _stopPing() {
      if (this._pingTimer) clearInterval(this._pingTimer);
      this._pingTimer = null;
    }

    _data(arrayBuffer) {
      const chunk = new Uint8Array(arrayBuffer);
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf, 0);
      merged.set(chunk, this.buf.length);
      this.buf = merged;

      let off = 0;
      while (this.buf.length - off >= 2) {
        const first = this.buf[off];
        let len = 0;
        let mult = 1;
        let i = off + 1;
        let b = 0;
        let complete = false;
        for (let guard = 0; guard < 4; guard++) {
          if (i >= this.buf.length) { complete = false; break; }
          b = this.buf[i++];
          len += (b & 0x7f) * mult;
          mult *= 128;
          if ((b & 0x80) === 0) { complete = true; break; }
        }
        if (!complete) break;
        if (this.buf.length - i < len) break;
        const body = this.buf.subarray(i, i + len);
        this._handle(first >> 4, first & 0x0f, body);
        off = i + len;
      }
      this.buf = this.buf.slice(off);
    }

    _handle(type, flags, body) {
      if (type === 2) {
        // CONNACK
        const rc = body.length > 1 ? body[1] : 1;
        const w = this._connack;
        this._connack = null;
        if (rc === 0) {
          this.connected = true;
          this._startPing();
          if (w) w.ok();
        } else if (w) {
          w.fail('брокер отклонил подключение (' + rc + ')');
        }
        return;
      }
      if (type === 9) {
        // SUBACK
        if (this._subWait && body.length >= 2) {
          const id = (body[0] << 8) | body[1];
          if (id === this._subWait.id) this._subWait.resolve();
        }
        return;
      }
      if (type === 3) {
        // PUBLISH
        if (body.length < 2) return;
        const tl = (body[0] << 8) | body[1];
        if (body.length < 2 + tl) return;
        const topic = new TextDecoder().decode(body.subarray(2, 2 + tl));
        let start = 2 + tl;
        const qos = (flags & 0x06) >> 1;
        if (qos > 0) start += 2;
        const text = new TextDecoder().decode(body.subarray(start));
        if (this.onMessage) this.onMessage(topic, text);
        return;
      }
      // PINGRESP (13), UNSUBACK и прочее — игнорируем
    }
  }

  global.MiniMqtt = { Client: MqttClient };
  if (typeof window !== 'undefined') window.MiniMqtt = global.MiniMqtt;
})(typeof window !== 'undefined' ? window : globalThis);
