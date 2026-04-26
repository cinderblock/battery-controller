/**
 * SequenceTimeline — hybrid canvas + HTML interactive sequence editor.
 *
 * Canvas renders: voltage curves, grid, backgrounds, setpoint lines,
 * separators, selection borders, loop brackets, drag overlay.
 *
 * HTML overlays render: editable pill badges for step parameters,
 * estimated duration labels, and exclude-from-count indicators.
 *
 * Tap a block (not a pill) to select. Drag to reorder.
 * Tap a pill to edit its value inline.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { SequenceStep, ExecutableStep, SimPoint } from '../lib/sequence-types.ts';
import {
  simulateStep,
  stepEndVoltage,
  estimateDurationH,
  flattenForTimeline,
  resolveCurrentA,
  parseDurationInput,
  formatMinutes,
} from '../lib/sequence-types.ts';

// ── Props ──────────────────────────────────────────────────────────

interface TimelineProps {
  steps: SequenceStep[];
  selectedPath: number[] | null;
  capacityAh: number;
  onSelectStep: (path: number[]) => void;
  onReorder: (fromPath: number[], toPath: number[]) => void;
  onUpdate: (path: number[], step: SequenceStep) => void;
}

// ── Internal types ─────────────────────────────────────────────────

const DRAG_THRESHOLD = 8;

interface DragInfo {
  sourcePath: number[];
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  isDragging: boolean;
  dropPath: number[] | null;
  label: string;
  color: string;
}

interface BlockLayout {
  topLevelIndex: number;
  path: number[];
  x: number;
  width: number;
  durationH: number;
  step: ExecutableStep;
  loopIndex?: number;
}

interface LoopLayout {
  topLevelIndex: number;
  count: number;
  x: number;
  width: number;
}

interface PillDef {
  position: 'tl' | 'tr' | 'bl' | 'br' | 'center';
  field: string;
  value: number;
  display: string;
  unit: string;
  editable: boolean;
  inputStep: number;
  minWidth: number;
  /** When true, input accepts duration strings like "8h", "30m", "8h 3m" */
  isTime?: boolean;
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

