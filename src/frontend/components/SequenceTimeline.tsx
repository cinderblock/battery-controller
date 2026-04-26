/**
 * SequenceTimeline — canvas-rendered visual preview of a sequence.
 *
 * Shows simulated voltage curves for each step flowing left-to-right.
 * Loop steps are rendered as a bracket/arc below the timeline with "xN",
 * showing one iteration of the loop's children.
 *
 * Setpoint values (current, cutoff V, target V) are annotated on each block.
 * Tap a block to select the corresponding step.
 */

import { useRef, useEffect, useCallback } from 'react';
import type { SequenceStep, ExecutableStep } from '../lib/sequence-types.ts';
import {
  simulateStep,
  stepEndVoltage,
  estimateDurationH,
  flattenForTimeline,
  resolveCurrentA,
} from '../lib/sequence-types.ts';

// ── Props ──────────────────────────────────────────────────────────

interface TimelineProps {
  steps: SequenceStep[];
  selectedIndex: number | null;
  capacityAh: number;
  onSelectStep: (index: number) => void;
}

// ── Colors ─────────────────────────────────────────────────────────

const COLORS = {
  bg: '#0a0a0a',
  grid: '#1a1a1a',
  gridLabel: '#333',
  dcc: '#fb923c',
  dcp: '#ffb74d',
  ccv: '#60a5fa',
  wait: '#666',
  loop: '#a78bfa',
  separator: '#2a2a2a',
  text: '#888',
  selectedBg: 0.12,
  normalBg: 0.05,
};

function stepColor(step: SequenceStep): string {
  switch (step.type) {
    case 'd-cc': return COLORS.dcc;
    case 'd-cp': return COLORS.dcp;
    case 'c-cv': return COLORS.ccv;
    case 'wait': return COLORS.wait;
    case 'loop': return COLORS.loop;
  }
}

// ── Layout calculation ─────────────────────────────────────────────

interface BlockLayout {
  /** Top-level step index (for selection mapping) */
  topLevelIndex: number;
  x: number;
  width: number;
  durationH: number;
  step: ExecutableStep;
  /** If inside a loop, the loop's top-level index */
  loopIndex?: number;
}

interface LoopLayout {
  topLevelIndex: number;
  count: number;
  x: number;
  width: number;
}

function computeLayout(
  steps: SequenceStep[],
  capacityAh: number,
  chartWidth: number,
): { blocks: BlockLayout[]; loops: LoopLayout[] } {
  const blocks: BlockLayout[] = [];
  const loops: LoopLayout[] = [];

  // Flatten for display (one iteration of loops)
  const flat = flattenForTimeline(steps);
  const durations = flat.map(f => estimateDurationH(f.step, capacityAh));
  const totalDuration = durations.reduce((a, b) => a + b, 0);
  if (totalDuration <= 0) return { blocks, loops };

  let x = 0;
  for (let i = 0; i < flat.length; i++) {
    const { step, path } = flat[i];
    const width = (durations[i] / totalDuration) * chartWidth;
    const topLevelIndex = path[0];
    blocks.push({
      topLevelIndex,
      x,
      width,
      durationH: durations[i],
      step,
      loopIndex: path.length > 1 ? path[0] : undefined,
    });
    x += width;
  }

  // Compute loop layouts from blocks that share a loopIndex
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.type !== 'loop') continue;
    const loopBlocks = blocks.filter(b => b.loopIndex === i);
    if (loopBlocks.length === 0) continue;
    const first = loopBlocks[0];
    const last = loopBlocks[loopBlocks.length - 1];
    loops.push({
      topLevelIndex: i,
      count: s.count,
      x: first.x,
      width: (last.x + last.width) - first.x,
    });
  }

  return { blocks, loops };
}

// ── Component ──────────────────────────────────────────────────────

