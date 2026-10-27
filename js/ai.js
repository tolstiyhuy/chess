/* =========================================================================
   AI — негамакс с альфа-бета отсечением, quiescence, оценкой позиции.
   Уровни: 1 — новичок, 2 — любитель, 3 — клубный игрок.
   ========================================================================= */
const ChessAI = (function () {
  'use strict';
  const E = typeof ChessEngine !== 'undefined' ? ChessEngine : require('./engine.js');

  const VALUE = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 20000 };
  const MATE = 100000;

  // Таблицы позиционных бонусов (первая строка — 8-я горизонталь, как в board)
  const PST = {
    P: [
      0, 0, 0, 0, 0, 0, 0, 0,
      50, 50, 50, 50, 50, 50, 50, 50,
      10, 10, 20, 30, 30, 20, 10, 10,
      5, 5, 10, 25, 25, 10, 5, 5,
      0, 0, 0, 20, 20, 0, 0, 0,
      5, -5, -10, 0, 0, -10, -5, 5,
      5, 10, 10, -20, -20, 10, 10, 5,
      0, 0, 0, 0, 0, 0, 0, 0,
    ],
    N: [
      -50, -40, -30, -30, -30, -30, -40, -50,
      -40, -20, 0, 0, 0, 0, -20, -40,
      -30, 0, 10, 15, 15, 10, 0, -30,
      -30, 5, 15, 20, 20, 15, 5, -30,
      -30, 0, 15, 20, 20, 15, 0, -30,
      -30, 5, 10, 15, 15, 10, 5, -30,
      -40, -20, 0, 5, 5, 0, -20, -40,
      -50, -40, -30, -30, -30, -30, -40, -50,
    ],
    B: [
      -20, -10, -10, -10, -10, -10, -10, -20,
      -10, 0, 0, 0, 0, 0, 0, -10,
      -10, 0, 5, 10, 10, 5, 0, -10,
      -10, 5, 5, 10, 10, 5, 5, -10,
      -10, 0, 10, 10, 10, 10, 0, -10,
      -10, 10, 10, 10, 10, 10, 10, -10,
      -10, 5, 0, 0, 0, 0, 5, -10,
      -20, -10, -10, -10, -10, -10, -10, -20,
    ],
    R: [
      0, 0, 0, 0, 0, 0, 0, 0,
      5, 10, 10, 10, 10, 10, 10, 5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      0, 0, 0, 5, 5, 0, 0, 0,
    ],
    Q: [
      -20, -10, -10, -5, -5, -10, -10, -20,
      -10, 0, 0, 0, 0, 0, 0, -10,
      -10, 0, 5, 5, 5, 5, 0, -10,
      -5, 0, 5, 5, 5, 5, 0, -5,
      0, 0, 5, 5, 5, 5, 0, -5,
      -10, 5, 5, 5, 5, 5, 0, -10,
      -10, 0, 5, 0, 0, 0, 0, -10,
      -20, -10, -10, -5, -5, -10, -10, -20,
    ],
    K: [
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -20, -30, -30, -40, -40, -30, -30, -20,
      -10, -20, -20, -20, -20, -20, -20, -10,
      20, 20, 0, 0, 0, 0, 20, 20,
      20, 30, 10, 0, 0, 10, 30, 20,
    ],
  };

  const KING_END = [
    -50, -40, -30, -20, -20, -30, -40, -50,
    -30, -20, -10, 0, 0, -10, -20, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -30, 0, 0, 0, 0, -30, -30,
    -50, -30, -30, -30, -30, -30, -30, -50,
  ];

  function evaluate(pos) {
    const b = pos.board;
    let score = 0;
    let whiteMaterial = 0, blackMaterial = 0;
    let whiteBishops = 0, blackBishops = 0;
    let phaseMaterial = 0;

    for (let i = 0; i < 64; i++) {
      const p = b[i];
      if (!p) continue;
      const white = E.isWhitePiece(p);
      const t = p.toUpperCase();
      const v = VALUE[t];
      if (t !== 'K' && t !== 'P') phaseMaterial += v;
      if (white) whiteMaterial += v; else blackMaterial += v;
      if (t === 'B') (white ? whiteBishops++ : blackBishops++);

      const idx = white ? i : (i ^ 56);
      let bonus = t === 'K'
        ? (phaseMaterial < 1300 ? KING_END[idx] : PST.K[idx])
        : PST[t][idx];
      score += white ? v + bonus : -(v + bonus);
    }

    if (whiteBishops >= 2) score += 30;
    if (blackBishops >= 2) score -= 30;

    // бонус за центральные пешки и продвижение
    const matDiff = whiteMaterial - blackMaterial;
    if (Math.abs(matDiff) > 400) {
      // в эндшпиле король активнее
      score += 0;
    }

    return pos.turn === 'w' ? score : -score;
  }

  function orderMoves(moves) {
    moves.sort((a, b) => scoreMove(b) - scoreMove(a));
    return moves;
  }

  function scoreMove(m) {
    let s = 0;
    if (m.captured) s += 10 * VALUE[m.captured.toUpperCase()] - VALUE[m.piece.toUpperCase()];
    if (m.promo) s += VALUE[m.promo] || 0;
    if (m.castle) s += 50;
    return s;
  }

  function makeSearch(timeLimit) {
    const deadline = Date.now() + timeLimit;
    let nodes = 0;
    let aborted = false;

    function checkTime() {
      if ((++nodes & 1023) === 0 && Date.now() > deadline) aborted = true;
      return aborted;
    }

    function quiesce(pos, alpha, beta, ply) {
      if (checkTime()) return alpha;
      const stand = evaluate(pos);
      if (stand >= beta) return beta;
      if (stand > alpha) alpha = stand;
      if (ply > 8) return alpha;

      const moves = E.genLegal(pos).filter((m) => m.captured || m.promo);
      orderMoves(moves);
      for (const m of moves) {
        const u = E.makeMove(pos, m);
        const sc = -quiesce(pos, -beta, -alpha, ply + 1);
        E.unmakeMove(pos, u);
        if (aborted) return alpha;
        if (sc >= beta) return beta;
        if (sc > alpha) alpha = sc;
      }
      return alpha;
    }

    function negamax(pos, depth, alpha, beta, ply) {
      if (checkTime()) return alpha;
      const moves = E.genLegal(pos);
      if (moves.length === 0) {
        return E.inCheck(pos, pos.turn) ? -MATE + ply : 0;
      }
      if (depth <= 0) return quiesce(pos, alpha, beta, 0);

      orderMoves(moves);
      for (const m of moves) {
        const u = E.makeMove(pos, m);
        const sc = -negamax(pos, depth - 1, -beta, -alpha, ply + 1);
        E.unmakeMove(pos, u);
        if (aborted) return alpha;
        if (sc >= beta) return beta;
        if (sc > alpha) alpha = sc;
      }
      return alpha;
    }

    function search(pos, maxDepth) {
      const rootMoves = E.genLegal(pos);
      if (!rootMoves.length) return null;
      orderMoves(rootMoves);

      let best = rootMoves[0];
      let bestScore = -Infinity;

      for (let d = 1; d <= maxDepth; d++) {
        let alpha = -Infinity;
        let iterBest = null;
        let iterScore = -Infinity;
        for (const m of rootMoves) {
          const u = E.makeMove(pos, m);
          const sc = -negamax(pos, d - 1, -Infinity, -alpha, 1);
          E.unmakeMove(pos, u);
          if (aborted) break;
          if (sc > iterScore) { iterScore = sc; iterBest = m; }
          if (sc > alpha) alpha = sc;
        }
        if (aborted && iterBest === null) break;
        if (iterBest) {
          best = iterBest;
          bestScore = iterScore;
          const i = rootMoves.indexOf(iterBest);
          if (i > 0) { rootMoves.splice(i, 1); rootMoves.unshift(iterBest); }
        }
        if (Math.abs(bestScore) > MATE - 100) break;
      }
      return { move: best, score: bestScore, nodes };
    }

    return { search, isAborted: () => aborted };
  }

  const LEVELS = {
    1: { name: 'Новичок', depth: 2, time: 150, random: 0.35 },
    2: { name: 'Любитель', depth: 3, time: 500, random: 0.08 },
    3: { name: 'Клубный игрок', depth: 5, time: 1200, random: 0 },
  };

  /**
   * Выбор хода.
   * @param {Position} pos
   * @param {number} level 1..3
   * @returns {{move:object, score:number}}
   */
  function chooseMove(pos, level) {
    const cfg = LEVELS[level] || LEVELS[2];
    const work = pos.clone();
    const engine = makeSearch(cfg.time);
    const result = engine.search(work, cfg.depth);
    if (!result) return null;

    if (cfg.random > 0 && Math.random() < cfg.random) {
      const legal = E.genLegal(work);
      // «человеческая» ошибка: выбираем не самый плохой ход
      const scored = legal.map((m) => {
        const u = E.makeMove(work, m);
        const sc = -evaluate(work);
        E.unmakeMove(work, u);
        return { m, sc };
      });
      scored.sort((a, b) => b.sc - a.sc);
      const pool = scored.slice(0, Math.max(2, Math.ceil(scored.length * 0.5)));
      const pick = pool[Math.floor(Math.random() * pool.length)];
      return { move: pick.m, score: pick.sc };
    }
    return result;
  }

  return { chooseMove, evaluate, LEVELS, VALUE };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ChessAI;