function pathsEqual(a: number[] | null, b: number[] | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

// ── Format helpers ─────────────────────────────────────────────────

function formatDuration(hours: number): string {
  if (hours < 1 / 60) return '<1m';
  if (hours < 1) return `~${Math.round(hours * 60)}m`;
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m > 0 ? `~${h}h${m}m` : `~${h}h`;
}

function formatTimePill(minutes: number): string {
  if (!minutes) return '\u221E';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

// ── Pill definitions per step type ─────────────────────────────────

function getStepPills(step: ExecutableStep, capacityAh: number, durationH: number): PillDef[] {
  switch (step.type) {
    case 'd-cc':
      return [
        {
          position: 'tl', field: 'currentA', value: step.currentA,
          display: step.useCRate ? `${step.currentA}C` : `${Math.round(resolveCurrentA(step, capacityAh))}A`,
          unit: step.useCRate ? 'C' : 'A', editable: true,
          inputStep: step.useCRate ? 0.01 : 1, minWidth: 45,
        },
        {
          position: 'center', field: '_est', value: 0,
          display: formatDuration(durationH),
          unit: '', editable: false, inputStep: 0, minWidth: 55,
        },
        {
          position: 'br', field: 'cutoffV', value: step.cutoffV,
          display: `${step.cutoffV.toFixed(2)}V`,
          unit: 'V', editable: true, inputStep: 0.01, minWidth: 45,
        },
        ...(step.maxTimeMin ? [{
          position: 'bl' as const, field: 'maxTimeMin', value: step.maxTimeMin,
          display: formatTimePill(step.maxTimeMin),
          unit: '', editable: true, inputStep: 1, minWidth: 85, isTime: true,
        }] : []),
      ];

    case 'd-cp':
      return [
        {
          position: 'tl', field: 'powerW', value: step.powerW,
          display: `${step.powerW}W`,
          unit: 'W', editable: true, inputStep: 1, minWidth: 45,
        },
        {
          position: 'center', field: '_est', value: 0,
          display: formatDuration(durationH),
          unit: '', editable: false, inputStep: 0, minWidth: 55,
        },
        {
          position: 'br', field: 'cutoffV', value: step.cutoffV,
          display: `${step.cutoffV.toFixed(2)}V`,
          unit: 'V', editable: true, inputStep: 0.01, minWidth: 45,
        },
        ...(step.maxTimeMin ? [{
          position: 'bl' as const, field: 'maxTimeMin', value: step.maxTimeMin,
          display: formatTimePill(step.maxTimeMin),
          unit: '', editable: true, inputStep: 1, minWidth: 85, isTime: true,
        }] : []),
      ];

    case 'c-cv':
      return [
        {
          position: 'tl', field: 'currentA', value: step.currentA,
          display: step.useCRate ? `${step.currentA}C` : `${Math.round(resolveCurrentA(step, capacityAh))}A`,
          unit: step.useCRate ? 'C' : 'A', editable: true,
          inputStep: step.useCRate ? 0.01 : 1, minWidth: 45,
        },
        {
          position: 'tr', field: 'targetV', value: step.targetV,
          display: `${step.targetV.toFixed(2)}V`,
          unit: 'V', editable: true, inputStep: 0.01, minWidth: 85,
        },
        {
          position: 'center', field: '_est', value: 0,
          display: formatDuration(durationH),
          unit: '', editable: false, inputStep: 0, minWidth: 55,
        },
        ...(step.maxTimeMin ? [{
          position: 'bl' as const, field: 'maxTimeMin', value: step.maxTimeMin,
          display: formatTimePill(step.maxTimeMin),
          unit: '', editable: true, inputStep: 1, minWidth: 85, isTime: true,
        }] : []),
        {
          position: 'br', field: 'cutoffCurrentA', value: step.cutoffCurrentA,
          display: `${step.cutoffCurrentA}A`,
          unit: 'A', editable: true, inputStep: 0.1, minWidth: 85,
        },
      ];

    case 'wait':
      return [{
        position: 'center', field: '_durationMin',
        value: Math.round(step.durationS / 60),
        display: formatTimePill(Math.round(step.durationS / 60)),
        unit: '', editable: true, inputStep: 1, minWidth: 30, isTime: true,
      }];
  }
}

// ── Layout calculation ─────────────────────────────────────────────

function computeLayout(
  steps: SequenceStep[],
  capacityAh: number,
  chartWidth: number,
): { blocks: BlockLayout[]; loops: LoopLayout[] } {
  const blocks: BlockLayout[] = [];
  const loops: LoopLayout[] = [];

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
      path: [...path],
      x,
      width,
      durationH: durations[i],
      step,
      loopIndex: path.length > 1 ? path[0] : undefined,
    });
    x += width;
  }

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

// ── EditablePill sub-component ─────────────────────────────────────

function EditablePill({
  className,
  value,
  display,
  unit,
  color,
  editing,
  inputStep,
  isTime,
  onTap,
  onCommit,
  onCancel,
}: {
  className: string;
  value: number;
  display: string;
  unit: string;
  color: string;
  editing: boolean;
  inputStep: number;
  isTime?: boolean;
  onTap: () => void;
  onCommit: (value: number) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  if (editing) {
    const commitTime = (raw: string) => {
      const parsed = parseDurationInput(raw);
      if (parsed !== null) onCommit(parsed);
      else onCancel();
    };
    const commitNumber = (raw: string) => {
      const v = parseFloat(raw);
      if (isNaN(v)) onCancel();
      else onCommit(v);
    };
    const commit = isTime ? commitTime : commitNumber;

    return (
      <span className={`tl-pill tl-pill-editing ${className}`} style={{ borderColor: color }}>
        <input
          ref={inputRef}
          className="tl-pill-input"
          type={isTime ? 'text' : 'number'}
          inputMode={isTime ? 'text' : 'decimal'}
          defaultValue={isTime ? formatMinutes(value) : value}
          step={isTime ? undefined : inputStep}
          placeholder={isTime ? 'e.g. 8h 30m' : undefined}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit((e.target as HTMLInputElement).value);
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
          }}
          onBlur={e => commit(e.target.value)}
        />
        {unit && <span className="tl-pill-unit">{unit}</span>}
      </span>
    );
  }

  return (
    <button
      className={`tl-pill ${className}`}
      style={{ background: `${color}30`, color }}
      onClick={onTap}
      title={`${display} \u2014 tap to edit`}
    >
      {display}
    </button>
  );
}

