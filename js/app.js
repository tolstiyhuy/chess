/* =========================================================================
   app.js — логика приложения: лобби, партия, часы, бот, онлайн, интерфейс.
   ========================================================================= */
(function () {
  'use strict';

  const E = ChessEngine;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const other = E.other;

  /* ------------------------------- утилиты -------------------------------- */

  const store = {
    get(k, def) {
      try {
        const v = localStorage.getItem('chess.' + k);
        return v === null ? def : JSON.parse(v);
      } catch (e) { return def; }
    },
    set(k, v) {
      try { localStorage.setItem('chess.' + k, JSON.stringify(v)); } catch (e) { /* noop */ }
    },
  };

  function pad(n) { return String(n).padStart(2, '0'); }

  function fmtClock(ms) {
    if (ms == null) return '∞';
    const t = Math.max(0, ms);
    if (t >= 3600000) {
      const h = Math.floor(t / 3600000);
      const m = Math.floor((t % 3600000) / 60000);
      const s = Math.floor((t % 60000) / 1000);
      return h + ':' + pad(m) + ':' + pad(s);
    }
    if (t < 20000) {
      return Math.floor(t / 1000) + '.' + Math.floor((t % 1000) / 100);
    }
    return Math.floor(t / 60000) + ':' + pad(Math.floor((t % 60000) / 1000));
  }

  const PIECE_VALUE = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };

  function pieceSrc(char) {
    const white = char === char.toUpperCase();
    return 'assets/pieces/' + (white ? 'w' : 'b') + char.toUpperCase() + '.svg';
  }

  function clip(text) {
    return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  async function copyText(text, okMsg) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch (err) { ok = false; }
    }
    toast(ok ? (okMsg || 'Скопировано') : 'Не удалось скопировать', ok ? '' : 'err');
    return ok;
  }

  /* ------------------------------- состояние ------------------------------ */

  const App = {
    mode: 'online',
    netMode: 'p2p',
    side: 'w',
    tc: { base: 300000, inc: 0 },
    level: 2,
    roomCode: null,
  };

  let G = null;
  let net = null;
  let board = null;
  let tickTimer = null;
  let netClockTimer = null;
  let chatUserScrolled = false;

  const els = {};

  /* -------------------------------- доска --------------------------------- */

  function initBoard() {
    board = new BoardView(
      {
        board: els.board,
        sqLayer: $('#sqLayer'),
        hlLayer: $('#hlLayer'),
        pieceLayer: $('#pieceLayer'),
        coordLayer: $('#coordLayer'),
        promo: $('#promo'),
      },
      {
        isInteractive: () => canPlay(),
        getLegal: (sq) => {
          if (!G || G.viewIndex !== G.liveIndex) return [];
          return E.genLegal(G.positions[G.viewIndex]).filter((m) => m.from === sq);
        },
        onMove: (from, to, promo) => userMove(from, to, promo),
        onIllegal: () => SoundFX.play('illegal'),
      }
    );
  }

  /* ------------------------------- партия --------------------------------- */

  class Game {
    constructor(opts) {
      this.mode = opts.mode;
      this.tc = opts.tc;
      this.myColor = opts.myColor;
      this.level = opts.level || 2;
      this.isHost = !!opts.isHost;
      this.positions = [];
      this.moves = [];
      this.viewIndex = 0;
      this.result = null;
      this.clocks = null;
      this.lastTick = null;
      this.thinking = false;
      this.reset();
    }

    reset() {
      this.positions = [new E.Position()];
      this.moves = [];
      this.viewIndex = 0;
      this.result = null;
      this.thinking = false;
      this.clocks = this.tc && this.tc.base > 0 ? { w: this.tc.base, b: this.tc.base } : null;
      this.lastTick = null;
      this.startedAt = null;
    }

    get pos() { return this.positions[this.positions.length - 1]; }
    get liveIndex() { return this.positions.length - 1; }
    get viewPos() { return this.positions[this.viewIndex]; }
  }

  /* ------------------------------ правила UI ------------------------------- */

  function canPlay() {
    if (!G || G.result) return false;
    if (G.viewIndex !== G.liveIndex) return false;
    if (G.mode === 'local') return true;
    if (G.mode === 'bot') return G.pos.turn === G.myColor && !G.thinking;
    if (G.mode === 'online') {
      return !!(net && net.connected) && G.pos.turn === G.myColor;
    }
    return false;
  }

  function computeStatus(pos) {
    const key = E.posKey(pos);
    let reps = 0;
    for (let i = 0; i < G.positions.length; i++) {
      if (E.posKey(G.positions[i]) === key) reps++;
    }
    return E.gameStatus(pos, reps);
  }

  function applyMove(from, to, promo, opts) {
    opts = opts || {};
    if (!G || G.result) return false;
    const pos = G.pos;
    const legal = E.genLegal(pos);
    const move = legal.find(
      (m) => m.from === from && m.to === to && (!m.promo || !promo || m.promo === promo)
    );
    if (!move) return false;

    const san = opts.san || E.toSan(pos, move, legal);
    const next = pos.clone();
    E.makeMove(next, move);

    const wasReviewing = G.viewIndex !== G.liveIndex;
    const synced = board.state && board.state.fen() === pos.fen();
    const animate = !wasReviewing && synced && !opts.silentAnim;

    const mover = pos.turn;
    G.positions.push(next);
    G.moves.push({
      san,
      from,
      to,
      promo: move.promo || null,
      color: mover,
      captured: move.captured || null,
      castle: move.castle || null,
      ep: !!move.ep,
    });
    G.viewIndex = G.positions.length - 1;

    if (G.clocks) {
      if (G.tc && G.tc.inc) G.clocks[mover] += G.tc.inc;
      G.lastTick = performance.now();
    }

    const inChk = E.inCheck(next, next.turn);
    const checkSq = inChk ? next.kingSquare(next.turn) : null;

    board.setState(next, {
      move: animate ? move : null,
      rebuild: !animate,
      animate,
      lastMove: move,
      checkSq,
      clearSelection: true,
    });

    if (!opts.silent) {
      if (move.castle) SoundFX.play('castle');
      else if (move.promo) SoundFX.play('promote');
      else if (move.captured) SoundFX.play('capture');
      else SoundFX.play('move');
      if (inChk) setTimeout(() => SoundFX.play('check'), 70);
    }

    const status = computeStatus(next);
    if (status.over) {
      finish(status, { broadcast: opts.broadcast });
    } else {
      renderAll();
      scheduleBot();
    }
    return true;
  }

  function userMove(from, to, promo) {
    if (!canPlay()) return;
    const ok = applyMove(from, to, promo, {});
    if (!ok) return;
    if (G.mode === 'online') {
      if (G.isHost) broadcastState();
      else if (net) net.send('move', { from, to, promo });
    }
  }

  /* -------------------------------- бот ----------------------------------- */

  function scheduleBot() {
    if (!G || G.mode !== 'bot' || G.result) return;
    if (G.pos.turn === G.myColor) {
      G.thinking = false;
      board.setEnabled(canPlay());
      return;
    }
    G.thinking = true;
    board.setEnabled(false);
    setTimeout(() => {
      if (!G || G.mode !== 'bot' || G.result) return;
      if (G.pos.turn === G.myColor) { G.thinking = false; return; }
      let res = null;
      try {
        res = ChessAI.chooseMove(G.pos, G.level);
      } catch (e) {
        console.error(e);
      }
      G.thinking = false;
      if (!res || !res.move) return;
      applyMove(res.move.from, res.move.to, res.move.promo, {});
    }, 280);
  }

  /* ------------------------------ завершение ------------------------------- */

  const REASON_TEXT = {
    checkmate: 'Мат',
    stalemate: 'Пат — ничья',
    insufficient: 'Недостаточно материала',
    fifty: 'Правило 50 ходов',
    threefold: 'Троекратное повторение',
    timeout: 'Время вышло',
    resign: 'Сдача',
    draw: 'Ничья по согласию',
    disconnected: 'Соперник отключился',
  };

  function finish(status, opts) {
    opts = opts || {};
    if (!G || G.result) return;
    G.result = status;
    G.lastTick = null;
    board.setEnabled(false);
    hideWaiting();
    renderAll();
    showResult(status);
    playEndSound(status);
    if (opts.broadcast !== false && G.mode === 'online' && G.isHost) broadcastState();
  }

  function playEndSound(status) {
    if (!status) return;
    if (status.result === '1/2-1/2') { SoundFX.play('end'); return; }
    if (G.mode === 'local') { SoundFX.play('end'); return; }
    const winner = status.result === '1-0' ? 'w' : 'b';
    const iWon = G.mode === 'bot' ? winner === G.myColor : winner === G.myColor;
    SoundFX.play(iWon ? 'win' : 'lose');
  }

  function showResult(status) {
    const overlay = els.resultOverlay;
    overlay.classList.remove('hidden');
    els.resultIcon.textContent = status.result === '1/2-1/2' ? '🤝' : '🏆';
    let title;
    let sub = REASON_TEXT[status.reason] || '';

    if (status.reason === 'disconnected') {
      els.resultIcon.textContent = '📡';
      title = 'Соединение потеряно';
      sub = 'Соперник вышел из игры';
    } else if (status.result === '1/2-1/2') {
      title = 'Ничья';
    } else {
      const winner = status.result === '1-0' ? 'w' : 'b';
      if (G.mode === 'local') {
        title = (winner === 'w' ? 'Белые' : 'Чёрные') + ' победили';
      } else {
        title = winner === G.myColor ? 'Вы победили!' : 'Вы проиграли';
      }
    }

    els.resultTitle.textContent = title;
    els.resultSub.textContent = sub;
    els.resultPgnBtn.classList.toggle('hidden', !G.moves.length);
    els.rematchBtn.classList.toggle('hidden', status.reason === 'disconnected');
    els.rematchBtn.textContent = G.mode === 'online' && !G.isHost ? 'Предложить реванш' : 'Играть снова';
  }

  function hideResult() {
    els.resultOverlay.classList.add('hidden');
  }

  /* ------------------------------ отрисовка -------------------------------- */

  function capturedBy(color) {
    const out = [];
    if (!G) return out;
    for (let i = 0; i < G.viewIndex; i++) {
      const m = G.moves[i];
      if (m.color === color && m.captured) out.push(m.captured);
    }
    out.sort((a, b) => PIECE_VALUE[b.toUpperCase()] - PIECE_VALUE[a.toUpperCase()]);
    return out;
  }

  function materialAdvantage(color) {
    const mine = capturedBy(color).reduce((s, p) => s + PIECE_VALUE[p.toUpperCase()], 0);
    const theirs = capturedBy(other(color)).reduce((s, p) => s + PIECE_VALUE[p.toUpperCase()], 0);
    return mine - theirs;
  }

  function playerCardHTML(color, slot) {
    const isMe = G.mode !== 'local' && color === G.myColor;
    let name;
    let av;
    if (G.mode === 'local') {
      name = color === 'w' ? 'Белые' : 'Чёрные';
      av = color === 'w' ? 'Б' : 'Ч';
    } else if (G.mode === 'bot') {
      name = isMe ? 'Вы' : 'Бот · ' + ChessAI.LEVELS[G.level].name;
      av = isMe ? 'Я' : 'Б';
    } else {
      name = isMe ? 'Вы' : 'Соперник';
      av = isMe ? 'Я' : 'С';
    }
    const tag = G.mode === 'local' ? '' : color === 'w' ? 'белые' : 'чёрные';
    const cap = capturedBy(color);
    const mat = materialAdvantage(color);

    let dot = '';
    if (G.mode === 'online') {
      dot = '<span class="dot' + (color === G.myColor || (net && net.connected) ? '' : ' off') + '"></span>';
    }

    const capHTML = cap.map((p) => `<img src="${pieceSrc(p)}" alt="">`).join('') +
      (mat > 0 ? `<span class="mat">+${mat}</span>` : '');

    return (
      `<div class="avatar${color === 'b' ? ' dark' : ''}">${av}${dot}</div>` +
      `<div class="player-meta">` +
      `<div class="player-name">${clip(name)}${tag ? `<span class="player-tag">${tag}</span>` : ''}</div>` +
      `<div class="captured">${capHTML}</div>` +
      `</div>` +
      `<div class="clock" data-slot="${slot}" data-color="${color}">${fmtClock(G.clocks ? G.clocks[color] : null)}</div>`
    );
  }

  function renderPlayers() {
    if (!G) return;
    const topColor = board.orientation === 'w' ? 'b' : 'w';
    const bottomColor = other(topColor);
    els.topPlayer.innerHTML = playerCardHTML(topColor, 'top');
    els.bottomPlayer.innerHTML = playerCardHTML(bottomColor, 'bottom');
    updateClockText();
  }

  function updateClockText() {
    if (!G) return;
    $$('.clock', els.game).forEach((el) => {
      const color = el.dataset.color;
      if (!color) return;
      const ms = G.clocks ? G.clocks[color] : null;
      el.textContent = fmtClock(ms);
      el.classList.toggle('is-off', !G.clocks);
      el.classList.toggle('is-low', ms != null && ms <= 20000);
      const active = !G.result && G.clocks && G.moves.length > 0 && G.pos.turn === color;
      el.classList.toggle('is-active', !!active);
    });
  }

  function moveBtnHTML(m, index) {
    const current = G.viewIndex === index + 1 ? ' current' : '';
    return `<button class="move-san${current}" data-ply="${index + 1}">${clip(m.san)}</button>`;
  }

  function renderMoves() {
    if (!G) return;
    const box = els.moves;
    if (!G.moves.length) {
      box.innerHTML = '<div class="moves-empty">Партия ещё не началась</div>';
      return;
    }
    let html = '';
    for (let i = 0; i < G.moves.length; i += 2) {
      const n = i / 2 + 1;
      html += '<div class="move-row"><span class="move-no">' + n + '.</span>';
      html += moveBtnHTML(G.moves[i], i);
      html += G.moves[i + 1] ? moveBtnHTML(G.moves[i + 1], i + 1) : '<span class="move-san empty"></span>';
      html += '</div>';
    }
    box.innerHTML = html;
    if (G.viewIndex === G.liveIndex) {
      box.scrollTop = box.scrollHeight;
    } else {
      const cur = $('.move-san.current', box);
      if (cur) cur.scrollIntoView({ block: 'nearest' });
    }
  }

  function renderNav() {
    if (!G) return;
    els.navLabel.textContent = G.viewIndex === 0
      ? 'старт'
      : G.viewIndex + ' / ' + G.liveIndex;
    $$('[data-nav]', els.game).forEach((b) => {
      const k = b.dataset.nav;
      b.disabled = k === 'start' || k === 'prev' ? G.viewIndex === 0 : G.viewIndex === G.liveIndex;
    });
  }

  function renderButtons() {
    if (!G) return;
    els.undoBtn.disabled = G.mode === 'online' || !G.moves.length || !!G.result;
    els.drawBtn.disabled = !!G.result;
    els.resignBtn.disabled = !!G.result;
    els.copyPgnBtn.disabled = !G.moves.length;
    els.fenBtn.disabled = false;
  }

  function renderAll() {
    if (!G) return;
    renderPlayers();
    renderMoves();
    renderNav();
    renderButtons();
    board.setEnabled(canPlay());
    updateStatusLine();
  }

  function updateStatusLine() {
    if (!G) return;
    let txt = '';
    if (G.result) {
      txt = 'Партия окончена';
    } else if (G.viewIndex !== G.liveIndex) {
      txt = 'Просмотр партии';
    } else if (G.mode === 'online' && (!net || !net.connected)) {
      txt = 'Нет соединения';
    } else if (G.mode === 'bot' && G.thinking) {
      txt = 'Бот думает…';
    } else if (G.mode === 'online') {
      txt = G.pos.turn === G.myColor ? 'Ваш ход' : 'Ход соперника';
    } else if (G.mode === 'local') {
      txt = G.pos.turn === 'w' ? 'Ход белых' : 'Ход чёрных';
    } else {
      txt = G.pos.turn === G.myColor ? 'Ваш ход' : 'Ход бота';
    }
    els.gameTitle.textContent = txt;
  }

  /* ----------------------------- навигация --------------------------------- */

  function gotoPly(index) {
    if (!G) return;
    const target = Math.max(0, Math.min(index, G.liveIndex));
    if (target === G.viewIndex) return;
    G.viewIndex = target;
    showPosition(target);
  }

  function showPosition(index) {
    const pos = G.positions[index];
    const last = index > 0 ? G.moves[index - 1] : null;
    const chk = E.inCheck(pos, pos.turn) ? pos.kingSquare(pos.turn) : null;
    board.setState(pos, {
      rebuild: true,
      animate: false,
      lastMove: last,
      checkSq: chk,
      clearSelection: true,
    });
    board.setEnabled(canPlay());
    renderPlayers();
    renderMoves();
    renderNav();
    renderButtons();
    updateStatusLine();
  }

  function navStep(dir) {
    if (!G) return;
    if (dir === 'start') gotoPly(0);
    else if (dir === 'prev') gotoPly(G.viewIndex - 1);
    else if (dir === 'next') gotoPly(G.viewIndex + 1);
    else if (dir === 'end') gotoPly(G.liveIndex);
  }

  /* ------------------------------- онлайн ---------------------------------- */

  function broadcastState() {
    if (!G || !net || !G.isHost) return;
    net.send('state', {
      fen: G.pos.fen(),
      clocks: G.clocks,
      result: G.result,
      moves: G.moves.map((m) => ({ san: m.san, from: m.from, to: m.to, promo: m.promo, color: m.color })),
    });
  }

  function rebuildFromState(msg) {
    const pos = new E.Position(E.START_FEN);
    const positions = [pos.clone()];
    const moves = [];
    for (const m of msg.moves || []) {
      const legal = E.genLegal(pos);
      const mv = legal.find((x) => x.from === m.from && x.to === m.to && (!x.promo || !m.promo || x.promo === m.promo));
      if (!mv) break;
      const san = E.toSan(pos, mv, legal);
      E.makeMove(pos, mv);
      positions.push(pos.clone());
      moves.push({
        san,
        from: m.from,
        to: m.to,
        promo: mv.promo || null,
        color: m.color,
        captured: mv.captured || null,
        castle: mv.castle || null,
        ep: !!mv.ep,
      });
    }
    if (positions[positions.length - 1].fen() !== msg.fen) {
      const p = new E.Position(msg.fen);
      G.positions = [p];
      G.moves = [];
    } else {
      G.positions = positions;
      G.moves = moves;
    }
    G.viewIndex = G.positions.length - 1;

    const last = G.moves.length ? G.moves[G.moves.length - 1] : null;
    const chk = E.inCheck(G.pos, G.pos.turn) ? G.pos.kingSquare(G.pos.turn) : null;
    board.setState(G.pos, {
      rebuild: true,
      animate: false,
      lastMove: last,
      checkSq: chk,
      clearSelection: true,
    });
  }

  function onNetData(msg) {
    if (!G) return;
    switch (msg.t) {
      case 'hello': {
        if (G.isHost) return;
        G.myColor = other(msg.color);
        if (msg.tc) G.tc = msg.tc;
        G.clocks = G.tc && G.tc.base > 0 ? { w: G.tc.base, b: G.tc.base } : null;
        G.lastTick = performance.now();
        board.setOrientation(G.myColor);
        hideWaiting();
        renderAll();
        SoundFX.play('notify');
        toast('Соперник подключился');
        els.chatStatus.textContent = 'на связи';
        break;
      }
      case 'move': {
        if (!G.isHost) return;
        if (G.result) return;
        if (G.pos.turn === G.myColor) { broadcastState(); return; }
        const ok = applyMove(msg.from, msg.to, msg.promo, { broadcast: false });
        // подтверждаем состояние в любом случае — так гость сам себя исправит
        broadcastState();
        if (!ok) { /* noop */ }
        break;
      }
      case 'state': {
        if (G.isHost) return;
        if (msg.moves && msg.fen !== G.pos.fen()) rebuildFromState(msg);
        if (msg.clocks) {
          G.clocks = { w: msg.clocks.w, b: msg.clocks.b };
          G.lastTick = performance.now();
        }
        if (msg.result && !G.result) {
          finish(msg.result, { broadcast: false });
        } else {
          renderAll();
        }
        break;
      }
      case 'clock': {
        if (G.isHost || !msg.clocks) return;
        G.clocks = { w: msg.clocks.w, b: msg.clocks.b };
        G.lastTick = performance.now();
        updateClockText();
        break;
      }
      case 'chat': {
        addChat(msg.text, false);
        break;
      }
      case 'draw-offer': {
        SoundFX.play('notify');
        confirmDialog({
          title: 'Соперник предлагает ничью',
          text: 'Принять предложение?',
          confirmText: 'Согласиться',
          cancelText: 'Отклонить',
        }).then((yes) => {
          if (!G || G.result) return;
          if (yes) {
            if (G.isHost) finish({ over: true, result: '1/2-1/2', reason: 'draw', winner: null });
            else {
              net.send('draw-accept');
              finish({ over: true, result: '1/2-1/2', reason: 'draw', winner: null }, { broadcast: false });
            }
          } else {
            net.send('draw-decline');
            toast('Вы отклонили ничью');
          }
        });
        break;
      }
      case 'draw-accept': {
        finish({ over: true, result: '1/2-1/2', reason: 'draw', winner: null });
        break;
      }
      case 'draw-decline': {
        toast('Соперник отклонил ничью');
        break;
      }
      case 'resign': {
        if (!G.isHost) return;
        finish({
          over: true,
          result: msg.color === 'w' ? '0-1' : '1-0',
          reason: 'resign',
          winner: other(msg.color),
        });
        break;
      }
      case 'rematch': {
        if (!G.isHost) return;
        startOnlineRematch(true);
        break;
      }
      case 'restart': {
        if (G.isHost) return;
        G.myColor = other(msg.color);
        if (msg.tc) G.tc = msg.tc;
        G.reset();
        board.setOrientation(G.myColor);
        board.setState(G.pos, { rebuild: true, animate: false, lastMove: null, checkSq: null });
        hideResult();
        hideWaiting();
        renderAll();
        toast('Новая партия');
        break;
      }
      case 'bye': {
        onPeerGone();
        break;
      }
      default:
        break;
    }
  }

  function onPeerGone() {
    if (!G || G.result) return;
    G.result = { over: true, result: '*', reason: 'disconnected', winner: null };
    board.setEnabled(false);
    showResult(G.result);
    els.rematchBtn.classList.add('hidden');
    els.resultPgnBtn.classList.add('hidden');
    toast('Соперник отключился', 'err');
  }

  function bindNet() {
    net.on('open', () => {
      if (!G) return;
      if (G.isHost) {
        net.send('hello', { color: G.myColor, tc: G.tc });
        hideWaiting();
        els.chatStatus.textContent = 'на связи';
        SoundFX.play('notify');
        toast('Соперник подключился');
        renderAll();
      }
    });
    net.on('data', onNetData);
    net.on('close', onPeerGone);
    net.on('error', () => {
      if (G && !G.result) toast('Проблема с соединением', 'err');
    });
  }

  /* ------------------------------ управление -------------------------------- */

  function startGame(opts) {
    G = new Game(opts);
    App.roomCode = opts.code || null;
    board.setOrientation(opts.myColor);
    board.setState(G.pos, { rebuild: true, animate: false, lastMove: null, checkSq: null });
    hideResult();
    hideWaiting();
    els.chatBlock.classList.toggle('hidden', opts.mode !== 'online');
    els.roomBadge.classList.toggle('hidden', opts.mode !== 'online');
    els.roomBadgeCode.textContent = App.roomCode || '—';
    els.chatStatus.textContent = opts.mode === 'online' ? 'подключение…' : '';
    els.chatLog.innerHTML = '';
    renderAll();
  }

  function startOnlineRematch(hostInitiated) {
    if (!G) return;
    G.myColor = other(G.myColor);
    G.reset();
    board.setOrientation(G.myColor);
    board.setState(G.pos, { rebuild: true, animate: false, lastMove: null, checkSq: null });
    hideResult();
    renderAll();
    if (G.isHost) {
      net.send('restart', { color: G.myColor, tc: G.tc });
      els.roomBadgeCode.textContent = App.roomCode || '—';
      toast('Новая партия');
    }
  }

  function resign() {
    if (!G || G.result) return;
    const color = G.mode === 'local' ? G.pos.turn : G.myColor;
    const who = G.mode === 'local'
      ? (color === 'w' ? 'белые' : 'чёрные')
      : 'вы';
    confirmDialog({
      title: 'Сдаться?',
      text: 'Партия будет засчитана как поражение (' + who + ').',
      confirmText: 'Сдаться',
      danger: true,
    }).then((yes) => {
      if (!yes || !G || G.result) return;
      if (G.mode === 'online') {
        if (G.isHost) {
          finish({
            over: true,
            result: color === 'w' ? '0-1' : '1-0',
            reason: 'resign',
            winner: other(color),
          });
        } else {
          net.send('resign', { color });
          finish({
            over: true,
            result: color === 'w' ? '0-1' : '1-0',
            reason: 'resign',
            winner: other(color),
          }, { broadcast: false });
        }
        return;
      }
      finish({
        over: true,
        result: color === 'w' ? '0-1' : '1-0',
        reason: 'resign',
        winner: other(color),
      });
    });
  }

  function offerDraw() {
    if (!G || G.result) return;
    if (G.mode === 'online') {
      if (!net || !net.connected) { toast('Нет соединения', 'err'); return; }
      net.send('draw-offer');
      toast('Предложение ничьей отправлено');
      addChat('Вы предложили ничью', true, true);
      return;
    }
    if (G.mode === 'bot') {
      const score = ChessAI.evaluate(G.pos);
      const botScore = G.pos.turn === G.myColor ? -score : score;
      if (botScore < 120) {
        finish({ over: true, result: '1/2-1/2', reason: 'draw', winner: null });
      } else {
        toast('Бот отклонил ничью');
      }
      return;
    }
    confirmDialog({
      title: 'Ничья?',
      text: 'Оба игрока согласны завершить партию вничью?',
      confirmText: 'Ничья',
    }).then((yes) => {
      if (yes && G && !G.result) {
        finish({ over: true, result: '1/2-1/2', reason: 'draw', winner: null });
      }
    });
  }

  function undo() {
    if (!G || G.result || G.mode === 'online') return;
    if (!G.moves.length) return;
    let count = 1;
    if (G.mode === 'bot' && G.moves.length >= 2 && G.moves[G.moves.length - 1].color !== G.myColor) count = 2;
    for (let i = 0; i < count && G.positions.length > 1; i++) {
      G.positions.pop();
      G.moves.pop();
    }
    G.viewIndex = G.positions.length - 1;
    board.setState(G.pos, {
      rebuild: true,
      animate: false,
      lastMove: G.moves.length ? G.moves[G.moves.length - 1] : null,
      checkSq: E.inCheck(G.pos, G.pos.turn) ? G.pos.kingSquare(G.pos.turn) : null,
      clearSelection: true,
    });
    board.setEnabled(canPlay());
    renderAll();
  }

  function pgnText() {
    if (!G) return '';
    return E.toPgn(
      G.moves.map((m) => ({ san: m.san, color: m.color })),
      {
        white: G.mode === 'local' ? 'Белые' : G.myColor === 'w' ? 'Вы' : 'Соперник',
        black: G.mode === 'local' ? 'Чёрные' : G.myColor === 'b' ? 'Вы' : 'Соперник',
        result: G.result ? G.result.result : '*',
        event: 'Шахматы',
        site: location.href,
      }
    );
  }

  /* --------------------------------- часы ---------------------------------- */

  function startTicker() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      if (!G || !G.clocks || G.result) return;
      if (!G.moves.length) { G.lastTick = performance.now(); return; }
      const now = performance.now();
      if (G.lastTick == null) { G.lastTick = now; return; }
      const dt = Math.min(now - G.lastTick, 1200);
      G.lastTick = now;
      const turn = G.pos.turn;
      if (G.clocks[turn] > 0) {
        G.clocks[turn] = Math.max(0, G.clocks[turn] - dt);
        updateClockText();
      }
      if (G.clocks[turn] <= 0) {
        if (G.mode === 'online' && !G.isHost) return;
        const opp = other(turn);
        if (E.insufficientMaterial(G.pos)) {
          finish({ over: true, result: '1/2-1/2', reason: 'timeout', winner: null });
        } else {
          finish({
            over: true,
            result: opp === 'w' ? '1-0' : '0-1',
            reason: 'timeout',
            winner: opp,
          });
        }
      }
    }, 100);
  }

  function startNetClock() {
    if (netClockTimer) clearInterval(netClockTimer);
    netClockTimer = setInterval(() => {
      if (G && G.mode === 'online' && G.isHost && !G.result && net && net.connected && G.clocks) {
        net.send('clock', { clocks: G.clocks });
      }
    }, 2000);
  }

  /* --------------------------------- чат ----------------------------------- */

  function addChat(text, mine, sys) {
    if (!text) return;
    const div = document.createElement('div');
    div.className = 'chat-msg' + (mine ? ' mine' : '') + (sys ? ' sys' : '');
    if (sys) {
      div.textContent = text;
    } else {
      div.innerHTML = '<b>' + (mine ? 'Вы' : 'Соперник') + ':</b> ' + clip(text);
    }
    els.chatLog.appendChild(div);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  function sendChat(text) {
    text = String(text || '').trim();
    if (!text) return;
    addChat(text, true);
    if (net && net.connected) net.send('chat', { text });
  }

  /* ------------------------------ модалки/тосты ----------------------------- */

  let modalResolve = null;

  function openModal(html) {
    els.modalCard.innerHTML = html;
    els.modal.classList.remove('hidden');
  }

  function closeModal(value) {
    els.modal.classList.add('hidden');
    els.modalCard.innerHTML = '';
    if (modalResolve) {
      const r = modalResolve;
      modalResolve = null;
      r(value);
    }
  }

  function confirmDialog(opts) {
    return new Promise((resolve) => {
      modalResolve = resolve;
      openModal(
        `<h3>${clip(opts.title)}</h3>` +
        `<p>${clip(opts.text || '')}</p>` +
        `<div class="modal-actions">` +
        `<button class="btn" data-act="cancel">${clip(opts.cancelText || 'Отмена')}</button>` +
        `<button class="btn ${opts.danger ? 'primary' : 'primary'}" data-act="ok">${clip(opts.confirmText || 'ОК')}</button>` +
        `</div>`
      );
      els.modalCard.querySelector('[data-act="ok"]').onclick = () => closeModal(true);
      els.modalCard.querySelector('[data-act="cancel"]').onclick = () => closeModal(false);
    });
  }

  let toastTimer = null;
  function toast(text, type, ms) {
    const div = document.createElement('div');
    div.className = 'toast' + (type === 'err' ? ' err' : '');
    div.textContent = text;
    els.toasts.appendChild(div);
    setTimeout(() => {
      div.classList.add('out');
      setTimeout(() => div.remove(), 260);
    }, ms || 2400);
  }

  /* ------------------------------- настройки -------------------------------- */

  const THEMES = [
    { id: 'green', name: 'Зелёная', l: '#eeeed2', d: '#769656' },
    { id: 'brown', name: 'Классика', l: '#f0d9b5', d: '#b58863' },
    { id: 'blue', name: 'Голубая', l: '#dfe6ea', d: '#7d9bab' },
    { id: 'graphite', name: 'Графит', l: '#cfd3d6', d: '#6c757c' },
  ];

  function applyTheme(id) {
    document.body.dataset.board = id;
    store.set('theme', id);
    $$('.theme-swatch', els.modalCard).forEach((b) => {
      b.classList.toggle('is-active', b.dataset.theme === id);
    });
    board.layout();
  }

  function setSound(on) {
    SoundFX.setEnabled(on);
    store.set('sound', on);
    els.soundBtn.textContent = on ? '🔊' : '🔇';
    els.soundBtn.classList.toggle('is-off', !on);
    const btn = $('[data-act="sound"]', els.modalCard);
    if (btn) btn.textContent = on ? 'Включён' : 'Выключен';
  }

  function openSettings() {
    const currentTheme = document.body.dataset.board || 'green';
    const swatches = THEMES.map((t) =>
      `<button class="theme-swatch${t.id === currentTheme ? ' is-active' : ''}" data-theme="${t.id}" title="${t.name}" ` +
      `style="--sw-l:${t.l};--sw-d:${t.d}"><i></i><i></i><i></i><i></i></button>`
    ).join('');
    openModal(
      `<h3>Настройки</h3>` +
      `<div class="modal-section"><div class="setting-label">Тема доски</div><div class="themes">${swatches}</div></div>` +
      `<div class="modal-section"><div class="setting-label">Звук</div>` +
      `<button class="btn" data-act="sound" style="min-width:130px">${SoundFX.isEnabled() ? 'Включён' : 'Выключен'}</button></div>` +
      `<div class="modal-actions"><button class="btn primary" data-act="close">Готово</button></div>`
    );
    $$('.theme-swatch', els.modalCard).forEach((b) => {
      b.onclick = () => applyTheme(b.dataset.theme);
    });
    els.modalCard.querySelector('[data-act="sound"]').onclick = () => setSound(!SoundFX.isEnabled());
    els.modalCard.querySelector('[data-act="close"]').onclick = () => closeModal();
    modalResolve = null;
  }

  /* -------------------------------- экраны ---------------------------------- */

  function showScreen(name) {
    els.lobby.classList.toggle('hidden', name !== 'lobby');
    els.game.classList.toggle('hidden', name !== 'game');
    if (name === 'game') {
      board.layout();
    }
  }

  function leaveGame(silent) {
    if (net) {
      if (!silent) net.send('bye');
      net.close();
      net = null;
    }
    G = null;
    hideResult();
    hideWaiting();
    showScreen('lobby');
  }

  function showLobbyError(msg) {
    els.lobbyError.textContent = msg || '';
  }

  function showWaiting(code, title, sub) {
    els.waitOverlay.classList.remove('hidden');
    if (code) {
      els.waitCode.textContent = code;
      const row = $('.code-row', els.waitOverlay);
      if (row) row.classList.remove('hidden');
    } else {
      els.waitCode.textContent = '·····';
    }
    if (title) $('h3', els.waitOverlay).textContent = title;
    if (sub) $('.wait-sub', els.waitOverlay).textContent = sub;
  }

  function hideWaiting() {
    els.waitOverlay.classList.add('hidden');
  }

  /* ------------------------------- запуск игр ------------------------------- */

  function chosenColor() {
    if (App.side === 'random') return Math.random() < 0.5 ? 'w' : 'b';
    return App.side;
  }

  function startOffline() {
    const myColor = App.mode === 'local' ? 'w' : chosenColor();
    startGame({
      mode: App.mode,
      myColor,
      tc: App.tc,
      level: App.level,
      isHost: false,
    });
    showScreen('game');
    if (App.mode === 'bot') {
      SoundFX.play('notify');
      if (G.pos.turn !== G.myColor) scheduleBot();
    }
  }

  function makeNet() {
    if (App.netMode === 'lan') {
      if (!window.ChessNetWs) throw new Error('Модуль локальной сети не загрузился. Обновите страницу.');
      return new window.ChessNetWs();
    }
    if (!window.TrysteroTorrent || !window.ChessNet) throw new Error('Онлайн-модуль не загрузился. Обновите страницу.');
    return new window.ChessNet();
  }

  async function createRoom() {
    showLobbyError('');
    let newNet;
    try {
      newNet = makeNet();
    } catch (e) {
      showLobbyError(e.message);
      return;
    }
    const myColor = chosenColor();
    startGame({
      mode: 'online',
      myColor,
      tc: App.tc,
      level: 2,
      isHost: true,
    });
    showScreen('game');
    showWaiting(null, 'Создаём комнату…', App.netMode === 'lan' ? 'Подключаемся к серверу…' : 'Подключаемся к сигнальным трекерам…');
    els.roomBadgeCode.textContent = '—';
    net = newNet;
    bindNet();
    try {
      const code = await net.host();
      App.roomCode = code;
      els.roomBadgeCode.textContent = code;
      showWaiting(
        code,
        'Ждём соперника',
        App.netMode === 'lan'
          ? 'Друг открывает адрес из окна сервера и вводит этот код:'
          : 'Друг открывает эту же страницу и вводит код. Не подключается — попробуйте «Локальная сеть».'
      );
      toast('Комната создана: ' + code);
    } catch (e) {
      console.error(e);
      if (net) { net.close(); net = null; }
      G = null;
      hideWaiting();
      showScreen('lobby');
      showLobbyError(e.message || 'Не удалось создать комнату. Проверьте интернет и попробуйте снова.');
    }
  }

  async function joinRoom() {
    showLobbyError('');
    const code = els.roomInput.value.trim().toUpperCase();
    if (code.length !== 5) {
      showLobbyError('Код комнаты состоит из 5 символов');
      els.roomInput.focus();
      return;
    }
    let newNet;
    try {
      newNet = makeNet();
    } catch (e) {
      showLobbyError(e.message);
      return;
    }
    startGame({
      mode: 'online',
      myColor: 'w',
      tc: App.tc,
      level: 2,
      isHost: false,
    });
    App.roomCode = code;
    els.roomBadgeCode.textContent = code;
    showScreen('game');
    showWaiting(null, 'Подключаемся…', 'Ищем комнату ' + code);
    net = newNet;
    bindNet();
    try {
      await net.join(code);
      showWaiting(null, 'Ожидаем соперника', 'Соединение установлено…');
    } catch (e) {
      console.error(e);
      if (net) { net.close(); net = null; }
      G = null;
      hideWaiting();
      showScreen('lobby');
      showLobbyError(e.message || 'Не удалось подключиться к комнате');
    }
  }

  /* ------------------------------- интерфейс -------------------------------- */

  function cacheEls() {
    els.lobby = $('#lobby');
    els.game = $('#game');
    els.board = $('#board');
    els.topPlayer = $('#topPlayer');
    els.bottomPlayer = $('#bottomPlayer');
    els.moves = $('#moves');
    els.navLabel = $('#navLabel');
    els.gameTitle = $('#gameTitle');
    els.roomBadge = $('#roomBadge');
    els.roomBadgeCode = $('#roomBadgeCode');
    els.undoBtn = $('#undoBtn');
    els.drawBtn = $('#drawBtn');
    els.resignBtn = $('#resignBtn');
    els.copyPgnBtn = $('#copyPgnBtn');
    els.fenBtn = $('#fenBtn');
    els.chatBlock = $('#chatBlock');
    els.chatLog = $('#chatLog');
    els.chatStatus = $('#chatStatus');
    els.chatForm = $('#chatForm');
    els.chatInput = $('#chatInput');
    els.modal = $('#modal');
    els.modalCard = $('#modalCard');
    els.toasts = $('#toasts');
    els.waitOverlay = $('#waitOverlay');
    els.waitCode = $('#waitCode');
    els.resultOverlay = $('#resultOverlay');
    els.resultIcon = $('#resultIcon');
    els.resultTitle = $('#resultTitle');
    els.resultSub = $('#resultSub');
    els.rematchBtn = $('#rematchBtn');
    els.resultPgnBtn = $('#resultPgnBtn');
    els.lobbyError = $('#lobbyError');
    els.roomInput = $('#roomInput');
    els.soundBtn = $('#soundBtn');
    els.startBtn = $('#startBtn');
  }

  function applyNetModeUI() {
    $$('#netModes button').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.net === App.netMode);
    });
    const hint = $('#netHint');
    if (hint) {
      hint.textContent =
        App.netMode === 'lan'
          ? 'Игра через ваш сервер: друг открывает адрес из окна start.bat (например, http://192.168.1.5:8000) и вводит этот же код. Подходит для локальной сети или туннеля.'
          : 'Прямое соединение через интернет (WebRTC). Обоим нужен современный браузер и доступ в сеть; в редких сетях соединение может не установиться.';
    }
  }

  function bindLobby() {
    $$('.mode').forEach((b) => {
      b.onclick = () => {
        $$('.mode').forEach((x) => x.classList.toggle('is-active', x === b));
        App.mode = b.dataset.mode;
        $$('.mode-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== App.mode));
        els.startBtn.textContent = App.mode === 'online' ? 'Создать комнату' : 'Начать игру';
        $('#sideSetting').classList.toggle('hidden', App.mode === 'local');
        showLobbyError('');
      };
    });

    $$('#netModes button').forEach((b) => {
      b.onclick = () => {
        App.netMode = b.dataset.net;
        store.set('netmode', App.netMode);
        applyNetModeUI();
        showLobbyError('');
      };
    });
    applyNetModeUI();

    $$('#tcs button').forEach((b) => {
      b.onclick = () => {
        $$('#tcs button').forEach((x) => x.classList.toggle('is-active', x === b));
        const [sec, inc] = b.dataset.tc.split(',').map(Number);
        App.tc = { base: sec * 1000, inc: inc * 1000 };
        store.set('tc', b.dataset.tc);
      };
    });

    $$('#botLevels button').forEach((b) => {
      b.onclick = () => {
        $$('#botLevels button').forEach((x) => x.classList.toggle('is-active', x === b));
        App.level = Number(b.dataset.level);
      };
    });

    $$('#sides button').forEach((b) => {
      b.onclick = () => {
        $$('#sides button').forEach((x) => x.classList.toggle('is-active', x === b));
        App.side = b.dataset.side;
      };
    });

    els.startBtn.onclick = () => {
      SoundFX.unlock();
      if (App.mode === 'online') createRoom();
      else startOffline();
    };
    $('#joinRoom').onclick = () => { SoundFX.unlock(); joinRoom(); };
    els.roomInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { SoundFX.unlock(); joinRoom(); }
    });
    els.roomInput.addEventListener('input', () => {
      els.roomInput.value = els.roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      showLobbyError('');
    });
  }

  function bindGame() {
    els.backBtn = $('#backBtn');
    els.backBtn.onclick = async () => {
      if (G && !G.result && G.moves.length) {
        const ok = await confirmDialog({
          title: 'Выйти в меню?',
          text: 'Текущая партия будет прервана.',
          confirmText: 'Выйти',
          danger: true,
        });
        if (!ok) return;
      }
      leaveGame(!G || !!G.result);
      showScreen('lobby');
    };

    $('#flipBtn').onclick = () => {
      board.flip();
      renderPlayers();
    };
    els.undoBtn.onclick = undo;
    els.drawBtn.onclick = offerDraw;
    els.resignBtn.onclick = resign;

    els.copyPgnBtn.onclick = () => {
      if (!G || !G.moves.length) return;
      copyText(pgnText(), 'PGN скопирован');
    };
    els.fenBtn.onclick = () => {
      if (!G) return;
      copyText(G.positions[G.viewIndex].fen(), 'FEN скопирован');
    };

    $$('[data-nav]', els.game).forEach((b) => {
      b.onclick = () => navStep(b.dataset.nav);
    });

    els.moves.addEventListener('click', (e) => {
      const btn = e.target.closest('.move-san[data-ply]');
      if (!btn) return;
      gotoPly(Number(btn.dataset.ply));
    });

    $('#soundBtn').onclick = () => setSound(!SoundFX.isEnabled());
    $('#settingsBtn').onclick = openSettings;

    els.rematchBtn.onclick = () => {
      if (!G) return;
      if (G.mode === 'online') {
        if (!net || !net.connected) { toast('Нет соединения', 'err'); return; }
        if (G.isHost) startOnlineRematch();
        else {
          net.send('rematch');
          toast('Предложение реванша отправлено');
        }
        return;
      }
      const opts = { mode: G.mode, myColor: G.myColor, tc: G.tc, level: G.level, isHost: false };
      G = new Game(opts);
      board.setOrientation(opts.myColor);
      board.setState(G.pos, { rebuild: true, animate: false, lastMove: null, checkSq: null });
      hideResult();
      renderAll();
      if (G.mode === 'bot' && G.pos.turn !== G.myColor) scheduleBot();
    };

    $('#resultMenuBtn').onclick = () => {
      leaveGame(!!(G && G.result));
      showScreen('lobby');
    };

    els.resultPgnBtn.onclick = () => copyText(pgnText(), 'PGN скопирован');

    $('#copyCodeBtn').onclick = () => {
      if (App.roomCode) copyText(App.roomCode, 'Код скопирован');
    };
    $('#cancelWait').onclick = () => {
      leaveGame(false);
      showScreen('lobby');
    };

    els.chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      sendChat(els.chatInput.value);
      els.chatInput.value = '';
    });
    $$('#chatQuick button').forEach((b) => {
      b.onclick = () => sendChat(b.textContent);
    });

    els.modal.addEventListener('click', (e) => {
      if (e.target === els.modal) closeModal(false);
    });

    startTicker();
    startNetClock();
  }

  function bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea')) return;
      if (e.key === 'Escape') {
        if (!els.modal.classList.contains('hidden')) { closeModal(false); return; }
        if (board) board.clearSelection();
        return;
      }
      if (els.game.classList.contains('hidden') || !G) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); navStep('prev'); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); navStep('next'); }
      else if (e.key === 'Home') { e.preventDefault(); navStep('start'); }
      else if (e.key === 'End') { e.preventDefault(); navStep('end'); }
      else if (e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') {
        board.flip();
        renderPlayers();
      }
    });
  }

  /* --------------------------------- init ----------------------------------- */

  function init() {
    cacheEls();
    initBoard();

    const savedTheme = store.get('theme', 'green');
    document.body.dataset.board = savedTheme;

    const savedSound = store.get('sound', true);
    SoundFX.setEnabled(savedSound);
    els.soundBtn.textContent = savedSound ? '🔊' : '🔇';
    els.soundBtn.classList.toggle('is-off', !savedSound);

    const savedTc = store.get('tc', '300,0');
    const tcBtn = $(`#tcs button[data-tc="${savedTc}"]`);
    if (tcBtn) {
      $$('#tcs button').forEach((x) => x.classList.toggle('is-active', x === tcBtn));
      const [sec, inc] = savedTc.split(',').map(Number);
      App.tc = { base: sec * 1000, inc: inc * 1000 };
    }

    App.netMode = store.get('netmode', 'p2p') === 'lan' ? 'lan' : 'p2p';

    bindLobby();
    bindGame();
    bindKeys();
    els.startBtn.textContent = App.mode === 'online' ? 'Создать комнату' : 'Начать игру';

    // стартовый экран
    showScreen('lobby');
    board.setState(new E.Position(), { rebuild: true, animate: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
