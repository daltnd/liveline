import type { LivelinePoint, CandlePoint } from 'liveline'

// --- Data generators shared by the dev pages ---

export type Volatility = 'calm' | 'normal' | 'spiky' | 'chaos'

export function generatePoint(prev: number, time: number, volatility: Volatility, baseValue = 100): LivelinePoint {
  const v: Record<Volatility, number> = { calm: 0.15, normal: 0.8, spiky: 3, chaos: 8 }
  const bias: Record<Volatility, number> = { calm: 0.49, normal: 0.48, spiky: 0.47, chaos: 0.45 }
  const priceScale = baseValue / 100
  const scale = v[volatility] * priceScale
  // Occasional large spikes in spiky/chaos modes
  const spike = (volatility === 'spiky' || volatility === 'chaos') && Math.random() < 0.08
    ? (Math.random() - 0.5) * scale * 3
    : 0
  const delta = (Math.random() - bias[volatility]) * scale + spike
  return { time, value: prev + delta }
}

/** Aggregate tick data into OHLC candles by time bucket. */
export function aggregateCandles(ticks: LivelinePoint[], width: number): { candles: CandlePoint[]; live: CandlePoint | null } {
  if (ticks.length === 0) return { candles: [], live: null }
  const candles: CandlePoint[] = []
  let slot = Math.floor(ticks[0].time / width) * width
  let o = ticks[0].value, h = o, l = o, c = o
  for (let i = 1; i < ticks.length; i++) {
    const t = ticks[i]
    if (t.time >= slot + width) {
      candles.push({ time: slot, open: o, high: h, low: l, close: c })
      slot = Math.floor(t.time / width) * width
      o = t.value; h = o; l = o; c = o
    } else {
      c = t.value
      if (c > h) h = c
      if (c < l) l = c
    }
  }
  return { candles, live: { time: slot, open: o, high: h, low: l, close: c } }
}

export const TIME_WINDOWS = [
  { label: '10s', secs: 10 },
  { label: '30s', secs: 30 },
  { label: '1m', secs: 60 },
  { label: '5m', secs: 300 },
]

export const TICK_RATES: { label: string; ms: number }[] = [
  { label: '50ms', ms: 50 },
  { label: '100ms', ms: 100 },
  { label: '300ms', ms: 300 },
  { label: '1s', ms: 1000 },
]

export const VOLATILITIES: Volatility[] = ['calm', 'normal', 'spiky', 'chaos']
