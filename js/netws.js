/* =========================================================================
   ChessNetWs — онлайн-игра через свой сервер (server.js, WebSocket /ws).
   Подходит для игры в локальной сети: друг открывает страницу по адресу
   компьютера, где запущен start.bat (например, http://192.168.1.5:8000).
   Интерфейс такой же, как у ChessNet (trystero), — app.js их не различает.
   ========================================================================= */
const ChessNetWs = (function () {
  'use strict';

  const BAD_SERVER =
    'Сервер не найден. Запустите start.bat (node server.js) и откройте игру по адресу из его окна.';

  class Net {
    constructor(url) {
      this.url = url || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      this.ws = null;
      this.role = null;
      this.code = null;
      this.handlers = new Map();
      this.connected = false;
      this.destroyed = false;
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

    _connect() {
      return new Promise((resolve, reject) => {
        let done = false;
        const ok = () => { if (!done) { done = true; resolve(); } };
        const fail = (err) => { if (!done) { done = true; reject(err); } };

        let ws;
        try {
          ws = new WebSocket(this.url);
        } catch (e) {
          fail(new Error(BAD_SERVER));
          return;
        }
        this.ws = ws;

        ws.onopen = () => ok();
        ws.onerror = () => fail(new Error(BAD_SERVER));
        ws.onclose = () => {
          if (this.ws === ws) this.ws = null;
          fail(new Error(BAD_SERVER));
          this._onClosed();
        };
        ws.onmessage = (e) => {
          try { this._onMessage(e.data); } catch (err) { console.error(err); }
        };
      });
    }

    _onClosed() {
      if (this.destroyed) return;
      this.destroyed = true;
      if (this.timeout) {
        clearTimeout(this.timeout);
        this.timeout = null;
      }
      const was = this.connected;
      this.connected = false;
      if (was) this._emit('close', {});
    }

    _onMessage(raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== 'object' || !msg.t) return;

      switch (msg.t) {
        case 'code':
          this.code = msg.code;
          this._emit('ready', { code: msg.code });
          break;
        case 'peer':
          this.connected = true;
          this._emit('open', { role: this.role, code: this.code });
          break;
        case 'joined':
          if (msg.code) this.code = msg.code;
          break;
        case 'nope':
          this._emit('joinfail', { reason: 'nope' });
          break;
        case 'full':
          this._emit('joinfail', { reason: 'full' });
          break;
        case 'peer-gone':
          if (this.connected) {
            this.connected = false;
            this._emit('close', {});
          }
          break;
        default:
          this._emit('data', msg);
          break;
      }
    }

    host() {
      return new Promise((resolve, reject) => {
        this.role = 'host';
        let settled = false;
        const done = (code) => {
          if (settled) return;
          settled = true;
          if (this.timeout) clearTimeout(this.timeout);
          this.code = code;
          resolve(code);
        };
        const fail = (err) => {
          if (settled) return;
          settled = true;
          if (this.timeout) clearTimeout(this.timeout);
          this.close();
          reject(err);
        };

        this.on('ready', (d) => done(d.code));
        this.on('error', fail);

        this.timeout = setTimeout(
          () => fail(new Error('Сервер не отвечает. Проверьте, что игра запущена через start.bat.')),
          8000
        );

        this._connect()
          .then(() => this.send('host'))
          .catch(fail);
      });
    }

    join(code) {
      code = String(code || '').trim().toUpperCase();
      return new Promise((resolve, reject) => {
        this.role = 'guest';
        this.code = code;
        let settled = false;

        const ok = () => {
          if (settled) return;
          settled = true;
          if (this.timeout) clearTimeout(this.timeout);
          resolve(true);
        };
        const fail = (err) => {
          if (settled) return;
          settled = true;
          if (this.timeout) clearTimeout(this.timeout);
          this.close();
          reject(err);
        };

        this.on('open', ok);
        this.on('joinfail', (d) => {
          fail(
            new Error(
              d.reason === 'full'
                ? 'В комнате уже двое. Попросите создать новую.'
                : 'Комната не найдена. Проверьте код и попробуйте снова.'
            )
          );
        });
        this.on('error', fail);

        this.timeout = setTimeout(
          () => fail(new Error('Комната не найдена. Проверьте код и попробуйте снова.')),
          12000
        );

        this._connect()
          .then(() => {
            if (!this.destroyed) this.send('join', { code });
          })
          .catch(fail);
      });
    }

    send(type, payload) {
      if (!this.ws || this.ws.readyState !== 1) return false;
      try {
        this.ws.send(JSON.stringify(Object.assign({ t: type }, payload || {})));
        return true;
      } catch (e) {
        return false;
      }
    }

    close() {
      if (this.timeout) {
        clearTimeout(this.timeout);
        this.timeout = null;
      }
      const ws = this.ws;
      this.ws = null;
      this.connected = false;
      if (this.destroyed) return;
      this.destroyed = true;
      if (ws) {
        try {
          if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'bye' }));
        } catch (e) { /* noop */ }
        setTimeout(() => {
          try { ws.close(); } catch (e) { /* noop */ }
        }, 80);
      }
    }
  }

  return Net;
})();

if (typeof window !== 'undefined') window.ChessNetWs = ChessNetWs;
