<script lang="ts">
  import { onMount } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import type { Attachment } from 'svelte/attachments'
  import type { LivelineProps, LivelineSeries, Momentum, DegenOptions } from './types.js'
  import { resolveTheme, resolveSeriesPalettes, SERIES_COLORS } from './theme.js'
  import { createLivelineEngine, type EngineConfig } from './engine.js'

  const defaultFormatValue = (v: number) => v.toFixed(2)

  const defaultFormatTime = (t: number) => {
    const d = new Date(t * 1000)
    const h = d.getHours().toString().padStart(2, '0')
    const m = d.getMinutes().toString().padStart(2, '0')
    const s = d.getSeconds().toString().padStart(2, '0')
    return `${h}:${m}:${s}`
  }

  let {
    data,
    value,
    series: seriesProp,
    theme = 'dark',
    color = '#3b82f6',
    window: windowSecs = 30,
    now,
    grid = true,
    badge = true,
    momentum = true,
    fill = true,
    scrub = true,
    loading = false,
    paused = false,
    emptyText,
    exaggerate = false,
    degen: degenProp,
    badgeTail = true,
    badgeVariant = 'default',
    showValue = false,
    valueMomentumColor = false,
    windows,
    onWindowChange,
    windowStyle,
    tooltipY = 14,
    tooltipOutline = true,
    orderbook,
    markers,
    onMarkerChange,
    referenceLine,
    formatValue = defaultFormatValue,
    formatTime = defaultFormatTime,
    lerpSpeed = 0.08,
    padding: paddingOverride,
    onHover,
    cursor = 'crosshair',
    pulse = true,
    mode = 'line',
    candles,
    candleWidth,
    liveCandle,
    lineMode,
    lineData,
    lineValue,
    onModeChange,
    onSeriesToggle,
    seriesToggleCompact = false,
    lineWidth,
    class: className,
    style,
  }: LivelineProps = $props()

  let canvasEl: HTMLCanvasElement
  let containerEl: HTMLDivElement
  let valueDisplayEl = $state<HTMLSpanElement | null>(null)
  let indicatorStyle = $state<{ left: number; width: number } | null>(null)
  let modeIndicatorStyle = $state<{ left: number; width: number } | null>(null)
  const hiddenSeries = new SvelteSet<string>()

  /**
   * Keep the last non-empty series prop so toggle chips persist through
   * loading/empty. The stash is a plain memo written from inside the derived —
   * it only needs to change when seriesProp does, so no state or effect needed.
   */
  let seriesStash: LivelineSeries[] | undefined
  const lastSeriesProp = $derived.by(() => {
    if (seriesProp && seriesProp.length > 0) {
      seriesStash = seriesProp
      return seriesProp
    }
    return seriesStash
  })

  const palette = $derived.by(() => {
    const p = resolveTheme(color, theme)
    if (lineWidth != null) p.lineWidth = lineWidth
    return p
  })
  const isDark = $derived(theme === 'dark')
  const isMultiSeries = $derived(seriesProp != null && seriesProp.length > 0)
  const showSeriesToggle = $derived((lastSeriesProp?.length ?? 0) > 1)

  /** Per-series palettes (derived from series ids + colors + theme) */
  const seriesPalettes = $derived.by(() => {
    if (!seriesProp || seriesProp.length === 0) return null
    return resolveSeriesPalettes(seriesProp, theme)
  })

  /** Normalized multi-series config for the engine */
  const multiSeries = $derived.by(() => {
    if (!seriesProp || !seriesPalettes) return undefined
    const palettes = seriesPalettes
    return seriesProp.map((s, i) => ({
      id: s.id,
      data: s.data,
      value: s.value,
      palette: palettes.get(s.id) ?? resolveTheme(s.color || SERIES_COLORS[i % SERIES_COLORS.length], theme),
      label: s.label,
    }))
  })

  /** Resolve momentum prop: boolean enables auto-detect, string overrides */
  const showMomentum = $derived(momentum !== false)
  const momentumOverride = $derived<Momentum | undefined>(
    typeof momentum === 'string' ? momentum : undefined,
  )

  const defaultRight = $derived(badge ? 80 : grid ? 54 : 12)
  const pad = $derived({
    top: paddingOverride?.top ?? 12,
    right: paddingOverride?.right ?? defaultRight,
    bottom: paddingOverride?.bottom ?? 28,
    left: paddingOverride?.left ?? 12,
  })

  /** Degen mode: explicit prop wins */
  const degenEnabled = $derived(degenProp != null ? degenProp !== false : false)
  const degenOptions = $derived<DegenOptions | undefined>(
    degenEnabled ? (typeof degenProp === 'object' ? degenProp : {}) : undefined,
  )

  /** Window buttons state (initialized once, like the mount-time default) */
  // svelte-ignore state_referenced_locally
  let activeWindowSecs = $state(windows && windows.length > 0 ? windows[0].secs : windowSecs)
  const effectiveWindowSecs = $derived(windows ? activeWindowSecs : windowSecs)

  const activeMode = $derived(lineMode ? 'line' : 'candle')

  /**
   * Positions a sliding indicator under the active pill. Attached only to
   * the active button ({@attach isActive && ...}), so it runs on mount and
   * re-runs exactly when the selection moves to a different button.
   */
  function measureIndicator(
    set: (rect: { left: number; width: number }) => void,
  ): Attachment<HTMLElement> {
    return (btn) => {
      const bar = btn.parentElement
      if (!bar) return
      const barRect = bar.getBoundingClientRect()
      const btnRect = btn.getBoundingClientRect()
      set({ left: btnRect.left - barRect.left, width: btnRect.width })
    }
  }

  /** Series toggle handler — prevent hiding the last visible series */
  function handleSeriesToggle(id: string) {
    if (hiddenSeries.has(id)) {
      hiddenSeries.delete(id)
      onSeriesToggle?.(id, true)
    } else {
      /** Count visible series — don't hide last one */
      const totalSeries = seriesProp?.length ?? 0
      const visibleCount = totalSeries - hiddenSeries.size
      if (visibleCount <= 1) return
      hiddenSeries.add(id)
      onSeriesToggle?.(id, false)
    }
  }

  const ws = $derived(windowStyle ?? 'default')

  const engineConfig = $derived<EngineConfig>({
    data,
    value,
    palette,
    windowSecs: effectiveWindowSecs,
    lerpSpeed,
    showGrid: grid,
    showBadge: isMultiSeries ? false : badge,
    showMomentum: isMultiSeries ? false : showMomentum,
    momentumOverride,
    showFill: isMultiSeries ? false : fill,
    referenceLine,
    formatValue,
    formatTime,
    padding: pad,
    onHover,
    showPulse: pulse,
    scrub,
    exaggerate,
    degenOptions: isMultiSeries ? undefined : degenOptions,
    badgeTail,
    badgeVariant,
    tooltipY,
    tooltipOutline,
    valueMomentumColor,
    valueDisplayEl: showValue ? valueDisplayEl : undefined,
    orderbookData: orderbook,
    markers,
    onMarkerChange,
    loading,
    paused,
    emptyText,
    now,
    mode,
    candles,
    candleWidth,
    liveCandle,
    lineMode,
    lineData,
    lineValue,
    multiSeries,
    isMultiSeries,
    hiddenSeriesIds: hiddenSeries,
  })

  /**
   * The engine owns the rAF loop and reads fresh config every frame. It reads
   * a plain snapshot (kept current by a pre-effect) rather than the derived
   * itself: during an outro (e.g. inside LivelineTransition) the component's
   * reactive graph is torn down before the last frames draw, and reading an
   * inert derived would warn — the frozen snapshot lets the chart fade out
   * with its last state instead.
   */
  let currentConfig: EngineConfig
  $effect.pre(() => {
    currentConfig = engineConfig
  })

  onMount(() => {
    const engine = createLivelineEngine(canvasEl, containerEl, () => currentConfig)
    return () => engine.destroy()
  })

  const cursorStyle = $derived(scrub ? cursor : 'default')

  const activeColor = $derived(isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.55)')
  const inactiveColor = $derived(isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.22)')

  const barBg = $derived(
    ws === 'text' ? 'transparent' : isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
  )
  const barRadius = $derived(ws === 'rounded' ? '999px' : '6px')
  const barPadding = $derived(ws === 'text' ? '0' : ws === 'rounded' ? '3px' : '2px')
  const barGap = $derived(ws === 'text' ? '4px' : '2px')
  const pillRadius = $derived(ws === 'rounded' ? '999px' : '4px')
  const indicatorBg = $derived(isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.035)')
  const indicatorTop = $derived(ws === 'rounded' ? 3 : 2)
  const indicatorHeight = $derived(ws === 'rounded' ? 'calc(100% - 6px)' : 'calc(100% - 4px)')
