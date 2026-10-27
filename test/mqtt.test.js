// Проверка MiniMqtt: две сессии, подписка и доставка сообщения.
require('../js/mqttlite.js');
const { Client } = globalThis.MiniMqtt;

const BROKER = process.argv[2] || 'wss://broker.emqx.io:8084/mqtt';
const topic = 'chesstime/test/' + Math.random().toString(36).slice(2, 8);

function mk(name) {
  return new Client({ url: BROKER, clientId: 't-' + name + '-' + Math.random().toString(16).slice(2, 8) });
}

(async () => {
  const a = mk('a');
  const b = mk('b');
  const got = [];
  a.onMessage = (t, text) => { got.push([t, text]); };

  await a.connect();
  console.log('A connected');
  await a.subscribe(topic);
  console.log('A subscribed');
  await b.connect();
  console.log('B connected');
  await b.subscribe(topic);
  console.log('B subscribed');

  await new Promise((r) => setTimeout(r, 400));
  b.publish(topic, JSON.stringify({ hello: 1 }));
  b.publish(topic, JSON.stringify({ hello: 2 }));
  await new Promise((r) => setTimeout(r, 2500));
  console.log('received:', JSON.stringify(got));
  a.end(); b.end();
  if (got.length < 1) { console.log('ПРОВАЛ'); process.exit(1); }
  console.log('OK');
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА', e); process.exit(1); });
