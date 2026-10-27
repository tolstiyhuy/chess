/* Сигнализация и передача ходов через публичный MQTT-брокер по WebSocket.
   Не требует WebRTC и работающего сервера: оба игрока подключаются к брокеру
   и обмениваются сообщениями в общем топике комнаты. */
(function (global) {
  'use strict';

  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const PREFIX = 'chesstime/v3/';
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://mqtt.eclipseprojects.io:443/mqtt',
    'wss://test.mosquitto.org:8081/mqtt',
  ];
  const JOIN_EVERY = 1500;
  const BEAT_EVERY = 2000;
  const GONE_AFTER = 20000;
  const JOIN_TIMEOUT = 18000;

  function rand(n) {
    let s = '';
    for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return s;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  class NetRelay {
    constructor() {
      this.handlers = {};
      this.id = 'p' + rand(10);
      this.role = null;
      this.code = null;
      this.topic = null;
      this.client = null;
      this.connected = false;
      this.partnerId = null;
      this.lastSeen = 0;
      this._closed = false;
      this._reconnecting = false;
      this._timers = {};
      this._resolveJoin = null;
      this._rejectJoin = null;
      this._url = null;
      this._switchTried = false;
      this.log = [];
      if (typeof window !== 'undefined') window.__relay = this;
    }

    _log(line) {
      this.log.push(Math.round(performance.now()) + ' ' + line);
      if (this.log.length > 300) this.log.shift();
    }

    on(evt, fn) {
      (this.handlers[evt] = this.handlers[evt] || []).push(fn);
      return this;
    }

    _emit(evt, arg) {
      (this.handlers[evt] || []).slice().forEach((fn) => {
        try { fn(arg); } catch (e) { console.error(e); }
      });
    }

    /* ----------------------------- подключение ----------------------------- */

    async _open(topic, urls) {
      this.topic = topic;
      let lastErr = null;
      const list = urls && urls.length ? urls : BROKERS;
      for (const url of list) {
        if (this._closed) throw new Error('Соединение закрыто');
        try {
          const client = new window.MiniMqtt.Client({
            url,
            clientId: 'ct' + rand(10),
            onMessage: (t, text) => this._onPayload(text),
            onClose: () => this._onSocketClose(),
          });
          await client.connect();
          await client.subscribe(topic);
          this.client = client;
          this._url = url;
          this._log('open ' + url);
          this._startWatchdog();
          return;
        } catch (e) {
          lastErr = e;
          if (this.client) {
            try { this.client.end(); } catch (err) { /* ignore */ }
            this.client = null;
          }
        }
      }
      console.warn('[relay] нет связи с брокерами', lastErr);
      throw new Error('Не удалось связаться с сервером. Проверьте интернет и попробуйте ещё раз.');
    }

    async host() {
      this.role = 'host';
      const code = rand(7);
      this.code = code;
      this._log('host ' + code);
      await this._open(PREFIX + code);
      if (this._closed) throw new Error('Соединение закрыто');
      this._startBeat();
      this._emit('ready');
      return code;
    }

    join(code) {
      this.role = 'guest';
      this.code = code;
      this._log('join ' + code);
      return this._open(PREFIX + code).then(() => new Promise((resolve, reject) => {
        if (this._closed) { reject(new Error('Соединение закрыто')); return; }
        this._resolveJoin = resolve;
        this._rejectJoin = reject;
        this._sendJoin();
        this._timers.join = setInterval(() => this._sendJoin(), JOIN_EVERY);
        this._timers.joinTimeout = setTimeout(() => {
          if (this.connected) return;
          this._failJoin('timeout');
          this.close();
        }, JOIN_TIMEOUT);
      }));
    }

    /* -------------------------------- обмен --------------------------------- */

    send(type, payload) {
      if (!this.connected) return;
      const text = JSON.stringify({ k: 'm', id: this.id, d: Object.assign({ t: type }, payload || {}) });
      this._publish(text);
      // Ходы и позиции дублируем: приёмная сторона спокойно отбрасывает повторы.
      if (type === 'move' || type === 'state') {
        setTimeout(() => { if (this.connected) this._publish(text); }, 70);
      }
    }

    close() {
      if (this._closed) return;
      this._closed = true;
      this._publish(JSON.stringify({ k: 'b', id: this.id }));
      this._clearTimers();
      this.connected = false;
      const client = this.client;
      this.client = null;
      setTimeout(() => {
        if (client) {
          try { client.end(); } catch (e) { /* ignore */ }
        }
      }, 80);
    }

    _publish(text) {
      if (this.client) this.client.publish(this.topic, text);
    }

    _sendJoin() {
      this._log('send j');
      this._publish(JSON.stringify({ k: 'j', id: this.id }));
    }

    _onPayload(text) {
      let msg;
      try { msg = JSON.parse(text); } catch (e) { return; }
      if (!msg || !msg.k || msg.id === this.id) return;
      if (msg.k !== 'm' && msg.k !== 'p') this._log('recv ' + msg.k + ' from ' + msg.id);

      if (msg.k === 'm') {
        if (msg.id !== this.partnerId) return;
        this.lastSeen = Date.now();
        if (msg.d && msg.d.t) this._emit('data', msg.d);
        return;
      }
      if (msg.k === 'p') {
        if (msg.id === this.partnerId) this.lastSeen = Date.now();
        return;
      }
      if (msg.k === 'b') {
        if (msg.id === this.partnerId) {
          this.partnerId = null;
          if (this.connected) {
            this.connected = false;
            this._emit('close');
          }
        }
        return;
      }
      if (msg.k === 'j') {
        if (this.role === 'host') this._onJoin(msg.id);
        return;
      }
      if (msg.k === 'a') {
        if (this.role !== 'guest' || msg.to !== this.id) return;
        if (msg.br && this._url && msg.br !== this._url && !this._switchTried) {
          this._switchBroker(msg.br);
          return;
        }
        this._accept(msg.id);
        return;
      }
      if (msg.k === 'f') {
        if (this.role === 'guest' && msg.to === this.id) {
          this._failJoin('full');
          this.close();
        }
      }
    }

    /* ------------------------------- хозяин --------------------------------- */

    _onJoin(guestId) {
      this._log('j from ' + guestId + ' conn=' + this.connected);
      if (this.connected && this.partnerId === guestId) {
        this._publish(JSON.stringify({ k: 'a', id: this.id, br: this._url, to: guestId }));
        this.lastSeen = Date.now();
        return;
      }
      if (this.connected && Date.now() - this.lastSeen < 6000) {
        this._publish(JSON.stringify({ k: 'f', id: this.id, to: guestId }));
        return;
      }
      const was = this.connected;
      this.partnerId = guestId;
      this.connected = true;
      this.lastSeen = Date.now();
      this._publish(JSON.stringify({ k: 'a', id: this.id, br: this._url, to: guestId }));
      this._startWatchdog();
      if (!was) this._emit('open');
    }

    /* -------------------------------- гость --------------------------------- */

    _accept(hostId) {
      if (this.connected) return;
      this._log('accepted by ' + hostId);
      this.connected = true;
      this.partnerId = hostId;
      this.lastSeen = Date.now();
      this._clearJoinTimers();
      this._startBeat();
      this._startWatchdog();
      this._emit('open');
      const resolve = this._resolveJoin;
      this._resolveJoin = null;
      this._rejectJoin = null;
      if (resolve) resolve();
    }

    _failJoin(reason) {
      this._clearJoinTimers();
      const reject = this._rejectJoin;
      this._resolveJoin = null;
      this._rejectJoin = null;
      if (reason === 'full') {
        this._emit('joinfail', { reason: 'full' });
        if (reject) reject(new Error('В комнате уже двое. Попросите создать новую комнату.'));
      } else {
        this._emit('joinfail', { reason: 'timeout' });
        if (reject) reject(new Error('Комната не найдена. Проверьте код — или выберите способ связи «Локальная сеть».'));
      }
    }

    /* -------------------------------- таймеры -------------------------------- */

    _startBeat() {
      if (this._timers.beat) return;
      this._timers.beat = setInterval(() => {
        if (this.connected) this._publish(JSON.stringify({ k: 'p', id: this.id }));
      }, BEAT_EVERY);
    }

    _startWatchdog() {
      if (this._timers.watch) return;
      this._timers.watch = setInterval(() => {
        if (!this.connected) return;
        if (Date.now() - this.lastSeen > GONE_AFTER) {
          this.connected = false;
          this.partnerId = null;
          this._emit('close');
        }
      }, 1000);
    }

    _clearJoinTimers() {
      if (this._timers.join) clearInterval(this._timers.join);
      if (this._timers.joinTimeout) clearTimeout(this._timers.joinTimeout);
      this._timers.join = null;
      this._timers.joinTimeout = null;
    }

    _clearTimers() {
      this._clearJoinTimers();
      Object.keys(this._timers).forEach((k) => {
        if (this._timers[k]) clearInterval(this._timers[k]);
        this._timers[k] = null;
      });
    }

    /* --------------------------- переподключение ----------------------------- */

    _switchBroker(url) {
      this._switchTried = true;
      this._log('switch broker -> ' + url);
      const client = this.client;
      this.client = null;
      if (client) {
        try { client.end(); } catch (e) { /* ignore */ }
      }
      const topic = this.topic;
      this._open(topic, [url])
        .then(() => {
          if (this.role === 'guest' && !this.connected) this._sendJoin();
        })
        .catch(() => {
          this._switchTried = false;
          this._open(topic).catch(() => { /* игнорируем */ });
        });
    }

    _onSocketClose() {
      if (this._closed || this._reconnecting) return;
      this._reconnecting = true;
      this._log('socket closed, reconnecting');
      const topic = this.topic;
      (async () => {
        const deadline = Date.now() + 15000;
        while (!this._closed && Date.now() < deadline) {
          try {
            await this._open(topic, this._url ? [this._url].concat(BROKERS.filter((u) => u !== this._url)) : null);
            this._reconnecting = false;
            if (this.role === 'guest' && !this.connected) this._sendJoin();
            return;
          } catch (e) {
            await sleep(1000);
          }
        }
        this._reconnecting = false;
        if (this.connected) {
          this.connected = false;
          this._emit('close');
        }
      })();
    }
  }

  global.ChessNetRelay = NetRelay;
  if (typeof window !== 'undefined') window.ChessNetRelay = NetRelay;
})(typeof window !== 'undefined' ? window : globalThis);
