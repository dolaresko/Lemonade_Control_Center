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
