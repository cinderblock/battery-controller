/**
 * SequenceTimeline — canvas-rendered visual preview of a sequence.
 *
 * Shows simulated voltage curves for each step flowing left-to-right.
 * Loop steps are rendered as a bracket/arc below the timeline with "×N",
 * NOT as repeated blocks.
 *
 * Setpoint values (current, cutoff V, target V) are annotated on each block.
 * Tap a block to select the corresponding step.
 */

import { useRef, useEffect, useCallback } from 'react';
import type {
  SequenceStep,
  ExecutableStep,
} from '../lib/sequence-types.ts';
import {
  simulateStep,
  stepEndVoltage,
  estimateDurationH,
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
  dcc: '#fb923c',     // orange
  dcp: '#ffb74d',     // lighter orange
  ccv: '#60a5fa',     // blue
  wait: '#666',
  loop: '#a78bfa',    // purple
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
  stepIndex: number;
  x: number;
  width: number;
  durationH: number;
}

interface LoopLayout {
  stepIndex: number;
  step: SequenceStep & { type: 'loop' };
  /** X start of the first covered block */
  x: number;
  /** Total width spanning all covered blocks */
  width: number;
}

function computeLayout(
  steps: SequenceStep[],
  capacityAh: number,
  chartWidth: number,
): { blocks: BlockLayout[]; loops: LoopLayout[] } {
  const blocks: BlockLayout[] = [];
  const loops: LoopLayout[] = [];

  // Compute durations for executable steps only
  const durations: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    durations.push(s.type === 'loop' ? 0 : estimateDurationH(s, capacityAh));
  }

  const totalDuration = durations.reduce((a, b) => a + b, 0);
  if (totalDuration <= 0) return { blocks, loops };

  let x = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.type === 'loop') {
      // Don't render a block — compute span later
      continue;
    }
    const width = (durations[i] / totalDuration) * chartWidth;
    blocks.push({ stepIndex: i, x, width, durationH: durations[i] });
    x += width;
  }

  // Compute loop layouts
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.type !== 'loop') continue;
    // Find the blocks that this loop covers
    const coveredBlocks = blocks.filter(
      b => b.stepIndex >= step.startIndex && b.stepIndex <= step.endIndex
    );
    if (coveredBlocks.length === 0) continue;
    const first = coveredBlocks[0];
    const last = coveredBlocks[coveredBlocks.length - 1];
    loops.push({
      stepIndex: i,
      step,
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
    let currentV = 3.35; // Start at ~full OCV
    const PTS_PER_STEP = 60;

    for (const block of layout.blocks) {
      const step = steps[block.stepIndex] as ExecutableStep;
      const color = stepColor(step);
      const isSelected = block.stepIndex === selectedIndex;

      // Background shading
      const bgAlpha = isSelected ? COLORS.selectedBg : COLORS.normalBg;
      ctx.fillStyle = `${color}${Math.round(bgAlpha * 255).toString(16).padStart(2, '0')}`;
      ctx.fillRect(pad.l + block.x, pad.t, block.width, ch);

      // Simulate voltage curve
      const sim = simulateStep(step, currentV, PTS_PER_STEP);

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

        // Scale current to chart range (0–50A mapped to bottom–top)
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

      // Setpoint annotations inside the block
      ctx.textAlign = 'center';
      const centerX = pad.l + block.x + block.width / 2;

      // Top label: step type + current/power
      ctx.fillStyle = color;
      ctx.font = 'bold 10px -apple-system, system-ui, sans-serif';
      let topLabel = '';
      if (step.type === 'd-cc') topLabel = `D-CC ${step.currentA}A`;
      else if (step.type === 'd-cp') topLabel = `D-CP ${step.powerW}W`;
      else if (step.type === 'c-cv') topLabel = `C-CV ${step.currentA}A`;
      else if (step.type === 'wait') topLabel = `Wait ${Math.round(step.durationS / 60)}m`;

      if (block.width > 40) {
        ctx.fillText(topLabel, centerX, pad.t + 12);
      }

      // Bottom label: cutoff/target voltage
      ctx.font = '9px -apple-system, system-ui, sans-serif';
      ctx.fillStyle = `${color}99`;
      let bottomLabel = '';
      if (step.type === 'd-cc' || step.type === 'd-cp') bottomLabel = `→${step.cutoffV.toFixed(2)}V`;
      else if (step.type === 'c-cv') bottomLabel = `→${step.targetV.toFixed(2)}V`;

      if (bottomLabel && block.width > 35) {
        ctx.fillText(bottomLabel, centerX, pad.t + ch - 4);
      }

      // Dashed setpoint level lines
      if (step.type === 'd-cc' || step.type === 'd-cp') {
        // Cutoff voltage horizontal line
        drawSetpointLine(ctx, pad.l + block.x, pad.l + block.x + block.width, yV(step.cutoffV), color);
      } else if (step.type === 'c-cv') {
        // Target voltage horizontal line
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
      const isSelected = loop.stepIndex === selectedIndex;

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

      // "×N" label centered
      ctx.font = 'bold 11px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`×${loop.step.count}`, (lx + rx) / 2, bracketY + bracketH - 2);

      // Return arrow (small curved arrow from right back to left)
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

  // Draw on mount and when data changes
  useEffect(() => {
    draw();
  }, [draw]);

  // Resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(container);
    return () => observer.disconnect();
  }, [draw]);

  // Click handler — map click position to step index
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const pad = { l: 6, r: 6, t: 20 };
    const localX = clickX - pad.l;

    const { blocks, loops } = layoutRef.current;

    // Check if click is on a loop bracket (lower area)
    const h = rect.height;
    if (clickY > h - 42) {
      for (const loop of loops) {
        if (localX >= loop.x && localX <= loop.x + loop.width) {
          onSelectStep(loop.stepIndex);
          return;
        }
      }
    }

    // Otherwise, find which block was clicked
    for (const block of blocks) {
      if (localX >= block.x && localX <= block.x + block.width) {
        onSelectStep(block.stepIndex);
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
