export class Sounds {
  constructor() {
    this.enabled = true;
    this.ctx = null;
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) this.unlock();
  }

  unlock() {
    if (!this.ctx) {
      const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  tone(freq, duration, type, gainValue, delay = 0) {
    if (!this.enabled || !this.ctx) return;
    const start = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  line() {
    this.unlock();
    this.tone(540, 0.07, "triangle", 0.035);
  }

  box() {
    this.unlock();
    this.tone(660, 0.09, "sine", 0.05);
    this.tone(880, 0.12, "sine", 0.04, 0.07);
  }

  win() {
    this.unlock();
    [523, 659, 784, 1046].forEach((freq, index) => {
      this.tone(freq, 0.16, "sine", 0.05, index * 0.11);
    });
  }

  lose() {
    this.unlock();
    this.tone(311, 0.18, "sine", 0.04);
    this.tone(233, 0.28, "sine", 0.04, 0.12);
  }

  tap() {
    this.unlock();
    this.tone(420, 0.035, "square", 0.012);
  }
}
