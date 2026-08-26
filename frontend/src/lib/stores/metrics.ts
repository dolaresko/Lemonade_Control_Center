import { get, writable } from 'svelte/store';
import { api, withLccKey } from '$lib/api/client';
import { notify } from '$lib/stores/notifications';
import { percentile, sizeKeySteps } from '$lib/utils/chart';
import type {
  HardwareSeriesBucket,
  HistoryRange,
  MetricPoint,
  TaskRecord,
  TaskSeriesBucket,
  TaskSeriesSummary,
  TimeRange,
} from '$lib/types';

export const timeSeriesData = writable<MetricPoint[]>([]);
export const taskHistory = writable<TaskRecord[]>([]);
export const metricsLoading = writable(true);
export const timeRange = writable<TimeRange>(15);
export const metricsPaused = writable(false);
export const metricsWsConnected = writable(false);

// ── Long-run history ──
// The live buffer above answers "right now"; these answer "over the last
// week". They are loaded on demand so the default live view costs nothing.
export const historyRange = writable<HistoryRange>('24h');
export const taskSeries = writable<TaskSeriesBucket[]>([]);
export const taskSeriesSummary = writable<TaskSeriesSummary | null>(null);
export const hardwareSeries = writable<HardwareSeriesBucket[]>([]);

/**
 * The window each series covers, straight from the response. The charts plot
 * against the requested window rather than the extent of the data, and need
 * the bucket width to tell an empty stretch from adjacent buckets.
 */
export interface SeriesWindow {
  start: string | null;
  end: string | null;
  bucketSeconds: number | null;
}

const EMPTY_WINDOW: SeriesWindow = { start: null, end: null, bucketSeconds: null };

export const taskWindow = writable<SeriesWindow>(EMPTY_WINDOW);
export const hardwareWindow = writable<SeriesWindow>(EMPTY_WINDOW);
export const seriesLoading = writable(false);
export const seriesLoaded = writable(false);

export const HISTORY_RANGES: HistoryRange[] = ['1h', '24h', '7d', '30d'];

const HOUR_MS = 60 * 60 * 1000;
const RANGE_MS: Record<HistoryRange, number> = {
  '1h': HOUR_MS,
  '24h': 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
  '30d': 30 * 24 * HOUR_MS,
};

/** Individual runs, for the scatter that plots one point per run. */
export const taskRuns = writable<TaskRecord[]>([]);

/** Ceiling on a runs request; also what the footer reports as truncated. */
export const RUN_LIMIT = 5000;

/**
 * Stable reference for the scatter's size encoding: the p95 of output_tokens
 * over the whole 30d history, so a run's mark is the same size on every
 * range. Fetched once and cached here rather than recomputed per range
 * switch -- see loadMagnitudeCeiling.
 */
export const magnitudeCeiling = writable<number | null>(null);
/** Size-key reference values, drawn from the same fixed 30d sample. */
export const magnitudeKeySteps = writable<number[]>([]);
let magnitudeCeilingLoaded = false;

/** Chart axis labels: clock time for short windows, calendar dates for long ones. */
export function rangeTickFormat(range: HistoryRange): 'time' | 'date' {
  return range === '1h' || range === '24h' ? 'time' : 'date';
}

let ws: WebSocket | null = null;
const MAX_POINTS = 360;

export async function loadMetrics(): Promise<void> {
  metricsLoading.set(true);
  const range = get(timeRange);
  const [historyResult, taskResult] = await Promise.allSettled([
    api.metrics.history(range),
    api.metrics.tasks(20),
  ]);

  if (historyResult.status === 'fulfilled' && historyResult.value.ok) {
    timeSeriesData.set(historyResult.value.data.points);
  }
  if (taskResult.status === 'fulfilled' && taskResult.value.ok) {
    taskHistory.set(taskResult.value.data.tasks);
  }
  metricsLoading.set(false);
}

