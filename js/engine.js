/* =========================================================================
   Chess engine — полные правила шахмат (ходы, рокировка, взятие на проходе,
   превращение, шах/мат/пат, ничья, SAN, FEN, PGN).
   Работает и в браузере (window.ChessEngine), и в Node (module.exports).
   ========================================================================= */
const ChessEngine = (function () {
  'use strict';

  const FILES = 'abcdefgh';
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  const KNIGHT_DIRS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
  const BISHOP_DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const ROOK_DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const KING_DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

  const other = (c) => (c === 'w' ? 'b' : 'w');
  const isWhitePiece = (p) => p === p.toUpperCase();

  function squareName(sq) {
    return FILES[sq & 7] + (8 - (sq >> 3));
  }
  function nameToSquare(name) {
    const f = FILES.indexOf(name[0]);
    const r = 8 - parseInt(name[1], 10);
    return r * 8 + f;
  }

  /* ------------------------------- Position ------------------------------ */

  class Position {
    constructor(fen) {
      this.board = new Array(64).fill(null);
      this.turn = 'w';
      this.castling = { K: false, Q: false, k: false, q: false };
      this.ep = null;
      this.half = 0;
      this.full = 1;
      this.setFen(fen || START_FEN);
    }

    setFen(fen) {
      const parts = String(fen).trim().split(/\s+/);
      const rows = parts[0].split('/');
      this.board = new Array(64).fill(null);
      for (let r = 0; r < 8; r++) {
        let f = 0;
        for (const ch of rows[r]) {
          if (/\d/.test(ch)) f += parseInt(ch, 10);
          else {
            this.board[r * 8 + f] = ch;
            f++;
          }
        }
      }
      this.turn = parts[1] || 'w';
      const rights = parts[2] || '-';
      this.castling = {
        K: rights.includes('K'),
        Q: rights.includes('Q'),
        k: rights.includes('k'),
        q: rights.includes('q'),
      };
      this.ep = parts[3] && parts[3] !== '-' ? nameToSquare(parts[3]) : null;
      this.half = parts[4] ? parseInt(parts[4], 10) : 0;
      this.full = parts[5] ? parseInt(parts[5], 10) : 1;
      return this;
    }

    fen() {
      let out = '';
      for (let r = 0; r < 8; r++) {
        let empty = 0;
        for (let f = 0; f < 8; f++) {
          const p = this.board[r * 8 + f];
          if (!p) empty++;
          else {
            if (empty) { out += empty; empty = 0; }
            out += p;
          }
        }
        if (empty) out += empty;
        if (r < 7) out += '/';
      }
      let rights = '';
      if (this.castling.K) rights += 'K';
      if (this.castling.Q) rights += 'Q';
      if (this.castling.k) rights += 'k';
      if (this.castling.q) rights += 'q';
      return [
        out,
        this.turn,
        rights || '-',
        this.ep === null ? '-' : squareName(this.ep),
        this.half,
        this.full,
      ].join(' ');
    }

    clone() {
      const p = Object.create(Position.prototype);
      p.board = this.board.slice();
      p.turn = this.turn;
      p.castling = { ...this.castling };
      p.ep = this.ep;
      p.half = this.half;
      p.full = this.full;
      return p;
    }

    pieceAt(sq) { return this.board[sq]; }

    kingSquare(color) {
      const k = color === 'w' ? 'K' : 'k';
      for (let i = 0; i < 64; i++) if (this.board[i] === k) return i;
      return -1;
    }
  }

  /* ------------------------------ Attacks -------------------------------- */

  function attacked(pos, sq, by) {
    const b = pos.board;
    const r = sq >> 3, f = sq & 7;

    // пешки
    const pr = by === 'w' ? r + 1 : r - 1;
    const pawn = by === 'w' ? 'P' : 'p';
    if (pr >= 0 && pr < 8) {
      for (const df of [-1, 1]) {
        const nf = f + df;
        if (nf >= 0 && nf < 8 && b[pr * 8 + nf] === pawn) return true;
      }
    }

    // кони
    const knight = by === 'w' ? 'N' : 'n';
    for (const [dr, df] of KNIGHT_DIRS) {
      const nr = r + dr, nf = f + df;
      if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8 && b[nr * 8 + nf] === knight) return true;
    }

    // король
    const king = by === 'w' ? 'K' : 'k';
    for (const [dr, df] of KING_DIRS) {
      const nr = r + dr, nf = f + df;
      if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8 && b[nr * 8 + nf] === king) return true;
    }

    // слон/ферзь
    const bishop = by === 'w' ? 'B' : 'b';
    const queen = by === 'w' ? 'Q' : 'q';
    const rook = by === 'w' ? 'R' : 'r';
    for (const [dr, df] of BISHOP_DIRS) {
      let nr = r + dr, nf = f + df;
      while (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
        const p = b[nr * 8 + nf];
        if (p) {
          if (p === bishop || p === queen) return true;
          break;
        }
        nr += dr; nf += df;
      }
    }
    for (const [dr, df] of ROOK_DIRS) {
      let nr = r + dr, nf = f + df;
      while (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
        const p = b[nr * 8 + nf];
        if (p) {
          if (p === rook || p === queen) return true;
          break;
        }
        nr += dr; nf += df;
      }
    }
    return false;
  }

  function inCheck(pos, color) {
    const ks = pos.kingSquare(color);
    return ks >= 0 && attacked(pos, ks, other(color));
  }

  /* --------------------------- Move generation --------------------------- */

  function mkMove(from, to, piece, captured, opts) {
    const m = {
      from, to, piece,
      captured: captured || null,
      promo: null,
      double: false,
      ep: false,
      castle: null,
    };
    if (opts) Object.assign(m, opts);
    return m;
  }

  function addPawnMove(moves, from, to, piece, captured, promote) {
    if (!promote) {
      moves.push(mkMove(from, to, piece, captured));
      return;
    }
    for (const pr of ['Q', 'R', 'B', 'N']) {
      moves.push(mkMove(from, to, piece, captured, { promo: pr }));
    }
  }

  function genPseudo(pos, color) {
    const b = pos.board;
    const moves = [];
    const white = color === 'w';

    for (let sq = 0; sq < 64; sq++) {
      const p = b[sq];
      if (!p || isWhitePiece(p) !== white) continue;
      const r = sq >> 3, f = sq & 7;
      const t = p.toUpperCase();

      if (t === 'P') {
        const dir = white ? -1 : 1;
        const startR = white ? 6 : 1;
        const promoR = white ? 0 : 7;
        const oneR = r + dir;
        if (oneR >= 0 && oneR < 8) {
          const one = oneR * 8 + f;
          if (!b[one]) {
            addPawnMove(moves, sq, one, p, null, oneR === promoR);
            if (r === startR) {
              const two = (r + 2 * dir) * 8 + f;
              if (!b[two]) moves.push(mkMove(sq, two, p, null, { double: true }));
            }
          }
          for (const df of [-1, 1]) {
            const nf = f + df;
            if (nf < 0 || nf > 7) continue;
            const to = oneR * 8 + nf;
            const target = b[to];
            if (target && isWhitePiece(target) !== white) {
              addPawnMove(moves, sq, to, p, target, oneR === promoR);
            } else if (!target && pos.ep === to) {
              moves.push(mkMove(sq, to, p, white ? 'p' : 'P', { ep: true }));
            }
          }
        }
      } else if (t === 'N') {
        for (const [dr, df] of KNIGHT_DIRS) {
          const nr = r + dr, nf = f + df;
          if (nr < 0 || nr > 7 || nf < 0 || nf > 7) continue;
          const to = nr * 8 + nf, target = b[to];
          if (!target || isWhitePiece(target) !== white) moves.push(mkMove(sq, to, p, target));
        }
      } else if (t === 'B' || t === 'R' || t === 'Q') {
        const dirs = t === 'B' ? BISHOP_DIRS : t === 'R' ? ROOK_DIRS : KING_DIRS;
        for (const [dr, df] of dirs) {
          let nr = r + dr, nf = f + df;
          while (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
            const to = nr * 8 + nf, target = b[to];
            if (!target) moves.push(mkMove(sq, to, p, null));
            else {
              if (isWhitePiece(target) !== white) moves.push(mkMove(sq, to, p, target));
              break;
            }
            nr += dr; nf += df;
          }
        }
      } else if (t === 'K') {
        for (const [dr, df] of KING_DIRS) {
          const nr = r + dr, nf = f + df;
          if (nr < 0 || nr > 7 || nf < 0 || nf > 7) continue;
          const to = nr * 8 + nf, target = b[to];
          if (!target || isWhitePiece(target) !== white) moves.push(mkMove(sq, to, p, target));
        }
        // рокировки
        if (white) {
          if (sq === 60) {
            if (pos.castling.K && b[63] === 'R' && !b[61] && !b[62] &&
              !attacked(pos, 60, 'b') && !attacked(pos, 61, 'b') && !attacked(pos, 62, 'b')) {
              moves.push(mkMove(60, 62, p, null, { castle: 'K' }));
            }
            if (pos.castling.Q && b[56] === 'R' && !b[57] && !b[58] && !b[59] &&
              !attacked(pos, 60, 'b') && !attacked(pos, 59, 'b') && !attacked(pos, 58, 'b')) {
              moves.push(mkMove(60, 58, p, null, { castle: 'Q' }));
            }
          }
        } else {
          if (sq === 4) {
            if (pos.castling.k && b[7] === 'r' && !b[5] && !b[6] &&
              !attacked(pos, 4, 'w') && !attacked(pos, 5, 'w') && !attacked(pos, 6, 'w')) {
              moves.push(mkMove(4, 6, p, null, { castle: 'K' }));
            }
            if (pos.castling.q && b[0] === 'r' && !b[1] && !b[2] && !b[3] &&
              !attacked(pos, 4, 'w') && !attacked(pos, 3, 'w') && !attacked(pos, 2, 'w')) {
              moves.push(mkMove(4, 2, p, null, { castle: 'Q' }));
            }
          }
        }
      }
    }
    return moves;
  }

  function updateRights(pos, from, to) {
    const c = pos.castling;
    if (from === 60 || to === 60) { c.K = false; c.Q = false; }
    if (from === 4 || to === 4) { c.k = false; c.q = false; }
    if (from === 63 || to === 63) c.K = false;
    if (from === 56 || to === 56) c.Q = false;
    if (from === 7 || to === 7) c.k = false;
    if (from === 0 || to === 0) c.q = false;
  }

  function makeMove(pos, m) {
    const b = pos.board;
    const piece = b[m.from];
    const color = isWhitePiece(piece) ? 'w' : 'b';
    const undo = {
      m,
      captured: m.captured || null,
      capturedSq: m.to,
      castling: { ...pos.castling },
      ep: pos.ep,
      half: pos.half,
      full: pos.full,
    };

    b[m.from] = null;
    if (m.ep) {
      const capSq = m.to + (color === 'w' ? 8 : -8);
      undo.captured = b[capSq];
      undo.capturedSq = capSq;
      b[capSq] = null;
    }
    b[m.to] = m.promo
      ? (color === 'w' ? m.promo.toUpperCase() : m.promo.toLowerCase())
      : piece;

    if (m.castle) {
      const rookFrom = m.castle === 'K' ? (color === 'w' ? 63 : 7) : (color === 'w' ? 56 : 0);
      const rookTo = m.castle === 'K' ? (color === 'w' ? 61 : 5) : (color === 'w' ? 59 : 3);
      b[rookTo] = b[rookFrom];
      b[rookFrom] = null;
    }

    updateRights(pos, m.from, m.to);
    pos.ep = m.double ? (m.from + m.to) / 2 : null;
    pos.half = undo.captured || piece.toUpperCase() === 'P' ? 0 : pos.half + 1;
    if (pos.turn === 'b') pos.full++;
    pos.turn = other(pos.turn);
    return undo;
  }

  function unmakeMove(pos, undo) {
    const m = undo.m;
    const b = pos.board;
    const moved = b[m.to];
    const white = isWhitePiece(moved);

    b[m.from] = m.promo ? (white ? 'P' : 'p') : moved;
    b[m.to] = null;
    if (undo.captured) b[undo.capturedSq] = undo.captured;
    if (m.castle) {
      const white = m.from === 60;
      const rookFrom = m.castle === 'K' ? (white ? 63 : 7) : (white ? 56 : 0);
      const rookTo = m.castle === 'K' ? (white ? 61 : 5) : (white ? 59 : 3);
      b[rookFrom] = b[rookTo];
      b[rookTo] = null;
    }
    pos.castling = undo.castling;
    pos.ep = undo.ep;
    pos.half = undo.half;
    pos.full = undo.full;
    pos.turn = other(pos.turn);
  }

  function genLegal(pos) {
    const color = pos.turn;
    const pseudo = genPseudo(pos, color);
    const legal = [];
    for (const m of pseudo) {
      const u = makeMove(pos, m);
      if (!inCheck(pos, color)) legal.push(m);
      unmakeMove(pos, u);
    }
    return legal;
  }

  function legalMovesFrom(pos, sq) {
    return genLegal(pos).filter((m) => m.from === sq);
  }

  function findMove(pos, from, to, promo) {
    const legal = genLegal(pos);
    return legal.find((m) => m.from === from && m.to === to && (!m.promo || !promo || m.promo === promo)) || null;
  }

  /* --------------------------------- SAN --------------------------------- */

  function toSan(pos, move, legal) {
    legal = legal || genLegal(pos);
    const b = pos.board;
    const piece = b[move.from];
    const t = piece.toUpperCase();
    const isCapture = !!move.captured || move.ep;
    let san;
    const containsMove = (m) => m.from === move.from && m.to === move.to;

    if (move.castle) {
      san = move.castle === 'K' ? 'O-O' : 'O-O-O';
    } else if (t === 'P') {
      san = isCapture ? FILES[move.from & 7] + 'x' + squareName(move.to) : squareName(move.to);
      if (move.promo) san += '=' + move.promo.toUpperCase();
    } else {
      const rivals = legal.filter(
        (m) => !containsMove(m) && m.to === move.to && b[m.from] && b[m.from].toUpperCase() === t
      );
      let dis = '';
      if (rivals.length) {
        const sameFile = rivals.some((m) => (m.from & 7) === (move.from & 7));
        const sameRank = rivals.some((m) => (m.from >> 3) === (move.from >> 3));
        if (!sameFile) dis = FILES[move.from & 7];
        else if (!sameRank) dis = String(8 - (move.from >> 3));
        else dis = squareName(move.from);
      }
      san = t + dis + (isCapture ? 'x' : '') + squareName(move.to);
    }

    const u = makeMove(pos, move);
    if (inCheck(pos, pos.turn)) {
      san += genLegal(pos).length === 0 ? '#' : '+';
    }
    unmakeMove(pos, u);
    return san;
  }

  /* ------------------------------ Status --------------------------------- */

  function insufficientMaterial(pos) {
    const pieces = [];
    for (let i = 0; i < 64; i++) {
      const p = pos.board[i];
      if (p && p.toUpperCase() !== 'K') pieces.push({ p: p.toUpperCase(), sq: i });
    }
    if (pieces.length === 0) return true;
    if (pieces.length === 1 && (pieces[0].p === 'B' || pieces[0].p === 'N')) return true;
    if (pieces.length === 2 && pieces.every((x) => x.p === 'B')) {
      const c1 = ((pieces[0].sq >> 3) + (pieces[0].sq & 7)) & 1;
      const c2 = ((pieces[1].sq >> 3) + (pieces[1].sq & 7)) & 1;
      return c1 === c2;
    }
    return false;
  }

  /** Результат партии. reps — количество повторений текущей позиции (>=3 → ничья). */
  function gameStatus(pos, reps) {
    const legal = genLegal(pos);
    if (legal.length === 0) {
      if (inCheck(pos, pos.turn)) {
        return {
          over: true,
          result: pos.turn === 'w' ? '0-1' : '1-0',
          reason: 'checkmate',
          winner: other(pos.turn),
        };
      }
      return { over: true, result: '1/2-1/2', reason: 'stalemate', winner: null };
    }
    if (pos.half >= 100) return { over: true, result: '1/2-1/2', reason: 'fifty', winner: null };
    if (insufficientMaterial(pos)) {
      return { over: true, result: '1/2-1/2', reason: 'insufficient', winner: null };
    }
    if ((reps || 0) >= 3) return { over: true, result: '1/2-1/2', reason: 'threefold', winner: null };
    return { over: false, result: null, reason: null, winner: null };
  }

  function posKey(pos) {
    const f = pos.fen().split(' ');
    return f.slice(0, 4).join(' ');
  }

  function moveNumber(pos) {
    return pos.full;
  }

  /* -------------------------------- PGN ---------------------------------- */

  function toPgn(moves, meta) {
    meta = meta || {};
    const headers = [
      ['Event', meta.event || 'Дружеская партия'],
      ['Site', meta.site || 'Chess'],
      ['Date', meta.date || new Date().toISOString().slice(0, 10).replace(/-/g, '.')],
      ['White', meta.white || 'Белые'],
      ['Black', meta.black || 'Чёрные'],
      ['Result', meta.result || '*'],
    ];
    let out = headers.map(([k, v]) => `[${k} "${v}"]`).join('\n') + '\n\n';

    let moveNo = 1;
    const tokens = [];
    moves.forEach((m) => {
      if (m.color === 'w') {
        tokens.push(moveNo + '.', m.san);
      } else {
        tokens.push(m.san);
        moveNo++;
      }
    });
    if (meta.result && meta.result !== '*') tokens.push(meta.result);

    // аккуратный перенос строк по ~80 символов, не разрывая SAN
    const lines = [];
    let cur = '';
    tokens.forEach((tok) => {
      if (!cur) cur = tok;
      else if (cur.length + 1 + tok.length > 80) {
        lines.push(cur);
        cur = tok;
      } else cur += ' ' + tok;
    });
    if (cur) lines.push(cur);
    out += lines.join('\n');
    return out.trim() + '\n';
  }

  return {
    FILES,
    START_FEN,
    Position,
    squareName,
    nameToSquare,
    other,
    isWhitePiece,
    attacked,
    inCheck,
    genPseudo,
    genLegal,
    legalMovesFrom,
    findMove,
    makeMove,
    unmakeMove,
    toSan,
    gameStatus,
    insufficientMaterial,
    posKey,
    moveNumber,
    toPgn,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ChessEngine;