export function SequenceTimeline({ steps, selectedIndex, capacityAh, onSelectStep }: TimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<{ blocks: BlockLayout[]; loops: LoopLayout[] }>({ blocks: [], loops: [] });

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const w = container.clientWidth;
    const h = container.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Padding
    const hasLoops = steps.some(s => s.type === 'loop');
    const pad = { t: 20, b: hasLoops ? 42 : 24, l: 6, r: 6 };
    const cw = w - pad.l - pad.r;
    const ch = h - pad.t - pad.b;

    // Background
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);

    const layout = computeLayout(steps, capacityAh, cw);
    layoutRef.current = layout;

    if (layout.blocks.length === 0) {
      ctx.fillStyle = COLORS.text;
      ctx.font = '14px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Add steps to preview the sequence', w / 2, h / 2);
      return;
    }

    // Voltage range
    const vMin = 2.2;
    const vMax = 3.85;
    const yV = (v: number) => pad.t + (1 - (v - vMin) / (vMax - vMin)) * ch;

    // Grid lines
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    for (let v = 2.5; v <= 3.7; v += 0.2) {
      const y = yV(v);
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + cw, y);
      ctx.stroke();
    }

    // V axis labels (right side)
    ctx.fillStyle = COLORS.gridLabel;
    ctx.font = '9px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'right';
    for (let v = 2.5; v <= 3.7; v += 0.3) {
      ctx.fillText(v.toFixed(1), pad.l + cw + pad.r - 1, yV(v) + 3);
    }

    // Draw each step block
    let currentV = 3.35;
    const PTS_PER_STEP = 60;

    for (const block of layout.blocks) {
      const step = block.step;
      const color = stepColor(step);
      const isSelected = block.topLevelIndex === selectedIndex;

      // Background shading
      const bgAlpha = isSelected ? COLORS.selectedBg : COLORS.normalBg;
      ctx.fillStyle = `${color}${Math.round(bgAlpha * 255).toString(16).padStart(2, '0')}`;
      ctx.fillRect(pad.l + block.x, pad.t, block.width, ch);

      // Simulate voltage curve
      const sim = simulateStep(step, currentV, PTS_PER_STEP, capacityAh);

      // Draw voltage curve
      ctx.strokeStyle = color;
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.beginPath();
      for (let pi = 0; pi < sim.length; pi++) {
        const x = pad.l + block.x + (pi / (sim.length - 1)) * block.width;
        const y = yV(sim[pi].v);
        pi === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Draw current line (dashed, dimmer) if enough width
      if (block.width > 30 && step.type !== 'wait') {
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);

        const iMax = 50;
        const yI = (a: number) => pad.t + ch - (a / iMax) * ch;

        ctx.beginPath();
        for (let pi = 0; pi < sim.length; pi++) {
          const x = pad.l + block.x + (pi / (sim.length - 1)) * block.width;
          const y = yI(sim[pi].i);
          pi === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
      }

      // Setpoint annotations
      ctx.textAlign = 'center';
      const centerX = pad.l + block.x + block.width / 2;

      ctx.fillStyle = color;
      ctx.font = 'bold 10px -apple-system, system-ui, sans-serif';
      let topLabel = '';
      if (step.type === 'd-cc') {
        const amps = resolveCurrentA(step, capacityAh);
        topLabel = `D-CC ${amps.toFixed(0)}A`;
      } else if (step.type === 'd-cp') topLabel = `D-CP ${step.powerW}W`;
      else if (step.type === 'c-cv') {
        const amps = resolveCurrentA(step, capacityAh);
        topLabel = `C-CV ${amps.toFixed(0)}A`;
      } else if (step.type === 'wait') topLabel = `Wait ${Math.round(step.durationS / 60)}m`;

      if (block.width > 40) {
        ctx.fillText(topLabel, centerX, pad.t + 12);
      }

      ctx.font = '9px -apple-system, system-ui, sans-serif';
      ctx.fillStyle = `${color}99`;
      let bottomLabel = '';
      if (step.type === 'd-cc' || step.type === 'd-cp') bottomLabel = `\u2192${step.cutoffV.toFixed(2)}V`;
      else if (step.type === 'c-cv') bottomLabel = `\u2192${step.targetV.toFixed(2)}V`;

      if (bottomLabel && block.width > 35) {
        ctx.fillText(bottomLabel, centerX, pad.t + ch - 4);
      }

      // Dashed setpoint level lines
      if (step.type === 'd-cc' || step.type === 'd-cp') {
        drawSetpointLine(ctx, pad.l + block.x, pad.l + block.x + block.width, yV(step.cutoffV), color);
      } else if (step.type === 'c-cv') {
        drawSetpointLine(ctx, pad.l + block.x, pad.l + block.x + block.width, yV(step.targetV), color);
      }

      // Step separator
      if (block !== layout.blocks[layout.blocks.length - 1]) {
        ctx.strokeStyle = COLORS.separator;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        const sepX = pad.l + block.x + block.width;
        ctx.moveTo(sepX, pad.t);
        ctx.lineTo(sepX, pad.t + ch);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Selection highlight border
      if (isSelected) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.strokeRect(pad.l + block.x + 1, pad.t + 1, block.width - 2, ch - 2);
      }

      currentV = stepEndVoltage(step, currentV);
    }

    // ── Draw loop brackets ───────────────────────────────────────
    for (const loop of layout.loops) {
      const color = COLORS.loop;
      const bracketY = pad.t + ch + 8;
      const bracketH = 14;
      const lx = pad.l + loop.x;
      const rx = pad.l + loop.x + loop.width;
      const isSelected = loop.topLevelIndex === selectedIndex;

      ctx.strokeStyle = color;
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.fillStyle = color;

      // Left bracket arm
      ctx.beginPath();
      ctx.moveTo(lx + 4, bracketY);
      ctx.lineTo(lx, bracketY);
      ctx.lineTo(lx, bracketY + bracketH);
      ctx.lineTo(lx + 4, bracketY + bracketH);
      ctx.stroke();

      // Right bracket arm
      ctx.beginPath();
      ctx.moveTo(rx - 4, bracketY);
      ctx.lineTo(rx, bracketY);
      ctx.lineTo(rx, bracketY + bracketH);
      ctx.lineTo(rx - 4, bracketY + bracketH);
      ctx.stroke();

      // Bottom connecting line
      ctx.beginPath();
      ctx.moveTo(lx, bracketY + bracketH);
      ctx.lineTo(rx, bracketY + bracketH);
      ctx.stroke();

      // "xN" label centered
      ctx.font = 'bold 11px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`\u00D7${loop.count}`, (lx + rx) / 2, bracketY + bracketH - 2);

      // Return arrow
      const arrowY = bracketY + bracketH + 2;
      ctx.beginPath();
      ctx.strokeStyle = `${color}88`;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.moveTo(rx - 8, arrowY);
      ctx.quadraticCurveTo((lx + rx) / 2, arrowY + 6, lx + 8, arrowY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Arrow head
      ctx.fillStyle = `${color}88`;
      ctx.beginPath();
      ctx.moveTo(lx + 8, arrowY);
      ctx.lineTo(lx + 13, arrowY - 3);
      ctx.lineTo(lx + 13, arrowY + 3);
      ctx.closePath();
      ctx.fill();
    }
  }, [steps, selectedIndex, capacityAh]);

  useEffect(() => { draw(); }, [draw]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(container);
    return () => observer.disconnect();
  }, [draw]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const pad = { l: 6, t: 20 };
    const localX = clickX - pad.l;

    const { blocks, loops } = layoutRef.current;

    // Check loop brackets
    if (clickY > rect.height - 42) {
      for (const loop of loops) {
        if (localX >= loop.x && localX <= loop.x + loop.width) {
          onSelectStep(loop.topLevelIndex);
          return;
        }
      }
    }

    // Find which block was clicked
    for (const block of blocks) {
      if (localX >= block.x && localX <= block.x + block.width) {
        onSelectStep(block.topLevelIndex);
        return;
      }
    }
  }, [onSelectStep]);

  return (
    <div ref={containerRef} className="seq-timeline-wrap">
      <canvas ref={canvasRef} className="seq-timeline-canvas" onClick={handleClick} />
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

function drawSetpointLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  x2: number,
  y: number,
  color: string,
) {
  ctx.save();
  ctx.strokeStyle = `${color}44`;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
  ctx.restore();
}
