import { derived, get, writable } from 'svelte/store';
import { api, withLccKey } from '$lib/api/client';
import { notify } from '$lib/stores/notifications';
import { sizeKeyFromCeiling } from '$lib/utils/chart';
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
 * range. The backend reduces the window to this one number -- see
 * loadMagnitudeCeiling.
 */
export const magnitudeCeiling = writable<number | null>(null);

/**
 * Size-key reference values.
 *
 * Derived from the ceiling rather than stored alongside it, because the key's
 * circles are drawn against the ceiling: any other source can only disagree
 * with what the plot actually renders.
 */
export const magnitudeKeySteps = derived(magnitudeCeiling, (ceiling) =>
  ceiling === null ? [] : sizeKeyFromCeiling(ceiling),
);

/** The window the fixed scale is measured over, whatever range is on screen. */
const MAGNITUDE_RANGE: HistoryRange = '30d';

/**
 * How long a cached ceiling stays trustworthy.
 *
 * "Do not recompute per range switch" is not "never recompute": a scale cached
 * at session start goes stale as new work lands, and every larger run then
 * pins silently to maximum radius. Ten minutes is far longer than a burst of
 * tab switches and far shorter than a working day.
 */
const MAGNITUDE_TTL_MS = 10 * 60 * 1000;

let magnitudeFetchedAt = 0;
let magnitudeInFlight: Promise<void> | null = null;

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

/** True while the cached ceiling is still inside its TTL. */
function magnitudeCacheFresh(): boolean {
  return magnitudeFetchedAt > 0 && Date.now() - magnitudeFetchedAt < MAGNITUDE_TTL_MS;
}

/**
 * Refresh the scatter's fixed size scale.
 *
 * Age-based, not switch-based: a range switch inside the TTL is served from
 * cache and issues no request at all, while a session left open past the TTL
 * picks the new ceiling up on its next load. `force` is the explicit Refresh
 * button, which never waits for the clock.
 */
export async function loadMagnitudeCeiling(force = false): Promise<void> {
  if (!force && magnitudeCacheFresh()) return;
  // Two loads arriving together share one request rather than racing.
  if (magnitudeInFlight && !force) return magnitudeInFlight;

  magnitudeInFlight = (async () => {
    const result = await api.metrics.taskScale(MAGNITUDE_RANGE, 0.95);
    // Keep whatever ceiling is already cached rather than blank the scale on a
    // transient failure; the stale scale still reads better than none.
    if (!result.ok) return;
    magnitudeCeiling.set(result.data.output_tokens);
    magnitudeFetchedAt = Date.now();
  })();

  try {
    await magnitudeInFlight;
  } finally {
    magnitudeInFlight = null;
  }
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

/**
 * Empty the live ring buffer only.
 *
 * Cheap and reversible -- the stream refills within seconds -- so it needs no
 * confirmation. The persisted history is untouched, which is why the task
 * table below the graphs keeps its rows.
 */
export async function clearLiveBuffer(): Promise<void> {
  const result = await api.metrics.clear('buffer');
  if (!result.ok) {
    notify.error('Clear failed', result.error);
    return;
  }
  timeSeriesData.set([]);
  notify.info('Live buffer cleared', 'The stream will refill as new samples arrive.');
}

/**
 * Delete the persisted history: both SQLite tables, irreversibly.
 *
 * Callers must confirm first -- this used to hide behind the same one-word
 * "Clear" button as the buffer reset above.
 */
export async function deleteMetricsHistory(): Promise<void> {
  const result = await api.metrics.clear('history');
  if (!result.ok) {
    notify.error('Delete history failed', result.error);
    return;
  }
  timeSeriesData.set([]);
  taskHistory.set([]);
  taskSeries.set([]);
  taskSeriesSummary.set(null);
  taskRuns.set([]);
  hardwareSeries.set([]);
  taskWindow.set(EMPTY_WINDOW);
  hardwareWindow.set(EMPTY_WINDOW);
  magnitudeCeiling.set(null);
  magnitudeFetchedAt = 0;

  const deleted = result.data.deleted;
  notify.info(
    'History deleted',
    deleted
      ? `Removed ${deleted.tasks} task ${deleted.tasks === 1 ? 'record' : 'records'} and ${deleted.hardware} hardware ${deleted.hardware === 1 ? 'sample' : 'samples'}.`
      : 'The persisted history was removed.',
  );
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