export function connectMetricsWs(): void {
  disconnectMetricsWs();
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}${withLccKey('/ws/metrics')}`);
  ws.onopen = () => metricsWsConnected.set(true);
  ws.onclose = () => {
    metricsWsConnected.set(false);
    ws = null;
  };
  ws.onerror = () => metricsWsConnected.set(false);
  ws.onmessage = (event) => {
    if (get(metricsPaused)) return;
    try {
      const message = JSON.parse(event.data) as { type?: string; data?: MetricPoint };
      if (message.type !== 'metric' || !message.data) return;
      const cutoff = Date.now() - get(timeRange) * 60 * 1000;
      timeSeriesData.update((points) =>
        [...points, message.data as MetricPoint]
          .filter((point) => parseMetricTimestamp(point.t) >= cutoff)
          .slice(-MAX_POINTS),
      );
    } catch {
      // Ignore malformed websocket messages.
    }
  };
}

export function disconnectMetricsWs(): void {
  if (ws) {
    ws.close();
    ws = null;
  }
  metricsWsConnected.set(false);
}

export async function loadSeries(
  range?: HistoryRange,
  opts: { refreshCeiling?: boolean } = {},
): Promise<void> {
  const selected = range ?? get(historyRange);
  seriesLoading.set(true);

  // The window is computed here rather than taken from the series response so
  // the runs request and the chart domain agree exactly; the series endpoint
  // derives its own window from the server clock a moment later.
  const until = new Date();
  const since = new Date(until.getTime() - RANGE_MS[selected]);

  // Fired alongside the rest, not awaited into the same array: a fixed-scale
  // refresh shouldn't block the range's own charts, and it may not run at all.
  const ceilingPromise = loadMagnitudeCeiling(Boolean(opts.refreshCeiling));

  const [tasks, hardware, runs] = await Promise.allSettled([
    api.metrics.taskSeries(selected),
    api.metrics.hardwareSeries(selected),
    api.metrics.tasksWindow({
      since: since.toISOString(),
      until: until.toISOString(),
      n: RUN_LIMIT,
    }),
  ]);

  // An empty range is a legitimate answer, not a failure: a quiet journal
  // simply has no buckets, and the UI renders an empty state for that.
  const taskData = tasks.status === 'fulfilled' && tasks.value.ok ? tasks.value.data : null;
  taskSeries.set(taskData?.buckets ?? []);
  taskSeriesSummary.set(taskData?.summary ?? null);
  taskWindow.set(toWindow(taskData));

  const hardwareData =
    hardware.status === 'fulfilled' && hardware.value.ok ? hardware.value.data : null;
  hardwareSeries.set(hardwareData?.buckets ?? []);
  hardwareWindow.set(toWindow(hardwareData));

  const runData = runs.status === 'fulfilled' && runs.value.ok ? runs.value.data : null;
  taskRuns.set(runData?.tasks ?? []);

  await ceilingPromise;
  seriesLoading.set(false);
  seriesLoaded.set(true);
}

/**
 * Refresh the scatter's fixed size scale from the whole 30d history.
 *
 * Guarded so a plain range switch never re-fetches it: `force` is only passed
 * from an explicit user refresh, and the very first load always runs because
 * nothing has been cached yet.
 */
export async function loadMagnitudeCeiling(force = false): Promise<void> {
  if (magnitudeCeilingLoaded && !force) return;
  const until = new Date();
  const since = new Date(until.getTime() - RANGE_MS['30d']);
  const result = await api.metrics.tasksWindow({
    since: since.toISOString(),
    until: until.toISOString(),
    n: RUN_LIMIT,
  });
  // Keep whatever ceiling is already cached rather than blank the scale on a
  // transient failure.
  if (!result.ok) return;

  const magnitudes = result.data.tasks
    .map((task) => task.output_tokens)
    .filter((value): value is number => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);

  magnitudeCeiling.set(magnitudes.length ? percentile(magnitudes, 0.95) : null);
  magnitudeKeySteps.set(sizeKeySteps(magnitudes));
  magnitudeCeilingLoaded = true;
}

export function setHistoryRange(range: HistoryRange): void {
  historyRange.set(range);
  loadSeries(range);
}

export function setTimeRange(range: TimeRange): void {
  timeRange.set(range);
  loadMetrics();
}

export function toggleMetricsPause(): void {
  metricsPaused.update((value) => !value);
}

export async function clearMetricsHistory(): Promise<void> {
  const result = await api.metrics.clear();
  if (result.ok) {
    timeSeriesData.set([]);
    taskHistory.set([]);
    taskSeries.set([]);
    taskSeriesSummary.set(null);
    taskRuns.set([]);
    hardwareSeries.set([]);
    taskWindow.set(EMPTY_WINDOW);
    hardwareWindow.set(EMPTY_WINDOW);
    magnitudeCeiling.set(null);
    magnitudeKeySteps.set([]);
    magnitudeCeilingLoaded = false;
    notify.info('Metrics cleared', 'Hardware and task history buffers were cleared.');
  } else {
    notify.error('Clear metrics failed', result.error);
  }
}

export function exportTasksCsv(range?: HistoryRange): void {
  const anchor = document.createElement('a');
  anchor.href = api.metrics.tasksCsvUrl(range);
  anchor.download = 'lcc-tasks.csv';
  anchor.click();
}

function toWindow(
  data: { start?: string; end?: string; bucket_seconds?: number } | null,
): SeriesWindow {
  if (!data) return EMPTY_WINDOW;
  return {
    start: data.start ?? null,
    end: data.end ?? null,
    bucketSeconds: data.bucket_seconds ?? null,
  };
}

function parseMetricTimestamp(value: string): number {
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  return new Date(hasTimezone ? value : `${value}Z`).getTime();
}
