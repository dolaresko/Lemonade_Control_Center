<script lang="ts">
  import {
    formatTick,
    formatValue,
    markRadius,
    MARK_HIT_RADIUS,
    MARK_RADIUS_MAX,
    nearestMarkIndex,
    niceScale,
    sizeKeySteps,
    timeTicks,
    xTickTarget,
    type ScatterPoint,
    type TickFormat,
  } from '$lib/utils/chart';

  /**
   * Discrete events plotted against time. Nothing is joined up: a run is a
   * thing that happened at an instant, and a line between two of them would
   * claim a continuity that the minutes or hours between them do not have.
   */
  export let points: ScatterPoint[] = [];
  export let title = 'Chart';
  export let unit = '';
  export let color = '#d8ff00';
  /** Panel background. Every mark carries a ring in it, so overlapping marks
   *  stay countable instead of merging into one blob. */
  export let surface = '#171918';
  export let heightClass = 'h-64';
  export let tickFormat: TickFormat = 'time';
  /** Requested window. The domain is what the user asked for, not the extent
   *  of the data, so a quiet range still reads as a quiet range. */
  export let start: string | null = null;
  export let end: string | null = null;
  export let yMax: number | null = null;
  /** What the mark area encodes, for the size key caption. */
  export let sizeLabel = 'output tokens';
  /** Qualifies the tooltip's headline number, e.g. "mean" for a bucket. */
  export let valueLabel = '';
  /** Which mode is active, plus anything dropped from the plot. */
  export let footnote = '';

  let plotBox: HTMLDivElement;
  let activeIndex: number | null = null;
  let pointerInside = false;

  // Measured so the viewBox maps 1:1 to CSS pixels: with preserveAspectRatio
  //="none" and a mismatched box, circles would render as ellipses.
  let boxWidth = 640;
  let boxHeight = 240;

  // Time order is the traversal order, and later marks draw over earlier ones.
  $: marks = [...points].sort((left, right) => left.time - right.time);
  $: hasData = marks.length > 0;
  $: lastIndex = marks.length - 1;

  $: domainStart = parseBoundary(start) ?? (hasData ? marks[0].time : 0);
  $: domainEnd = parseBoundary(end) ?? (hasData ? marks[lastIndex].time : 1);
  $: domainSpan = domainEnd > domainStart ? domainEnd - domainStart : 0;

  $: padLeft = 46;
  $: padRight = 18;
  $: padTop = unit.trim() ? 26 : 14;
  $: padBottom = 28;

  $: width = Math.max(boxWidth, 120);
  $: height = Math.max(boxHeight, 60);
  $: plotWidth = Math.max(width - padLeft - padRight, 1);
  $: plotHeight = Math.max(height - padTop - padBottom, 1);

  $: dataMax = hasData ? Math.max(...marks.map((mark) => mark.value)) : 0;
  $: scale = niceScale(yMax ?? dataMax, 4);
  $: axisMax = yMax && yMax > 0 ? yMax : Math.max(scale.max, 1);
  // An empty window gets no value axis: labelling 0 .. 1 t/s would put a
  // scale on a plot that has nothing to scale.
  $: gridTicks = hasData ? scale.ticks.filter((tick) => tick <= axisMax) : [];

  $: axisTimeTicks = hasData
    ? timeTicks(domainStart, domainEnd, xTickTarget(plotWidth), tickFormat)
    : [];

  $: magnitudes = marks.map((mark) => mark.magnitude);
  $: magnitudeMax = magnitudes.length ? Math.max(...magnitudes) : 0;
  $: radii = magnitudes.map((magnitude) => markRadius(magnitude, magnitudeMax));
  $: markXs = marks.map((mark) => timeX(mark.time));
  $: markYs = marks.map((mark) => pointY(mark.value));
  $: keySteps = sizeKeySteps(magnitudes);

  $: active = activeIndex === null ? null : marks[activeIndex];
  $: activeX = activeIndex === null ? 0 : markXs[activeIndex];
  $: activeY = activeIndex === null ? 0 : markYs[activeIndex];
  // Flip the tooltip to the left of the mark near the right edge so it never
  // spills outside the panel.
  $: tooltipFlipped = activeX > padLeft + plotWidth * 0.6;
  $: liveDescription = active
    ? `${title}. ${active.label}: ${formatValue(active.value, unit)}. ${active.rows
        .map((row) => `${row.label} ${row.value}`)
        .join(', ')}`
    : `${title}. ${marks.length} points. Use arrow keys to inspect them in time order.`;

  function parseBoundary(value: string | null): number | null {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /** Map epoch milliseconds onto the plot, linear in time. */
  function timeX(time: number): number {
    if (domainSpan <= 0) return padLeft + plotWidth / 2;
    const ratio = (time - domainStart) / domainSpan;
    return padLeft + Math.min(Math.max(ratio, 0), 1) * plotWidth;
  }

  function pointY(value: number): number {
    const clamped = Math.min(Math.max(0, value), axisMax);
    return padTop + plotHeight - (clamped / axisMax) * plotHeight;
  }

  /** Pointer position in viewBox units. */
  function viewPosition(event: PointerEvent): { x: number; y: number } | null {
    const bounds = plotBox?.getBoundingClientRect();
    if (!bounds || bounds.width === 0 || bounds.height === 0) return null;
    return {
      x: ((event.clientX - bounds.left) * width) / bounds.width,
      y: ((event.clientY - bounds.top) * height) / bounds.height,
    };
  }

  function handlePointer(event: PointerEvent) {
    if (!hasData) return;
    pointerInside = true;
    const position = viewPosition(event);
    if (!position) return;
    activeIndex = nearestMarkIndex(markXs, markYs, position.x, position.y, MARK_HIT_RADIUS);
  }

  function handlePointerLeave() {
    pointerInside = false;
    // Keep the readout while the chart still holds keyboard focus.
    if (typeof document !== 'undefined' && document.activeElement === plotBox) return;
    activeIndex = null;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!hasData) return;
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
    if (hasData && activeIndex === null) activeIndex = lastIndex;
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
    class="{heightClass} w-full {hasData
      ? 'cursor-crosshair focus:outline-none focus-visible:ring-1 focus-visible:ring-[#d8ff00]'
      : ''}"
    bind:this={plotBox}
    bind:clientWidth={boxWidth}
    bind:clientHeight={boxHeight}
    role={hasData ? 'application' : undefined}
    tabindex={hasData ? 0 : undefined}
    aria-label={hasData ? liveDescription : undefined}
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
      aria-hidden={hasData ? 'true' : undefined}
    >
      {#if !hasData}
        <line x1={padLeft} y1={padTop + plotHeight} x2={padLeft + plotWidth} y2={padTop + plotHeight} stroke="#3f432d" stroke-width="1" />
        <line x1={padLeft} y1={padTop} x2={padLeft} y2={padTop + plotHeight} stroke="#3f432d" stroke-width="1" />
      {/if}

      <!-- Hairline solid gridlines. Dashes read as marks of their own, and on
           a scatter they compete with the data for attention. -->
      {#each gridTicks as tick}
        <line
          x1={padLeft}
          y1={pointY(tick)}
          x2={padLeft + plotWidth}
          y2={pointY(tick)}
          stroke="#3f432d"
          stroke-width="1"
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

      {#if unit.trim() && hasData}
        <text x={padLeft - 8} y={padTop - 13} text-anchor="end" font-size="9" fill="#8b9178">{unit.trim()}</text>
      {/if}

      <!-- One mark per event. The ring is drawn in the panel colour, so two
           runs seconds apart still read as two runs. -->
      {#each radii as radius, index}
        <circle
          cx={markXs[index]}
          cy={markYs[index]}
          r={radius}
          fill={color}
          fill-opacity="0.62"
          stroke={surface}
          stroke-width="2"
        />
      {/each}

      {#if active && activeIndex !== null}
        <!-- Redrawn on top: the selected mark may sit under a later one, and
             a highlight hidden behind its neighbour is no highlight. -->
        <circle
          cx={activeX}
          cy={activeY}
          r={radii[activeIndex]}
          fill={color}
          fill-opacity="0.95"
          stroke={surface}
          stroke-width="2"
        />
        <circle
          cx={activeX}
          cy={activeY}
          r={radii[activeIndex] + 3.5}
          fill="none"
          stroke={color}
          stroke-width="1.5"
          vector-effect="non-scaling-stroke"
        />
      {/if}
    </svg>
  </div>

  {#if active}
    <div
      class="pointer-events-none absolute top-1 z-10 min-w-40 rounded border border-[#596044] bg-[#0b0d0b] px-3 py-2 text-xs shadow-lg"
      style={tooltipFlipped
        ? `right: ${((width - activeX) / width) * 100}%; margin-right: 12px;`
        : `left: ${(activeX / width) * 100}%; margin-left: 12px;`}
    >
      <p class="text-muted-foreground">{active.label}</p>
      <p class="ops-value mt-1 text-sm">
        {formatValue(active.value, unit)}{#if valueLabel}<span class="ml-1 text-xs text-muted-foreground">{valueLabel}</span>{/if}
      </p>
      {#each active.rows as row}
        <p class="mt-1 flex justify-between gap-4 text-muted-foreground">
          <span>{row.label}</span>
          <span class="ops-value">{row.value}</span>
        </p>
      {/each}
    </div>
  {/if}

  <div class="mt-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-2 text-xs text-muted-foreground">
    {#if keySteps.length}
      <!-- Mandatory: size carries data here, and a size encoding without a
           reference cannot be read back to a number. -->
      <div class="flex items-end gap-4">
        <span class="pb-1">{sizeLabel}</span>
        {#each keySteps as step}
          <div class="flex flex-col items-center gap-1">
            <svg
              width={MARK_RADIUS_MAX * 2}
              height={MARK_RADIUS_MAX * 2}
              viewBox={`0 0 ${MARK_RADIUS_MAX * 2} ${MARK_RADIUS_MAX * 2}`}
              role="presentation"
            >
              <circle
                cx={MARK_RADIUS_MAX}
                cy={MARK_RADIUS_MAX}
                r={markRadius(step, magnitudeMax)}
                fill="none"
                stroke={color}
                stroke-width="1.5"
              />
            </svg>
            <span class="ops-mono">{step.toLocaleString('en-GB')}</span>
          </div>
        {/each}
      </div>
    {:else}
      <span></span>
    {/if}
    {#if footnote}
      <span class="pb-1 text-right">{footnote}</span>
    {/if}
  </div>
</div>