// ── Main component ─────────────────────────────────────────────────

export function SequenceTimeline({
  steps, selectedPath, capacityAh, onSelectStep, onReorder, onUpdate,
}: TimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragInfo | null>(null);

  // Container dimensions for HTML positioning
  const [dims, setDims] = useState({ w: 0, h: 0 });

  // Pill editing state
  const [editingPill, setEditingPill] = useState<{ key: string; field: string } | null>(null);

  // Drag source key (for dimming source block's pills)
  const [dragSourceKey, setDragSourceKey] = useState<string | null>(null);

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setDims({ w: width, h: height });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Layout
  const hasLoops = steps.some(s => s.type === 'loop');
  const pad = useMemo(() => ({ t: 24, b: hasLoops ? 44 : 24, l: 6, r: 6 }), [hasLoops]);
  const cw = dims.w - pad.l - pad.r;
  const ch = dims.h - pad.t - pad.b;
  const layout = useMemo(
    () => cw > 0 ? computeLayout(steps, capacityAh, cw) : { blocks: [], loops: [] },
    [steps, capacityAh, cw],
  );
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // Pre-compute simulations for all blocks (used for drawing + hover lookup)
  const PTS_PER_STEP = 60;
  const blockSims = useMemo(() => {
    const sims: SimPoint[][] = [];
    let currentV = 3.35;
    for (const block of layout.blocks) {
      const sim = simulateStep(block.step, currentV, PTS_PER_STEP, capacityAh);
      sims.push(sim);
      currentV = stepEndVoltage(block.step, currentV);
    }
    return sims;
  }, [layout.blocks, capacityAh]);

  // Hover state (ref to avoid re-renders on every mouse move)
  const hoverRef = useRef<{ x: number } | null>(null);

  // ── Canvas draw ──────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { w, h } = dims;
    if (w === 0 || h === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);

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

    // Grid
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    for (let v = 2.5; v <= 3.7; v += 0.2) {
      const y = yV(v);
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + cw, y);
      ctx.stroke();
    }

    // V axis labels
    ctx.fillStyle = COLORS.gridLabel;
    ctx.font = '9px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'right';
    for (let v = 2.5; v <= 3.7; v += 0.3) {
      ctx.fillText(v.toFixed(1), pad.l + cw + pad.r - 1, yV(v) + 3);
    }

    // Draw each block
    for (let bi = 0; bi < layout.blocks.length; bi++) {
      const block = layout.blocks[bi];
      const step = block.step;
      const color = stepColor(step);
      const isSelected = pathsEqual(block.path, selectedPath);
      const isDragSource = dragRef.current?.isDragging && pathsEqual(block.path, dragRef.current.sourcePath);
      const isExcluded = 'excludeFromCount' in step && (step as any).excludeFromCount;

      if (isDragSource) { ctx.save(); ctx.globalAlpha = 0.25; }
      if (isExcluded) { ctx.save(); ctx.globalAlpha = (ctx.globalAlpha ?? 1) * 0.5; }

      // Background shading
      const bgAlpha = isSelected ? COLORS.selectedBg : COLORS.normalBg;
      ctx.fillStyle = `${color}${Math.round(bgAlpha * 255).toString(16).padStart(2, '0')}`;
      ctx.fillRect(pad.l + block.x, pad.t, block.width, ch);

      const sim = blockSims[bi] ?? [];

      // Voltage curve
      ctx.strokeStyle = color;
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.beginPath();
      for (let pi = 0; pi < sim.length; pi++) {
        const x = pad.l + block.x + (pi / (sim.length - 1)) * block.width;
        const y = yV(sim[pi].v);
        pi === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Current line (dashed, dimmer)
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

      // Setpoint level lines (dashed)
      if (step.type === 'd-cc' || step.type === 'd-cp') {
        drawSetpointLine(ctx, pad.l + block.x, pad.l + block.x + block.width, yV(step.cutoffV), color);
      } else if (step.type === 'c-cv') {
        drawSetpointLine(ctx, pad.l + block.x, pad.l + block.x + block.width, yV(step.targetV), color);
      }

      // Separator
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

      // Selection border
      if (isSelected) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.strokeRect(pad.l + block.x + 1, pad.t + 1, block.width - 2, ch - 2);
      }

      if (isExcluded) ctx.restore();
      if (isDragSource) ctx.restore();
    }

    // ── Loop brackets ──────────────────────────────────────────────
    for (const loop of layout.loops) {
      const color = COLORS.loop;
      const bracketY = pad.t + ch + 8;
      const bracketH = 14;
      const lx = pad.l + loop.x;
      const rx = pad.l + loop.x + loop.width;
      const isSelected = selectedPath !== null && selectedPath[0] === loop.topLevelIndex;

      ctx.strokeStyle = color;
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.fillStyle = color;

      // Left bracket
      ctx.beginPath();
      ctx.moveTo(lx + 4, bracketY);
      ctx.lineTo(lx, bracketY);
      ctx.lineTo(lx, bracketY + bracketH);
      ctx.lineTo(lx + 4, bracketY + bracketH);
      ctx.stroke();

      // Right bracket
      ctx.beginPath();
      ctx.moveTo(rx - 4, bracketY);
      ctx.lineTo(rx, bracketY);
      ctx.lineTo(rx, bracketY + bracketH);
      ctx.lineTo(rx - 4, bracketY + bracketH);
      ctx.stroke();

      // Bottom line
      ctx.beginPath();
      ctx.moveTo(lx, bracketY + bracketH);
      ctx.lineTo(rx, bracketY + bracketH);
      ctx.stroke();

      // Count label
      ctx.font = 'bold 11px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`\u00D7${loop.count}`, (lx + rx) / 2, bracketY + bracketH - 2);

    }

    // ── Drag overlay ───────────────────────────────────────────────
    const drag = dragRef.current;
    if (drag?.isDragging && drag.dropPath) {
      const dropX = computeDropX(drag.dropPath, layout.blocks, pad.l);
      if (dropX !== null) {
        ctx.save();
        ctx.strokeStyle = '#4fc3f7';
        ctx.lineWidth = 3;
        ctx.shadowColor = '#4fc3f7';
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.moveTo(dropX, pad.t - 4);
        ctx.lineTo(dropX, pad.t + ch + 4);
        ctx.stroke();
        ctx.fillStyle = '#4fc3f7';
        ctx.beginPath();
        ctx.arc(dropX, pad.t - 4, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(dropX, pad.t + ch + 4, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      drawCanvasPill(ctx, drag.currentX, drag.currentY - 24, drag.label, '#fff', `${drag.color}cc`, 11);
    }

    // ── Hover crosshair ─────────────────────────────────────────────
    const hover = hoverRef.current;
    if (hover && !drag?.isDragging && layout.blocks.length > 0) {
      const localX = hover.x - pad.l;
      // Find which block and interpolation fraction
      for (let bi = 0; bi < layout.blocks.length; bi++) {
        const block = layout.blocks[bi];
        if (localX >= block.x && localX < block.x + block.width) {
          const sim = blockSims[bi];
          if (!sim || sim.length === 0) break;

          // Fraction within this block
          const frac = Math.max(0, Math.min(1, (localX - block.x) / block.width));
          // Interpolate sim point
          const idx = frac * (sim.length - 1);
          const lo = Math.floor(idx);
          const hi = Math.min(lo + 1, sim.length - 1);
          const t = idx - lo;
          const voltage = sim[lo].v + (sim[hi].v - sim[lo].v) * t;
          const current = sim[lo].i + (sim[hi].i - sim[lo].i) * t;
          const power = voltage * current;

          const hx = hover.x;
          const hy = yV(voltage);

          // Vertical crosshair line
          ctx.save();
          ctx.strokeStyle = '#ffffff44';
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(hx, pad.t);
          ctx.lineTo(hx, pad.t + ch);
          ctx.stroke();

          // Horizontal crosshair at voltage
          ctx.beginPath();
          ctx.moveTo(pad.l, hy);
          ctx.lineTo(pad.l + cw, hy);
          ctx.stroke();
          ctx.restore();

          // Dot at intersection
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.arc(hx, hy, 3, 0, Math.PI * 2);
          ctx.fill();

          // Value label
          const label = `${voltage.toFixed(2)}V  ${current.toFixed(1)}A  ${power.toFixed(0)}W`;
          const labelX = hx + 8;
          const labelY = pad.t + 14;
          ctx.font = 'bold 10px SF Mono, Consolas, monospace';
          const tw = ctx.measureText(label).width;

          // Flip label to left side if too close to right edge
          const finalX = (labelX + tw + 6) > (pad.l + cw) ? hx - tw - 14 : labelX;

          ctx.fillStyle = '#000000cc';
          ctx.fillRect(finalX - 4, labelY - 11, tw + 8, 14);
          ctx.fillStyle = '#ffffffdd';
          ctx.textAlign = 'left';
          ctx.fillText(label, finalX, labelY);

          break;
        }
      }
    }
  }, [dims, layout, pad, cw, ch, selectedPath, capacityAh, blockSims]);

  useEffect(() => { draw(); }, [draw]);

  // ── Pointer events on canvas ─────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const localX = x - pad.l;

    const { blocks, loops } = layoutRef.current;

    // Loop brackets
    if (y > dims.h - 44) {
      for (const loop of loops) {
        if (localX >= loop.x && localX <= loop.x + loop.width) {
          onSelectStep([loop.topLevelIndex]);
          return;
        }
      }
    }

    // Block hit-test
    for (const block of blocks) {
      if (localX >= block.x && localX <= block.x + block.width) {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);

        const step = block.step;
        const clr = stepColor(step);
        let label = '';
        if (step.type === 'd-cc') label = `D-CC ${Math.round(resolveCurrentA(step, capacityAh))}A`;
        else if (step.type === 'd-cp') label = `D-CP ${step.powerW}W`;
        else if (step.type === 'c-cv') label = `C-CV ${Math.round(resolveCurrentA(step, capacityAh))}A`;
        else if (step.type === 'wait') label = `Wait ${Math.round(step.durationS / 60)}m`;

        dragRef.current = {
          sourcePath: [...block.path],
          startX: x, startY: y,
          currentX: x, currentY: y,
          isDragging: false,
          dropPath: null,
          label, color: clr,
        };
        return;
      }
    }
  }, [onSelectStep, capacityAh, pad.l, dims.h]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    drag.currentX = e.clientX - rect.left;
    drag.currentY = e.clientY - rect.top;

    if (!drag.isDragging) {
      const dx = drag.currentX - drag.startX;
      const dy = drag.currentY - drag.startY;
      if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
        drag.isDragging = true;
        hoverRef.current = null; // hide crosshair during drag
        setDragSourceKey(drag.sourcePath.join(','));
      } else {
        return;
      }
    }

    const localX = drag.currentX - pad.l;
    drag.dropPath = computeDropPath(localX, layoutRef.current.blocks, drag.sourcePath);
    draw();
  }, [draw, pad.l]);

  const handlePointerUp = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;

    if (drag.isDragging && drag.dropPath) {
      onReorder(drag.sourcePath, drag.dropPath);
    } else if (!drag.isDragging) {
      onSelectStep(drag.sourcePath);
    }

    dragRef.current = null;
    setDragSourceKey(null);
    draw();
  }, [onReorder, onSelectStep, draw]);

  const handlePointerCancel = useCallback(() => {
    dragRef.current = null;
    setDragSourceKey(null);
    draw();
  }, [draw]);

  // ── Hover crosshair tracking ─────────────────────────────────────

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragRef.current) return; // don't show crosshair while dragging
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    hoverRef.current = { x: e.clientX - rect.left };
    draw();
  }, [draw]);

  const handleMouseLeave = useCallback(() => {
    hoverRef.current = null;
    draw();
  }, [draw]);

  // ── Pill commit handler ──────────────────────────────────────────

  const handlePillCommit = useCallback((
    path: number[], field: string, value: number, step: ExecutableStep,
  ) => {
    let updated: SequenceStep;
    if (field === '_durationMin') {
      updated = { ...step, durationS: value * 60 } as SequenceStep;
    } else if (field === 'maxTimeMin' && value <= 0) {
      updated = { ...step, maxTimeMin: undefined } as SequenceStep;
    } else {
      updated = { ...step, [field]: value } as SequenceStep;
    }
    onUpdate(path, updated);
    setEditingPill(null);
  }, [onUpdate]);

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div ref={containerRef} className="seq-timeline-wrap">
      <canvas
        ref={canvasRef}
        className="seq-timeline-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{ touchAction: 'none' }}
      />

      {/* Block overlays with editable pills */}
      {ch > 0 && layout.blocks.map(block => {
        const key = block.path.join(',');
        const isDragSource = dragSourceKey === key;
        const isExcluded = 'excludeFromCount' in block.step && (block.step as any).excludeFromCount;
        const pills = getStepPills(block.step, capacityAh, block.durationH);
        const color = stepColor(block.step);

        return (
          <div
            key={key}
            className={`tl-block${isExcluded ? ' tl-block-excluded' : ''}${isDragSource ? ' tl-block-dragging' : ''}`}
            style={{
              left: pad.l + block.x,
              top: pad.t,
              width: block.width,
              height: ch,
            }}
          >
            {pills.filter(p => block.width >= p.minWidth).map(pill =>
              pill.editable ? (
                <EditablePill
                  key={pill.field}
                  className={`tl-pill-${pill.position}`}
                  value={pill.value}
                  display={pill.display}
                  unit={pill.unit}
                  color={color}
                  editing={editingPill?.key === key && editingPill.field === pill.field}
                  inputStep={pill.inputStep}
                  isTime={pill.isTime}
                  onTap={() => setEditingPill({ key, field: pill.field })}
                  onCommit={v => handlePillCommit(block.path, pill.field, v, block.step)}
                  onCancel={() => setEditingPill(null)}
                />
              ) : (
                <span
                  key={pill.field}
                  className={`tl-pill tl-pill-readonly tl-pill-${pill.position}`}
                  style={{ color: `${color}88` }}
                >
                  {pill.display}
                </span>
              ),
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Drop path computation ──────────────────────────────────────────

function computeDropPath(
  localX: number,
  blocks: BlockLayout[],
  sourcePath: number[],
): number[] | null {
  if (blocks.length === 0) return null;

  if (sourcePath.length > 1) {
    const loopIdx = sourcePath[0];
    const childIdx = sourcePath[1];
    const siblings = blocks.filter(b => b.loopIndex === loopIdx);
    if (siblings.length === 0) return null;

    const bounds: number[] = [];
    bounds.push(siblings[0].x);
    for (let i = 0; i < siblings.length - 1; i++) {
      bounds.push((siblings[i].x + siblings[i].width + siblings[i + 1].x) / 2);
    }
    bounds.push(siblings[siblings.length - 1].x + siblings[siblings.length - 1].width);

    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < bounds.length; i++) {
      const dist = Math.abs(localX - bounds[i]);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }

    const dropChildIdx = bestIdx < siblings.length
      ? siblings[bestIdx].path[1]
      : siblings[siblings.length - 1].path[1] + 1;

    if (dropChildIdx === childIdx || dropChildIdx === childIdx + 1) return null;
    return [loopIdx, dropChildIdx];
  } else {
    const sourceIdx = sourcePath[0];
    const ranges = new Map<number, { x: number; right: number }>();
    for (const b of blocks) {
      const r = ranges.get(b.topLevelIndex);
      if (r) { r.right = Math.max(r.right, b.x + b.width); }
      else { ranges.set(b.topLevelIndex, { x: b.x, right: b.x + b.width }); }
    }
    const sorted = [...ranges.entries()].sort((a, b) => a[1].x - b[1].x);

    const bounds: number[] = [];
    bounds.push(sorted[0][1].x);
    for (let i = 0; i < sorted.length - 1; i++) {
      bounds.push((sorted[i][1].right + sorted[i + 1][1].x) / 2);
    }
    bounds.push(sorted[sorted.length - 1][1].right);

    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < bounds.length; i++) {
      const dist = Math.abs(localX - bounds[i]);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }

    const dropIndex = bestIdx < sorted.length ? sorted[bestIdx][0] : sorted[sorted.length - 1][0] + 1;
    if (dropIndex === sourceIdx || dropIndex === sourceIdx + 1) return null;
    return [dropIndex];
  }
}

function computeDropX(
  dropPath: number[],
  blocks: BlockLayout[],
  padL: number,
): number | null {
  if (dropPath.length === 2) {
    const [loopIdx, childIdx] = dropPath;
    const siblings = blocks.filter(b => b.loopIndex === loopIdx);
    if (siblings.length === 0) return null;
    const target = siblings.find(b => b.path[1] === childIdx);
    if (target) return padL + target.x;
    const last = siblings[siblings.length - 1];
    return padL + last.x + last.width;
  } else {
    const [dropIdx] = dropPath;
    const ranges = new Map<number, { x: number; right: number }>();
    for (const b of blocks) {
      const r = ranges.get(b.topLevelIndex);
      if (r) { r.right = Math.max(r.right, b.x + b.width); }
      else { ranges.set(b.topLevelIndex, { x: b.x, right: b.x + b.width }); }
    }
    const range = ranges.get(dropIdx);
    if (range) return padL + range.x;
    const prevRange = ranges.get(dropIdx - 1);
    return prevRange ? padL + prevRange.right : padL;
  }
}

// ── Canvas helpers ─────────────────────────────────────────────────

function drawSetpointLine(
  ctx: CanvasRenderingContext2D,
  x1: number, x2: number, y: number, color: string,
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

/** Canvas-drawn pill for drag ghost only */
function drawCanvasPill(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, text: string,
  textColor: string, bgColor: string, fontSize = 10,
) {
  ctx.save();
  const font = `bold ${fontSize}px -apple-system, system-ui, sans-serif`;
  ctx.font = font;
  const tw = ctx.measureText(text).width;
  const pw = tw + 10;
  const ph = fontSize + 6;
  const rx = x - pw / 2;
  const ry = y - ph / 2;
  const r = ph / 2;

  ctx.fillStyle = bgColor;
  ctx.beginPath();
  ctx.moveTo(rx + r, ry);
  ctx.arcTo(rx + pw, ry, rx + pw, ry + ph, r);
  ctx.arcTo(rx + pw, ry + ph, rx, ry + ph, r);
  ctx.arcTo(rx, ry + ph, rx, ry, r);
  ctx.arcTo(rx, ry, rx + pw, ry, r);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
  ctx.restore();
}
