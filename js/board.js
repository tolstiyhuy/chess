/* =========================================================================
   BoardView — отрисовка доски, анимация фигур, drag&drop, подсветка ходов.
   ========================================================================= */
class BoardView {
  constructor(els, opts) {
    this.root = els.board;
    this.sqLayer = els.sqLayer;
    this.hlLayer = els.hlLayer;
    this.pieceLayer = els.pieceLayer;
    this.coordLayer = els.coordLayer;
    this.promoEl = els.promo;

    opts = opts || {};
    this.orientation = 'w';
    this.state = null;
    this.ids = new Array(64).fill(null);
    this.elById = new Map();
    this.nextId = 1;
    this.selected = null;
    this.legal = [];
    this.lastMove = null;
    this.checkSq = null;
    this.enabled = false;
    this.review = false;
    this.drag = null;
    this._hintPromise = null;

    this.isInteractive = opts.isInteractive || (() => this.enabled);
    this.getLegal = opts.getLegal || (() => []);
    this.onMove = opts.onMove || (() => {});
    this.onIllegal = opts.onIllegal || (() => {});
    this.onSelect = opts.onSelect || (() => {});

    this._buildSquares();
    this._bind();
    this.layout();
  }

  /* ------------------------------- построение ---------------------------- */

  _buildSquares() {
    const frag = document.createDocumentFragment();
    this.squareEls = [];
    for (let sq = 0; sq < 64; sq++) {
      const d = document.createElement('div');
      const r = sq >> 3, f = sq & 7;
      d.className = 'sq ' + ((r + f) % 2 === 0 ? 'light' : 'dark');
      d.dataset.sq = sq;
      this.squareEls.push(d);
      frag.appendChild(d);
    }
    this.sqLayer.appendChild(frag);

    this.coordEls = [];
    for (let i = 0; i < 8; i++) {
      const file = document.createElement('span');
      file.className = 'coord file';
      this.coordEls.push(file);
      this.coordLayer.appendChild(file);
      const rank = document.createElement('span');
      rank.className = 'coord rank';
      this.coordEls.push(rank);
      this.coordLayer.appendChild(rank);
    }
  }

  layout() {
    const flipped = this.orientation === 'b';
    this.squareEls.forEach((el, sq) => {
      const r = sq >> 3, f = sq & 7;
      const sr = flipped ? 7 - r : r;
      const sf = flipped ? 7 - f : f;
      el.style.left = sf * 12.5 + '%';
      el.style.top = sr * 12.5 + '%';
    });

    // координаты: файлы снизу, ранги слева
    const coordColor = (light) => (light ? 'rgba(0,0,0,0.44)' : 'rgba(255,255,255,0.62)');
    const files = this.coordEls.filter((e) => e.classList.contains('file'));
    const ranks = this.coordEls.filter((e) => e.classList.contains('rank'));
    for (let i = 0; i < 8; i++) {
      files[i].textContent = flipped ? 'hgfedcba'[i] : 'abcdefgh'[i];
      files[i].style.color = coordColor((7 + i) % 2 === 0);
      files[i].style.left = i * 12.5 + '%';
      files[i].style.top = 'auto';
      files[i].style.bottom = '0.4%';
      files[i].style.right = 'auto';
      ranks[i].textContent = String(flipped ? i + 1 : 8 - i);
      ranks[i].style.color = coordColor(i % 2 === 0);
      ranks[i].style.top = i * 12.5 + '%';
      ranks[i].style.left = '0';
    }
    // точная установка углов
    files.forEach((el, i) => {
      el.style.left = i * 12.5 + '%';
      el.style.top = 'auto';
      el.style.bottom = '0.4%';
      el.style.right = 'auto';
      el.style.width = '12.5%';
      el.style.textAlign = 'right';
      el.style.paddingRight = '0.6cqw';
    });
    ranks.forEach((el, i) => {
      el.style.left = '0';
      el.style.top = i * 12.5 + '%';
      el.style.width = '12.5%';
      el.style.paddingLeft = '0.6cqw';
    });

    this._renderPieces(false);
    this._renderHighlights();
  }

  setOrientation(color) {
    if (color === this.orientation) return;
    this.orientation = color;
    this.layout();
  }

  flip() {
    this.setOrientation(this.orientation === 'w' ? 'b' : 'w');
  }

  /* --------------------------------- данные ------------------------------- */

  setState(state, opts) {
    opts = opts || {};
    const prev = this.state;
    this.state = state;

    if (opts.rebuild || !prev || opts.move == null) {
      this._rebuildIds();
    } else {
      this._applyMoveIds(opts.move, prev);
    }

    this.lastMove = opts.lastMove !== undefined ? opts.lastMove : this.lastMove;
    this.checkSq = opts.checkSq !== undefined ? opts.checkSq : null;
    if (opts.clearSelection) this.selected = null;

    this._renderPieces(opts.animate !== false);
    this.refreshLegal();
    this._renderHighlights();
  }

