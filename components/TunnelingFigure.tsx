"use client";

import { useEffect, useRef } from "react";

const INK_RGB = "27,26,23";
const PERIOD = 16000;
const STATIC_T = 0.56 * PERIOD;

function drawFrame(canvas: HTMLCanvasElement, accent: string, t: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const d = window.devicePixelRatio || 1;
  const w = canvas.width / d;
  const h = canvas.height / d;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const y0 = h * 0.54;
  const A0 = h * 0.3;
  const bx0 = w * 0.53;
  const bx1 = w * 0.61;
  const bw = bx1 - bx0;

  // baseline axis with ticks
  const axisY = Math.round(y0 + A0 * 1.15) + 0.5;
  ctx.strokeStyle = `rgba(${INK_RGB},0.3)`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, axisY);
  ctx.lineTo(w, axisY);
  ctx.stroke();
  const tick = w / 24;
  for (let x = 0; x <= w; x += tick) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, axisY);
    ctx.lineTo(x + 0.5, axisY - 5);
    ctx.stroke();
  }

  // center line
  ctx.strokeStyle = `rgba(${INK_RGB},0.12)`;
  ctx.beginPath();
  ctx.moveTo(0, y0 + 0.5);
  ctx.lineTo(w, y0 + 0.5);
  ctx.stroke();

  // barrier: hatched band
  const bTop = y0 - A0 * 1.12;
  const bBot = y0 + A0 * 1.12;
  ctx.strokeStyle = `rgba(${INK_RGB},0.1)`;
  for (let x = bx0; x <= bx1; x += 5) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, bTop);
    ctx.lineTo(x + 0.5, bBot);
    ctx.stroke();
  }
  ctx.strokeStyle = `rgba(${INK_RGB},0.45)`;
  ctx.beginPath();
  ctx.moveTo(Math.round(bx0) + 0.5, bTop);
  ctx.lineTo(Math.round(bx0) + 0.5, bBot);
  ctx.moveTo(Math.round(bx1) + 0.5, bTop);
  ctx.lineTo(Math.round(bx1) + 0.5, bBot);
  ctx.stroke();

  // wave packet
  const u = (((t % PERIOD) + PERIOD) % PERIOD) / PERIOD;
  const xc = -0.15 * w + u * 1.3 * w;
  const sig = 0.085 * w;
  const k = (2 * Math.PI) / 72;
  const phase = t * 0.0035;
  const lam = bw / Math.log(1 / 0.3);
  const xr = 2 * bx0 - xc;
  const R = xc > bx0 ? 0.45 * Math.min(1, (xc - bx0) / sig) : 0;

  const tau = (x: number) => (x < bx0 ? 1 : x < bx1 ? Math.exp(-(x - bx0) / lam) : 0.3);
  const env = (x: number, c: number) => Math.exp(-((x - c) * (x - c)) / (2 * sig * sig));
  const psi = (x: number) => {
    let v = env(x, xc) * Math.sin(k * x - phase);
    if (R > 0 && x < bx0) v += R * env(x, xr) * Math.sin(k * x + phase);
    return tau(x) * A0 * v;
  };
  const mag = (x: number) => {
    let m = env(x, xc);
    if (R > 0 && x < bx0) m += R * env(x, xr);
    return tau(x) * A0 * m;
  };

  // envelope dots
  for (let x = 0; x <= w; x += 7) {
    const m = mag(x);
    if (m < 2) continue;
    const isT = x >= bx1;
    ctx.fillStyle = isT ? accent : `rgba(${INK_RGB},0.3)`;
    ctx.globalAlpha = isT ? 0.4 : 1;
    ctx.beginPath();
    ctx.arc(x, y0 - m, 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y0 + m, 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // main trace: ink up to barrier exit, accent after
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = `rgba(${INK_RGB},0.85)`;
  ctx.beginPath();
  for (let x = 0; x <= bx1; x += 2) {
    const y = y0 - psi(x);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.strokeStyle = accent;
  ctx.beginPath();
  for (let x = Math.floor(bx1); x <= w; x += 2) {
    const y = y0 - psi(x);
    if (x === Math.floor(bx1)) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

export default function TunnelingFigure() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const accent =
      getComputedStyle(document.documentElement).getPropertyValue("--fil-accent").trim() ||
      "#2E45B8";
    let raf = 0;

    const fit = () => {
      const rect = canvas.getBoundingClientRect();
      const d = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * d));
      canvas.height = Math.max(1, Math.round(rect.height * d));
      if (!raf) drawFrame(canvas, accent, STATIC_T);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(canvas);

    drawFrame(canvas, accent, STATIC_T);
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const loop = (t: number) => {
        drawFrame(canvas, accent, t);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="figure-canvas" />;
}
