/**
 * LoopContainer — visual wrapper that groups looped steps in the pill bar.
 *
 * Renders a purple-bordered container around the loop's child pills,
 * with a header showing "Loop x{count}". Supports drag-and-drop
 * of steps into/out of the loop.
 */

import type { StepLoop, StepPath } from '../lib/sequence-types.ts';
import { StepPill } from './StepPill.tsx';

// ── Props ──────────────────────────────────────────────────────────

interface LoopContainerProps {
  step: StepLoop;
  path: StepPath;
  selectedPath: StepPath | null;
  capacityAh: number;
  onSelect: (path: StepPath) => void;
  dragPropsForPath?: (path: StepPath) => Record<string, any>;
  draggingPath?: StepPath | null;
  dropIndicatorPath?: StepPath | null;
}

function pathsEqual(a: StepPath | null, b: StepPath | null): boolean {
  if (!a || !b) return false;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ── Component ──────────────────────────────────────────────────────

export function LoopContainer({
  step,
  path,
  selectedPath,
  capacityAh,
  onSelect,
  dragPropsForPath,
  draggingPath,
  dropIndicatorPath,
}: LoopContainerProps) {
  const isLoopSelected = pathsEqual(selectedPath, path);
  const parentIndex = path[0];

  return (
    <div className={`loop-container ${isLoopSelected ? 'loop-container-selected' : ''}`}>
      <div
        className="loop-header"
        onClick={e => {
          e.stopPropagation();
          onSelect(path);
        }}
      >
        <span className="loop-icon">{'\u27F3'}</span>
        <span>Loop \u00D7{step.count}</span>
      </div>
      <div className="loop-children">
        {step.children.length === 0 && <div className="loop-empty">Drop steps here</div>}
        {step.children.map((child, i) => {
          const childPath: StepPath = [parentIndex, i];
          const isBeforeDrop = pathsEqual(dropIndicatorPath, childPath);

          return (
            <div key={i} className="loop-child-slot">
              {isBeforeDrop && <div className="drop-indicator" />}
              {child.type === 'loop' ? (
                <LoopContainer
                  step={child}
                  path={childPath}
                  selectedPath={selectedPath}
                  capacityAh={capacityAh}
                  onSelect={onSelect}
                  dragPropsForPath={dragPropsForPath}
                  draggingPath={draggingPath}
                  dropIndicatorPath={dropIndicatorPath}
                />
              ) : (
                <StepPill
                  step={child}
                  path={childPath}
                  selected={pathsEqual(selectedPath, childPath)}
                  capacityAh={capacityAh}
                  onSelect={onSelect}
                  dragProps={dragPropsForPath?.(childPath)}
                  isDragging={pathsEqual(draggingPath, childPath)}
                />
              )}
            </div>
          );
        })}
        {/* Drop indicator at end of loop children */}
        {pathsEqual(dropIndicatorPath, [parentIndex, step.children.length]) && <div className="drop-indicator" />}
      </div>
    </div>
  );
}
