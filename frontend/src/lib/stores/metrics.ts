import { get, writable } from 'svelte/store';
import { api, withLccKey } from '$lib/api/client';
import { notify } from '$lib/stores/notifications';
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

export async function loadSeries(range?: HistoryRange): Promise<void> {
  const selected = range ?? get(historyRange);
  seriesLoading.set(true);
  const [tasks, hardware] = await Promise.allSettled([
    api.metrics.taskSeries(selected),
    api.metrics.hardwareSeries(selected),
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
  seriesLoading.set(false);
  seriesLoaded.set(true);
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
    hardwareSeries.set([]);
    taskWindow.set(EMPTY_WINDOW);
    hardwareWindow.set(EMPTY_WINDOW);
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
