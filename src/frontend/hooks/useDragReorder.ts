/**
 * useDragReorder — pointer-event-based drag-and-drop for sequence pills.
 *
 * Supports both mouse and touch (iOS Chrome) via PointerEvent API.
 * Handles:
 * - Reordering existing steps (drag pill to new position)
 * - Inserting new steps (drag from palette)
 * - Moving steps into/out of loop containers
 */

import { useCallback, useRef, useState } from 'react';
import type { SequenceStep, StepPath } from '../lib/sequence-types.ts';

// ── Types ──────────────────────────────────────────────────────────

export interface DragState {
  isDragging: boolean;
  sourcePath: StepPath | null;
  ghostPosition: { x: number; y: number } | null;
  ghostLabel: string | null;
  ghostColor: string | null;
  dropTarget: StepPath | null;
  /** When dragging from palette, the step to insert */
  newStep: SequenceStep | null;
}

const INITIAL_STATE: DragState = {
  isDragging: false,
  sourcePath: null,
  ghostPosition: null,
  ghostLabel: null,
  ghostColor: null,
  dropTarget: null,
  newStep: null,
};

const DRAG_THRESHOLD_PX = 8;
const PRESS_DELAY_MS = 150;

const PILL_COLORS: Record<string, string> = {
  'd-cc': '#fb923c',
  'd-cp': '#ffb74d',
  'c-cv': '#60a5fa',
  wait: '#777',
  loop: '#a78bfa',
};

// ── Hook ───────────────────────────────────────────────────────────

