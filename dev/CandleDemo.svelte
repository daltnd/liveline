<script lang="ts">
  import { untrack } from 'svelte'
  import { Liveline, LivelineTransition } from 'liveline'
  import type { LivelinePoint, CandlePoint } from 'liveline'
  import { generatePoint, aggregateCandles, TIME_WINDOWS, TICK_RATES, VOLATILITIES, type Volatility } from './data'
  import Section from './ui/Section.svelte'
  import Label from './ui/Label.svelte'
  import Sep from './ui/Sep.svelte'
  import Btn from './ui/Btn.svelte'
  import Toggle from './ui/Toggle.svelte'

  const CRYPTO_WINDOWS = [
    { label: '5m', secs: 300 },
    { label: '15m', secs: 900 },
    { label: '1h', secs: 3600 },
  ]

  const CANDLE_WIDTHS = [
    { label: '1s', secs: 1 },
    { label: '2s', secs: 2 },
    { label: '5s', secs: 5 },
    { label: '10s', secs: 10 },
  ]

  type Preset = 'dev' | 'crypto'

  const formatCrypto = (v: number) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  let preset = $state<Preset>('dev')
  let data = $state<LivelinePoint[]>([])
  let value = $state(100)
  let paused = $state(false)
  let scenario = $state<'loading' | 'loading-hold' | 'live' | 'empty'>('loading')
  /** Loading is a pure function of the scenario — derived, not synced */
  const loading = $derived(scenario === 'loading' || scenario === 'loading-hold')

  let windowSecs = $state(30)
  let theme = $state<'dark' | 'light'>('dark')
  let grid = $state(true)
  let scrub = $state(true)

  let volatility = $state<Volatility>('normal')
  let tickRate = $state(300)

  let chartType = $state<'line' | 'candle'>('candle')
  let candleSecs = $state(2)
  let candles = $state<CandlePoint[]>([])
  let liveCandle = $state<CandlePoint | null>(null)

  let startValue = 100
  let lastValue = 100
  /** Working copy of the live candle — mutated per tick, copied into state */
  let liveCandleLocal: CandlePoint | null = null
  let interval = 0
  /** Tick buffer covers widest window: crypto 1h=3600 ticks, dev 5m≈1000 ticks */
  let maxTicks = 1200

  function tickAndAggregate(pt: LivelinePoint) {
    const width = candleSecs
    const lc = liveCandleLocal
    if (!lc) {
      const slot = Math.floor(pt.time / width) * width
      liveCandleLocal = { time: slot, open: pt.value, high: pt.value, low: pt.value, close: pt.value }
      liveCandle = { ...liveCandleLocal }
    } else if (pt.time >= lc.time + width) {
      const committed = { ...lc }
      const next = [...candles, committed]
      candles = next.length > maxTicks ? next.slice(-maxTicks) : next
      const slot = Math.floor(pt.time / width) * width
      liveCandleLocal = { time: slot, open: pt.value, high: pt.value, low: pt.value, close: pt.value }
      liveCandle = { ...liveCandleLocal }
    } else {
      lc.close = pt.value
      if (pt.value > lc.high) lc.high = pt.value
      if (pt.value < lc.low) lc.low = pt.value
      liveCandle = { ...lc }
    }
  }

  function tick() {
    const now = Date.now() / 1000
    const pt = generatePoint(lastValue, now, volatility, startValue)
    lastValue = pt.value
    value = pt.value
    const next = [...data, pt]
    data = next.length > maxTicks ? next.slice(-maxTicks) : next
    tickAndAggregate(pt)
  }

  function startLive() {
    clearInterval(interval)

    const now = Date.now() / 1000
    const base = startValue
    const isCrypto = base > 1000
    const seedTickInterval = isCrypto ? 1 : 0.3
    /** Cover the widest time window with margin: crypto 1h=3600s, dev 5m=300s */
    const seedCount = isCrypto ? 3800 : 500
    const seed: LivelinePoint[] = []
    let v = base
    for (let i = seedCount; i >= 0; i--) {
      const pt = generatePoint(v, now - i * seedTickInterval, volatility, base)
      seed.push(pt)
      v = pt.value
    }
    data = seed
    value = v
    lastValue = v

    const agg = aggregateCandles(seed, candleSecs)
    candles = agg.candles
    liveCandle = agg.live
    liveCandleLocal = agg.live ? { ...agg.live } : null

    interval = window.setInterval(tick, tickRate)
  }

  function resetData() {
    data = []
    candles = []
    liveCandle = null
    liveCandleLocal = null
    clearInterval(interval)
  }

  /** Scenario transitions */
  $effect(() => {
    if (scenario === 'loading') {
      untrack(resetData)
      const timer = setTimeout(() => { scenario = 'live' }, 3000)
      return () => clearTimeout(timer)
    }

    if (scenario === 'loading-hold' || scenario === 'empty') {
      untrack(resetData)
      return
    }

    untrack(startLive)
    return () => clearInterval(interval)
  })

  /** Restart interval when tick rate changes while live */
  $effect(() => {
    if (scenario !== 'live') return
    const rate = tickRate
    clearInterval(interval)
    interval = window.setInterval(tick, rate)
    return () => clearInterval(interval)
  })

  /** Re-aggregate candles when candle width changes while live */
  $effect(() => {
    const width = candleSecs
    if (scenario !== 'live') return
    untrack(() => {
      if (data.length === 0) return
      const agg = aggregateCandles(data, width)
      candles = agg.candles
      liveCandle = agg.live
      liveCandleLocal = agg.live ? { ...agg.live } : null
    })
  })

  /** Preset switch — reset all dependent state */
  $effect(() => {
    const p = preset
    untrack(() => {
      if (p === 'crypto') {
        startValue = 65000
        tickRate = 1000
        candleSecs = 60
        windowSecs = 300
        volatility = 'calm'
        chartType = 'candle'
        /** covers 1h window at 1 tick/sec */
        maxTicks = 4000
      } else {
        startValue = 100
        tickRate = 300
        candleSecs = 2
        windowSecs = 30
        volatility = 'normal'
        chartType = 'candle'
        /** covers 5m window at ~3 ticks/sec */
        maxTicks = 1200
      }
      /** Force re-seed by cycling to loading */
      resetData()
      lastValue = p === 'crypto' ? 65000 : 100
      scenario = 'loading'
    })
  })

  /** LivelineTransition demo state */
  let transActive = $state<'line' | 'candle'>('candle')

  const isDark = $derived(theme === 'dark')
  const fgBase = $derived(isDark ? '255,255,255' : '0,0,0')
  const pageBg = $derived(isDark ? '#111' : '#f5f5f5')

  const SIZES = [
    { w: 320, h: 180, label: '320×180' },
    { w: 240, h: 120, label: '240×120' },
    { w: 160, h: 100, label: '160×100' },
    { w: 120, h: 80, label: '120×80' },
  ]