  _rebuildIds() {
    this.elById.forEach((el) => el.remove());
    this.elById.clear();
    this.ids = new Array(64).fill(null);
    for (let sq = 0; sq < 64; sq++) {
      if (this.state.board[sq]) this.ids[sq] = this.nextId++;
    }
  }

  _applyMoveIds(move, prevState) {
    const piece = prevState.board[move.from];
    const white = piece === piece.toUpperCase();
    const capSq = move.ep ? move.to + (white ? 8 : -8) : move.to;

    if (this.ids[capSq]) {
      const el = this.elById.get(this.ids[capSq]);
      if (el) {
        el.classList.add('fade');
        setTimeout(() => { if (el.parentNode) el.remove(); }, 190);
      }
      this.elById.delete(this.ids[capSq]);
      this.ids[capSq] = null;
    }

    this.ids[move.to] = this.ids[move.from];
    this.ids[move.from] = null;

    if (move.castle) {
      const rookFrom = move.castle === 'K' ? (white ? 63 : 7) : (white ? 56 : 0);
      const rookTo = move.castle === 'K' ? (white ? 61 : 5) : (white ? 59 : 3);
      this.ids[rookTo] = this.ids[rookFrom];
      this.ids[rookFrom] = null;
    }
  }

  _pos(sq) {
    const r = sq >> 3, f = sq & 7;
    const flipped = this.orientation === 'b';
    const sr = flipped ? 7 - r : r;
    const sf = flipped ? 7 - f : f;
    return { left: sf * 12.5, top: sr * 12.5 };
  }

  _renderPieces(animate) {
    if (!this.state) return;
    const used = new Set();
    const board = this.state.board;

    for (let sq = 0; sq < 64; sq++) {
      const piece = board[sq];
      const id = this.ids[sq];
      if (!piece || !id) continue;
      used.add(id);

      let el = this.elById.get(id);
      const isNew = !el;
      if (!el) {
        el = document.createElement('div');
        el.className = 'piece no-anim';
        el.dataset.id = id;
        el.innerHTML = '<img alt="" draggable="false" />';
        this.pieceLayer.appendChild(el);
        this.elById.set(id, el);
      }

      const want = (piece === piece.toUpperCase() ? 'w' : 'b') + piece.toUpperCase();
      const img = el.firstChild;
      if (el.dataset.piece !== want) {
        img.src = 'assets/pieces/' + want + '.svg';
        el.dataset.piece = want;
        el.dataset.color = piece === piece.toUpperCase() ? 'w' : 'b';
      }
      el.dataset.sq = sq;
      el.dataset.ptype = piece.toUpperCase();

      const p = this._pos(sq);
      const dur = animate ? '' : '0s';
      el.style.transitionDuration = dur;
      el.style.left = p.left + '%';
      el.style.top = p.top + '%';
      el.style.display = '';
      if (isNew) {
        void el.offsetWidth;
        el.classList.remove('no-anim');
      }
    }

    // удалённые фигуры
    for (const [id, el] of Array.from(this.elById.entries())) {
      if (!used.has(id)) {
        el.classList.add('fade');
        this.elById.delete(id);
        setTimeout(() => { if (el.parentNode) el.remove(); }, 190);
      }
    }
  }

  refreshLegal() {
    if (this.selected === null || !this.state) { this.legal = []; return; }
    try {
      this.legal = this.getLegal(this.selected) || [];
    } catch (e) {
      this.legal = [];
    }
  }

  select(sq) {
    this.selected = sq;
    this.refreshLegal();
    this._renderHighlights();
    this.onSelect(sq);
  }

  clearSelection() {
    if (this.selected === null) return;
    this.selected = null;
    this.legal = [];
    this._renderHighlights();
  }

  _renderHighlights() {
    if (!this.state) return;
    const frag = document.createDocumentFragment();
    const add = (sq, cls, inner) => {
      const d = document.createElement('div');
      const p = this._pos(sq);
      d.className = 'hl ' + cls;
      d.style.left = p.left + '%';
      d.style.top = p.top + '%';
      if (inner) d.innerHTML = inner;
      frag.appendChild(d);
      return d;
    };

    if (this.lastMove) {
      add(this.lastMove.from, 'last');
      add(this.lastMove.to, 'last');
    }
    if (this.checkSq !== null && this.checkSq !== undefined && this.checkSq >= 0) {
      add(this.checkSq, 'check');
    }
    if (this.selected !== null) add(this.selected, 'sel');

    for (const m of this.legal) {
      if (m.captured || m.ep) add(m.to, '', '<div class="hint-ring"></div>');
      else add(m.to, '', '<div class="hint-dot"></div>');
    }

    this.hlLayer.replaceChildren(frag);
  }

  /* ------------------------------- события -------------------------------- */