</script>

<!-- Live value display — above the chart -->
{#if showValue}
  <span
    bind:this={valueDisplayEl}
    style="display:block; font-size:20px; font-weight:500; font-family:'SF Mono', Menlo, monospace; color:{isDark ? 'rgba(255,255,255,0.85)' : '#111'}; transition:color 0.3s; letter-spacing:-0.01em; margin-bottom:8px; padding-top:4px; padding-left:{pad.left}px;"
  ></span>
{/if}

<!-- Control bars row — window pills + mode toggle + series chips side by side -->
{#if (windows && windows.length > 0) || onModeChange || showSeriesToggle}
  <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px; margin-left:{pad.left}px;">
    <!-- Time window controls -->
    {#if windows && windows.length > 0}
      <div
        style="position:relative; display:inline-flex; gap:{barGap}; background:{barBg}; border-radius:{barRadius}; padding:{barPadding};"
      >
        <!-- Sliding indicator (default + rounded) -->
        {#if ws !== 'text' && indicatorStyle}
          <div
            style="position:absolute; top:{indicatorTop}px; left:{indicatorStyle.left}px; width:{indicatorStyle.width}px; height:{indicatorHeight}; background:{indicatorBg}; border-radius:{pillRadius}; transition:left 0.25s cubic-bezier(0.4, 0, 0.2, 1), width 0.25s cubic-bezier(0.4, 0, 0.2, 1); pointer-events:none;"
          ></div>
        {/if}
        {#each windows as w (w.secs)}
          {@const isActive = w.secs === activeWindowSecs}
          <button
            {@attach isActive && measureIndicator((rect) => (indicatorStyle = rect))}
            onclick={() => {
              activeWindowSecs = w.secs
              onWindowChange?.(w.secs)
            }}
            style="position:relative; z-index:1; font-size:11px; padding:{ws === 'text' ? '2px 6px' : '3px 10px'}; border-radius:{pillRadius}; border:none; cursor:pointer; font-family:system-ui, -apple-system, sans-serif; font-weight:{isActive ? 600 : 400}; background:transparent; color:{isActive ? activeColor : inactiveColor}; transition:color 0.2s, background 0.15s; line-height:16px;"
          >
            {w.label}
          </button>
        {/each}
      </div>
    {/if}

    <!-- Mode toggle — separate bar with its own sliding indicator -->
    {#if onModeChange}
      <div
        style="position:relative; display:inline-flex; gap:{barGap}; background:{barBg}; border-radius:{barRadius}; padding:{barPadding};"
      >
        <!-- Sliding indicator -->
        {#if ws !== 'text' && modeIndicatorStyle}
          <div
            style="position:absolute; top:{indicatorTop}px; left:{modeIndicatorStyle.left}px; width:{modeIndicatorStyle.width}px; height:{indicatorHeight}; background:{indicatorBg}; border-radius:{pillRadius}; transition:left 0.25s cubic-bezier(0.4, 0, 0.2, 1), width 0.25s cubic-bezier(0.4, 0, 0.2, 1); pointer-events:none;"
          ></div>
        {/if}
        <!-- Line icon -->
        <button
          {@attach activeMode === 'line' && measureIndicator((rect) => (modeIndicatorStyle = rect))}
          onclick={() => onModeChange?.('line')}
          aria-label="Line chart"
          style="position:relative; z-index:1; padding:5px 7px; border-radius:{pillRadius}; border:none; cursor:pointer; background:transparent; display:flex; align-items:center;"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M1 8.5C2.5 8.5 3 4 5.5 4S7.5 7 8.5 7C9.5 7 10 3.5 11 3.5"
              stroke={activeMode === 'line' ? activeColor : inactiveColor}
              stroke-width={activeMode === 'line' ? 1.5 : 1.2}
              stroke-linecap="round"
              fill="none"
            />
          </svg>
        </button>
        <!-- Candle icon -->
        <button
          {@attach activeMode === 'candle' && measureIndicator((rect) => (modeIndicatorStyle = rect))}
          onclick={() => onModeChange?.('candle')}
          aria-label="Candlestick chart"
          style="position:relative; z-index:1; padding:5px 7px; border-radius:{pillRadius}; border:none; cursor:pointer; background:transparent; display:flex; align-items:center;"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <line x1="3.5" y1="1" x2="3.5" y2="11"
              stroke={activeMode === 'candle' ? activeColor : inactiveColor} stroke-width="1" />
            <rect x="2" y="3" width="3" height="5" rx="0.5"
              fill={activeMode === 'candle' ? activeColor : inactiveColor} />
            <line x1="8.5" y1="2" x2="8.5" y2="10"
              stroke={activeMode === 'candle' ? activeColor : inactiveColor} stroke-width="1" />
            <rect x="7" y="4" width="3" height="4" rx="0.5"
              fill={activeMode === 'candle' ? activeColor : inactiveColor} />
          </svg>
        </button>
      </div>
    {/if}

    <!-- Series toggle chips -->
    {#if showSeriesToggle}
      <div
        style="display:inline-flex; gap:{barGap}; background:{barBg}; border-radius:{barRadius}; padding:{barPadding}; opacity:{isMultiSeries ? 1 : 0}; transition:opacity 0.4s; pointer-events:{isMultiSeries ? 'auto' : 'none'};"
      >
        {#each lastSeriesProp ?? [] as s, si (s.id)}
          {@const isHidden = hiddenSeries.has(s.id)}
          {@const seriesColor = s.color || SERIES_COLORS[si % SERIES_COLORS.length]}
          <button
            onclick={() => handleSeriesToggle(s.id)}
            style="position:relative; z-index:1; font-size:11px; padding:{seriesToggleCompact ? (ws === 'text' ? '2px 4px' : '5px 7px') : (ws === 'text' ? '2px 6px' : '3px 8px')}; border-radius:{pillRadius}; border:none; cursor:pointer; font-family:system-ui, -apple-system, sans-serif; font-weight:500; background:{isHidden ? 'transparent' : (ws === 'text' ? 'transparent' : indicatorBg)}; color:{isHidden ? inactiveColor : activeColor}; opacity:{isHidden ? 0.4 : 1}; transition:opacity 0.2s, background 0.15s, color 0.2s; line-height:16px; display:flex; align-items:center; gap:{seriesToggleCompact ? 0 : 4}px;"
          >
            <span
              style="width:{seriesToggleCompact ? 8 : 6}px; height:{seriesToggleCompact ? 8 : 6}px; border-radius:50%; background:{seriesColor}; flex-shrink:0; opacity:{isHidden ? 0.4 : 1}; transition:opacity 0.2s;"
            ></span>
            {#if !seriesToggleCompact}{s.label ?? s.id}{/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<div
  bind:this={containerEl}
  class={className}
  style="width:100%; height:100%; position:relative;{style ? ` ${style}` : ''}"
>
  <canvas bind:this={canvasEl} style="display:block; cursor:{cursorStyle};"></canvas>
</div>
