/**
 * Server-side IR estimation entry point.
 *
 * The pure estimator lives in src/shared/ir-estimate.ts (also consumed by
 * the frontend for the running-mΩ chart trace); this module re-exports it
 * and adds the DB-backed one-time backfills.
 */

import { estimateHeatMwh, estimateIrMohm } from '../shared/ir-estimate.ts';
import { logger } from '../utils/logger.ts';
import {
  getDataPointsForRun,
  getRunsNeedingHeat,
  getRunsNeedingIr,
  getSetting,
  setRunHeatMwh,
  setRunIrMohm,
  setSetting,
} from './db.ts';

export {
  estimateHeatMwh,
  estimateIrMohm,
  estimateIrSamples,
  type IrEstimate,
  type IrPoint,
  type IrSample,
  MAX_STEP_DT_S,
  MIN_STEP_A,
  modeSupportsIr,
} from '../shared/ir-estimate.ts';

const BACKFILL_KEY = 'ir_backfill_v1';
const HEAT_BACKFILL_KEY = 'heat_backfill_v1';

/**
 * One-time backfill: compute IR for runs recorded before the ir_mohm column
 * existed. Guarded by a settings flag so historical runs with no usable
 * current step (stored as 0) aren't rescanned on every boot.
 */
export function backfillIrEstimates(): void {
  if (getSetting(BACKFILL_KEY) !== '1') {
    const runs = getRunsNeedingIr();
    let estimated = 0;
    for (const run of runs) {
      const ir = estimateIrMohm(getDataPointsForRun(run.id), run.mode);
      setRunIrMohm(run.id, ir?.mohm ?? 0);
      if (ir) estimated++;
    }
    setSetting(BACKFILL_KEY, '1');
    if (runs.length > 0) {
      logger.info(`IR backfill: estimated ${estimated} of ${runs.length} historical run(s)`);
    }
  }

  if (getSetting(HEAT_BACKFILL_KEY) !== '1') {
    const runs = getRunsNeedingHeat();
    let estimated = 0;
    for (const run of runs) {
      const heat = estimateHeatMwh(getDataPointsForRun(run.id), run.ir_mohm ?? 0);
      setRunHeatMwh(run.id, heat ?? 0);
      if (heat !== null) estimated++;
    }
    setSetting(HEAT_BACKFILL_KEY, '1');
    if (runs.length > 0) {
      logger.info(`Heat backfill: estimated ${estimated} of ${runs.length} historical run(s)`);
    }
  }
}
