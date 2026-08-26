/**
 * Shared axis and tick helpers for the SVG charts.
 *
 * Both SvgLineChart and SvgBarChart draw their own marks but share this
 * arithmetic, so gridlines, tick spacing and label formatting stay identical
 * across every chart on the page.
 */

/**
 * One locale for every chart label. The surrounding UI is English, and letting
 * the browser locale decide produced mixed axes — "22:45" next to "21 серп."
 * on the same page.
 */
export const CHART_LOCALE = 'en-GB';

export type TickFormat = 'time' | 'date';

export interface NiceScale {
  /** Top of the axis: a round number at or above the largest value. */
  max: number;
  /** Gridline values, ascending, always starting at zero. */
  ticks: number[];
}

/**
 * Round a raw step up to the nearest 1 / 2 / 2.5 / 5 / 10 x 10^n, the classic
 * set of steps that read as round numbers on an axis.
 */
function niceStep(rawStep: number): number {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  if (normalized <= 1) return magnitude;
  if (normalized <= 2) return 2 * magnitude;
  if (normalized <= 2.5) return 2.5 * magnitude;
  if (normalized <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

/**
 * Build a zero-based axis of round gridlines covering `dataMax`.
 *
 * The axis always starts at zero. A non-zero baseline exaggerates small
 * fluctuations, and R2 forbids one that is not called out — zero-based keeps
 * the chart honest without needing the disclaimer.
 *
 * `intervals` is a target, not a guarantee: the rounding can land one line
 * either side, which keeps the count in the 3-5 range the design asks for.
 */
export function niceScale(dataMax: number, intervals = 4): NiceScale {
  const safeMax = Number.isFinite(dataMax) && dataMax > 0 ? dataMax : 1;
  const step = niceStep(safeMax / Math.max(1, intervals));
  // toFixed guards the float drift that turns 3 x 0.2 into 0.6000000000000001.
  const max = Number((Math.ceil(safeMax / step) * step).toFixed(10));
  const ticks: number[] = [];
  // Accumulate by index rather than by repeated addition so a fractional step
  // (2.5, 0.25, ...) does not drift into 7.499999999999999.
  const count = Math.round(max / step);
  for (let index = 0; index <= count; index += 1) {
    ticks.push(Number((step * index).toFixed(10)));
  }
  return { max, ticks };
}

export interface XTick {
  /** Fractional index, used for the tick's x position. */
  position: number;
  /** Nearest real data index, used to pick the label. */
  index: number;
}

export interface TimeTick {
  /** Epoch milliseconds of the tick. */
  time: number;
  /** Preformatted label for the tick. */
  label: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Candidate tick spacings, all of them values a reader recognises as round.
 * Anything not listed (7 minutes, 5 hours) would put labels on times nobody
 * thinks in.
 */
const TIME_STEPS = [
  MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE,
  HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
  DAY, 2 * DAY, 7 * DAY, 14 * DAY, 28 * DAY,
];

/**
 * Finest round step whose tick count still fits the target.
 *
 * Dividing by target + 1 rather than target picks the denser of two candidate
 * steps, which keeps a 1-hour window on 10-minute ticks instead of dropping to
 * four. Round boundaries win over hitting the target exactly: no round step
 * divides a 7-day span into five, so that range settles on four 2-day ticks.
 */
function pickTimeStep(spanMs: number, target: number): number {
  const wanted = spanMs / Math.max(2, target + 1);
  return TIME_STEPS.find((step) => step >= wanted) ?? TIME_STEPS[TIME_STEPS.length - 1];
}

/** Local midnight on the day containing `time`. */
function startOfLocalDay(time: number): Date {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day;
}

/**
 * Ticks on round wall-clock boundaries across a time domain.
 *
 * Sub-day steps are anchored to local midnight, so a 6-hour step lands on
 * 00:00 / 06:00 / 12:00 / 18:00 rather than on an arbitrary offset from the
 * window edge. Day-or-larger steps advance by calendar date, which keeps them
 * on midnight across a DST change instead of drifting an hour.
 */
export function timeTicks(
  startMs: number,
  endMs: number,
  target: number,
  format: TickFormat,
): TimeTick[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];

  const step = pickTimeStep(endMs - startMs, target);
  const ticks: TimeTick[] = [];

  if (step >= DAY) {
    const days = Math.round(step / DAY);
    const cursor = startOfLocalDay(startMs);
    if (cursor.getTime() < startMs) cursor.setDate(cursor.getDate() + days);
    while (cursor.getTime() <= endMs && ticks.length < 24) {
      ticks.push({ time: cursor.getTime(), label: formatAxisLabel(cursor.toISOString(), format) });
      cursor.setDate(cursor.getDate() + days);
    }
    return ticks;
  }

  const anchor = startOfLocalDay(startMs).getTime();
  let time = anchor + Math.ceil((startMs - anchor) / step) * step;
  while (time <= endMs && ticks.length < 24) {
    ticks.push({ time, label: formatAxisLabel(new Date(time).toISOString(), format) });
    time += step;
  }
  return ticks;
}

/**
 * Split a series into runs of consecutive buckets.
 *
 * The series omits empty buckets, so a gap in the data is a jump in the
 * timestamps. Drawing straight through such a jump would invent a trend across
 * time when nothing ran; each run is drawn separately instead. The 1.5x
 * tolerance absorbs the sub-second jitter in bucket boundaries.
 */
export function timeSegments(times: number[], bucketMs: number): number[][] {
  if (times.length === 0) return [];
  const limit = bucketMs > 0 ? bucketMs * 1.5 : Number.POSITIVE_INFINITY;
  const segments: number[][] = [[0]];
  for (let index = 1; index < times.length; index += 1) {
    if (times[index] - times[index - 1] > limit) segments.push([index]);
    else segments[segments.length - 1].push(index);
  }
  return segments;
}

/**
 * Infer the bucket width from the closest pair of timestamps.
 *
 * Only a fallback: callers that know the server's bucket_seconds should pass
 * it, because a series whose buckets are all isolated has no pair to measure.
 */
export function inferBucketMs(times: number[]): number {
  let smallest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < times.length; index += 1) {
    const delta = times[index] - times[index - 1];
    if (delta > 0 && delta < smallest) smallest = delta;
  }
  return Number.isFinite(smallest) ? smallest : 0;
}

/** Index of the point closest in time to `target`. */
export function nearestTimeIndex(times: number[], target: number): number {
  if (times.length === 0) return 0;
  let best = 0;
  let bestDistance = Math.abs(times[0] - target);
  for (let index = 1; index < times.length; index += 1) {
    const distance = Math.abs(times[index] - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

/**
 * How many x ticks the available width can hold without labels colliding.
 *
 * Desktop panels land on 5-6. Narrow viewports fall back to 3 rather than
 * clipping the outermost label, which is what a fixed count did at phone
 * width.
 */
export function xTickTarget(plotWidth: number): number {
  return Math.max(3, Math.min(6, Math.round(plotWidth / 150)));
}

/**
 * Place evenly spaced ticks along the x axis.
 *
 * The tick sits at an exact fractional position so the spacing is genuinely
 * even; rounding to the nearest index first produced visibly uneven gaps
 * (0, 2, 4, 5, 7 across eight points). The label still comes from a real
 * bucket, which is accurate because buckets are uniform in time.
 *
 * Series with few points get one tick each, rather than invented positions.
 */
export function xTicks(pointCount: number, target = 5): XTick[] {
  if (pointCount <= 0) return [];
  if (pointCount <= target + 1) {
    return Array.from({ length: pointCount }, (_, index) => ({ position: index, index }));
  }
  const count = Math.min(6, Math.max(4, target));
  const last = pointCount - 1;
  return Array.from({ length: count }, (_, tick) => {
    const position = (tick * last) / (count - 1);
    return { position, index: Math.round(position) };
  });
}

/** Axis tick label: HH:mm for short ranges, day and month for long ones. */
export function formatAxisLabel(value: string | undefined, format: TickFormat): string {
  const moment = toDate(value);
  if (!moment) return value ?? '';
  return format === 'date'
    ? moment.toLocaleDateString(CHART_LOCALE, { day: 'numeric', month: 'short' })
    : moment.toLocaleTimeString(CHART_LOCALE, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
}

/**
 * Tooltip timestamp. Always carries the date as well as the time: a bare
 * "13:45" is ambiguous the moment a range spans midnight.
 */
export function formatTooltipTimestamp(value: string | undefined): string {
  const moment = toDate(value);
  if (!moment) return value ?? '';
  return `${moment.toLocaleDateString(CHART_LOCALE, {
    day: 'numeric',
    month: 'short',
  })}, ${moment.toLocaleTimeString(CHART_LOCALE, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })}`;
}

/** Trim a value for display: integers stay whole, fractions keep one decimal. */
export function formatValue(value: number, unit = ''): string {
  if (!Number.isFinite(value)) return '--';
  const rounded = Math.abs(value) >= 100 || Number.isInteger(value)
    ? Math.round(value).toString()
    : value.toFixed(1);
  return `${rounded}${unit}`;
}

/**
 * Axis tick text. Keeps enough decimals for the step actually in use -- a
 * 0.25 step must not be labelled "0.3" -- and drops trailing zeros.
 */
export function formatTick(value: number): string {
  if (Number.isInteger(value)) return value.toString();
  return value.toFixed(2).replace(/\.?0+$/, '');
}

function toDate(value: string | undefined): Date | null {
  if (!value) return null;
  const moment = new Date(value);
  return Number.isNaN(moment.getTime()) ? null : moment;
}

// ═══════════════════════════════════════════════
// Scatter marks
// ═══════════════════════════════════════════════

/** One labelled line in a scatter tooltip. */
export interface ScatterRow {
  label: string;
  value: string;
}

/**
 * One mark on a scatter plot. The caller formats everything the tooltip shows,
 * because only it knows whether a point is a single run or a bucket of them.
 */
export interface ScatterPoint {
  /** Epoch milliseconds; the x position. */
  time: number;
  /** The y value, in whatever unit the chart carries. */
  value: number;
  /** Encoded as the mark's AREA -- see markRadius. */
  magnitude: number;
  /** Tooltip heading, already formatted. */
  label: string;
  /** Tooltip detail rows. */
  rows: ScatterRow[];
}

/** Mark radii, in CSS pixels. Below 4px a dot stops reading as a dot; above
 *  14px the largest runs start swallowing their neighbours. */
export const MARK_RADIUS_MIN = 4;
export const MARK_RADIUS_MAX = 14;

/** Pointer slack for hit testing, in CSS pixels. */
export const MARK_HIT_RADIUS = 24;

/**
 * Radius of a mark whose AREA carries `magnitude`.
 *
 * Area grows with the square of the radius, so the radius has to grow with the
 * square root of the value. Scaling the radius linearly instead would draw a
 * run with 20x the tokens of another one 400x as large, which reads as a far
 * bigger difference than the data holds.
 */
export function markRadius(
  magnitude: number,
  magnitudeMax: number,
  min = MARK_RADIUS_MIN,
  max = MARK_RADIUS_MAX,
): number {
  if (!Number.isFinite(magnitude) || magnitude <= 0) return min;
  if (!Number.isFinite(magnitudeMax) || magnitudeMax <= 0) return min;
  const ratio = Math.min(magnitude / magnitudeMax, 1);
  return min + (max - min) * Math.sqrt(ratio);
}

/**
 * Round to `digits` significant figures, so key labels read as round numbers.
 *
 * toFixed strips the float drift the final multiply introduces -- without it
 * two significant figures of 1.2 come back as 1.2000000000000002, which is the
 * opposite of a readable number.
 */
export function roundSignificant(value: number, digits = 2): number {
  if (!Number.isFinite(value) || value === 0) return 0;
  const step = 10 ** (Math.floor(Math.log10(Math.abs(value))) - digits + 1);
  return Number((Math.round(value / step) * step).toFixed(10));
}

/** As roundSignificant, but never downwards. */
function ceilSignificant(value: number, digits = 2): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const step = 10 ** (Math.floor(Math.log10(value)) - digits + 1);
  return Number((Math.ceil(value / step) * step).toFixed(10));
}

/**
 * Fractions of the ceiling the key's reference circles stand at.
 *
 * markRadius scales by the square root, so these land at radii of roughly
 * 9 / 11.8 / 14 px -- three sizes a reader can tell apart at a glance. Evenly
 * spaced *values* would not do that: 33% and 66% of the ceiling differ by
 * under 3px of radius at the small end.
 */
const SIZE_KEY_FRACTIONS = [0.25, 0.6, 1];

/**
 * Reference values for the size key, derived from the scale's own ceiling.
 *
 * Deriving them from the plotted sample instead was the bug this replaces:
 * markRadius clamps at the ceiling, so every sampled value at or above it drew
 * at exactly MARK_RADIUS_MAX and the key rendered two identical circles. The
 * fractions below are of the ceiling, which is what the radii are measured
 * against, so each entry is guaranteed a distinct size.
 *
 * The top entry rounds *up*, so it is at or above the ceiling and therefore
 * draws at exactly the radius the plot's largest marks draw -- the key reads
 * directly off the chart rather than approximating it.
 */
export function sizeKeyFromCeiling(ceiling: number): number[] {
  if (!Number.isFinite(ceiling) || ceiling <= 0) return [];
  const steps: number[] = [];
  for (const fraction of SIZE_KEY_FRACTIONS) {
    const step =
      fraction >= 1 ? ceilSignificant(ceiling, 2) : roundSignificant(ceiling * fraction, 2);
    // Rounding can collapse two fractions onto the same readable number; a
    // repeated entry is dropped rather than drawn twice.
    if (step > 0 && !steps.includes(step)) steps.push(step);
  }
  return steps;
}

/**
 * Index of the mark nearest (x, y) within `radius` pixels, or null.
 *
 * Hit testing uses a generous radius rather than each mark's own geometry: a
 * 4px dot is awkward to hit with a mouse and impossible with a thumb, and the
 * small dots are exactly the short runs a reader wants to inspect.
 */
export function nearestMarkIndex(
  xs: number[],
  ys: number[],
  x: number,
  y: number,
  radius = MARK_HIT_RADIUS,
): number | null {
  let best: number | null = null;
  let bestDistance = radius * radius;
  for (let index = 0; index < xs.length; index += 1) {
    const dx = xs[index] - x;
    const dy = ys[index] - y;
    const distance = dx * dx + dy * dy;
    // <= keeps the later of two coincident marks, which is the one drawn on
    // top and therefore the one under the pointer.
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

/** A new session starts when the gap since the previous run exceeds this. */
export const SESSION_GAP_MS = 20 * 60_000;

/** Minimum pixel gap between adjacent session-tick labels before one is dropped. */
export const SESSION_LABEL_MIN_GAP_PX = 46;

/**
 * Indices (into a time-ascending array) where a new session begins: index 0,
 * plus every index whose gap from the previous point exceeds `gapMs`.
 */
export function sessionStartIndices(times: number[], gapMs: number): number[] {
  if (times.length === 0) return [];
  const starts = [0];
  for (let index = 1; index < times.length; index += 1) {
    if (times[index] - times[index - 1] > gapMs) starts.push(index);
  }
  return starts;
}

/**
 * Thin a candidate tick list so labels never collide.
 *
 * Sessions vary in size, so candidates land at uneven pixel positions and a
 * fixed stride cannot guarantee clearance. Keep the first candidate, then
 * greedily keep the next one only once it clears `minGapPx` from the last
 * kept tick. The final candidate is always forced in -- swapping out its
 * nearest neighbour if the two would otherwise collide -- so the window's
 * right edge is never left unlabelled.
 */
export function thinTicks(
  candidates: number[],
  xOf: (index: number) => number,
  minGapPx: number,
): number[] {
  if (candidates.length <= 1) return candidates;
  const kept: number[] = [candidates[0]];
  let lastX = xOf(candidates[0]);
  for (let index = 1; index < candidates.length - 1; index += 1) {
    const x = xOf(candidates[index]);
    if (x - lastX >= minGapPx) {
      kept.push(candidates[index]);
      lastX = x;
    }
  }
  const last = candidates[candidates.length - 1];
  if (xOf(last) - lastX >= minGapPx) {
    kept.push(last);
  } else if (kept[kept.length - 1] !== last) {
    kept[kept.length - 1] = last;
  }
  return kept;
}

/** "hour", "6 hours", "day" -- how wide one bucket is, for the footer note. */
export function formatBucketWidth(seconds: number | null): string {
  if (!seconds || seconds <= 0) return 'bucket';
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return days === 1 ? 'day' : `${days} days`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return hours === 1 ? 'hour' : `${hours} hours`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? 'minute' : `${minutes} minutes`;
}
