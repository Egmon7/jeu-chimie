import { COLORS, catchLoops, enclosures } from "./engine.js";

export function displayColor(key, theme) {
  if (key === "black" && theme === "dark") return "#e7e9ee";
  return COLORS[key] || key;
}

export class BoardView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.game = null;
    this.colors = ["#2f6fed", "#e23d3d"];
    this.penStyle = "fine";
    this.theme = "classic";
    this.hover = null;
    this.press = null;
    this.pointers = new Set();
    this.anims = [];
    this.geom = null;
    this.canPlay = () => false;
    this.onMove = () => {};
    this.onTrace = () => {};
    this.tracing = false;
    this.trace = [];
    this.traceFault = false;
    this.traceId = null;
    this.onPointer = this.onPointer.bind(this);
    canvas.addEventListener("pointerdown", this.onPointer);
    canvas.addEventListener("pointermove", this.onPointer);
    canvas.addEventListener("pointerup", this.onPointer);
    canvas.addEventListener("pointercancel", this.onPointer);
    canvas.addEventListener("pointerleave", (event) => {
      this.hover = null;
      if (this.traceId != null) return;
      this.press = null;
      this.pointers.delete(event.pointerId);
    });
  }

  setMatch({ game, colors, penStyle, theme }) {
    this.game = game;
    this.colors = colors;
    this.penStyle = penStyle;
    this.theme = theme;
  }

  clearAnims() {
    this.anims = [];
    this.hover = null;
  }

  animate(move, result) {
    const now = performance.now();
    this.anims.push({
      kind: "dot",
      r: move.r,
      c: move.c,
      player: result.player,
      start: now,
      dur: 180,
    });
    if (result.completed) {
      this.anims.push({
        kind: "frame",
        player: result.player,
        start: now + 120,
        dur: 280,
      });
    }
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.viewWidth = width;
    this.viewHeight = height;
    this.layout();
  }

  layout() {
    const game = this.game;
    if (!game) {
      this.geom = null;
      return;
    }
    const padX = 22;
    const padY = 22;
    const cell = Math.min(
      (this.viewWidth - padX * 2) / game.cols,
      (this.viewHeight - padY * 2) / game.rows,
    );
    const boardW = cell * game.cols;
    const boardH = cell * game.rows;
    this.geom = {
      cell,
      ox: (this.viewWidth - boardW) / 2,
      oy: (this.viewHeight - boardH) / 2,
    };
  }

  point(c, r) {
    return [this.geom.ox + c * this.geom.cell, this.geom.oy + r * this.geom.cell];
  }

  hit(x, y) {
    const game = this.game;
    if (!game || !this.geom) return null;
    const limit = Math.max(14, this.geom.cell * 0.46);
    let best = null;
    let bestDist = limit;
    for (let r = 0; r <= game.rows; r += 1) {
      for (let c = 0; c <= game.cols; c += 1) {
        if (game.dots[r][c] != null || game.framed[r][c] != null) continue;
        const [px, py] = this.point(c, r);
        const dist = Math.hypot(x - px, y - py);
        if (dist < bestDist) {
          bestDist = dist;
          best = { r, c };
        }
      }
    }
    return best;
  }

  setTracing(on) {
    this.tracing = on;
    this.trace = [];
    this.traceFault = false;
    this.traceId = null;
    this.press = null;
    this.canvas.style.touchAction = on ? "none" : "pan-x pan-y";
  }

  targetSet() {
    const set = new Set();
    if (!this.game) return set;
    for (const loop of catchLoops(this.game, this.game.current)) {
      for (const dot of loop) set.add(`${dot.r},${dot.c}`);
    }
    return set;
  }

  ownDot(hit) {
    if (!hit || !this.game) return false;
    if (this.targets && !this.targets.has(`${hit.r},${hit.c}`)) return false;
    const player = this.game.current;
    return this.game.dots[hit.r]?.[hit.c] === player && this.game.framed[hit.r][hit.c] == null;
  }

  loopUnder(hit) {
    if (!hit || !this.game) return null;
    const matches = catchLoops(this.game, this.game.current)
      .filter((loop) => loop.some((dot) => dot.r === hit.r && dot.c === hit.c));
    if (!matches.length) return null;
    matches.sort((a, b) => a.length - b.length);
    return matches[0];
  }

  hitOwn(x, y) {
    const game = this.game;
    if (!game || !this.geom) return null;
    this.targets = this.targetSet();
    const limit = Math.max(20, this.geom.cell * 0.85);
    let best = null;
    let bestDist = limit;
    for (const key of this.targets) {
      const [r, c] = key.split(",").map(Number);
      const [px, py] = this.point(c, r);
      const dist = Math.hypot(x - px, y - py);
      if (dist < bestDist) {
        bestDist = dist;
        best = { r, c };
      }
    }
    return best;
  }

  pushTrace(hit) {
    if (!this.ownDot(hit)) return;
    const last = this.trace[this.trace.length - 1];
    if (!last) {
      this.trace.push(hit);
      return;
    }
    if (last.r === hit.r && last.c === hit.c) return;
    const walked = this.walkOwn(last, hit);
    if (!walked) return;
    for (const dot of walked) {
      const prev = this.trace[this.trace.length - 1];
      if (prev.r === dot.r && prev.c === dot.c) continue;
      this.trace.push(dot);
      if (this.sealTrace()) return;
    }
  }

  closedLoop(trace) {
    if (!trace || trace.length < 4) return null;
    const last = trace[trace.length - 1];
    for (let i = 0; i <= trace.length - 4; i += 1) {
      const dot = trace[i];
      if (dot.r === last.r && dot.c === last.c) {
        const loop = trace.slice(i, -1);
        if (loop.length >= 4) return loop;
        continue;
      }
      const step = Math.max(Math.abs(dot.r - last.r), Math.abs(dot.c - last.c));
      if (step === 1) return trace.slice(i);
    }
    return null;
  }

  sealTrace() {
    const loop = this.closedLoop(this.trace);
    if (!loop) return false;
    this.traceId = null;
    this.trace = [];
    this.traceFault = false;
    this.onTrace(loop, false);
    return true;
  }

  walkOwn(from, to) {
    const path = [];
    let cur = from;
    for (let n = 0; n < 64; n += 1) {
      if (cur.r === to.r && cur.c === to.c) return path;
      const step = Math.max(Math.abs(cur.r - to.r), Math.abs(cur.c - to.c));
      if (step === 1) {
        path.push({ r: to.r, c: to.c });
        return path;
      }
      const next = this.onlyStep(cur, to);
      if (!next) return null;
      path.push(next);
      cur = next;
    }
    return null;
  }

  onlyStep(from, to) {
    const game = this.game;
    const player = game.current;
    const prev = Math.max(Math.abs(from.r - to.r), Math.abs(from.c - to.c));
    let best = null;
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        if (!dr && !dc) continue;
        const r = from.r + dr;
        const c = from.c + dc;
        if (this.targets && !this.targets.has(`${r},${c}`)) continue;
        if (game.dots[r]?.[c] !== player || game.framed[r]?.[c] != null) continue;
        const dist = Math.max(Math.abs(r - to.r), Math.abs(c - to.c));
        if (dist >= prev) continue;
        if (best) return null;
        best = { r, c };
      }
    }
    return best;
  }

  finishTrace() {
    const trace = this.trace.slice();
    const fault = this.traceFault;
    this.trace = [];
    this.traceFault = false;
    if (!trace.length) return;
    const loop = this.closedLoop(trace);
    this.onTrace(loop, !loop && fault);
  }

  onPointer(event) {
    if (this.tracing) {
      const rect = this.canvas.getBoundingClientRect();
      const hit = this.hitOwn(event.clientX - rect.left, event.clientY - rect.top);
      if (event.type === "pointerdown") {
        event.preventDefault();
        const house = this.loopUnder(hit);
        if (house) {
          this.traceId = null;
          this.trace = [];
          this.onTrace(house, false);
          return;
        }
        this.traceId = event.pointerId;
        this.trace = [];
        this.traceFault = false;
        try { this.canvas.setPointerCapture(event.pointerId); } catch { /* le doigt est déjà parti */ }
        this.pushTrace(hit);
        return;
      }
      if (event.type === "pointermove") {
        if (this.traceId !== event.pointerId) return;
        this.pushTrace(hit);
        return;
      }
      if (event.type === "pointerup" || event.type === "pointercancel") {
        if (this.traceId !== event.pointerId) return;
        this.traceId = null;
        this.finishTrace();
      }
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit = this.hit(x, y);
    if (event.type === "pointermove") {
      this.hover = this.canPlay() ? hit : null;
      this.canvas.style.cursor = this.hover ? "pointer" : "default";
      return;
    }
    if (event.type === "pointerdown") {
      this.pointers.add(event.pointerId);
      if (this.pointers.size > 1) {
        this.press = null;
        return;
      }
      this.press = hit && this.canPlay()
        ? {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          hit,
          scale: window.visualViewport?.scale || 1,
        }
        : null;
      return;
    }
    if (event.type === "pointercancel" || event.type === "pointerleave") {
      this.pointers.delete(event.pointerId);
      this.press = null;
      if (event.type === "pointerleave") this.hover = null;
      return;
    }
    if (event.type !== "pointerup") return;
    this.pointers.delete(event.pointerId);
    if (!this.press || this.press.id !== event.pointerId || this.pointers.size > 0) {
      this.press = null;
      return;
    }
    const press = this.press;
    this.press = null;
    const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    const scale = window.visualViewport?.scale || 1;
    if (moved > 10 || Math.abs(scale - press.scale) > 0.01) return;
    this.onMove(press.hit);
  }

  frameProgress(player, now) {
    const anim = this.anims.find((item) => item.kind === "frame" && item.player === player && now < item.start + item.dur);
    if (!anim) return 1;
    if (now < anim.start) return 0;
    return (now - anim.start) / anim.dur;
  }

  frame(now) {
    this.anims = this.anims.filter((anim) => now < anim.start + anim.dur);
    this.draw(now);
  }

  draw(now) {
    const ctx = this.ctx;
    const w = this.viewWidth;
    const h = this.viewHeight;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    this.paper(ctx, w, h);
    const game = this.game;
    const geom = this.geom;
    if (!game || !geom) return;

    this.marks(ctx, now);
    this.placedDots(ctx, now);
    this.drawGuide(ctx);
    this.drawTrace(ctx);

    if (this.hover && this.canPlay()) {
      this.paintDot(this.hover.c, this.hover.r, this.colors[game.current], 0.4, 1);
    }
  }

  paper(ctx, w, h) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    const game = this.game;
    const geom = this.geom;
    if (!game || !geom) return;
    ctx.save();
    const inset = Math.max(12, Math.min(18, geom.cell * 0.42));
    const left = Math.max(6, geom.ox - inset);
    const right = Math.min(w - 6, geom.ox + game.cols * geom.cell + inset);
    const top = Math.max(6, geom.oy - inset);
    const bottom = Math.min(h - 6, geom.oy + game.rows * geom.cell + inset);
    ctx.strokeStyle = "rgba(74, 128, 176, 0.28)";
    ctx.lineWidth = 1;
    for (let r = 0; r <= game.rows; r += 1) {
      const y = geom.oy + r * geom.cell;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(74, 128, 176, 0.12)";
    for (let c = 0; c <= game.cols; c += 1) {
      const x = geom.ox + c * geom.cell;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(196, 64, 46, 0.72)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(left, top, right - left, bottom - top);
    ctx.restore();
  }

  marks(ctx, now) {
    const { cell } = this.geom;
    for (const frame of enclosures(this.game)) {
      const progress = this.frameProgress(frame.player, now);
      if (progress <= 0 || frame.loop.length < 4) continue;
      const color = this.colors[frame.player];
      ctx.save();
      ctx.beginPath();
      frame.loop.forEach((dot, index) => {
        const [x, y] = this.point(dot.c, dot.r);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      if (frame.alive !== false) {
        ctx.globalAlpha = 0.14 * progress;
        ctx.fillStyle = color;
        ctx.fill();
      }
      ctx.globalAlpha = progress;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.8, cell * 0.07);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
      ctx.restore();
    }
  }

  drawGuide(ctx) {
    if (!this.tracing || !this.game || !this.geom) return;
    const player = this.game.current;
    const targets = this.targetSet();
    this.targets = targets;
    ctx.save();
    ctx.strokeStyle = this.colors[player];
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2;
    const radius = Math.max(8, this.geom.cell * 0.32);
    for (const key of targets) {
      const [r, c] = key.split(",").map(Number);
      const [x, y] = this.point(c, r);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawTrace(ctx) {
    if (this.trace.length < 2) return;
    const player = this.game?.current ?? 0;
    ctx.save();
    ctx.beginPath();
    this.trace.forEach((dot, index) => {
      const [x, y] = this.point(dot.c, dot.r);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = this.colors[player];
    ctx.lineWidth = Math.max(2, this.geom.cell * 0.08);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.restore();
  }

  placedDots(ctx, now) {
    const game = this.game;
    for (let r = 0; r <= game.rows; r += 1) {
      for (let c = 0; c <= game.cols; c += 1) {
        const owner = game.dots[r][c];
        if (owner == null) continue;
        const anim = this.anims.find((item) => item.kind === "dot" && item.r === r && item.c === c);
        let scale = 1;
        if (anim) {
          if (now < anim.start) continue;
          scale = Math.min(1, (now - anim.start) / anim.dur);
        }
        this.paintDot(c, r, this.colors[owner], 1, scale);
      }
    }
  }

  paintDot(c, r, color, alpha, scale) {
    const [x, y] = this.point(c, r);
    const radius = Math.max(3.2, this.geom.cell * 0.16) * scale;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
