/* =========================================================================
   ChessNet — онлайн-соединение через WebRTC.
   Сигнализация — публичные WebTorrent-трекеры (библиотека Trystero),
   поэтому не нужен собственный сервер. Комната = код из 5 символов.
   ========================================================================= */
const ChessNet = (function () {
  'use strict';

  const APP_ID = 'chesstime-online-v1';
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const RELAYS = [
    'wss://open.ftorrent.com',
    'wss://tracker.webtorrent.dev',
    'wss://tracker.openwebtorrent.com',
  ];

  function makeCode() {
    let s = '';
    for (let i = 0; i < 5; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return s;
  }

  class Net {
    constructor() {
      this.room = null;
      this.action = null;
      this.role = null;
      this.code = null;
      this.handlers = new Map();
      this.destroyed = false;
      this.connected = false;
      this.peers = new Set();
      this.timeout = null;
    }

    on(evt, fn) {
      if (!this.handlers.has(evt)) this.handlers.set(evt, []);
      this.handlers.get(evt).push(fn);
      return this;
    }

    _emit(evt, data) {
      const list = this.handlers.get(evt) || [];
      for (const fn of list) {
        try { fn(data); } catch (e) { console.error(e); }
      }
    }

    _connect(roomId) {
      const T = window.TrysteroTorrent;
      if (!T) throw new Error('Модуль онлайн-игры не загружен');

      const room = T.joinRoom(
        { appId: APP_ID, relayConfig: { urls: RELAYS, redundancy: 2 } },
        roomId,
        {
          onJoinError: () => {
            if (!this.connected && !this.destroyed) {
              this._emit('error', new Error('Сигнальный сервер недоступен'));
            }
          },
        }
      );
      this.room = room;

      const action = room.makeAction('msg');
      this.action = action;
      action.onMessage = (data) => {
        if (!data || typeof data !== 'object' || !data.t) return;
        this._emit('data', data);
      };

      room.onPeerJoin = (peerId) => {
        if (this.destroyed) return;
        this.peers.add(peerId);
        if (this.timeout) {
          clearTimeout(this.timeout);
          this.timeout = null;
        }
        if (!this.connected) {
          this.connected = true;
          this._emit('open', { role: this.role, code: this.code, peerId });
        }
      };

      room.onPeerLeave = (peerId) => {
        this.peers.delete(peerId);
        if (!this.peers.size && this.connected) {
          this.connected = false;
          this._emit('close', {});
        }
      };
    }

    host() {
      return new Promise((resolve, reject) => {
        const code = makeCode();
        this.role = 'host';
        this.code = code;
        try {
          this._connect(code);
        } catch (e) {
          reject(e);
          return;
        }
        this._emit('ready', { code });
        resolve(code);
      });
    }

    join(code) {
      code = String(code || '').trim().toUpperCase();
      return new Promise((resolve, reject) => {
        this.role = 'guest';
        this.code = code;

        let done = false;
        const fail = (err) => {
          if (done) return;
          done = true;
          if (this.timeout) clearTimeout(this.timeout);
          try { this.close(); } catch (e) { /* noop */ }
          reject(err || new Error('Не удалось подключиться'));
        };

        try {
          this._connect(code);
        } catch (e) {
          fail(e);
          return;
        }

        this.on('open', () => {
          if (done) return;
          done = true;
          if (this.timeout) clearTimeout(this.timeout);
          resolve(true);
        });
        // ошибка отдельного трекера не фатальна: ждём остальные и таймаут
        this.on('error', (e) => console.warn('[online]', e && e.message));
        this.on('close', () => fail(new Error('Соединение прервано')));

        if (this.connected) {
          done = true;
          resolve(true);
          return;
        }

        this.timeout = setTimeout(() => {
          fail(
            new Error(
              'Не удалось подключиться. Проверьте код комнаты. Если не помогает — выберите способ связи «Локальная сеть».'
            )
          );
        }, 18000);
      });
    }

    send(type, payload) {
      if (!this.connected || !this.action) return false;
      try {
        const msg = Object.assign({ t: type }, payload || {});
        const p = this.action.send(msg);
        if (p && typeof p.catch === 'function') p.catch(() => {});
        return true;
      } catch (e) {
        return false;
      }
    }

    close() {
      this.destroyed = true;
      this.connected = false;
      if (this.timeout) {
        clearTimeout(this.timeout);
        this.timeout = null;
      }
      if (this.action) this.action.onMessage = null;
      this.action = null;

      const room = this.room;
      this.room = null;
      if (room) {
        // небольшая задержка, чтобы последнее сообщение ('bye') успело уйти
        setTimeout(() => {
          try {
            const p = room.leave();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } catch (e) { /* noop */ }
        }, 80);
      }

      this.peers.clear();
      this.role = null;
      this.code = null;
    }
  }

  return Net;
})();

if (typeof window !== 'undefined') window.ChessNet = ChessNet;
