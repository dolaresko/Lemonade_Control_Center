<script lang="ts">
  import {
    formatTick,
    formatTooltipTimestamp,
    formatValue,
    inferBucketMs,
    nearestTimeIndex,
    niceScale,
    timeSegments,
    timeTicks,
    xTicks,
    xTickTarget,
    type TickFormat,
  } from '$lib/utils/chart';

  export let values: number[] = [];
  export let labels: string[] = [];
  export let yMax: number | null = null;
  export let color = '#d8ff00';
  export let unit = '';
  export let title = 'Chart';
  export let heightClass = 'h-48';
  export let showFooter = true;

  // ── Opt-in trend-chart behaviour ──
  // Everything below defaults off, so the existing callers keep rendering the
  // plain sparkline they render today.

  /** Draw a labelled zero-based y axis and x ticks. */
  export let axes = false;
  /** Enable crosshair, tooltip, keyboard traversal and tap-to-inspect. */
  export let interactive = false;
  /**
   * ISO timestamp per point. Supplying one per value switches the x axis from
   * index positions to a linear time scale.
   */
  export let timestamps: string[] = [];
  /** Runs behind each point, reported in the tooltip. */
  export let counts: number[] = [];
  /** Axis label style: HH:mm for short ranges, day and month for long ones. */
  export let tickFormat: TickFormat = 'time';
  /** What `counts` counts, singular. Task buckets hold runs, hardware samples. */
  export let countLabel = 'run';
  /**
   * Requested window. The domain is the window the user asked for, not the
   * extent of the data, so a range whose only activity is in its last hour
   * shows that hour at the right edge with empty space before it.
   */
  export let start: string | null = null;
  export let end: string | null = null;
  /**
   * Server bucket width. Used to tell a real gap from adjacent buckets;
   * inferred from the timestamps when absent.
   */
  export let bucketSeconds: number | null = null;

  let plotBox: HTMLDivElement;
  let activeIndex: number | null = null;
  let pointerInside = false;

  // Measured so the viewBox maps 1:1 to CSS pixels. Without it
  // preserveAspectRatio="none" stretches the axis text out of shape.
  let boxWidth = 640;
  let boxHeight = 180;

  $: hasData = values.length > 0;
  $: showAxes = axes && hasData;
  // Empty ranges get no handlers at all, per the brief.
  $: interactiveNow = interactive && hasData;

  // ── Time scale ──
  $: times = timestamps.map((value) => Date.parse(value));
  // Callers that pass no timestamps keep the original index positioning.
  $: useTimeAxis =
    hasData && times.length === values.length && times.every((time) => Number.isFinite(time));

  $: domainStart = useTimeAxis ? (parseBoundary(start) ?? times[0]) : 0;
  $: domainEnd = useTimeAxis ? (parseBoundary(end) ?? times[times.length - 1]) : 1;
  // A zero-width domain (one bucket, no window given) would divide by zero;
  // fall back to the bucket width so the single point lands mid-plot.
  $: domainSpan = domainEnd > domainStart ? domainEnd - domainStart : 0;

  $: bucketMs = bucketSeconds && bucketSeconds > 0 ? bucketSeconds * 1000 : inferBucketMs(times);
  // Index mode has no notion of a gap, so it stays one unbroken run.
  $: segments = useTimeAxis
    ? timeSegments(times, bucketMs)
    : hasData
      ? [values.map((_, index) => index)]
      : [];

  // Axis gutters only where there are labels to fit; the sparkline keeps the
  // symmetric padding it has always used.
  $: padLeft = showAxes ? 46 : 18;
  $: padRight = showAxes ? 14 : 18;
  $: padTop = showAxes ? (unit.trim() ? 26 : 14) : 18;
  $: padBottom = showAxes ? 28 : 18;

  $: width = Math.max(boxWidth, 120);
  $: height = Math.max(boxHeight, 60);
  $: plotWidth = Math.max(width - padLeft - padRight, 1);
  $: plotHeight = Math.max(height - padTop - padBottom, 1);

  $: dataMax = hasData ? Math.max(0, ...values) : 0;
  $: scale = niceScale(yMax ?? dataMax, 4);
  // An explicit yMax stays the ceiling. Without one, the axis rounds up to a
  // tidy gridline -- but only when axes are drawn, so the plain sparkline keeps
  // scaling to the raw maximum exactly as it always has.
  $: axisMax = yMax && yMax > 0 ? yMax : showAxes ? Math.max(scale.max, 1) : Math.max(1, dataMax);
  $: gridTicks = showAxes ? scale.ticks.filter((tick) => tick <= axisMax) : [];

  $: tickTarget = xTickTarget(plotWidth);
  $: axisTimeTicks =
    showAxes && useTimeAxis ? timeTicks(domainStart, domainEnd, tickTarget, tickFormat) : [];
  $: axisIndexTicks = showAxes && !useTimeAxis ? xTicks(values.length, tickTarget) : [];

  $: lastIndex = values.length - 1;
  $: latest = values.at(-1);

  $: activeValue = activeIndex === null ? undefined : values[activeIndex];
  $: activeX = activeIndex === null ? 0 : pointX(activeIndex);
  $: activeY = activeValue === undefined ? 0 : pointY(activeValue);
  $: activeCount = activeIndex === null ? undefined : counts[activeIndex];
  $: activeLabel =
    activeIndex === null
      ? ''
      : timestamps[activeIndex]
        ? formatTooltipTimestamp(timestamps[activeIndex])
        : (labels[activeIndex] ?? '');
  // Flip the tooltip left of the crosshair near the right edge so it never
  // spills outside the panel.
  $: tooltipFlipped = activeX > padLeft + plotWidth * 0.6;
  // Announced to screen readers as the selection moves.
  $: liveDescription =
    activeIndex !== null && activeValue !== undefined
      ? `${title}. ${activeLabel}: ${formatValue(activeValue, unit)}${activeCount !== undefined ? `, ${activeCount} ${activeCount === 1 ? countLabel : `${countLabel}s`}` : ''}`
      : `${title}. Use arrow keys to inspect data points.`;

  function parseBoundary(value: string | null): number | null {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /** Map epoch milliseconds onto the plot. */
  function timeX(time: number): number {
    if (domainSpan <= 0) return padLeft + plotWidth / 2;
    const ratio = (time - domainStart) / domainSpan;
    return padLeft + Math.min(Math.max(ratio, 0), 1) * plotWidth;
  }

  function pointX(index: number): number {
    if (useTimeAxis) return timeX(times[index]);
    return values.length <= 1
      ? padLeft + plotWidth / 2
      : padLeft + (index / (values.length - 1)) * plotWidth;
  }

  function pointY(value: number): number {
    const clamped = Math.min(Math.max(0, value), axisMax);
    return padTop + plotHeight - (clamped / axisMax) * plotHeight;
  }

  function segmentPoints(segment: number[]): string {
    return segment.map((index) => `${pointX(index)},${pointY(values[index])}`).join(' ');
  }

  function nearestIndex(clientX: number): number {
    if (values.length <= 1) return 0;
    const bounds = plotBox?.getBoundingClientRect();
    if (!bounds || bounds.width === 0) return 0;
    // The viewBox is 1:1 with the box, but guard against a CSS transform.
    const viewX = ((clientX - bounds.left) * width) / bounds.width;
    const ratio = (viewX - padLeft) / plotWidth;
    if (useTimeAxis) {
      // Snap in time space: with gaps present, index space no longer matches
      // what the reader sees under the pointer.
      return nearestTimeIndex(times, domainStart + Math.min(Math.max(ratio, 0), 1) * domainSpan);
    }
    return Math.min(Math.max(Math.round(ratio * lastIndex), 0), lastIndex);
  }

  function handlePointer(event: PointerEvent) {
    if (!interactiveNow) return;
    pointerInside = true;
    activeIndex = nearestIndex(event.clientX);
  }

  function handlePointerLeave() {
    pointerInside = false;
    // Keep the readout while the chart still holds keyboard focus.
    if (typeof document !== 'undefined' && document.activeElement === plotBox) return;
    activeIndex = null;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!interactiveNow) return;
    // Arrow keys walk real data points, so an empty stretch is stepped over
    // rather than traversed.
    let next = activeIndex;
    if (event.key === 'ArrowRight') next = activeIndex === null ? 0 : Math.min(activeIndex + 1, lastIndex);
    else if (event.key === 'ArrowLeft') next = activeIndex === null ? lastIndex : Math.max(activeIndex - 1, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = lastIndex;
    else if (event.key === 'Escape') next = null;
    else return;

    event.preventDefault();
    activeIndex = next;
  }

  function handleFocus() {
    if (interactiveNow && activeIndex === null) activeIndex = lastIndex;
  }

  function handleBlur() {
    if (!pointerInside) activeIndex = null;
  }
</script>

<div class="relative">
  <!-- role="application" on the focusable wrapper, so assistive tech forwards
       the arrow keys instead of swallowing them for its own navigation. The
       inner <svg> stays a plain image and is hidden while the wrapper speaks.
       The role is set conditionally, which the a11y rule cannot see, so it
       reads the element as non-interactive; the tabindex is deliberate. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="{heightClass} w-full {interactiveNow
      ? 'cursor-crosshair focus:outline-none focus-visible:ring-1 focus-visible:ring-[#d8ff00]'
      : ''}"
    bind:this={plotBox}
    bind:clientWidth={boxWidth}
    bind:clientHeight={boxHeight}
    role={interactiveNow ? 'application' : undefined}
    tabindex={interactiveNow ? 0 : undefined}
    aria-label={interactiveNow ? liveDescription : undefined}
    on:pointermove={handlePointer}
    on:pointerdown={handlePointer}
    on:pointerleave={handlePointerLeave}
    on:keydown={handleKeydown}
    on:focus={handleFocus}
    on:blur={handleBlur}
  >
    <svg
      class="h-full w-full"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={title}
      aria-hidden={interactiveNow ? 'true' : undefined}
    >
      {#if showAxes}
        <!-- Zero-based gridlines at round values, so the shape is not
             exaggerated by an unstated baseline. -->
        {#each gridTicks as tick}
          <line
            x1={padLeft}
            y1={pointY(tick)}
            x2={padLeft + plotWidth}
            y2={pointY(tick)}
            stroke="#3f432d"
            stroke-width="1"
            stroke-dasharray={tick === 0 ? '' : '2 4'}
            vector-effect="non-scaling-stroke"
          />
          <text x={padLeft - 8} y={pointY(tick) + 3} text-anchor="end" font-size="10" fill="#8b9178">
            {formatTick(tick)}
          </text>
        {/each}

        {#each axisTimeTicks as tick}
          <line
            x1={timeX(tick.time)}
            y1={padTop + plotHeight}
            x2={timeX(tick.time)}
            y2={padTop + plotHeight + 4}
            stroke="#3f432d"
            stroke-width="1"
            vector-effect="non-scaling-stroke"
          />
          <text
            x={timeX(tick.time)}
            y={padTop + plotHeight + 17}
            text-anchor="middle"
            font-size="10"
            fill="#8b9178"
          >
            {tick.label}
          </text>
        {/each}

        {#each axisIndexTicks as tick}
          <line
            x1={pointX(tick.position)}
            y1={padTop + plotHeight}
            x2={pointX(tick.position)}
            y2={padTop + plotHeight + 4}
            stroke="#3f432d"
            stroke-width="1"
            vector-effect="non-scaling-stroke"
          />
          <text
            x={pointX(tick.position)}
            y={padTop + plotHeight + 17}
            text-anchor={tick.index === 0 ? 'start' : tick.index === lastIndex ? 'end' : 'middle'}
            font-size="10"
            fill="#8b9178"
          >
            {labels[tick.index] ?? ''}
          </text>
        {/each}

        {#if unit.trim()}
          <text x={padLeft - 8} y={padTop - 13} text-anchor="end" font-size="9" fill="#8b9178">{unit.trim()}</text>
        {/if}
      {:else}
        <line x1={padLeft} y1={height - padBottom} x2={width - padRight} y2={height - padBottom} stroke="#3f432d" stroke-width="1" />
        <line x1={padLeft} y1={padTop} x2={padLeft} y2={height - padBottom} stroke="#3f432d" stroke-width="1" />
      {/if}

      <!-- One polyline per run of consecutive buckets: a gap in the data is
           left as a gap rather than bridged by an invented segment. A run of a
           single bucket has no line to draw, so it is marked with a dot. -->
      {#each segments as segment}
        {#if segment.length > 1}
          <polyline
            points={segmentPoints(segment)}
            fill="none"
            stroke={color}
            stroke-width="2.5"
            vector-effect="non-scaling-stroke"
          />
        {:else if segment.length === 1}
          <circle cx={pointX(segment[0])} cy={pointY(values[segment[0]])} r="3" fill={color} />
        {/if}
      {/each}

      {#if interactiveNow && activeIndex !== null && activeValue !== undefined}
        <line
          x1={activeX}
          y1={padTop}
          x2={activeX}
          y2={padTop + plotHeight}
          stroke="#8b9178"
          stroke-width="1"
          stroke-dasharray="3 3"
          vector-effect="non-scaling-stroke"
        />
        <circle cx={activeX} cy={activeY} r="4" fill={color} stroke="#111312" stroke-width="1.5" />
      {/if}
    </svg>
  </div>

  {#if interactiveNow && activeIndex !== null && activeValue !== undefined}
    <div
      class="pointer-events-none absolute top-1 z-10 min-w-32 rounded border border-[#596044] bg-[#0b0d0b] px-3 py-2 text-xs shadow-lg"
      style={tooltipFlipped
        ? `right: ${((width - activeX) / width) * 100}%; margin-right: 10px;`
        : `left: ${(activeX / width) * 100}%; margin-left: 10px;`}
    >
      <p class="text-muted-foreground">{activeLabel}</p>
      <p class="ops-value mt-1 text-sm">{formatValue(activeValue, unit)}</p>
      {#if activeCount !== undefined}
        <p class="mt-1 text-muted-foreground">{activeCount} {activeCount === 1 ? countLabel : `${countLabel}s`}</p>
      {/if}
    </div>
  {/if}

  {#if showFooter}
    <div class="mt-2 flex justify-between text-xs text-muted-foreground">
      <span>{labels[0] ?? 'start'}</span>
      <span>{latest !== undefined ? `${latest.toFixed(1)}${unit}` : 'No data'}</span>
      <span>{labels.at(-1) ?? 'now'}</span>
    </div>
  {/if}
</div>