</script>

<div
  style="padding:32px; max-width:960px; margin:0 auto; color:{isDark ? '#fff' : '#111'}; background:{pageBg}; min-height:100vh; transition:background 0.3s, color 0.3s; --fg-02:rgba({fgBase},0.02); --fg-06:rgba({fgBase},0.06); --fg-08:rgba({fgBase},0.08); --fg-20:rgba({fgBase},0.2); --fg-25:rgba({fgBase},0.25); --fg-30:rgba({fgBase},0.3); --fg-35:rgba({fgBase},0.35); --fg-45:rgba({fgBase},0.45);"
>
  <h1 style="font-size:20px; font-weight:600; margin-bottom:4px;">
    Liveline Candlestick
  </h1>
  <p style="font-size:12px; color:var(--fg-30); margin-bottom:20px;">Candlestick chart with line mode morph</p>

  <Section label="Preset">
    <Btn active={preset === 'dev'} onclick={() => preset = 'dev'}>Dev</Btn>
    <Btn active={preset === 'crypto'} onclick={() => preset = 'crypto'}>Crypto</Btn>
  </Section>

  <Section label="State">
    <Btn active={scenario === 'loading'} onclick={() => scenario = 'loading'}>Loading → Live</Btn>
    <Btn active={scenario === 'loading-hold'} onclick={() => scenario = 'loading-hold'}>Loading</Btn>
    <Btn active={scenario === 'live'} onclick={() => scenario = 'live'}>Live</Btn>
    <Btn active={scenario === 'empty'} onclick={() => scenario = 'empty'}>No Data</Btn>
    <Sep />
    <Btn active={paused} onclick={() => paused = !paused}>
      {paused ? '▶ Play' : '⏸ Pause'}
    </Btn>
  </Section>

  <Section label="Chart">
    <Btn active={chartType === 'candle'} onclick={() => chartType = 'candle'}>Candle</Btn>
    <Btn active={chartType === 'line'} onclick={() => chartType = 'line'}>Line</Btn>
    <Sep />
    <Label text="Width">
      {#each CANDLE_WIDTHS as cw (cw.secs)}
        <Btn active={candleSecs === cw.secs} onclick={() => candleSecs = cw.secs}>{cw.label}</Btn>
      {/each}
    </Label>
  </Section>

  <Section label="Data">
    <Label text="Volatility">
      {#each VOLATILITIES as v (v)}
        <Btn active={volatility === v} onclick={() => volatility = v}>{v}</Btn>
      {/each}
    </Label>
    <Sep />
    <Label text="Tick rate">
      {#each TICK_RATES as t (t.ms)}
        <Btn active={tickRate === t.ms} onclick={() => tickRate = t.ms}>{t.label}</Btn>
      {/each}
    </Label>
  </Section>

  <Section label="Window">
    {#each TIME_WINDOWS as w (w.secs)}
      <Btn active={windowSecs === w.secs} onclick={() => windowSecs = w.secs}>
        {w.label}
      </Btn>
    {/each}
  </Section>

  <Section label="Features">
    <Btn active={theme === 'dark'} onclick={() => theme = 'dark'}>Dark</Btn>
    <Btn active={theme === 'light'} onclick={() => theme = 'light'}>Light</Btn>
    <Sep />
    <Toggle on={grid} onToggle={(v) => grid = v}>Grid</Toggle>
    <Toggle on={scrub} onToggle={(v) => scrub = v}>Scrub</Toggle>
  </Section>

  <!-- Main chart -->
  <div style="height:320px; background:var(--fg-02); border-radius:12px; border:1px solid var(--fg-06); padding:8px; overflow:hidden; margin-top:16px;">
    <Liveline
      mode="candle"
      {data}
      {value}
      {candles}
      candleWidth={candleSecs}
      liveCandle={liveCandle ?? undefined}
      lineMode={chartType === 'line'}
      lineData={data}
      lineValue={value}
      {loading}
      {paused}
      {theme}
      color={preset === 'crypto' ? '#f7931a' : undefined}
      window={windowSecs}
      windows={preset === 'crypto' ? CRYPTO_WINDOWS : undefined}
      formatValue={preset === 'crypto' ? formatCrypto : undefined}
      onModeChange={(mode) => chartType = mode}
      {grid}
      {scrub}
    />
  </div>

  <!-- Size variants -->
  <p style="font-size:12px; color:var(--fg-30); margin-top:24px; margin-bottom:8px;">Size variants</p>
  <div style="display:flex; gap:12px; flex-wrap:wrap;">
    {#each SIZES as size (size.label)}
      <div>
        <span style="font-size:10px; color:var(--fg-25); display:block; margin-bottom:4px;">
          {size.label}
        </span>
        <div style="width:{size.w}px; height:{size.h}px; background:var(--fg-02); border-radius:8px; border:1px solid var(--fg-06); overflow:hidden;">
          <Liveline
            mode="candle"
            {data}
            {value}
            {candles}
            candleWidth={candleSecs}
            liveCandle={liveCandle ?? undefined}
            lineMode={chartType === 'line'}
            lineData={data}
            lineValue={value}
            {loading}
            {paused}
            {theme}
            color={preset === 'crypto' ? '#f7931a' : undefined}
            window={windowSecs}
            formatValue={preset === 'crypto' ? formatCrypto : undefined}
            grid={grid && size.w >= 200}
            {scrub}
          />
        </div>
      </div>
    {/each}
  </div>

  <!-- LivelineTransition demo — cross-fade between two chart instances -->
  <h2 style="font-size:16px; font-weight:600; margin-top:40px; margin-bottom:4px;">LivelineTransition</h2>
  <p style="font-size:12px; color:var(--fg-30); margin-bottom:12px;">Cross-fade between separate chart instances</p>
  <Section label="Active">
    <Btn active={transActive === 'line'} onclick={() => transActive = 'line'}>Line</Btn>
    <Btn active={transActive === 'candle'} onclick={() => transActive = 'candle'}>Candle</Btn>
  </Section>
  <div style="height:240px; background:var(--fg-02); border-radius:12px; border:1px solid var(--fg-06); padding:8px; overflow:hidden;">
    <LivelineTransition active={transActive}>
      {#snippet line()}
        <Liveline
          {data}
          {value}
          {theme}
          window={windowSecs}
          {loading}
          {paused}
          {grid}
          {scrub}
        />
      {/snippet}
      {#snippet candle()}
        <Liveline
          mode="candle"
          {data}
          {value}
          {candles}
          candleWidth={candleSecs}
          liveCandle={liveCandle ?? undefined}
          {theme}
          window={windowSecs}
          {loading}
          {paused}
          {grid}
          {scrub}
        />
      {/snippet}
    </LivelineTransition>
  </div>

  <!-- Status bar -->
  <div style="margin-top:10px; font-size:11px; font-family:'SF Mono', Menlo, monospace; color:var(--fg-25); display:flex; gap:16px; flex-wrap:wrap;">
    <span>preset: {preset}</span>
    <span>ticks: {data.length}</span>
    <span>candles: {candles.length}</span>
    <span>loading: {String(loading)}</span>
    <span>paused: {String(paused)}</span>
    <span>value: {value.toFixed(2)}</span>
    <span>window: {windowSecs}s</span>
    <span>candle: {candleSecs}s</span>
    <span>tick: {tickRate}ms</span>
    <span>volatility: {volatility}</span>
    <span>mode: {chartType}</span>
  </div>
</div>
