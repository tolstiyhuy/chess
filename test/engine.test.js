/* Perft-тесты движка: node test/engine.test.js */
const E = require('../js/engine.js');

function perft(pos, depth) {
  if (depth === 0) return 1;
  const moves = E.genLegal(pos);
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) {
    const u = E.makeMove(pos, m);
    n += perft(pos, depth - 1);
    E.unmakeMove(pos, u);
  }
  return n;
}

const cases = [
  { name: 'startpos', fen: E.START_FEN, counts: [20, 400, 8902, 197281] },
  { name: 'kiwipete', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', counts: [48, 2039, 97862] },
  { name: 'pos3', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', counts: [14, 191, 2812, 43238] },
  { name: 'pos4', fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', counts: [6, 264, 9467] },
  { name: 'promo/ep', fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', counts: [44, 1486, 62379] },
];

let failures = 0;
for (const c of cases) {
  for (let d = 1; d <= c.counts.length; d++) {
    const pos = new E.Position(c.fen);
    const t0 = Date.now();
    const got = perft(pos, d);
    const ms = Date.now() - t0;
    const want = c.counts[d - 1];
    const ok = got === want;
    if (!ok) failures++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${c.name} depth ${d}: ${got} (ожидалось ${want}) ${ms}ms`);
  }
}

// SAN / статусы / FEN
const pos = new E.Position();
const legal = E.genLegal(pos);
const s1 = E.toSan(pos, legal.find((m) => m.from === 52 && m.to === 36));
console.log('SAN e2e4 =', s1, s1 === 'e4' ? 'OK' : 'FAIL');
if (s1 !== 'e4') failures++;

const mate = new E.Position('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
console.log('status =', JSON.stringify(E.gameStatus(mate)));

const fools = new E.Position();
const seq = [[53, 45], [12, 28], [54, 38], [3, 39]];
for (const [from, to] of seq) {
  const m = E.genLegal(fools).find((x) => x.from === from && x.to === to);
  if (!m) { console.log('FAIL move', from, to); failures++; break; }
  E.makeMove(fools, m);
}
console.log('fools mate status =', JSON.stringify(E.gameStatus(fools)));
console.log('fen =', fools.fen());

// roundtrip FEN
const f = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
console.log('fen roundtrip', new E.Position(f).fen() === f ? 'OK' : 'FAIL');
if (new E.Position(f).fen() !== f) failures++;

console.log(failures === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${failures}`);
process.exit(failures ? 1 : 0);
