/**
 * Apply ffmpeg-style -vf filter strings using sharp.
 *
 * Used as a fallback when ffmpeg can't apply filters itself (e.g. on
 * Windows where -update 1 bypasses -vf), and by the proxy camera for
 * per-capture filtering.
 *
 * Supported filters:
 *   crop=W:H:X:Y       — values may be expressions (iw, ih, PI, rotw/roth)
 *   rotate=ANGLE        — angle in radians, extra params (ow/oh) ignored
 *   scale=W:H           — nearest-neighbor resize
 */

type SharpFn = typeof import('sharp');

export async function applyFilter(
  sharp: SharpFn,
  image: Buffer,
  filterString: string,
): Promise<Buffer> {
  const filters = filterString.split(',').map(f => f.trim());
  let buf = image;

  for (const filter of filters) {
    const meta = await sharp(buf).metadata();
    const iw = meta.width ?? 0;
    const ih = meta.height ?? 0;
    if (iw === 0 || ih === 0) break;

    if (filter.startsWith('crop=')) {
      const parts = filter.slice(5).split(':');
      if (parts.length >= 4) {
        const w = evalDimExpr(parts[0], iw, ih);
        const h = evalDimExpr(parts[1], iw, ih);
        const x = evalDimExpr(parts[2], iw, ih);
        const y = evalDimExpr(parts[3], iw, ih);
        const cx = Math.max(0, Math.min(x, iw - 1));
        const cy = Math.max(0, Math.min(y, ih - 1));
        const cw = Math.max(1, Math.min(w, iw - cx));
        const ch = Math.max(1, Math.min(h, ih - cy));
        buf = await sharp(buf).extract({ left: cx, top: cy, width: cw, height: ch }).toBuffer();
      }
    } else if (filter.startsWith('rotate=')) {
      const anglePart = filter.slice(7).split(':')[0];
      const radians = evalAngle(anglePart);
      const degrees = (radians * 180) / Math.PI;
      buf = await sharp(buf).rotate(degrees, { background: '#000' }).toBuffer();
    } else if (filter.startsWith('scale=')) {
      const parts = filter.slice(6).split(':');
      if (parts.length >= 2) {
        const newW = Math.round(evalDimExpr(parts[0], iw, ih));
        const newH = Math.round(evalDimExpr(parts[1], iw, ih));
        if (newW > 0 && newH > 0) {
          buf = await sharp(buf).resize(newW, newH, { kernel: 'nearest' }).toBuffer();
        }
      }
    }
  }

  return buf;
}

/** Evaluate an ffmpeg dimension expression against current width/height. */
function evalDimExpr(expr: string, iw: number, ih: number): number {
  const cleaned = expr.trim();
  const plain = Number(cleaned);
  if (!Number.isNaN(plain) && !cleaned.includes('i')) return plain;

  let sub = cleaned
    .replace(/\biw\b/g, String(iw))
    .replace(/\bih\b/g, String(ih))
    .replace(/\bPI\b/gi, String(Math.PI));

  sub = sub.replace(/rotw\(([^)]+)\)/g, (_m, angleExpr) => {
    const angle = evalAngle(angleExpr);
    return String(Math.abs(iw * Math.cos(angle)) + Math.abs(ih * Math.sin(angle)));
  });
  sub = sub.replace(/roth\(([^)]+)\)/g, (_m, angleExpr) => {
    const angle = evalAngle(angleExpr);
    return String(Math.abs(iw * Math.sin(angle)) + Math.abs(ih * Math.cos(angle)));
  });

  try {
    const result = Function(`"use strict"; return (${sub})`)();
    if (typeof result === 'number' && !Number.isNaN(result)) return Math.round(result);
  } catch {}

  return parseFloat(cleaned) || 0;
}

/** Parse an angle expression that may contain PI (e.g. "PI/2", "9.5*PI/180"). */
function evalAngle(expr: string): number {
  const cleaned = expr.trim().replace(/\bPI\b/gi, String(Math.PI));
  try {
    const result = Function(`"use strict"; return (${cleaned})`)();
    if (typeof result === 'number' && !Number.isNaN(result)) return result;
  } catch {}
  return parseFloat(expr) || 0;
}
