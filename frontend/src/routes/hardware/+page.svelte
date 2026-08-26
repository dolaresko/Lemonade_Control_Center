<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { Download, Pause, Play, RefreshCw, Trash2 } from 'lucide-svelte';
  import ChartPanel from '$lib/components/hardware/ChartPanel.svelte';
  import SvgBarChart from '$lib/components/hardware/SvgBarChart.svelte';
  import SvgLineChart from '$lib/components/hardware/SvgLineChart.svelte';
  import SvgScatterChart from '$lib/components/hardware/SvgScatterChart.svelte';
  import {
    clearMetricsHistory,
    connectMetricsWs,
    disconnectMetricsWs,
    exportTasksCsv,
    hardwareSeries,
    historyRange,
    HISTORY_RANGES,
    loadMetrics,
    loadSeries,
    metricsLoading,
    metricsPaused,
    metricsWsConnected,
    rangeScatterMode,
    rangeTickFormat,
    runWindow,
    seriesLoaded,
    seriesLoading,
    setHistoryRange,
    setTimeRange,
    taskHistory,
    taskRuns,
    taskSeries,
    taskSeriesSummary,
    taskWindow,
    hardwareWindow,
    timeRange,
    timeSeriesData,
    toggleMetricsPause,
  } from '$lib/stores/metrics';
  import { formatBucketWidth, formatTooltipTimestamp, type ScatterPoint } from '$lib/utils/chart';
  import type { HistoryRange, MetricPoint, TaskRecord, TaskSeriesBucket, TimeRange } from '$lib/types';
  import type { TelemetrySnapshot } from '$lib/types';
  import { api } from '$lib/api/client';

  const ranges: TimeRange[] = [5, 15, 30];
  /** Ceiling on the runs request; also what the footer reports as truncated. */
  const RUN_LIMIT = 1000;
  let telemetry: TelemetrySnapshot | null = null;

  // The live stream stays the default view; long-run history is opt-in and
  // only fetches its series the first time it is opened.
  let view: 'live' | 'history' = 'live';

  onMount(() => {
    loadMetrics();
    connectMetricsWs();
    loadTelemetryProviders();
  });

  function showHistory() {
    view = 'history';
    if (!$seriesLoaded) loadSeries();
  }

  async function loadTelemetryProviders() {
    const result = await api.system.telemetry();
    telemetry = result.ok ? result.data : null;
  }

  onDestroy(() => {
    disconnectMetricsWs();
  });

  $: labels = $timeSeriesData.map(formatTime);
  $: ramValues = $timeSeriesData.map((point) => point.ram_used);
  $: ramTotal = latest($timeSeriesData)?.ram_total ?? 0;
  $: cpuValues = $timeSeriesData.map((point) => point.cpu_pct);
  $: gpuValues = $timeSeriesData.map((point) => point.gpu_load_pct).filter((value): value is number => typeof value === 'number');
  $: tempValues = $timeSeriesData.map(primaryTemperature).filter((value): value is number => typeof value === 'number');
  $: gpuTempValues = $timeSeriesData.map((point) => point.gpu_temp_c).filter((value): value is number => typeof value === 'number');
  $: tpsValues = $taskHistory.map((task) => task.gen_tps);
  $: ttftValues = $taskHistory.map((task) => task.ttft_seconds);
  $: throughputValues = $taskHistory.map((task) => task.output_tokens);
  $: taskLabels = $taskHistory.map((task) => new Date(task.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

  // ── Long-run series ──
  // The charts format their own axes, so they take ISO timestamps rather than
  // pre-rendered label strings.
  $: seriesTimestamps = $taskSeries.map((bucket) => bucket.t);
  $: seriesCounts = $taskSeries.map((bucket) => bucket.count);
  $: tickFormat = rangeTickFormat($historyRange);
  $: seriesTpsP50 = $taskSeries.map((bucket) => bucket.gen_tps_p50);
  $: seriesTpsP95 = $taskSeries.map((bucket) => bucket.gen_tps_p95);
  $: seriesTtft = $taskSeries.map((bucket) => bucket.ttft_mean);
  $: seriesTokens = $taskSeries.map((bucket) => bucket.total_tokens);
  $: seriesRuns = $taskSeries.reduce((total, bucket) => total + bucket.count, 0);

  $: hardwareTimestamps = $hardwareSeries.map((bucket) => bucket.t);
  $: hardwareCounts = $hardwareSeries.map((bucket) => bucket.count);
  $: hardwareRam = $hardwareSeries.map((bucket) => bucket.ram_percent);
  $: hardwareRamPeak = $hardwareSeries.map((bucket) => bucket.ram_percent_max);
  $: hardwareCpu = $hardwareSeries.map((bucket) => bucket.cpu_percent);
  $: hardwareGpuBuckets = $hardwareSeries.filter(
    (bucket) => typeof bucket.gpu_load_percent === 'number',
  );
  $: hardwareGpu = hardwareGpuBuckets.map((bucket) => bucket.gpu_load_percent as number);
  $: hardwareGpuTimestamps = hardwareGpuBuckets.map((bucket) => bucket.t);
  $: hardwareGpuCounts = hardwareGpuBuckets.map((bucket) => bucket.count);

  // ── Generation-speed scatter ──
  // A run is a discrete event, so it is drawn as one: a mark per run, no line
  // between them. The long ranges hold too many runs to draw individually and
  // fall back to a mark per bucket.
  $: scatterMode = rangeScatterMode($historyRange);
  $: scatterWindow = scatterMode === 'run' ? $runWindow : $taskWindow;
  $: bucketWidth = formatBucketWidth($taskWindow.bucketSeconds);

  // A rate of zero is not a slow run, it is a run whose rate could not be
  // measured -- a one-token completion has no generation interval to divide
  // by. Plotting those on the baseline would invent a cluster of slow work.
  $: measurableRuns = $taskRuns.filter((run) => run.gen_tps > 0);
  $: unmeasurableRuns = $taskRuns.length - measurableRuns.length;
  $: runPoints = measurableRuns.map(toRunPoint);
  // The request asks for 1000 runs; a window that fills it may have more.
  $: runsTruncated = $taskRuns.length >= RUN_LIMIT;

  // The server already drops unmeasurable rates from its aggregates, so a
  // bucket with a zero mean is a bucket where nothing was measurable at all.
  $: measurableBuckets = $taskSeries.filter((bucket) => bucket.gen_tps_mean > 0);
  $: unmeasurableBucketRuns = $taskSeries
    .filter((bucket) => bucket.gen_tps_mean <= 0)
    .reduce((total, bucket) => total + bucket.count, 0);
  $: bucketPoints = measurableBuckets.map(toBucketPoint);
  $: plottedBucketRuns = measurableBuckets.reduce((total, bucket) => total + bucket.count, 0);

  $: scatterPoints = scatterMode === 'run' ? runPoints : bucketPoints;
  $: scatterUnmeasurable = scatterMode === 'run' ? unmeasurableRuns : unmeasurableBucketRuns;
  $: scatterFootnote = [
    scatterMode === 'run'
      ? 'one point per run'
      : `one point per ${bucketWidth}, ${plottedBucketRuns} ${plottedBucketRuns === 1 ? 'run' : 'runs'}`,
    scatterMode === 'run' && runsTruncated ? `most recent ${RUN_LIMIT} runs only` : '',
    scatterUnmeasurable > 0
      ? `${scatterUnmeasurable} ${scatterUnmeasurable === 1 ? 'run' : 'runs'} had no measurable rate`
      : '',
  ]
    .filter(Boolean)
    .join(' \u00b7 ');
  $: scatterHeadline =
    scatterMode === 'run'
      ? `${runPoints.length} ${runPoints.length === 1 ? 'run' : 'runs'}`
      : `${bucketPoints.length} ${bucketPoints.length === 1 ? 'bucket' : 'buckets'}`;

  /** The slowest bucket in the window: the dip a trend view exists to surface. */
  $: slowestP50 = $taskSeries.length
    ? Math.min(...$taskSeries.map((bucket) => bucket.gen_tps_p50))
    : null;

  function toRunPoint(run: TaskRecord): ScatterPoint {
    return {
      time: Date.parse(run.timestamp),
      value: run.gen_tps,
      magnitude: run.output_tokens,
      label: formatTooltipTimestamp(run.timestamp),
      rows: [
        { label: 'Tokens', value: `${run.input_tokens} in / ${run.output_tokens} out` },
        { label: 'TTFT', value: `${run.ttft_seconds.toFixed(2)}s` },
        { label: 'Duration', value: `${run.total_seconds.toFixed(1)}s` },
        { label: 'Finish', value: run.finish_reason },
      ],
    };
  }

  function toBucketPoint(bucket: TaskSeriesBucket): ScatterPoint {
    return {
      time: Date.parse(bucket.t),
      value: bucket.gen_tps_mean,
      magnitude: bucket.output_tokens,
      label: formatTooltipTimestamp(bucket.t),
      rows: [
        { label: 'Runs', value: `${bucket.count}` },
        { label: 'p50', value: `${bucket.gen_tps_p50.toFixed(1)} t/s` },
        { label: 'Tokens', value: `${bucket.total_tokens.toLocaleString('en-GB')} total` },
      ],
    };
  }

  function rangeLabel(range: HistoryRange): string {
    return { '1h': '1h', '24h': '24h', '7d': '7d', '30d': '30d' }[range];
  }

  function latest(points: MetricPoint[]): MetricPoint | null {
    return points.at(-1) ?? null;
  }

  function formatTime(point: MetricPoint): string {
    return new Date(parseMetricTimestamp(point.t)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function primaryTemperature(point: MetricPoint): number | null {
    const values = Object.values(point.temps);
    if (values.length === 0) return null;
    return Math.max(...values);
  }

  function parseMetricTimestamp(value: string): number {
    const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
    return new Date(hasTimezone ? value : `${value}Z`).getTime();
  }
</script>

<div class="space-y-5">
  <div class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
    <div>
      <h1 class="text-3xl font-bold">Hardware Monitor</h1>
      <p class="mt-2 max-w-3xl text-sm text-muted-foreground">
        Real-time time-series metrics for RAM, CPU, GPU load, thermals, and task performance.
      </p>
    </div>
    <div class="flex flex-wrap gap-2">
      <div class="flex gap-1 rounded border border-[#444936] bg-[#2b2d2a] p-1">
        <button
          class="rounded px-3 py-2 text-xs {view === 'live' ? 'bg-[#4a4d49] text-lemon' : 'text-[#e3e5d3] hover:bg-[#363935]'}"
          type="button"
          on:click={() => (view = 'live')}
        >
          Live
        </button>
        <button
          class="rounded px-3 py-2 text-xs {view === 'history' ? 'bg-[#4a4d49] text-lemon' : 'text-[#e3e5d3] hover:bg-[#363935]'}"
          type="button"
          on:click={showHistory}
        >
          History
        </button>
      </div>

      {#if view === 'live'}
        <div class="flex gap-1 rounded border border-[#444936] bg-[#2b2d2a] p-1">
          {#each ranges as range}
            <button
              class="rounded px-3 py-2 ops-mono text-xs {$timeRange === range ? 'bg-[#4a4d49] text-lemon' : 'text-[#e3e5d3] hover:bg-[#363935]'}"
              type="button"
              on:click={() => setTimeRange(range)}
            >
              {range}m
            </button>
          {/each}
        </div>
        <button class="ops-button" type="button" on:click={toggleMetricsPause}>
          {#if $metricsPaused}<Play class="h-4 w-4" /> Resume{:else}<Pause class="h-4 w-4" /> Pause{/if}
        </button>
        <button class="ops-button" type="button" on:click={loadMetrics} disabled={$metricsLoading}>
          <RefreshCw class="h-4 w-4 {$metricsLoading ? 'animate-spin' : ''}" />
          Refresh
        </button>
      {:else}
        <div class="flex gap-1 rounded border border-[#444936] bg-[#2b2d2a] p-1">
          {#each HISTORY_RANGES as range}
            <button
              class="rounded px-3 py-2 ops-mono text-xs {$historyRange === range ? 'bg-[#4a4d49] text-lemon' : 'text-[#e3e5d3] hover:bg-[#363935]'}"
              type="button"
              on:click={() => setHistoryRange(range)}
            >
              {rangeLabel(range)}
            </button>
          {/each}
        </div>
        <button class="ops-button" type="button" on:click={() => loadSeries()} disabled={$seriesLoading}>
          <RefreshCw class="h-4 w-4 {$seriesLoading ? 'animate-spin' : ''}" />
          Refresh
        </button>
      {/if}

      <button class="ops-button" type="button" on:click={() => exportTasksCsv(view === 'history' ? $historyRange : undefined)}>
        <Download class="h-4 w-4" />
        Export CSV
      </button>
      <button class="ops-button ops-button-danger" type="button" on:click={clearMetricsHistory}>
        <Trash2 class="h-4 w-4" />
        Clear
      </button>
    </div>
  </div>

  <section class="ops-panel px-4 py-3">
    <div class="flex flex-wrap gap-x-8 gap-y-2 text-sm">
      {#if view === 'live'}
        <span class="ops-muted">Stream: <span class="ops-value {$metricsWsConnected ? 'text-status-ok' : 'text-status-warn'}">{$metricsWsConnected ? 'live' : 'offline'}</span></span>
        <span class="ops-muted">Samples: <span class="ops-value">{$timeSeriesData.length}</span></span>
        <span class="ops-muted">Tasks: <span class="ops-value">{$taskHistory.length}</span></span>
      {:else}
        <span class="ops-muted">Window: <span class="ops-value">{rangeLabel($historyRange)}</span></span>
        <span class="ops-muted">Runs: <span class="ops-value">{seriesRuns}</span></span>
        <span class="ops-muted">Buckets: <span class="ops-value">{$taskSeries.length}</span></span>
        <span class="ops-muted">Samples: <span class="ops-value">{$hardwareSeries.length}</span></span>
      {/if}
    </div>
  </section>

  <section class="ops-panel p-5">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="ops-title">Telemetry Providers</h2>
        <p class="ops-subtitle">Every metric reports provenance and quality. Activity correlation does not prove accelerator ownership.</p>
      </div>
      <button class="ops-button" type="button" on:click={loadTelemetryProviders}><RefreshCw class="h-4 w-4" /> Providers</button>
    </div>
    {#if telemetry}
      <div class="mt-4 grid gap-3 lg:grid-cols-3">
        {#each telemetry.samples as sample}
          <article class="border border-[#34382d] bg-[#111312] p-4">
            <div class="flex items-center justify-between gap-2">
              <h3 class="ops-value">{sample.provider_label}</h3>
              <span class="ops-badge {sample.quality === 'measured' ? 'ops-badge-ok' : sample.quality === 'unsupported' ? '' : 'ops-badge-danger'}">{sample.quality}</span>
            </div>
            <p class="mt-2 text-xs text-muted-foreground">{sample.error ?? `${sample.metrics.length} metrics`}</p>
          </article>
        {/each}
      </div>
      <p class="mt-4 text-xs text-status-warn">{telemetry.ownership_note}</p>
    {:else}
      <p class="mt-4 text-sm text-muted-foreground">Provider status is unavailable.</p>
    {/if}
  </section>

  {#if view === 'live'}
  <section class="grid grid-cols-1 gap-4 xl:grid-cols-2">
    <ChartPanel title="RAM" value={latest($timeSeriesData) ? `${latest($timeSeriesData)?.ram_used.toFixed(1)} / ${latest($timeSeriesData)?.ram_total.toFixed(1)} GB` : 'No data'}>
      <SvgLineChart title="RAM usage" values={ramValues} {labels} yMax={ramTotal || null} unit=" GB" />
    </ChartPanel>

    <ChartPanel title="CPU" value={latest($timeSeriesData) ? `${latest($timeSeriesData)?.cpu_pct.toFixed(1)}%` : 'No data'}>
      <SvgLineChart title="CPU usage" values={cpuValues} {labels} yMax={100} unit="%" color="#40f078" />
    </ChartPanel>

    <ChartPanel title="Temperature" value={tempValues.at(-1) !== undefined ? `${tempValues.at(-1)?.toFixed(1)} C` : 'No sensors'}>
      <SvgLineChart title="Temperature" values={tempValues} {labels} yMax={100} unit=" C" color="#f2c94c" />
    </ChartPanel>

    <ChartPanel title="GPU Load" value={gpuValues.at(-1) !== undefined ? `${gpuValues.at(-1)?.toFixed(1)}%${gpuTempValues.at(-1) !== undefined ? ` / ${gpuTempValues.at(-1)?.toFixed(1)} C` : ''}` : 'No data'}>
      <SvgLineChart title="GPU load" values={gpuValues} {labels} yMax={100} unit="%" color="#ffb84d" />
    </ChartPanel>

    <ChartPanel title="TPS per Task" value={tpsValues.at(-1) !== undefined ? `${tpsValues.at(-1)?.toFixed(1)} t/s` : 'No tasks'}>
      <SvgBarChart title="TPS per task" values={tpsValues} labels={taskLabels} unit=" t/s" color="#d8ff00" />
    </ChartPanel>

    <ChartPanel title="TTFT per Task" value={ttftValues.at(-1) !== undefined ? `${ttftValues.at(-1)?.toFixed(2)}s` : 'No tasks'}>
      <SvgBarChart title="TTFT per task" values={ttftValues} labels={taskLabels} unit="s" color="#ffb0a8" />
    </ChartPanel>

    <div class="xl:col-span-2">
      <ChartPanel title="Token Throughput" value={throughputValues.at(-1) !== undefined ? `${throughputValues.at(-1)} output tokens` : 'No tasks'}>
        <SvgLineChart title="Output tokens per task" values={throughputValues} labels={taskLabels} color="#efff7a" />
      </ChartPanel>
    </div>
  </section>
  {:else}
  <section class="space-y-4">
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      <article class="ops-card p-5">
        <span class="ops-label">Runs</span>
        <p class="mt-4 ops-value text-3xl font-bold">{$taskSeriesSummary?.count ?? 0}</p>
        <p class="mt-3 text-sm text-muted-foreground">over the last {rangeLabel($historyRange)}</p>
      </article>
      <article class="ops-card p-5">
        <span class="ops-label">Mean Generation</span>
        <p class="mt-4 ops-value text-3xl font-bold">{$taskSeriesSummary?.count ? $taskSeriesSummary.gen_tps_mean.toFixed(1) : '--'}<span class="text-base">&nbsp;t/s</span></p>
        <p class="mt-3 text-sm text-muted-foreground">across every run in the window</p>
      </article>
      <article class="ops-card p-5">
        <span class="ops-label">p95 Generation</span>
        <p class="mt-4 ops-value text-3xl font-bold">{$taskSeriesSummary?.count ? $taskSeriesSummary.gen_tps_p95.toFixed(1) : '--'}<span class="text-base">&nbsp;t/s</span></p>
        <p class="mt-3 text-sm text-muted-foreground">95th percentile of the raw runs</p>
      </article>
      <article class="ops-card p-5">
        <span class="ops-label">Slowest Bucket p50</span>
        <p class="mt-4 ops-value text-3xl font-bold">{slowestP50?.toFixed(1) ?? '--'}<span class="text-base">&nbsp;t/s</span></p>
        <p class="mt-3 text-sm text-muted-foreground">the dip worth investigating</p>
      </article>
    </div>

    {#if $seriesLoading && !$seriesLoaded}
      <section class="ops-panel p-8 text-center text-sm text-muted-foreground">Loading history...</section>
    {:else if $taskSeries.length === 0 && $hardwareSeries.length === 0}
      <section class="ops-panel p-8 text-center">
        <p class="ops-value">No history recorded in this window</p>
        <p class="mt-2 text-sm text-muted-foreground">
          The background sampler records every completed inference and one hardware
          rollup per minute. Pick a longer range, or come back once the server has run some work.
        </p>
      </section>
    {:else}
      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div class="xl:col-span-2">
          <ChartPanel title="Generation Speed" value={scatterPoints.length ? `${rangeLabel($historyRange)} - ${scatterHeadline}` : 'No runs'}>
            <SvgScatterChart
              title={scatterMode === 'run' ? 'Generation speed per run' : 'Mean generation speed per bucket'}
              points={scatterPoints}
              {tickFormat}
              start={scatterWindow.start}
              end={scatterWindow.end}
              unit=" t/s"
              color="#d8ff00"
              heightClass="h-64"
              sizeLabel={scatterMode === 'run' ? 'output tokens' : `output tokens per ${bucketWidth}`}
              valueLabel={scatterMode === 'run' ? '' : 'mean'}
              footnote={scatterFootnote}
            />
          </ChartPanel>
        </div>

        <ChartPanel title="Generation p50" value={slowestP50 !== null ? `low ${slowestP50.toFixed(1)} t/s` : 'No runs'}>
          <SvgLineChart title="Median generation speed per bucket" values={seriesTpsP50} timestamps={seriesTimestamps} counts={seriesCounts} {tickFormat} start={$taskWindow.start} end={$taskWindow.end} bucketSeconds={$taskWindow.bucketSeconds} axes interactive showFooter={false} unit=" t/s" color="#40f078" />
        </ChartPanel>

        <ChartPanel title="Generation p95" value={$taskSeriesSummary?.count ? `window ${$taskSeriesSummary.gen_tps_p95.toFixed(1)} t/s` : 'No runs'}>
          <SvgLineChart title="95th percentile generation speed per bucket" values={seriesTpsP95} timestamps={seriesTimestamps} counts={seriesCounts} {tickFormat} start={$taskWindow.start} end={$taskWindow.end} bucketSeconds={$taskWindow.bucketSeconds} axes interactive showFooter={false} unit=" t/s" color="#ffb84d" />
        </ChartPanel>

        <ChartPanel title="TTFT (mean)" value={$taskSeriesSummary?.count ? `${$taskSeriesSummary.ttft_mean.toFixed(2)}s` : 'No runs'}>
          <SvgLineChart title="Mean time to first token per bucket" values={seriesTtft} timestamps={seriesTimestamps} counts={seriesCounts} {tickFormat} start={$taskWindow.start} end={$taskWindow.end} bucketSeconds={$taskWindow.bucketSeconds} axes interactive showFooter={false} unit="s" color="#ffb0a8" />
        </ChartPanel>

        <ChartPanel title="Tokens per Bucket" value={$taskSeriesSummary?.count ? `${$taskSeriesSummary.total_tokens} total` : 'No runs'}>
          <SvgBarChart title="Total tokens per bucket" values={seriesTokens} timestamps={seriesTimestamps} counts={seriesCounts} {tickFormat} start={$taskWindow.start} end={$taskWindow.end} bucketSeconds={$taskWindow.bucketSeconds} axes interactive showFooter={false} color="#efff7a" />
        </ChartPanel>

        <ChartPanel title="RAM (mean / peak)" value={hardwareRam.length ? `${hardwareRam.at(-1)?.toFixed(1)}% / ${Math.max(...hardwareRamPeak).toFixed(1)}%` : 'No samples'}>
          <SvgLineChart title="Mean RAM percentage per bucket" values={hardwareRam} timestamps={hardwareTimestamps} counts={hardwareCounts} {tickFormat} countLabel="sample" start={$hardwareWindow.start} end={$hardwareWindow.end} bucketSeconds={$hardwareWindow.bucketSeconds} axes interactive showFooter={false} yMax={100} unit="%" color="#76a9ff" />
        </ChartPanel>

        <ChartPanel title="CPU (mean)" value={hardwareCpu.length ? `${hardwareCpu.at(-1)?.toFixed(1)}%` : 'No samples'}>
          <SvgLineChart title="Mean CPU percentage per bucket" values={hardwareCpu} timestamps={hardwareTimestamps} counts={hardwareCounts} {tickFormat} countLabel="sample" start={$hardwareWindow.start} end={$hardwareWindow.end} bucketSeconds={$hardwareWindow.bucketSeconds} axes interactive showFooter={false} yMax={100} unit="%" color="#40f078" />
        </ChartPanel>

        {#if hardwareGpu.length > 0}
          <div class="xl:col-span-2">
            <ChartPanel title="GPU Load (mean)" value={`${hardwareGpu.at(-1)?.toFixed(1)}%`}>
              <SvgLineChart title="Mean GPU load per bucket" values={hardwareGpu} timestamps={hardwareGpuTimestamps} counts={hardwareGpuCounts} {tickFormat} countLabel="sample" start={$hardwareWindow.start} end={$hardwareWindow.end} bucketSeconds={$hardwareWindow.bucketSeconds} axes interactive showFooter={false} yMax={100} unit="%" color="#c28cff" heightClass="h-52" />
            </ChartPanel>
          </div>
        {/if}
      </div>
    {/if}
  </section>
  {/if}
</div>
