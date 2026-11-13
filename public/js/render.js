import { COLORS, enclosures } from "./engine.js";

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
    this.onPointer = this.onPointer.bind(this);
    canvas.addEventListener("pointerdown", this.onPointer);
    canvas.addEventListener("pointermove", this.onPointer);
    canvas.addEventListener("pointerup", this.onPointer);
    canvas.addEventListener("pointercancel", this.onPointer);
    canvas.addEventListener("pointerleave", (event) => {
      this.hover = null;
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

  onPointer(event) {
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
