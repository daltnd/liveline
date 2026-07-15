<script lang="ts">
  import { untrack } from 'svelte'
  import { Liveline } from 'liveline'
  import type { LivelinePoint } from 'liveline'
  import { generatePoint, TIME_WINDOWS, TICK_RATES, VOLATILITIES, type Volatility } from './data'
  import MultiSeriesDemo from './MultiSeriesDemo.svelte'
  import Section from './ui/Section.svelte'
  import Label from './ui/Label.svelte'
  import Sep from './ui/Sep.svelte'
  import Btn from './ui/Btn.svelte'
  import Toggle from './ui/Toggle.svelte'

  let data = $state<LivelinePoint[]>([])
  let value = $state(100)
  let paused = $state(false)
  let scenario = $state<'loading' | 'loading-hold' | 'live' | 'empty'>('loading')
  /** Loading is a pure function of the scenario — derived, not synced */
  const loading = $derived(scenario === 'loading' || scenario === 'loading-hold')

  /** Prop controls */
  let windowSecs = $state(30)
  let degen = $state(false)
  let degenScale = $state(1)
  let degenDown = $state(false)
  let fill = $state(true)
  let grid = $state(true)
  let badge = $state(true)
  let badgeVariant = $state<'default' | 'minimal'>('default')
  let momentum = $state(true)
  let pulse = $state(true)
  let scrub = $state(true)
  let exaggerate = $state(false)
  let theme = $state<'dark' | 'light'>('dark')
  let windowStyle = $state<'default' | 'rounded' | 'text'>('default')
  let lineMode = $state(true)

  /** Data controls */
  let volatility = $state<Volatility>('normal')
  let tickRate = $state(300)

  let interval = 0

  function tick() {
    const now = Date.now() / 1000
    const lastVal = data.length > 0 ? data[data.length - 1].value : 100
    const pt = generatePoint(lastVal, now, volatility)
    value = pt.value
    const next = [...data, pt]
    data = next.length > 500 ? next.slice(-500) : next
  }

  function startLive() {
    clearInterval(interval)

    const now = Date.now() / 1000
    const seed: LivelinePoint[] = []
    let v = 100
    for (let i = 60; i >= 0; i--) {
      const pt = generatePoint(v, now - i * 0.5, volatility)
      seed.push(pt)
      v = pt.value
    }
    data = seed
    value = v

    interval = window.setInterval(tick, tickRate)
  }

  /** Scenario transitions */
  $effect(() => {
    if (scenario === 'loading') {
      data = []
      clearInterval(interval)
      const timer = setTimeout(() => { scenario = 'live' }, 3000)
      return () => clearTimeout(timer)
    }

    if (scenario === 'loading-hold' || scenario === 'empty') {
      data = []
      clearInterval(interval)
      return
    }

    /** scenario === 'live' */
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

  const degenOpts = $derived(degen ? { scale: degenScale, downMomentum: degenDown } : undefined)

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
    Liveline Dev
  </h1>
  <p style="font-size:12px; color:var(--fg-30); margin-bottom:20px;">Stress-test playground</p>

  <!-- Scenario row -->
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

  <!-- Data controls -->
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

  <!-- Time window -->
  <Section label="Window">
    {#each TIME_WINDOWS as w (w.secs)}
      <Btn active={windowSecs === w.secs} onclick={() => windowSecs = w.secs}>
        {w.label}
      </Btn>
    {/each}
    <Sep />
    <Label text="Style">
      <Btn active={windowStyle === 'default'} onclick={() => windowStyle = 'default'}>Default</Btn>
      <Btn active={windowStyle === 'rounded'} onclick={() => windowStyle = 'rounded'}>Rounded</Btn>
      <Btn active={windowStyle === 'text'} onclick={() => windowStyle = 'text'}>Text</Btn>
    </Label>
  </Section>

  <!-- Feature toggles -->
  <Section label="Features">
    <Btn active={theme === 'dark'} onclick={() => theme = 'dark'}>Dark</Btn>
    <Btn active={theme === 'light'} onclick={() => theme = 'light'}>Light</Btn>
    <Sep />
    <Toggle on={grid} onToggle={(v) => grid = v}>Grid</Toggle>
    <Toggle on={fill} onToggle={(v) => fill = v}>Fill</Toggle>
    <Toggle on={badge} onToggle={(v) => badge = v}>Badge</Toggle>
    <Toggle on={momentum} onToggle={(v) => momentum = v}>Momentum</Toggle>
    <Toggle on={pulse} onToggle={(v) => pulse = v}>Pulse</Toggle>
    <Toggle on={scrub} onToggle={(v) => scrub = v}>Scrub</Toggle>
    <Toggle on={exaggerate} onToggle={(v) => exaggerate = v}>Exaggerate</Toggle>
    <Sep />
    <Label text="Badge style">
      <Btn active={badgeVariant === 'default'} onclick={() => badgeVariant = 'default'}>Default</Btn>
      <Btn active={badgeVariant === 'minimal'} onclick={() => badgeVariant = 'minimal'}>Minimal</Btn>
    </Label>
  </Section>

  <!-- Degen -->
  <Section label="Degen">
    <Toggle on={degen} onToggle={(v) => degen = v}>Enable</Toggle>
    {#if degen}
      <Sep />
      <Toggle on={degenDown} onToggle={(v) => degenDown = v}>Down momentum</Toggle>
      <Sep />
      <Label text="Scale">
        {#each [0.5, 1, 2, 4] as s (s)}
          <Btn active={degenScale === s} onclick={() => degenScale = s}>{s}x</Btn>
        {/each}
      </Label>
    {/if}
  </Section>

  <!-- Chart -->
  <div style="height:320px; background:var(--fg-02); border-radius:12px; border:1px solid var(--fg-06); padding:8px; overflow:hidden; margin-top:16px;">
    <Liveline
      {data}
      {value}
      {theme}
      window={windowSecs}
      {loading}
      {paused}
      {badge}
      {badgeVariant}
      {momentum}
      {fill}
      {grid}
      {scrub}
      {pulse}
      {exaggerate}
      degen={degenOpts}
      windows={TIME_WINDOWS}
      onWindowChange={(secs) => windowSecs = secs}
      {windowStyle}
      {lineMode}
      onModeChange={(m) => lineMode = m === 'line'}
    />
  </div>

  <!-- Smaller sizes -->
  <p style="font-size:12px; color:var(--fg-30); margin-top:24px; margin-bottom:8px;">Size variants</p>
  <div style="display:flex; gap:12px; flex-wrap:wrap;">
    {#each SIZES as size (size.label)}
      <div>
        <span style="font-size:10px; color:var(--fg-25); display:block; margin-bottom:4px;">
          {size.label}
        </span>
        <div style="width:{size.w}px; height:{size.h}px; background:var(--fg-02); border-radius:8px; border:1px solid var(--fg-06); overflow:hidden;">
          <Liveline
            {data}
            {value}
            {theme}
            window={windowSecs}
            {loading}
            {paused}
            badge={badge && size.w >= 200}
            {badgeVariant}
            momentum={momentum && size.w >= 200}
            {fill}
            grid={grid && size.w >= 200}
            {scrub}
            {pulse}
            {exaggerate}
            degen={degenOpts}
          />
        </div>
      </div>
    {/each}
  </div>

  <!-- Status bar -->
  <div style="margin-top:10px; font-size:11px; font-family:'SF Mono', Menlo, monospace; color:var(--fg-25); display:flex; gap:16px; flex-wrap:wrap;">
    <span>points: {data.length}</span>
    <span>loading: {String(loading)}</span>
    <span>paused: {String(paused)}</span>
    <span>value: {value.toFixed(2)}</span>
    <span>window: {windowSecs}s</span>
    <span>tick: {tickRate}ms</span>
    <span>volatility: {volatility}</span>
  </div>

  <!-- Multi-series demo -->
  <MultiSeriesDemo {theme} />
</div>
