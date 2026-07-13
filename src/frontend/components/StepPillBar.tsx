/**
 * StepPillBar — horizontal scrollable strip of sequence step pills.
 *
 * Renders steps as compact pills flowing left-to-right.
 * Loop steps render as LoopContainers wrapping their children.
 * Supports drag-and-drop reordering via pointer events.
 */

import { useEffect, useRef } from 'react';
import type { DragState } from '../hooks/useDragReorder.ts';
import type { SequenceStep, StepPath } from '../lib/sequence-types.ts';
import { LoopContainer } from './LoopContainer.tsx';
import { StepPill } from './StepPill.tsx';

// ── Props ──────────────────────────────────────────────────────────

interface StepPillBarProps {
  steps: SequenceStep[];
  selectedPath: StepPath | null;
  capacityAh: number;
  onSelect: (path: StepPath) => void;
  dragState: DragState;
  dragPropsForPath: (path: StepPath) => Record<string, any>;
  barProps: Record<string, any>;
}

function pathsEqual(a: StepPath | null, b: StepPath | null): boolean {
  if (!a || !b) return false;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ── Component ──────────────────────────────────────────────────────

export function StepPillBar({
  steps,
  selectedPath,
  capacityAh,
  onSelect,
  dragState,
  dragPropsForPath,
  barProps,
}: StepPillBarProps) {
  const barRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to keep selected pill visible
  useEffect(() => {
    if (!selectedPath || !barRef.current) return;
    const idx = selectedPath[0];
    const child = barRef.current.children[idx] as HTMLElement | undefined;
    child?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [selectedPath]);

  return (
    <div className="pill-bar" ref={barRef} {...barProps}>
      {steps.length === 0 && <div className="pill-bar-empty">Add or drag steps to build a sequence</div>}
      {steps.map((step, i) => {
        const stepPath: StepPath = [i];
        const isBeforeDrop = pathsEqual(dragState.dropTarget, stepPath);

        return (
          <div key={i} className="pill-slot">
            {isBeforeDrop && <div className="drop-indicator" />}
            {step.type === 'loop' ? (
              <LoopContainer
                step={step}
                path={stepPath}
                selectedPath={selectedPath}
                capacityAh={capacityAh}
                onSelect={onSelect}
                dragPropsForPath={dragPropsForPath}
                draggingPath={dragState.sourcePath}
                dropIndicatorPath={dragState.dropTarget}
              />
            ) : (
              <StepPill
                step={step}
                path={stepPath}
                selected={pathsEqual(selectedPath, stepPath)}
                capacityAh={capacityAh}
                onSelect={onSelect}
                dragProps={dragPropsForPath(stepPath)}
                isDragging={pathsEqual(dragState.sourcePath, stepPath)}
              />
            )}
          </div>
        );
      })}
      {/* Drop indicator at end of list */}
      {pathsEqual(dragState.dropTarget, [steps.length]) && <div className="drop-indicator" />}

      {/* Drag ghost */}
      {dragState.isDragging && dragState.ghostLabel && (
        <div
          className="drag-ghost"
          style={{
            left: dragState.ghostPosition?.x ?? 0,
            top: dragState.ghostPosition?.y ?? 0,
          }}
        >
          <span className="step-pill-dot" style={{ background: dragState.ghostColor ?? '#888' }} />
          <span className="step-pill-label">{dragState.ghostLabel}</span>
        </div>
      )}
    </div>
  );
}