export function useDragReorder(
  steps: SequenceStep[],
  onReorder: (fromPath: StepPath, toPath: StepPath) => void,
  onInsertNew: (step: SequenceStep, atPath: StepPath) => void
) {
  const [dragState, setDragState] = useState<DragState>(INITIAL_STATE);
  const pressRef = useRef<{
    path: StepPath;
    startX: number;
    startY: number;
    label: string;
    color: string;
    timer: ReturnType<typeof setTimeout> | null;
    pointerId: number;
    newStep: SequenceStep | null;
  } | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  // Compute drop target from pointer position
  const computeDropTarget = useCallback((clientX: number, clientY: number): StepPath | null => {
    const bar = barRef.current;
    if (!bar) return null;

    // Find all pill-slot and loop-child-slot elements
    const slots = bar.querySelectorAll('.pill-slot, .loop-child-slot');
    let bestPath: StepPath | null = null;
    let bestDist = Infinity;

    for (const slot of slots) {
      const rect = slot.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;

      // Check if we're vertically within this row
      if (clientY < rect.top - 20 || clientY > rect.bottom + 20) continue;

      // Left side of slot → insert before
      const distLeft = Math.abs(clientX - rect.left);
      if (distLeft < bestDist) {
        bestDist = distLeft;
        // Parse path from slot
        const pathStr = slot.getAttribute('data-path');
        if (pathStr) {
          bestPath = pathStr.split('-').map(Number);
        }
      }

      // Right side of slot → insert after
      const distRight = Math.abs(clientX - rect.right);
      if (distRight < bestDist) {
        bestDist = distRight;
        const pathStr = slot.getAttribute('data-path');
        if (pathStr) {
          const parsed = pathStr.split('-').map(Number);
          parsed[parsed.length - 1]++;
          bestPath = parsed;
        }
      }
    }

    // Also check loop-container drop zones
    const loopContainers = bar.querySelectorAll('.loop-children');
    for (const lc of loopContainers) {
      const rect = lc.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
        // We're inside a loop container
        const parentSlot = lc.closest('.pill-slot');
        const parentPath = parentSlot?.getAttribute('data-path');
        if (parentPath) {
          const parentIdx = parseInt(parentPath, 10);
          const children = lc.querySelectorAll(':scope > .loop-child-slot');
          if (children.length === 0) {
            // Empty loop: drop at [parentIdx, 0]
            return [parentIdx, 0];
          }
        }
      }
    }

    return bestPath;
  }, []);

  // Start a drag (from existing pill)
  const startDrag = useCallback(
    (
      path: StepPath,
      label: string,
      color: string,
      x: number,
      y: number,
      pointerId: number,
      newStep: SequenceStep | null = null
    ) => {
      pressRef.current = { path, startX: x, startY: y, label, color, timer: null, pointerId, newStep };

      // Start press timer — after delay, even small moves count as drag
      pressRef.current.timer = setTimeout(() => {
        if (pressRef.current) {
          pressRef.current.timer = null;
        }
      }, PRESS_DELAY_MS);
    },
    []
  );

  const onPointerDown = useCallback(
    (path: StepPath, label: string, color: string, e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      startDrag(path, label, color, e.clientX, e.clientY, e.pointerId);
    },
    [startDrag]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const press = pressRef.current;
      if (!press) return;

      const dx = e.clientX - press.startX;
      const dy = e.clientY - press.startY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (!dragState.isDragging) {
        // Check if we've moved enough to start dragging
        if (dist > DRAG_THRESHOLD_PX) {
          setDragState({
            isDragging: true,
            sourcePath: press.newStep ? null : press.path,
            ghostPosition: { x: e.clientX, y: e.clientY },
            ghostLabel: press.label,
            ghostColor: press.color,
            dropTarget: null,
            newStep: press.newStep,
          });
        }
      } else {
        // Update ghost position and compute drop target
        const dropTarget = computeDropTarget(e.clientX, e.clientY);
        setDragState(prev => ({
          ...prev,
          ghostPosition: { x: e.clientX, y: e.clientY },
          dropTarget,
        }));
      }
    },
    [dragState.isDragging, computeDropTarget]
  );

  const onPointerUp = useCallback(() => {
    const press = pressRef.current;
    if (!press) return;

    if (press.timer) {
      clearTimeout(press.timer);
    }

    if (dragState.isDragging && dragState.dropTarget) {
      if (dragState.newStep) {
        // Inserting a new step from palette
        onInsertNew(dragState.newStep, dragState.dropTarget);
      } else if (dragState.sourcePath) {
        // Reordering an existing step
        onReorder(dragState.sourcePath, dragState.dropTarget);
      }
    }

    pressRef.current = null;
    setDragState(INITIAL_STATE);
  }, [dragState, onReorder, onInsertNew]);

  const cancelDrag = useCallback(() => {
    if (pressRef.current?.timer) {
      clearTimeout(pressRef.current.timer);
    }
    pressRef.current = null;
    setDragState(INITIAL_STATE);
  }, []);

  // Generate drag props for a pill at a given path
  const dragPropsForPath = useCallback(
    (path: StepPath): Record<string, any> => {
      const step = getStepByPath(steps, path);
      if (!step) return {};
      const label = pillLabelForDrag(step);
      const color = PILL_COLORS[step.type] ?? '#888';

      return {
        onPointerDown: (e: React.PointerEvent) => onPointerDown(path, label, color, e),
        'data-path': path.join('-'),
        style: { touchAction: 'none' },
      };
    },
    [steps, onPointerDown]
  );

  // Start drag from palette (new step)
  const startPaletteDrag = useCallback(
    (step: SequenceStep, label: string, color: string, e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      pressRef.current = {
        path: [steps.length], // tentative insert at end
        startX: e.clientX,
        startY: e.clientY,
        label,
        color,
        timer: null,
        pointerId: e.pointerId,
        newStep: step,
      };
    },
    [steps.length]
  );

  const barProps = {
    onPointerMove,
    onPointerUp,
    onPointerLeave: cancelDrag,
    ref: (el: HTMLDivElement | null) => {
      barRef.current = el;
    },
  };

  return { dragState, dragPropsForPath, startPaletteDrag, barProps };
}

// ── Helpers ────────────────────────────────────────────────────────

function getStepByPath(steps: SequenceStep[], path: StepPath): SequenceStep | undefined {
  if (path.length === 0) return undefined;
  const step = steps[path[0]];
  if (path.length === 1) return step;
  if (step?.type === 'loop') return getStepByPath(step.children, path.slice(1));
  return undefined;
}

function pillLabelForDrag(step: SequenceStep): string {
  switch (step.type) {
    case 'd-cc':
      return `DCC ${step.currentA}A`;
    case 'd-cp':
      return `DCP ${step.powerW}W`;
    case 'c-cv':
      return `CCV ${step.currentA}A`;
    case 'wait':
      return `Wait ${Math.round(step.durationS / 60)}m`;
    case 'loop':
      return `Loop \u00D7${step.count}`;
  }
}
