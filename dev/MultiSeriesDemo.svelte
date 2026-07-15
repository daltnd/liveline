<script lang="ts">
  import { untrack } from 'svelte'
  import { Liveline } from 'liveline'
  import type { LivelinePoint, LivelineSeries } from 'liveline'
  import Section from './ui/Section.svelte'
  import Label from './ui/Label.svelte'
  import Sep from './ui/Sep.svelte'
  import Btn from './ui/Btn.svelte'
  import Toggle from './ui/Toggle.svelte'

  let { theme }: { theme: 'dark' | 'light' } = $props()

  const MULTI_COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b']
  const MULTI_LABELS = ['Yes', 'No', 'Maybe', 'Other']
  const MULTI_BIASES = [0.51, 0.49, 0.50, 0.48]

  const MULTI_WINDOWS = [
    { label: '10s', secs: 10 },
    { label: '30s', secs: 30 },
    { label: '1m', secs: 60 },
    { label: '5m', secs: 300 },
  ]

  let series = $state<LivelineSeries[]>([])
  let paused = $state(false)
  let scenario = $state<'live' | 'loading' | 'loading-hold' | 'empty'>('live')
  // Loading is a pure function of the scenario — derived, not synced
  const loading = $derived(scenario === 'loading' || scenario === 'loading-hold')
  let seriesCount = $state(4)
  let windowSecs = $state(MULTI_WINDOWS[0].secs)
  let windowStyle = $state<'default' | 'rounded' | 'text'>('default')
  let grid = $state(true)
  let scrub = $state(true)
  let exaggerate = $state(false)
  let showRef = $state(false)
  let pulse = $state(true)
  let compactToggle = $state(false)

  let interval = 0

  function tick() {
    const c = seriesCount
    // Trim or expand series to match count
    let next = series.slice(0, c)
    // Add new series if count grew
    while (next.length < c) {
      const i = next.length
      const now = Date.now() / 1000
      const seed: LivelinePoint[] = []
      let v = 50 + (Math.random() - 0.5) * 4
      for (let j = 10; j >= 0; j--) {
        v += (Math.random() - MULTI_BIASES[i]) * 1.2
        v = Math.max(10, Math.min(90, v))
        seed.push({ time: now - j * 0.5, value: v })
      }
      next.push({ id: MULTI_LABELS[i].toLowerCase(), data: seed, value: v, color: MULTI_COLORS[i], label: MULTI_LABELS[i] })
    }
    series = next.map((s, i) => {
      const now = Date.now() / 1000
      const delta = (Math.random() - MULTI_BIASES[i]) * 1.2
      const newVal = Math.max(10, Math.min(90, s.value + delta))
      const newData = [...s.data, { time: now, value: newVal }]
      return { ...s, data: newData.length > 2000 ? newData.slice(-2000) : newData, value: newVal }
    })
  }

  function startLive(count: number) {
    clearInterval(interval)
    const now = Date.now() / 1000
    // Seed enough history for the 5m window (300s / 0.5s interval = 600 points)
    series = MULTI_LABELS.slice(0, count).map((label, i) => {
      const seed: LivelinePoint[] = []
      let v = 50 + (Math.random() - 0.5) * 4
      for (let j = 700; j >= 0; j--) {
        v += (Math.random() - MULTI_BIASES[i]) * 1.2
        v = Math.max(10, Math.min(90, v))
        seed.push({ time: now - j * 0.5, value: v })
      }
      return { id: label.toLowerCase(), data: seed, value: v, color: MULTI_COLORS[i], label }
    })

    interval = window.setInterval(tick, 300)
  }

  $effect(() => {
    if (scenario === 'loading') {
      series = []
      clearInterval(interval)
      const timer = setTimeout(() => { scenario = 'live' }, 3000)
      return () => clearTimeout(timer)
    }
    if (scenario === 'loading-hold' || scenario === 'empty') {
      series = []
      clearInterval(interval)
      return
    }
    // scenario === 'live' — the interval reads seriesCount directly,
    // so count changes apply on the next tick without a restart
    untrack(() => startLive(seriesCount))
    return () => clearInterval(interval)
  })
</script>

<h2 style="font-size:16px; font-weight:600; margin-top:40px; margin-bottom:4px; border-bottom:none;">Multi-Line</h2>
<p style="font-size:12px; color:var(--fg-30); margin-bottom:12px;">
  Overlapping series, shared axes
</p>

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

<Section label="Series">
  {#each [2, 3, 4] as n (n)}
    <Btn active={seriesCount === n} onclick={() => seriesCount = n}>{n} lines</Btn>
  {/each}
</Section>

<Section label="Window">
  <Label text="Style">
    <Btn active={windowStyle === 'default'} onclick={() => windowStyle = 'default'}>Default</Btn>
    <Btn active={windowStyle === 'rounded'} onclick={() => windowStyle = 'rounded'}>Rounded</Btn>
    <Btn active={windowStyle === 'text'} onclick={() => windowStyle = 'text'}>Text</Btn>
  </Label>
</Section>

<Section label="Features">
  <Toggle on={grid} onToggle={(v) => grid = v}>Grid</Toggle>
  <Toggle on={scrub} onToggle={(v) => scrub = v}>Scrub</Toggle>
  <Toggle on={pulse} onToggle={(v) => pulse = v}>Pulse</Toggle>
  <Toggle on={exaggerate} onToggle={(v) => exaggerate = v}>Exaggerate</Toggle>
  <Toggle on={showRef} onToggle={(v) => showRef = v}>Ref Line</Toggle>
  <Toggle on={compactToggle} onToggle={(v) => compactToggle = v}>Compact Toggle</Toggle>
</Section>

<div style="height:300px; background:var(--fg-02); border-radius:12px; border:1px solid var(--fg-06); padding:8px; overflow:hidden; margin-top:8px;">
  <Liveline
    data={[]}
    value={0}
    {series}
    {theme}
    window={windowSecs}
    windows={MULTI_WINDOWS}
    onWindowChange={(secs) => windowSecs = secs}
    {windowStyle}
    {grid}
    {scrub}
    {pulse}
    {exaggerate}
    {loading}
    {paused}
    referenceLine={showRef ? { value: 50, label: '50%' } : undefined}
    formatValue={(v) => v.toFixed(1) + '%'}
    seriesToggleCompact={compactToggle}
    onSeriesToggle={(id, vis) => console.log('series toggle:', id, vis)}
  />
</div>

<div style="margin-top:8px; font-size:11px; font-family:'SF Mono', Menlo, monospace; color:var(--fg-25); display:flex; gap:16px; flex-wrap:wrap;">
  <span>series: {series.length}</span>
  <span>loading: {String(loading)}</span>
  <span>paused: {String(paused)}</span>
  <span>window: {windowSecs}s</span>
  <span>points: {series[0]?.data.length ?? 0}</span>
</div>
