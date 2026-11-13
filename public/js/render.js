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
    this.anims = [];
    this.geom = null;
    this.canPlay = () => false;
    this.onMove = () => {};
    this.onPointer = this.onPointer.bind(this);
    canvas.addEventListener("pointerdown", this.onPointer);
    canvas.addEventListener("pointermove", this.onPointer);
    canvas.addEventListener("pointerleave", () => {
      this.hover = null;
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
    const padX = 16;
    const padY = 12;
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
    if (event.type === "pointerdown" && hit && this.canPlay()) {
      event.preventDefault();
      this.onMove(hit);
    }
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
    ctx.strokeStyle = "rgba(74, 128, 176, 0.28)";
    ctx.lineWidth = 1;
    for (let r = 0; r <= game.rows; r += 1) {
      const y = geom.oy + r * geom.cell;
      ctx.beginPath();
      ctx.moveTo(10, y);
      ctx.lineTo(w - 10, y);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(74, 128, 176, 0.12)";
    for (let c = 0; c <= game.cols; c += 1) {
      const x = geom.ox + c * geom.cell;
      ctx.beginPath();
      ctx.moveTo(x, 10);
      ctx.lineTo(x, h - 10);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(196, 64, 46, 0.72)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const marginX = Math.max(14, geom.ox - 18);
    ctx.moveTo(marginX, 8);
    ctx.lineTo(marginX, h - 8);
    ctx.stroke();
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
