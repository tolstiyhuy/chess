/* Тест комнат локального сервера (server.js, WebSocket /ws).
   Запуск: node test/ws.test.js
   Сам поднимает сервер на свободном порту и проверяет обмен сообщениями. */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 8123;
const URL = 'ws://127.0.0.1:' + PORT + '/ws';

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: Object.assign({}, process.env, { PORT: String(PORT) }),
  stdio: 'ignore',
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const ws = new WebSocket(URL);
  const queue = [];
  const waiters = [];

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const i = waiters.findIndex((w) => w.type === msg.t);
    if (i >= 0) {
      const w = waiters.splice(i, 1)[0];
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      queue.push(msg);
    }
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('не удалось подключиться к ' + URL));
  });

  return {
    ws,
    send(type, payload) {
      ws.send(JSON.stringify(Object.assign({ t: type }, payload || {})));
    },
    next(type, ms = 5000) {
      return new Promise((resolve, reject) => {
        const i = queue.findIndex((m) => m.t === type);
        if (i >= 0) return resolve(queue.splice(i, 1)[0]);
        const w = { type, resolve };
        w.timer = setTimeout(() => {
          const j = waiters.indexOf(w);
          if (j >= 0) waiters.splice(j, 1);
          reject(new Error('таймаут ожидания «' + type + '»'));
        }, ms);
        waiters.push(w);
      });
    },
  };
}

function assert(cond, name) {
  if (!cond) throw new Error('ПРОВАЛ: ' + name);
  console.log('  ok — ' + name);
}

(async () => {
  await wait(600);
  try {
    const host = await connect();
    host.send('host');
    const { code } = await host.next('code');
    assert(/^[A-Z2-9]{5}$/.test(code), 'сервер выдал код комнаты ' + code);

    const missing = await connect();
    missing.send('join', { code: 'ZZZZZ' });
    const nope = await missing.next('nope');
    assert(nope.t === 'nope', 'несуществующая комната отклонена');
    missing.ws.close();

    const guest = await connect();
    guest.send('join', { code });
    await guest.next('joined');
    await Promise.all([host.next('peer'), guest.next('peer')]);
    assert(true, 'соперники видят друг друга');

    host.send('hello', { color: 'w' });
    const hello = await guest.next('hello');
    assert(hello.color === 'w', 'сообщения доходят от хоста к гостю');

    guest.send('chat', { text: 'привет' });
    const chat = await host.next('chat');
    assert(chat.text === 'привет', 'сообщения доходят от гостя к хосту');

    const third = await connect();
    third.send('join', { code });
    const full = await third.next('full');
    assert(full.t === 'full', 'третьего игрока не пускают');
    third.ws.close();

    guest.send('bye');
    await host.next('bye');
    guest.ws.close();
    const gone = await host.next('peer-gone');
    assert(gone.t === 'peer-gone', 'хост узнаёт об уходе гостя');

    host.ws.close();
    console.log('\nВСЕ ТЕСТЫ СОЕДИНЕНИЯ ПРОЙДЕНЫ');
  } catch (e) {
    console.error('\n' + e.message);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();
