/**
 * Temperature rate (dT/dt) estimator.
 *
 * 2-state Kalman filter with state [temperature (°C), rate (°C/s)] and a
 * continuous white-noise-acceleration process model. This is the standard
 * optimal linear estimator for a smoothly-varying rate observed through a
 * noisy sensor, and it handles irregular sample intervals naturally — the
 * covariance propagation uses the actual dt of each sample.
 *
 * Raw finite differences of DS18B20 readings are useless for this: 12-bit
 * resolution is 0.0625 °C, so a 10 s difference has ~0.5 °C/min of
 * quantization noise — larger than the signals we care about. The filter's
 * defaults smooth over roughly the last 1–2 minutes of samples, giving a
 * noise floor well under 0.1 °C/min while still tracking a real ramp within
 * a couple of minutes.
 */
export class TempRateFilter {
  // State estimate
  private t = 0; // °C
  private r = 0; // °C/s
  // Covariance (symmetric 2×2: [[p00, p01], [p01, p11]])
  private p00 = 0;
  private p01 = 0;
  private p11 = 0;
  private lastSampleMs: number | null = null;

  constructor(
    /** Measurement noise std dev (°C). DS18B20 12-bit quantization ≈ 0.0625 °C. */
    private readonly measStdC = 0.08,
    /** Rate random-walk PSD q (°C²/s³). Larger = faster response, noisier rate. */
    private readonly q = 1e-7,
    /** Reset the filter when the gap between samples exceeds this (ms). */
    private readonly maxGapMs = 120_000
  ) {}

  /**
   * Feed one temperature sample.
   * @returns Current filtered rate estimate in °C/min.
   */
  update(tempC: number, nowMs: number): number {
    const last = this.lastSampleMs;
    if (last === null || nowMs <= last || nowMs - last > this.maxGapMs) {
      // (Re)initialize: temperature known from the sample, rate unknown.
      this.t = tempC;
      this.r = 0;
      this.p00 = this.measStdC * this.measStdC;
      this.p01 = 0;
      this.p11 = 1e-4; // generous initial rate variance (≈ 0.6 °C/min std)
      this.lastSampleMs = nowMs;
      return 0;
    }

    const dt = (nowMs - last) / 1000;
    this.lastSampleMs = nowMs;

    // Predict: T ← T + r·dt, with CWNA process noise
    this.t += this.r * dt;
    const dt2 = dt * dt;
    this.p00 += 2 * this.p01 * dt + this.p11 * dt2 + (this.q * dt2 * dt) / 3;
    this.p01 += this.p11 * dt + (this.q * dt2) / 2;
    this.p11 += this.q * dt;

    // Update with the measurement z = T + noise
    const s = this.p00 + this.measStdC * this.measStdC;
    const k0 = this.p00 / s;
    const k1 = this.p01 / s;
    const innovation = tempC - this.t;
    this.t += k0 * innovation;
    this.r += k1 * innovation;
    const p00 = this.p00;
    const p01 = this.p01;
    this.p00 = (1 - k0) * p00;
    this.p01 = (1 - k0) * p01;
    this.p11 -= k1 * p01;

    return this.rateCPerMin;
  }

  /** Filtered temperature estimate (°C) */
  get temperatureC(): number {
    return this.t;
  }

  /** Filtered rate estimate (°C/min) */
  get rateCPerMin(): number {
    return this.r * 60;
  }
}