  _bind() {
    this._onDown = this._handleDown.bind(this);
    this._onMoveEv = this._handleMove.bind(this);
    this._onUp = this._handleUp.bind(this);
    this._onCancel = this._handleCancel.bind(this);
    this.root.addEventListener('pointerdown', this._onDown);
    this.root.addEventListener('pointermove', this._onMoveEv);
    this.root.addEventListener('pointerup', this._onUp);
    this.root.addEventListener('pointercancel', this._onCancel);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _squareFromEvent(e) {
    const rect = this.root.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (x < 0 || x >= 1 || y < 0 || y >= 1) return -1;
    let f = Math.floor(x * 8);
    let r = Math.floor(y * 8);
    if (this.orientation === 'b') { f = 7 - f; r = 7 - r; }
    return r * 8 + f;
  }

  _colorAt(sq) {
    const p = this.state && this.state.board[sq];
    if (!p) return null;
    return p === p.toUpperCase() ? 'w' : 'b';
  }

  _isLegalTarget(sq) {
    return this.legal.some((m) => m.to === sq);
  }

  _handleDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target.closest && e.target.closest('.promo')) return;
    if (!this.isInteractive() || !this.state) return;
    const sq = this._squareFromEvent(e);
    if (sq < 0) return;

    // клик по подсвеченной цели — сделать ход
    if (this.selected !== null && sq !== this.selected && this._isLegalTarget(sq)) {
      this._tryMove(this.selected, sq);
      return;
    }

    const piece = this.state.board[sq];
    if (!piece) {
      if (this.selected !== null) this.clearSelection();
      return;
    }

    if (this._colorAt(sq) !== this.state.turn) {
      this.clearSelection();
      this.onIllegal();
      return;
    }

    const wasSelected = this.selected === sq;
    this.select(sq);
    if (e.pointerType === 'mouse') e.preventDefault();

    const id = this.ids[sq];
    const el = this.elById.get(id);
    if (!el) return;

    const rect = this.root.getBoundingClientRect();
    this.drag = {
      pointerId: e.pointerId,
      sq,
      wasSelected,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      el,
      rect,
      size: rect.width / 8,
    };
    try { this.root.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
  }

  _handleMove(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;

    if (!d.moved) {
      d.moved = true;
      d.el.classList.add('dragging');
      d.el.style.transitionDuration = '0s';
    }
    const rect = d.rect;
    const left = e.clientX - rect.left - d.size / 2;
    const top = e.clientY - rect.top - d.size / 2;
    d.el.style.left = left + 'px';
    d.el.style.top = top + 'px';
  }

  _handleUp(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.drag = null;
    try { this.root.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }

    d.el.classList.remove('dragging');
    d.el.style.transitionDuration = '';
    d.el.style.left = '';
    d.el.style.top = '';

    if (!d.moved) {
      if (d.wasSelected) {
        this.clearSelection();
      } else {
        this.onSelect(d.sq);
      }
      return;
    }

    const sq = this._squareFromEvent(e);
    if (sq >= 0 && sq !== d.sq && this._isLegalTarget(sq)) {
      this._tryMove(d.sq, sq);
    } else {
      // вернуть фигуру на место
      this._renderPieces(false);
      if (sq >= 0 && this._colorAt(sq) === this.state.turn && sq !== d.sq) {
        this.select(sq);
      } else if (sq === d.sq) {
        /* остаёмся с выделением */
      } else {
        this.clearSelection();
      }
    }
  }

  _handleCancel(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    d.el.classList.remove('dragging');
    d.el.style.transitionDuration = '';
    d.el.style.left = '';
    d.el.style.top = '';
    this._renderPieces(false);
  }

  _tryMove(from, to) {
    const moves = this.getLegal(from) || [];
    const targets = moves.filter((m) => m.to === to);
    if (!targets.length) {
      this.onIllegal();
      this.clearSelection();
      return;
    }
    if (targets.some((m) => m.promo)) {
      this._askPromotion(to, targets[0].piece === targets[0].piece.toUpperCase() ? 'w' : 'b', (promo) => {
        this.clearSelection();
        this.onMove(from, to, promo);
      });
      return;
    }
    this.clearSelection();
    this.onMove(from, to, null);
  }

  _askPromotion(to, color, cb) {
    this.promoEl.innerHTML = '';
    this.promoEl.classList.remove('hidden');
    const order = ['Q', 'N', 'R', 'B'];
    const p = this._pos(to);
    const atTop = to >> 3 <= 3;
    for (const t of order) {
      const btn = document.createElement('button');
      const img = document.createElement('img');
      img.src = 'assets/pieces/' + (color === 'w' ? 'w' : 'b') + t + '.svg';
      img.alt = t;
      btn.appendChild(img);
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.promoEl.classList.add('hidden');
        cb(t);
      });
      this.promoEl.appendChild(btn);
    }
    this.promoEl.style.left = p.left + '%';
    if (atTop) {
      this.promoEl.style.top = 'auto';
      this.promoEl.style.bottom = (100 - p.top) + '%';
    } else {
      this.promoEl.style.bottom = 'auto';
      this.promoEl.style.top = p.top + '%';
    }
  }

  /* ------------------------------- утилиты -------------------------------- */

  setEnabled(v) {
    this.enabled = !!v;
    this.root.classList.toggle('locked', !this.enabled);
    if (!v) this.clearSelection();
  }

  setReview(v) {
    this.review = !!v;
    this.root.classList.toggle('review', this.review);
  }
}
