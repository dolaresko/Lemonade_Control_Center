<script lang="ts">
  import {
    formatAxisLabel,
    formatTick,
    formatTooltipTimestamp,
    formatValue,
    niceScale,
    xTicks,
    xTickTarget,
    type TickFormat,
  } from '$lib/utils/chart';

  export let values: number[] = [];
  export let labels: string[] = [];
  export let color = '#d8ff00';
  export let unit = '';
  export let title = 'Bar chart';
  export let heightClass = 'h-48';
  export let showFooter = true;

  // ── Opt-in trend-chart behaviour, mirroring SvgLineChart ──
  export let axes = false;
  export let interactive = false;
  export let timestamps: string[] = [];
  export let counts: number[] = [];
  export let tickFormat: TickFormat = 'time';
  /** What `counts` counts, singular. Task buckets hold runs, hardware samples. */
  export let countLabel = 'run';

  let plotBox: HTMLDivElement;
  let activeIndex: number | null = null;
  let pointerInside = false;

  let boxWidth = 640;
  let boxHeight = 180;

  $: hasData = values.length > 0;
  $: showAxes = axes && hasData;
  $: interactiveNow = interactive && hasData;

  $: padLeft = showAxes ? 46 : 18;
  $: padRight = showAxes ? 14 : 18;
  $: padTop = showAxes ? (unit.trim() ? 26 : 14) : 18;
  $: padBottom = showAxes ? 28 : 18;

  $: width = Math.max(boxWidth, 120);
  $: height = Math.max(boxHeight, 60);
  $: plotWidth = Math.max(width - padLeft - padRight, 1);
  $: plotHeight = Math.max(height - padTop - padBottom, 1);

  $: dataMax = values.length ? Math.max(0, ...values) : 0;
  $: scale = niceScale(dataMax, 4);
  // Rounded gridline max with axes on; raw max otherwise, so existing
  // sparkline callers keep the bar heights they render today.
  $: axisMax = showAxes ? Math.max(scale.max, 1) : Math.max(1, dataMax);
  $: gridTicks = showAxes ? scale.ticks : [];
  $: xAxisTicks = showAxes ? xTicks(values.length, xTickTarget(plotWidth)) : [];

  $: lastIndex = values.length - 1;
  $: barWidth = values.length ? plotWidth / values.length : 0;

  $: activeValue = activeIndex === null ? undefined : values[activeIndex];
  $: activeCount = activeIndex === null ? undefined : counts[activeIndex];
  $: activeCentre = activeIndex === null ? 0 : barCentre(activeIndex);
  $: activeLabel =
    activeIndex === null
      ? ''
      : timestamps[activeIndex]
        ? formatTooltipTimestamp(timestamps[activeIndex])
        : (labels[activeIndex] ?? '');
  $: tooltipFlipped = activeCentre > padLeft + plotWidth * 0.6;
  $: liveDescription =
    activeIndex !== null && activeValue !== undefined
      ? `${title}. ${activeLabel}: ${formatValue(activeValue, unit)}${activeCount !== undefined ? `, ${activeCount} ${activeCount === 1 ? countLabel : countLabel + 's'}` : ''}`
      : `${title}. Use arrow keys to inspect data points.`;

  function barCentre(index: number): number {
    return padLeft + index * barWidth + barWidth / 2;
  }

  function barHeight(value: number): number {
    return (Math.min(Math.max(0, value), axisMax) / axisMax) * plotHeight;
  }

  function tickY(tick: number): number {
    return padTop + plotHeight - (tick / axisMax) * plotHeight;
  }

  function nearestIndex(clientX: number): number {
    if (values.length <= 1) return 0;
    const bounds = plotBox?.getBoundingClientRect();
    if (!bounds || bounds.width === 0) return 0;
    const viewX = ((clientX - bounds.left) * width) / bounds.width;
    const index = Math.floor((viewX - padLeft) / barWidth);
    return Math.min(Math.max(index, 0), lastIndex);
  }

  function handlePointer(event: PointerEvent) {
    if (!interactiveNow) return;
    pointerInside = true;
    activeIndex = nearestIndex(event.clientX);
  }

  function handlePointerLeave() {
    pointerInside = false;
    if (typeof document !== 'undefined' && document.activeElement === plotBox) return;
    activeIndex = null;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!interactiveNow) return;
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
  <!-- See SvgLineChart: the conditional role hides the interactive intent from
       the a11y rule, so the deliberate tabindex is suppressed there. -->
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
        {#each gridTicks as tick}
          <line
            x1={padLeft}
            y1={tickY(tick)}
            x2={padLeft + plotWidth}
            y2={tickY(tick)}
            stroke="#3f432d"
            stroke-width="1"
            stroke-dasharray={tick === 0 ? '' : '2 4'}
            vector-effect="non-scaling-stroke"
          />
          <text x={padLeft - 8} y={tickY(tick) + 3} text-anchor="end" font-size="10" fill="#8b9178">
            {formatTick(tick)}
          </text>
        {/each}

        {#each xAxisTicks as tick}
          <text
            x={barCentre(tick.position)}
            y={padTop + plotHeight + 17}
            text-anchor={tick.index === 0 ? 'start' : tick.index === lastIndex ? 'end' : 'middle'}
            font-size="10"
            fill="#8b9178"
          >
            {timestamps[tick.index] ? formatAxisLabel(timestamps[tick.index], tickFormat) : (labels[tick.index] ?? '')}
          </text>
        {/each}

        {#if unit.trim()}
          <text x={padLeft - 8} y={padTop - 13} text-anchor="end" font-size="9" fill="#8b9178">{unit.trim()}</text>
        {/if}
      {:else}
        <line x1={padLeft} y1={height - padBottom} x2={width - padRight} y2={height - padBottom} stroke="#3f432d" stroke-width="1" />
      {/if}

      {#each values as value, index}
        <rect
          x={padLeft + index * barWidth + 2}
          y={padTop + plotHeight - barHeight(value)}
          width={Math.max(2, barWidth - 4)}
          height={barHeight(value)}
          fill={color}
          opacity={activeIndex === null || activeIndex === index ? 0.88 : 0.4}
        />
      {/each}
    </svg>
  </div>

  {#if interactiveNow && activeIndex !== null && activeValue !== undefined}
    <div
      class="pointer-events-none absolute top-1 z-10 min-w-32 rounded border border-[#596044] bg-[#0b0d0b] px-3 py-2 text-xs shadow-lg"
      style={tooltipFlipped
        ? `right: ${((width - activeCentre) / width) * 100}%; margin-right: 10px;`
        : `left: ${(activeCentre / width) * 100}%; margin-left: 10px;`}
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
      <span>{values.at(-1) !== undefined ? `${values.at(-1)?.toFixed(1)}${unit}` : 'No data'}</span>
      <span>{labels.at(-1) ?? 'latest'}</span>
    </div>
  {/if}
</div>
