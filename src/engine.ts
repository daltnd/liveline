import type { LivelinePoint, LivelinePalette, LivelineSeries, Momentum, ReferenceLine, HoverPoint, Padding, ChartLayout, OrderbookData, DegenOptions, BadgeVariant, CandlePoint } from './types.js'
import { lerp } from './math/lerp.js'
import { computeRange } from './math/range.js'
import { detectMomentum } from './math/momentum.js'
import { interpolateAtTime } from './math/interpolate.js'
import { getDpr, applyDpr } from './canvas/dpr.js'
import { drawFrame, drawCandleFrame, drawMultiFrame, FADE_EDGE_WIDTH } from './draw/index.js'
import type { MultiSeriesEntry } from './draw/index.js'
import { drawLoading } from './draw/loading.js'
import { drawEmpty } from './draw/empty.js'
import { createOrderbookState } from './draw/orderbook.js'
import { createParticleState } from './draw/particles.js'
import { createShakeState } from './draw/index.js'
import { badgeSvgPath, badgePillOnly, BADGE_PAD_X, BADGE_PAD_Y, BADGE_TAIL_LEN, BADGE_TAIL_SPREAD, BADGE_LINE_H } from './draw/badge.js'

export interface EngineConfig {
  data: LivelinePoint[]
  value: number
  palette: LivelinePalette
  windowSecs: number
  lerpSpeed: number
  showGrid: boolean
  showBadge: boolean
  showMomentum: boolean
  momentumOverride?: Momentum
  showFill: boolean
  referenceLine?: ReferenceLine
  formatValue: (v: number) => string
  formatTime: (t: number) => string
  padding: Required<Padding>
  onHover?: (point: HoverPoint | null) => void
  showPulse: boolean
  scrub: boolean
  exaggerate: boolean
  degenOptions?: DegenOptions
  badgeTail: boolean
  badgeVariant: BadgeVariant
  tooltipY: number
  tooltipOutline: boolean
  valueMomentumColor: boolean
  valueDisplayEl?: HTMLSpanElement | null
  orderbookData?: OrderbookData
  loading?: boolean
  paused?: boolean
  emptyText?: string

  /** Candlestick mode */
  mode: 'line' | 'candle'
  candles?: CandlePoint[]
  candleWidth?: number
  liveCandle?: CandlePoint
  lineMode?: boolean
  lineData?: LivelinePoint[]
  lineValue?: number

  /** Multi-series mode */
  multiSeries?: Array<{
    id: string
    data: LivelinePoint[]
    value: number
    palette: LivelinePalette
    label?: string
  }>
  isMultiSeries?: boolean
  hiddenSeriesIds?: Set<string>
}

interface BadgeEls {
  container: HTMLDivElement
  svg: SVGSVGElement
  path: SVGPathElement
  text: HTMLSpanElement
  /** current lerped text width */
  displayW: number
  /** target text width */
  targetW: number
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** --- Constants --- */
const MAX_DELTA_MS = 50
const SCRUB_LERP_SPEED = 0.12
const BADGE_WIDTH_LERP = 0.15
const BADGE_Y_LERP = 0.35
const BADGE_Y_LERP_TRANSITIONING = 0.5
const MOMENTUM_COLOR_LERP = 0.12
const WINDOW_TRANSITION_MS = 750
const WINDOW_BUFFER = 0.05
const WINDOW_BUFFER_NO_BADGE = 0.015
const VALUE_SNAP_THRESHOLD = 0.001
const ADAPTIVE_SPEED_BOOST = 0.2
const MOMENTUM_GREEN: [number, number, number] = [34, 197, 94]
const MOMENTUM_RED: [number, number, number] = [239, 68, 68]
/** data → loading/empty (reverse) */
const CHART_REVEAL_SPEED = 0.14
/** loading/empty → data (forward, slower for choreography) */
const CHART_REVEAL_SPEED_FWD = 0.09
const PAUSE_PROGRESS_SPEED = 0.12
const PAUSE_CATCHUP_SPEED = 0.08
const PAUSE_CATCHUP_SPEED_FAST = 0.22
const LOADING_ALPHA_SPEED = 0.14
const SERIES_TOGGLE_SPEED = 0.10

/** --- Candle-specific constants --- */
const CANDLE_LERP_SPEED = 0.25
const CANDLE_WIDTH_TRANS_MS = 300
const LINE_MORPH_MS = 500
/** matches candle body speed */
const CLOSE_LINE_LERP_SPEED = 0.25
const LINE_DENSITY_MS = 350
const LINE_LERP_BASE = 0.08
const LINE_ADAPTIVE_BOOST = 0.2
const LINE_SNAP_THRESHOLD = 0.001
const RANGE_LERP_SPEED = 0.15
const RANGE_ADAPTIVE_BOOST = 0.2
const CANDLE_BUFFER = 0.05
const CANDLE_BUFFER_NO_BADGE = 0.015

/** --- Extracted helper functions (pure computation, called inside draw loop) --- */

interface WindowTransState {
  from: number; to: number; startMs: number
  rangeFromMin: number; rangeFromMax: number; rangeToMin: number; rangeToMax: number
}

/** Lerp display value with adaptive speed — slow for big jumps, fast for small ticks. */
function computeAdaptiveSpeed(
  value: number,
  displayValue: number,
  displayMin: number,
  displayMax: number,
  lerpSpeed: number,
  noMotion: boolean,
): number {
  const valGap = Math.abs(value - displayValue)
  const prevRange = displayMax - displayMin || 1
  const gapRatio = Math.min(valGap / prevRange, 1)
  return noMotion ? 1 : lerpSpeed + (1 - gapRatio) * ADAPTIVE_SPEED_BOOST
}

/** Update window transition state, returning current display window and transition progress. */
function updateWindowTransition(
  cfg: EngineConfig,
  wt: WindowTransState,
  displayWindow: number,
  displayMin: number,
  displayMax: number,
  noMotion: boolean,
  now_ms: number,
  now: number,
  points: LivelinePoint[],
  smoothValue: number,
  buffer: number,
): { windowSecs: number; windowTransProgress: number } {
  if (wt.to !== cfg.windowSecs) {
    wt.from = displayWindow
    wt.to = cfg.windowSecs
    wt.startMs = now_ms
    wt.rangeFromMin = displayMin
    wt.rangeFromMax = displayMax
    const targetRightEdge = now + cfg.windowSecs * buffer
    const targetLeftEdge = targetRightEdge - cfg.windowSecs
    const targetVisible: LivelinePoint[] = []
    for (const p of points) {
      if (p.time >= targetLeftEdge - 2 && p.time <= targetRightEdge) {
        targetVisible.push(p)
      }
    }
    if (targetVisible.length > 0) {
      const targetRange = computeRange(targetVisible, smoothValue, cfg.referenceLine?.value, cfg.exaggerate)
      wt.rangeToMin = targetRange.min
      wt.rangeToMax = targetRange.max
    }
  }

  let windowTransProgress = 0
  let resultWindow: number
  if (noMotion || wt.startMs === 0) {
    resultWindow = cfg.windowSecs
  } else {
    const elapsed = now_ms - wt.startMs
    const duration = WINDOW_TRANSITION_MS
    const t = Math.min(elapsed / duration, 1)
    const eased = (1 - Math.cos(t * Math.PI)) / 2
    windowTransProgress = eased
    const logFrom = Math.log(wt.from)
    const logTo = Math.log(wt.to)
    resultWindow = Math.exp(logFrom + (logTo - logFrom) * eased)
    if (t >= 1) {
      resultWindow = cfg.windowSecs
      wt.startMs = 0
      windowTransProgress = 0
    }
  }

  return { windowSecs: resultWindow, windowTransProgress }
}

/** Smooth Y range with lerp. During window transitions, interpolates between pre-computed ranges. */
function updateRange(
  computedRange: { min: number; max: number },
  rangeInited: boolean,
  targetMin: number,
  targetMax: number,
  displayMin: number,
  displayMax: number,
  isTransitioning: boolean,
  windowTransProgress: number,
  wt: WindowTransState,
  adaptiveSpeed: number,
  chartH: number,
  dt: number,
): { minVal: number; maxVal: number; valRange: number; targetMin: number; targetMax: number; displayMin: number; displayMax: number; rangeInited: boolean } {
  if (!rangeInited) {
    return {
      minVal: computedRange.min, maxVal: computedRange.max,
      valRange: (computedRange.max - computedRange.min) || 0.001,
      targetMin: computedRange.min, targetMax: computedRange.max,
      displayMin: computedRange.min, displayMax: computedRange.max,
      rangeInited: true,
    }
  }

  if (isTransitioning) {
    displayMin = wt.rangeFromMin + (wt.rangeToMin - wt.rangeFromMin) * windowTransProgress
    displayMax = wt.rangeFromMax + (wt.rangeToMax - wt.rangeFromMax) * windowTransProgress
    targetMin = computedRange.min
    targetMax = computedRange.max
  } else {
    const curRange = displayMax - displayMin
    targetMin = computedRange.min
    targetMax = computedRange.max
    displayMin = lerp(displayMin, targetMin, adaptiveSpeed, dt)
    displayMax = lerp(displayMax, targetMax, adaptiveSpeed, dt)
    const pxThreshold = 0.5 * curRange / chartH || 0.001
    if (Math.abs(displayMin - targetMin) < pxThreshold) displayMin = targetMin
    if (Math.abs(displayMax - targetMax) < pxThreshold) displayMax = targetMax
  }

  return {
    minVal: displayMin, maxVal: displayMax,
    valRange: (displayMax - displayMin) || 0.001,
    targetMin, targetMax, displayMin, displayMax,
    rangeInited: true,
  }
}

/** Compute hover position, interpolated value, and scrub amount. */
function updateHoverState(
  hoverPixelX: number | null,
  pad: Required<Padding>,
  w: number,
  layout: ChartLayout,
  now: number,
  visible: LivelinePoint[],
  scrubAmount: number,
  lastHover: { x: number; value: number; time: number } | null,
  cfg: EngineConfig,
  noMotion: boolean,
  leftEdge: number,
  rightEdge: number,
  chartW: number,
  dt: number,
): {
  hoverX: number | null; hoverValue: number | null; hoverTime: number | null
  scrubAmount: number; isActiveHover: boolean
  lastHover: { x: number; value: number; time: number } | null
} {
  let hoverValue: number | null = null
  let hoverTime: number | null = null
  let hoverChartX: number | null = null
  let isActiveHover = false

  if (hoverPixelX !== null && hoverPixelX >= pad.left && hoverPixelX <= w - pad.right) {
    const maxHoverX = layout.toX(now)
    const clampedX = Math.min(hoverPixelX, maxHoverX)
    const t = leftEdge + ((clampedX - pad.left) / chartW) * (rightEdge - leftEdge)
    const v = interpolateAtTime(visible, t)
    if (v !== null) {
      hoverValue = v
      hoverTime = t
      hoverChartX = clampedX
      isActiveHover = true
      lastHover = { x: clampedX, value: v, time: t }
      cfg.onHover?.({ time: t, value: v, x: clampedX, y: layout.toY(v) })
    }
  }

  /** Lerp scrub amount */
  const scrubTarget = isActiveHover ? 1 : 0
  if (noMotion) {
    scrubAmount = scrubTarget
  } else {
    scrubAmount += (scrubTarget - scrubAmount) * SCRUB_LERP_SPEED
    if (scrubAmount < 0.01) scrubAmount = 0
    if (scrubAmount > 0.99) scrubAmount = 1
  }

  /** Use last known position during fade-out */
  let drawHoverX = hoverChartX
  let drawHoverValue = hoverValue
  let drawHoverTime = hoverTime
  if (!isActiveHover && scrubAmount > 0 && lastHover) {
    drawHoverX = lastHover.x
    drawHoverValue = lastHover.value
    drawHoverTime = lastHover.time
  }

  return {
    hoverX: drawHoverX, hoverValue: drawHoverValue, hoverTime: drawHoverTime,
    scrubAmount, isActiveHover, lastHover,
  }
}

/** Update badge DOM element — text, width lerp, SVG path, position, color. */
function updateBadgeDOM(
  badge: BadgeEls,
  cfg: EngineConfig,
  smoothValue: number,
  layout: ChartLayout,
  momentum: Momentum,
  badgeY: number | null,
  badgeColor: { green: number },
  isWindowTransitioning: boolean,
  noMotion: boolean,
  ctx: CanvasRenderingContext2D,
  dt: number,
  chartReveal: number = 1,
): number | null /* updated badgeY */ {
  if (!cfg.showBadge || chartReveal < 0.25) {
    badge.container.style.display = 'none'
    return badgeY
  }

  badge.container.style.display = ''
  const badgeOpacity = chartReveal < 0.5 ? (chartReveal - 0.25) / 0.25 : 1
  badge.container.style.opacity = badgeOpacity < 1 ? String(badgeOpacity) : ''
  const { w, h, pad } = layout

  const text = cfg.formatValue(smoothValue)
  badge.text.textContent = text
  badge.text.style.font = cfg.palette.labelFont
  badge.text.style.lineHeight = `${BADGE_LINE_H}px`
  const tailLen = cfg.badgeTail ? BADGE_TAIL_LEN : 0
  badge.text.style.padding = `${BADGE_PAD_Y}px ${BADGE_PAD_X}px ${BADGE_PAD_Y}px ${tailLen + BADGE_PAD_X}px`

  /** Measure target text width using canvas (template with widest digits) */
  ctx.font = cfg.palette.labelFont
  const template = text.replace(/[0-9]/g, '8')
  const targetTextW = ctx.measureText(template).width

  /** Smooth-lerp the badge width */
  badge.targetW = targetTextW
  if (badge.displayW === 0) badge.displayW = targetTextW
  badge.displayW = lerp(badge.displayW, badge.targetW, BADGE_WIDTH_LERP, dt)
  if (Math.abs(badge.displayW - badge.targetW) < 0.3) badge.displayW = badge.targetW
  const textW = badge.displayW

  const pillW = textW + BADGE_PAD_X * 2
  const pillH = BADGE_LINE_H + BADGE_PAD_Y * 2

  const totalW = tailLen + pillW
  badge.svg.setAttribute('width', String(Math.ceil(totalW)))
  badge.svg.setAttribute('height', String(pillH))
  badge.svg.setAttribute('viewBox', `0 0 ${totalW} ${pillH}`)
  badge.path.setAttribute('d', cfg.badgeTail
    ? badgeSvgPath(pillW, pillH, BADGE_TAIL_LEN, BADGE_TAIL_SPREAD)
    : badgePillOnly(pillW, pillH))

  /** Badge Y lerp — decoupled from range/value math, morphed during reveal */
  const centerY = pad.top + layout.chartH / 2
  const realTargetY = Math.max(pad.top, Math.min(h - pad.bottom, layout.toY(smoothValue)))
  const targetBadgeY = chartReveal < 1
    ? centerY + (realTargetY - centerY) * chartReveal
    : realTargetY
  if (badgeY === null || noMotion) {
    badgeY = targetBadgeY
  } else {
    const badgeSpeed = isWindowTransitioning ? BADGE_Y_LERP_TRANSITIONING : BADGE_Y_LERP
    badgeY = lerp(badgeY, targetBadgeY, badgeSpeed, dt)
  }

  const badgeLeft = w - pad.right + 8 - BADGE_PAD_X - tailLen
  const badgeTop = badgeY - pillH / 2
  badge.container.style.transform = `translate3d(${badgeLeft}px, ${badgeTop}px, 0)`

  /** Badge styling */
  if (cfg.badgeVariant === 'minimal') {
    badge.path.setAttribute('fill', cfg.palette.badgeOuterBg)
    badge.text.style.color = cfg.palette.tooltipText
    badge.container.style.filter = `drop-shadow(0 1px 4px ${cfg.palette.badgeOuterShadow})`
  } else {
    badge.container.style.filter = ''
    badge.text.style.color = '#fff'
    const bs = badgeColor
    let fillColor: string
    if (!cfg.showMomentum) {
      fillColor = cfg.palette.line
    } else {
      const target = momentum === 'up' ? 1 : momentum === 'down' ? 0 : bs.green
      bs.green = noMotion ? target : lerp(bs.green, target, MOMENTUM_COLOR_LERP, dt)
      if (bs.green > 0.99) bs.green = 1
      if (bs.green < 0.01) bs.green = 0
      const g = bs.green
      const rr = Math.round(MOMENTUM_RED[0] + (MOMENTUM_GREEN[0] - MOMENTUM_RED[0]) * g)
      const gg = Math.round(MOMENTUM_RED[1] + (MOMENTUM_GREEN[1] - MOMENTUM_RED[1]) * g)
      const bb = Math.round(MOMENTUM_RED[2] + (MOMENTUM_GREEN[2] - MOMENTUM_RED[2]) * g)
      fillColor = `rgb(${rr},${gg},${bb})`
    }
    badge.path.setAttribute('fill', fillColor)
  }

  return badgeY
}

/** --- Candle-specific helper functions --- */

function computeCandleRange(
  candles: CandlePoint[],
): { min: number; max: number } {
  let min = Infinity
  let max = -Infinity
  for (const c of candles) {
    if (c.low < min) min = c.low
    if (c.high > max) max = c.high
  }
  if (!isFinite(min) || !isFinite(max)) return { min: 99, max: 101 }
  const range = max - min
  const margin = range * 0.12
  const minRange = range * 0.1 || 0.4
  if (range < minRange) {
    const mid = (min + max) / 2
    return { min: mid - minRange / 2, max: mid + minRange / 2 }
  }
  return { min: min - margin, max: max + margin }
}

function candleAtX(
  candles: CandlePoint[],
  hoverX: number,
  candleWidth: number,
  layout: ChartLayout,
): CandlePoint | null {
  const time = layout.leftEdge + ((hoverX - layout.pad.left) / layout.chartW) * (layout.rightEdge - layout.leftEdge)
  let lo = 0
  let hi = candles.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const c = candles[mid]
    if (time < c.time) hi = mid - 1
    else if (time >= c.time + candleWidth) lo = mid + 1
    else return c
  }
  return null
}

/** Smooth Y range for candle mode — adaptive speed, no target tracking. */
function updateCandleRange(
  computedRange: { min: number; max: number },
  rangeInited: boolean,
  displayMin: number,
  displayMax: number,
  isTransitioning: boolean,
  windowTransProgress: number,
  wt: { rangeFromMin: number; rangeFromMax: number; rangeToMin: number; rangeToMax: number },
  chartH: number,
  dt: number,
): { minVal: number; maxVal: number; valRange: number; displayMin: number; displayMax: number; rangeInited: boolean } {
  if (!rangeInited) {
    return {
      minVal: computedRange.min, maxVal: computedRange.max,
      valRange: (computedRange.max - computedRange.min) || 0.001,
      displayMin: computedRange.min, displayMax: computedRange.max,
      rangeInited: true,
    }
  }

  if (isTransitioning) {
    displayMin = wt.rangeFromMin + (wt.rangeToMin - wt.rangeFromMin) * windowTransProgress
    displayMax = wt.rangeFromMax + (wt.rangeToMax - wt.rangeFromMax) * windowTransProgress
  } else {
    const curRange = displayMax - displayMin || 1
    const gapMin = Math.abs(displayMin - computedRange.min)
    const gapMax = Math.abs(displayMax - computedRange.max)
    const gapRatio = Math.min((gapMin + gapMax) / curRange, 1)
    const speed = RANGE_LERP_SPEED + (1 - gapRatio) * RANGE_ADAPTIVE_BOOST

    displayMin = lerp(displayMin, computedRange.min, speed, dt)
    displayMax = lerp(displayMax, computedRange.max, speed, dt)
    const pxThreshold = 0.5 * curRange / chartH || 0.001
    if (Math.abs(displayMin - computedRange.min) < pxThreshold) displayMin = computedRange.min
    if (Math.abs(displayMax - computedRange.max) < pxThreshold) displayMax = computedRange.max
  }

  return {
    minVal: displayMin, maxVal: displayMax,
    valRange: (displayMax - displayMin) || 0.001,
    displayMin, displayMax,
    rangeInited: true,
  }
}

/** Candle window transition — uses candle data instead of line points. */
function updateCandleWindowTransition(
  targetWindowSecs: number,
  wt: { from: number; to: number; startMs: number; rangeFromMin: number; rangeFromMax: number; rangeToMin: number; rangeToMax: number },
  displayWindow: number,
  displayMin: number,
  displayMax: number,
  now_ms: number,
  now: number,
  candles: CandlePoint[],
  liveCandle: CandlePoint | undefined,
  candleWidth: number,
  buffer: number,
): { windowSecs: number; windowTransProgress: number } {
  if (wt.to !== targetWindowSecs) {
    wt.from = displayWindow
    wt.to = targetWindowSecs
    wt.startMs = now_ms
    wt.rangeFromMin = displayMin
    wt.rangeFromMax = displayMax
    const targetRightEdge = now + targetWindowSecs * buffer
    const targetLeftEdge = targetRightEdge - targetWindowSecs
    const targetVisible: CandlePoint[] = []
    for (const c of candles) {
      if (c.time + candleWidth >= targetLeftEdge && c.time <= targetRightEdge) {
        targetVisible.push(c)
      }
    }
    if (liveCandle && liveCandle.time + candleWidth >= targetLeftEdge && liveCandle.time <= targetRightEdge) {
      targetVisible.push(liveCandle)
    }
    if (targetVisible.length > 0) {
      const tr = computeCandleRange(targetVisible)
      wt.rangeToMin = tr.min
      wt.rangeToMax = tr.max
    }
  }

  let windowTransProgress = 0
  let resultWindow: number
  if (wt.startMs === 0) {
    resultWindow = targetWindowSecs
  } else {
    const elapsed = now_ms - wt.startMs
    const t = Math.min(elapsed / WINDOW_TRANSITION_MS, 1)
    const eased = (1 - Math.cos(t * Math.PI)) / 2
    windowTransProgress = eased
    const logFrom = Math.log(wt.from)
    const logTo = Math.log(wt.to)
    resultWindow = Math.exp(logFrom + (logTo - logFrom) * eased)
    if (t >= 1) {
      resultWindow = targetWindowSecs
      wt.startMs = 0
      windowTransProgress = 0
    }
  }

  return { windowSecs: resultWindow, windowTransProgress }
}

export interface LivelineEngine {
  destroy(): void
}

/**
 * Framework-agnostic rendering engine. Owns the rAF loop, canvas sizing,
 * pointer/touch scrubbing, and the floating badge DOM element.
 * Reads fresh config every frame via `getConfig`.
 */
export function createLivelineEngine(
  canvas: HTMLCanvasElement,
  container: HTMLDivElement,
  getConfig: () => EngineConfig,
): LivelineEngine {
  const config = getConfig()

  /** Animation state (persistent across frames, no allocations) */
  const st = {
    displayValue: config.value,
    displayValues: new Map<string, number>(),
    seriesAlpha: new Map<string, number>(),
    displayMin: 0,
    displayMax: 0,
    targetMin: 0,
    targetMax: 0,
    rangeInited: false,
    displayWindow: config.windowSecs,
    windowTransition: {
      from: config.windowSecs, to: config.windowSecs, startMs: 0,
      rangeFromMin: 0, rangeFromMax: 0, rangeToMin: 0, rangeToMax: 0,
    },
    arrowState: { up: 0, down: 0 },
    /** labels: key=Math.round(val*1000), value=alpha */
    gridState: { interval: 0, labels: new Map<number, number>() },
    timeAxisState: { labels: new Map<number, { alpha: number; text: string }>() },
    orderbookState: createOrderbookState(),
    particleState: createParticleState(),
    shakeState: createShakeState(),
    badgeColor: { green: 1 },
    /** lerped badge Y, null = uninited */
    badgeY: null as number | null,
    reducedMotion: false,
    size: { w: 0, h: 0 },
    ctx: null as CanvasRenderingContext2D | null,
    raf: 0,
    lastFrame: 0,

    /** Badge DOM elements */
    badge: null as BadgeEls | null,

    /** Hover state */
    hoverX: null as number | null,
    /** 0 = not scrubbing, 1 = fully scrubbing */
    scrubAmount: 0,
    lastHover: null as { x: number; value: number; time: number } | null,
    lastHoverEntries: [] as { color: string; label: string; value: number }[],

    /** Reveal state (loading -> chart morph): 0 = loading/empty, 1 = fully revealed */
    chartReveal: 0,

    /** Pause state */
    /** 0 = playing, 1 = fully paused */
    pauseProgress: 0,
    /** accumulated seconds behind real time */
    timeDebt: 0,

    /** Data stash for reverse morph (chart -> flat line when data disappears) */
    lastData: [] as LivelinePoint[],
    lastMultiSeries: [] as Array<{ id: string; data: LivelinePoint[]; value: number; palette: LivelinePalette; label?: string }>,
    frozenNow: 0,

    /**
     * Pause data snapshot — freeze visible data when pausing to prevent
     * consumer-side pruning from eroding the left edge of the line
     */
    pausedData: null as LivelinePoint[] | null,
    pausedMultiData: null as Map<string, { data: LivelinePoint[]; value: number }> | null,

    /** Loading <-> empty crossfade */
    loadingAlpha: config.loading ? 1 : 0,

    /** --- Candle mode state (only used when mode='candle') --- */
    displayCandle: null as CandlePoint | null,
    liveBirthAlpha: 1,
    liveBull: 0.5,
    lineSmoothClose: 0,
    lineSmoothInited: false,
    /** smooth close for dashed line — never resets on candle birth */
    closeLineSmooth: 0,
    closeLineSmoothInited: false,
    lineModeProg: 0,
    lineModeTrans: { startMs: 0, from: 0, to: 0 },
    lineDensityProg: 0,
    lineDensityTrans: { startMs: 0, from: 0, to: 0 },
    lineTickSmooth: 0,
    lineTickSmoothInited: false,
    candleWidthTrans: {
      fromWidth: config.candleWidth ?? 1,
      toWidth: config.candleWidth ?? 1,
      startMs: 0,
      rangeFromMin: 0, rangeFromMax: 0,
      rangeToMin: 0, rangeToMax: 0,
      oldCandles: [] as CandlePoint[],
      oldWidth: config.candleWidth ?? 1,
    },
    prevCandleData: { candles: [] as CandlePoint[], width: config.candleWidth ?? 1 },
    pausedCandles: null as CandlePoint[] | null,
    pausedLive: null as CandlePoint | null,
    pausedLineData: null as LivelinePoint[] | null,
    pausedLineValue: null as number | null,
    lastCandles: [] as CandlePoint[],
    lastLive: null as CandlePoint | null,
    lastLineDataStash: [] as LivelinePoint[],
    lastLineValueStash: undefined as number | undefined,
  }

  /** Badge DOM elements (created once, appended to container) */
  const badgeContainer = document.createElement('div')
  badgeContainer.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;will-change:transform;display:none;z-index:1;'

  const badgeSvg = document.createElementNS(SVG_NS, 'svg')
  badgeSvg.style.cssText = 'position:absolute;top:0;left:0;'

  const badgePathEl = document.createElementNS(SVG_NS, 'path')
  badgeSvg.appendChild(badgePathEl)

  const badgeTextEl = document.createElement('span')
  badgeTextEl.style.cssText = 'position:relative;display:block;color:#fff;white-space:nowrap;'

  badgeContainer.appendChild(badgeSvg)
  badgeContainer.appendChild(badgeTextEl)
  container.appendChild(badgeContainer)

  st.badge = { container: badgeContainer, svg: badgeSvg, path: badgePathEl, text: badgeTextEl, displayW: 0, targetW: 0 }

  /** ResizeObserver — update size without layout thrashing */
  const ro = new ResizeObserver((entries) => {
    const entry = entries[0]
    if (!entry) return
    const { width, height } = entry.contentRect
    st.size = { w: width, h: height }
  })
  ro.observe(container)
  /** Init size */
  const initRect = container.getBoundingClientRect()
  st.size = { w: initRect.width, h: initRect.height }

  /** Mouse + touch events for hover/scrub */
  const onMove = (e: MouseEvent) => {
    if (!getConfig().scrub) return
    const rect = container.getBoundingClientRect()
    st.hoverX = e.clientX - rect.left
  }
  const onLeave = () => {
    st.hoverX = null
    getConfig().onHover?.(null)
  }

  const onTouchStart = (e: TouchEvent) => {
    if (!getConfig().scrub) return
    if (e.touches.length !== 1) return
    const rect = container.getBoundingClientRect()
    st.hoverX = e.touches[0].clientX - rect.left
  }
  const onTouchMove = (e: TouchEvent) => {
    if (!getConfig().scrub) return
    if (e.touches.length !== 1) return
    /** prevent scroll while scrubbing */
    e.preventDefault()
    const rect = container.getBoundingClientRect()
    st.hoverX = e.touches[0].clientX - rect.left
  }
  const onTouchEnd = () => {
    st.hoverX = null
    getConfig().onHover?.(null)
  }

  container.addEventListener('mousemove', onMove)
  container.addEventListener('mouseleave', onLeave)
  container.addEventListener('touchstart', onTouchStart, { passive: true })
  container.addEventListener('touchmove', onTouchMove, { passive: false })
  container.addEventListener('touchend', onTouchEnd)
  container.addEventListener('touchcancel', onTouchEnd)

  /** Reduced motion detection */
  const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
  st.reducedMotion = mql.matches
  const onMqlChange = (e: MediaQueryListEvent) => { st.reducedMotion = e.matches }
  mql.addEventListener('change', onMqlChange)

  /** Resume on visibility change (don't spin rAF when tab is hidden) */
  const onVisibility = () => {
    if (!document.hidden && !st.raf) {
      st.raf = requestAnimationFrame(draw)
    }
  }
  document.addEventListener('visibilitychange', onVisibility)

  /** rAF draw loop */
  function draw() {
    if (document.hidden) {
      st.raf = 0
      /** stop the loop; visibilitychange listener will restart it */
      return
    }

    const { w, h } = st.size
    if (!canvas || w === 0 || h === 0) {
      st.raf = requestAnimationFrame(draw)
      return
    }

    const cfg = getConfig()
    const dpr = getDpr()

    /** Delta time for frame-rate-independent lerps */
    const now_ms = performance.now()
    const dt = st.lastFrame ? Math.min(now_ms - st.lastFrame, MAX_DELTA_MS) : 16.67
    st.lastFrame = now_ms

    /** Resize canvas if needed */
    const targetW = Math.round(w * dpr)
    const targetH = Math.round(h * dpr)
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW
      canvas.height = targetH
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
    }

    let ctx = st.ctx
    if (!ctx || ctx.canvas !== canvas) {
      ctx = canvas.getContext('2d')
      st.ctx = ctx
    }
    if (!ctx) {
      st.raf = requestAnimationFrame(draw)
      return
    }

    applyDpr(ctx, dpr, w, h)

    /** Reduced motion: use speed=1 to skip all lerps (instant snap) */
    const noMotion = st.reducedMotion

    /** --- Mode-specific pause data snapshot --- */
    const isCandle = cfg.mode === 'candle'

    if (isCandle) {
      if (cfg.paused && st.pausedCandles === null && (cfg.candles?.length ?? 0) > 0) {
        st.pausedCandles = cfg.candles!.slice()
        st.pausedLive = cfg.liveCandle ?? null
        st.pausedLineData = cfg.lineData?.slice() ?? null
        st.pausedLineValue = cfg.lineValue ?? null
      }
      if (!cfg.paused) {
        st.pausedCandles = null
        st.pausedLive = null
        st.pausedLineData = null
        st.pausedLineValue = null
      }
    } else if (cfg.isMultiSeries && cfg.multiSeries) {
      if (cfg.paused && st.pausedMultiData === null) {
        const snap = new Map<string, { data: LivelinePoint[]; value: number }>()
        for (const s of cfg.multiSeries) {
          if (s.data.length >= 2) snap.set(s.id, { data: s.data.slice(), value: s.value })
        }
        if (snap.size > 0) st.pausedMultiData = snap
      }
      if (!cfg.paused) {
        st.pausedMultiData = null
      }
    } else {
      if (cfg.paused && st.pausedData === null && cfg.data.length >= 2) {
        st.pausedData = cfg.data.slice()
      }
      if (!cfg.paused) {
        st.pausedData = null
      }
    }

    const points = isCandle ? ([] as LivelinePoint[]) : (st.pausedData ?? cfg.data)
    const effectiveCandles = isCandle ? (st.pausedCandles ?? (cfg.candles ?? [])) : ([] as CandlePoint[])
    const hasMultiData = cfg.isMultiSeries && cfg.multiSeries ? cfg.multiSeries.some(s => s.data.length >= 2) : false
    const hasData = isCandle ? effectiveCandles.length >= 2 : (hasMultiData || points.length >= 2)
    const pad = cfg.padding
    const chartH = h - pad.top - pad.bottom

    /** --- Pause time management --- */
    const pauseTarget = cfg.paused ? 1 : 0
    st.pauseProgress = noMotion
      ? pauseTarget
      : lerp(st.pauseProgress, pauseTarget, PAUSE_PROGRESS_SPEED, dt)
    if (st.pauseProgress < 0.005) st.pauseProgress = 0
    if (st.pauseProgress > 0.995) st.pauseProgress = 1
    const pauseProgress = st.pauseProgress
    const pausedDt = dt * (1 - pauseProgress)

    const realDtSec = dt / 1000
    st.timeDebt += realDtSec * pauseProgress
    /**
     * Only drain time debt when unpausing — during pausing, let it
     * accumulate freely so the chart decelerates smoothly
     */
    if (!cfg.paused && st.timeDebt > 0.001) {
      const catchUpSpeed = st.timeDebt > 10
        ? PAUSE_CATCHUP_SPEED_FAST
        : PAUSE_CATCHUP_SPEED
      st.timeDebt = lerp(st.timeDebt, 0, catchUpSpeed, dt)
      if (st.timeDebt < 0.01) st.timeDebt = 0
    }

    /** --- Loading alpha (loading ↔ empty crossfade) --- */
    const loadingTarget = cfg.loading ? 1 : 0
    st.loadingAlpha = noMotion
      ? loadingTarget
      : lerp(st.loadingAlpha, loadingTarget, LOADING_ALPHA_SPEED, dt)
    if (st.loadingAlpha < 0.01) st.loadingAlpha = 0
    if (st.loadingAlpha > 0.99) st.loadingAlpha = 1
    const loadingAlpha = st.loadingAlpha

    /** --- Chart reveal (loading/empty → data morph) --- */
    const revealTarget = (!cfg.loading && hasData) ? 1 : 0
    st.chartReveal = noMotion
      ? revealTarget
      : lerp(st.chartReveal, revealTarget,
          revealTarget === 1 ? CHART_REVEAL_SPEED_FWD : CHART_REVEAL_SPEED, dt)
    if (Math.abs(st.chartReveal - revealTarget) < 0.005) {
      st.chartReveal = revealTarget
    }
    const chartReveal = st.chartReveal

    /**
     * Reset range when reveal fully collapses — guarantees a fresh snap
     * (not a slow lerp from stale values) when data reappears.
     */
    if (chartReveal < 0.01) {
      st.rangeInited = false
    }

    /**
     * Data stash for reverse morph — keep drawing chart while it morphs back
     * to the squiggly shape (identical to loading/empty line at reveal=0)
     */
    let useStash: boolean
    let useMultiStash = false
    if (isCandle) {
      useStash = !hasData && chartReveal > 0.005 && st.lastCandles.length > 0
      /** Candle stash updated inside candle pipeline after computing visible */
    } else {
      /** Multi-series stash */
      useMultiStash = !hasData && chartReveal > 0.005 && st.lastMultiSeries.length > 0
      if (hasMultiData && cfg.multiSeries) {
        st.lastMultiSeries = cfg.multiSeries.map(s => ({
          id: s.id, data: s.data.slice(), value: s.value, palette: s.palette, label: s.label,
        }))
      }
      /** Clear multi stash when single-series data arrives */
      if (hasData && !cfg.isMultiSeries) st.lastMultiSeries = []

      useStash = !useMultiStash && !hasData && chartReveal > 0.005 && st.lastData.length >= 2
      if (hasData && !cfg.isMultiSeries) st.lastData = points
    }

    /**
     * Update lineModeProg even during early return — prevents the
     * transition from freezing when the user toggles lineMode while
     * in loading or empty state. Without this, lineModeProg stays at
     * its pre-loading value and causes an accent-colored line flash
     * when data arrives (BUG #3).
     */
    if (isCandle) {
      const lmt = st.lineModeTrans
      const lineModeTarget = cfg.lineMode ? 1 : 0
      if (lmt.to !== lineModeTarget) {
        lmt.from = st.lineModeProg
        lmt.to = lineModeTarget
        lmt.startMs = now_ms
      }
      if (lmt.startMs > 0) {
        const elapsed = now_ms - lmt.startMs
        const t = Math.min(elapsed / LINE_MORPH_MS, 1)
        st.lineModeProg = lmt.from + (lmt.to - lmt.from) * ((1 - Math.cos(t * Math.PI)) / 2)
        if (t >= 1) { st.lineModeProg = lmt.to; lmt.startMs = 0 }
      } else {
        st.lineModeProg = lmt.to
      }
    }

    if (!hasData && !useStash && !useMultiStash) {
      /**
       * No chart pipeline — draw loading or empty as the sole visual.
       * Grey loading line for candle mode and multi-series (no single accent color)
       */
      const loadingColor = (isCandle || cfg.isMultiSeries || st.lastMultiSeries.length > 0)
        ? cfg.palette.gridLabel
        : undefined
      if (loadingAlpha > 0.01) {
        drawLoading(ctx, w, h, pad, cfg.palette, now_ms, loadingAlpha, loadingColor)
      }
      if ((1 - loadingAlpha) > 0.01) {
        drawEmpty(ctx, w, h, pad, cfg.palette, 1 - loadingAlpha, now_ms, false, cfg.emptyText)
      }
      /** Left-edge fade */
      ctx.save()
      ctx.globalCompositeOperation = 'destination-out'
      const fadeGrad = ctx.createLinearGradient(pad.left, 0, pad.left + FADE_EDGE_WIDTH, 0)
      fadeGrad.addColorStop(0, 'rgba(0, 0, 0, 1)')
      fadeGrad.addColorStop(1, 'rgba(0, 0, 0, 0)')
      ctx.fillStyle = fadeGrad
      ctx.fillRect(0, 0, pad.left + FADE_EDGE_WIDTH, h)
      ctx.restore()

      if (st.badge) st.badge.container.style.display = 'none'
      st.raf = requestAnimationFrame(draw)
      return
    }

    if (isCandle) {
      /**
       * ═══════════════════════════════════════════════════════
       * CANDLE MODE PIPELINE
       * ═══════════════════════════════════════════════════════
       */

      /**
       * Badge is never visible in pure candle mode (only during line morph),
       * so always use the smaller buffer to avoid dead space on the right.
       */
      const candleBuffer = CANDLE_BUFFER_NO_BADGE

      /** Frozen now — prevent candles from scrolling during reverse morph */
      if (hasData) st.frozenNow = Date.now() / 1000 - st.timeDebt
      const now = (hasData || chartReveal < 0.005)
        ? Date.now() / 1000 - st.timeDebt
        : st.frozenNow
      const rawLive = st.pausedCandles ? (st.pausedLive ?? undefined) : cfg.liveCandle
      let effectiveLineData = st.pausedLineData ?? cfg.lineData
      let effectiveLineValue = st.pausedLineValue ?? cfg.lineValue
      /** Stash tick data for reverse morph — keeps tick resolution during morphback */
      if (hasData && effectiveLineData && effectiveLineData.length > 0) {
        st.lastLineDataStash = effectiveLineData
        st.lastLineValueStash = effectiveLineValue
      }
      if (useStash && st.lastLineDataStash.length > 0) {
        effectiveLineData = st.lastLineDataStash
        effectiveLineValue = st.lastLineValueStash
      }
      const candleWidthSecs = cfg.candleWidth ?? 1

      /** --- Candle width morph transition --- */
      const cwt = st.candleWidthTrans
      let morphT = -1
      let displayCandleWidth: number
      if (cwt.startMs > 0) {
        const elapsed = now_ms - cwt.startMs
        const t = Math.min(elapsed / CANDLE_WIDTH_TRANS_MS, 1)
        morphT = (1 - Math.cos(t * Math.PI)) / 2
        displayCandleWidth = Math.exp(
          Math.log(cwt.fromWidth) + (Math.log(cwt.toWidth) - Math.log(cwt.fromWidth)) * morphT,
        )
        if (t >= 1) { displayCandleWidth = cwt.toWidth; cwt.startMs = 0; morphT = -1 }
      } else {
        displayCandleWidth = cwt.toWidth
      }
      if (candleWidthSecs !== cwt.toWidth) {
        cwt.oldCandles = st.prevCandleData.candles
        cwt.oldWidth = st.prevCandleData.width
        cwt.fromWidth = displayCandleWidth
        cwt.toWidth = candleWidthSecs
        cwt.startMs = now_ms
        morphT = 0
        cwt.rangeFromMin = st.displayMin
        cwt.rangeFromMax = st.displayMax
        const curWindow = st.displayWindow
        const re = now + curWindow * candleBuffer
        const le = re - curWindow
        const targetVis: CandlePoint[] = []
        for (const c of effectiveCandles) {
          if (c.time + candleWidthSecs >= le && c.time <= re) targetVis.push(c)
        }
        if (rawLive) targetVis.push(rawLive)
        if (targetVis.length > 0) {
          const tr = computeCandleRange(targetVis)
          cwt.rangeToMin = tr.min
          cwt.rangeToMax = tr.max
        } else {
          cwt.rangeToMin = st.displayMin
          cwt.rangeToMax = st.displayMax
        }
      }
      st.prevCandleData = { candles: cfg.candles ?? [], width: candleWidthSecs }

      /** lineModeProg is updated before the early return (see above). */
      const lineModeProg = st.lineModeProg

      /** --- Line density transition --- */
      const ldt = st.lineDensityTrans
      const hasTickData = effectiveLineData && effectiveLineData.length > 0
      const densityTarget = (cfg.lineMode && lineModeProg >= 0.3 && hasTickData) ? 1 : 0
      if (ldt.to !== densityTarget) {
        ldt.from = st.lineDensityProg
        ldt.to = densityTarget
        ldt.startMs = now_ms
      }
      let lineDensityProg: number
      if (ldt.startMs > 0) {
        const elapsed = now_ms - ldt.startMs
        const t = Math.min(elapsed / LINE_DENSITY_MS, 1)
        lineDensityProg = ldt.from + (ldt.to - ldt.from) * (1 - (1 - t) * (1 - t))
        if (t >= 1) { lineDensityProg = ldt.to; ldt.startMs = 0 }
      } else {
        lineDensityProg = ldt.to
      }
      st.lineDensityProg = lineDensityProg

      /** --- Window transition --- */
      const transition = st.windowTransition
      const windowResult = updateCandleWindowTransition(
        cfg.windowSecs, transition, st.displayWindow,
        st.displayMin, st.displayMax,
        now_ms, now, effectiveCandles, rawLive, candleWidthSecs, candleBuffer,
      )
      st.displayWindow = windowResult.windowSecs
      const windowSecs = windowResult.windowSecs
      const windowTransProgress = windowResult.windowTransProgress
      const isWindowTransitioning = transition.startMs > 0

      const rightEdge = now + windowSecs * candleBuffer
      const leftEdge = rightEdge - windowSecs

      /** --- Live candle OHLC lerp --- */
      let smoothLive: CandlePoint | undefined
      if (rawLive) {
        const prev = st.displayCandle
        if (!prev || prev.time !== rawLive.time) {
          st.displayCandle = {
            time: rawLive.time, open: rawLive.open,
            high: rawLive.open, low: rawLive.open, close: rawLive.open,
          }
          st.liveBirthAlpha = 0
        } else {
          const dc = st.displayCandle!
          dc.open = lerp(dc.open, rawLive.open, CANDLE_LERP_SPEED, pausedDt)
          dc.high = lerp(dc.high, rawLive.high, CANDLE_LERP_SPEED, pausedDt)
          dc.low = lerp(dc.low, rawLive.low, CANDLE_LERP_SPEED, pausedDt)
          dc.close = lerp(dc.close, rawLive.close, CANDLE_LERP_SPEED, pausedDt)
        }
        st.liveBirthAlpha = lerp(st.liveBirthAlpha, 1, 0.2, pausedDt)
        if (st.liveBirthAlpha > 0.99) st.liveBirthAlpha = 1
        const dc = st.displayCandle!
        const bullTarget = dc.close >= dc.open ? 1 : 0
        st.liveBull = lerp(st.liveBull, bullTarget, 0.12, pausedDt)
        if (st.liveBull > 0.99) st.liveBull = 1
        if (st.liveBull < 0.01) st.liveBull = 0
        smoothLive = dc
      } else {
        st.displayCandle = null
        st.liveBirthAlpha = 1
        st.liveBull = 0.5
      }

      /**
       * --- Smooth close for dashed price line ---
       * Tracks rawLive.close at candle-body speed but never resets on candle
       * birth, so the dashed line doesn't jump when a new candle starts.
       */
      if (rawLive) {
        if (!st.closeLineSmoothInited) {
          st.closeLineSmooth = rawLive.close
          st.closeLineSmoothInited = true
        } else {
          st.closeLineSmooth = lerp(st.closeLineSmooth, rawLive.close, CLOSE_LINE_LERP_SPEED, pausedDt)
          const gap = Math.abs(st.closeLineSmooth - rawLive.close)
          const range = st.displayMax - st.displayMin || 1
          if (gap < range * 0.0005) st.closeLineSmooth = rawLive.close
        }
      } else if (!useStash) {
        st.closeLineSmoothInited = false
      }

      /** --- Smooth close for line mode --- */
      if (rawLive) {
        if (!st.lineSmoothInited) {
          st.lineSmoothClose = rawLive.close
          st.lineSmoothInited = true
        } else {
          const valGap = Math.abs(rawLive.close - st.lineSmoothClose)
          const prevRange = st.displayMax - st.displayMin || 1
          const gapRatio = Math.min(valGap / prevRange, 1)
          const adaptiveSpeed = LINE_LERP_BASE + (1 - gapRatio) * LINE_ADAPTIVE_BOOST
          st.lineSmoothClose = lerp(st.lineSmoothClose, rawLive.close, adaptiveSpeed, pausedDt)
          if (valGap < prevRange * LINE_SNAP_THRESHOLD) st.lineSmoothClose = rawLive.close
        }
      } else if (!useStash) {
        /**
         * Only reset when not using stash — during reverse morph,
         * freeze the smooth value (matches line mode's displayValue freeze)
         */
        st.lineSmoothInited = false
      }

      /** --- Smooth tick value for density transition --- */
      if (effectiveLineValue !== undefined && hasTickData) {
        if (!st.lineTickSmoothInited) {
          st.lineTickSmooth = effectiveLineValue
          st.lineTickSmoothInited = true
        } else {
          const valGap = Math.abs(effectiveLineValue - st.lineTickSmooth)
          const prevRange = st.displayMax - st.displayMin || 1
          const gapRatio = Math.min(valGap / prevRange, 1)
          const adaptiveSpeed = LINE_LERP_BASE + (1 - gapRatio) * LINE_ADAPTIVE_BOOST
          st.lineTickSmooth = lerp(st.lineTickSmooth, effectiveLineValue, adaptiveSpeed, pausedDt)
          if (valGap < prevRange * LINE_SNAP_THRESHOLD) st.lineTickSmooth = effectiveLineValue
        }
      } else if (!useStash) {
        st.lineTickSmoothInited = false
      }

      /** --- Build visible candles --- */
      const visible: CandlePoint[] = []
      for (const c of effectiveCandles) {
        if (c.time + candleWidthSecs >= leftEdge && c.time <= rightEdge) visible.push(c)
      }
      if (smoothLive && smoothLive.time + displayCandleWidth >= leftEdge && smoothLive.time <= rightEdge) {
        visible.push(smoothLive)
      }
      let oldVisible: CandlePoint[] = []
      if (morphT >= 0 && cwt.oldCandles.length > 0) {
        for (const c of cwt.oldCandles) {
          if (c.time + cwt.oldWidth >= leftEdge && c.time <= rightEdge) oldVisible.push(c)
        }
      }

      /** Stash visible candles for reverse morph */
      if (hasData) {
        st.lastCandles = visible
        st.lastLive = smoothLive ?? null
      }
      const effectiveVisible = useStash ? st.lastCandles : visible
      const effectiveLive = useStash ? (st.lastLive ?? undefined) : smoothLive

      /**
       * --- Range computation ---
       * Always use full OHLC range regardless of line mode progress.
       * The close-only and tick-level ranges are tighter (no wicks),
       * so blending between them during morphs shifts the Y axis and
       * causes visible grid label drift + line position jumps.
       * Using one consistent OHLC range means zero range change during
       * the morph — the line gets slightly more Y margin in line mode
       * (room for wicks it doesn't use) but that's an acceptable trade-off.
       */
      const chartW = w - pad.left - pad.right
      const computed = effectiveVisible.length > 0
        ? computeCandleRange(effectiveVisible)
        : { min: st.displayMin, max: st.displayMax }

      const rangeResult = updateCandleRange(
        computed, st.rangeInited,
        st.displayMin, st.displayMax,
        isWindowTransitioning, windowTransProgress, transition,
        chartH, pausedDt,
      )
      if (morphT >= 0) {
        rangeResult.displayMin = cwt.rangeFromMin + (cwt.rangeToMin - cwt.rangeFromMin) * morphT
        rangeResult.displayMax = cwt.rangeFromMax + (cwt.rangeToMax - cwt.rangeFromMax) * morphT
        rangeResult.minVal = rangeResult.displayMin
        rangeResult.maxVal = rangeResult.displayMax
        rangeResult.valRange = (rangeResult.displayMax - rangeResult.displayMin) || 0.001
      }
      st.rangeInited = rangeResult.rangeInited
      st.displayMin = rangeResult.displayMin
      st.displayMax = rangeResult.displayMax
      const { minVal, maxVal, valRange } = rangeResult

      const layout: ChartLayout = {
        w, h, pad,
        chartW, chartH,
        leftEdge, rightEdge,
        minVal, maxVal, valRange,
        toX: (t: number) => pad.left + ((t - leftEdge) / (rightEdge - leftEdge)) * chartW,
        toY: (v: number) => pad.top + (1 - (v - minVal) / valRange) * chartH,
      }

      /** --- Hover + scrub --- */
      const hoverPx = st.hoverX
      let hoveredCandle: CandlePoint | null = null
      let isActiveHover = false
      if (hoverPx !== null && hoverPx >= pad.left && hoverPx <= w - pad.right) {
        hoveredCandle = candleAtX(effectiveVisible, hoverPx, displayCandleWidth, layout)
        if (hoveredCandle) isActiveHover = true
      }
      const scrubTarget = isActiveHover ? 1 : 0
      st.scrubAmount = lerp(st.scrubAmount, scrubTarget, 0.12, dt)
      if (st.scrubAmount < 0.01) st.scrubAmount = 0
      if (st.scrubAmount > 0.99) st.scrubAmount = 1
      const scrubAmount = st.scrubAmount

      let drawHoverX = hoverPx
      let drawHoverTime = 0
      let drawHoverCandle: CandlePoint | null = hoveredCandle
      if (!isActiveHover && scrubAmount > 0 && st.lastHover) {
        drawHoverX = st.lastHover.x
        drawHoverTime = st.lastHover.time
        drawHoverCandle = candleAtX(effectiveVisible, st.lastHover.x, displayCandleWidth, layout)
      } else if (isActiveHover && hoverPx !== null) {
        drawHoverTime = layout.leftEdge + ((hoverPx - pad.left) / chartW) * (layout.rightEdge - layout.leftEdge)
        st.lastHover = { x: hoverPx, value: hoveredCandle?.close ?? 0, time: drawHoverTime }
      }

      let drawCandles = effectiveVisible
      let drawOldCandles = oldVisible
      let drawLive = effectiveLive

      /** Line mode: blend live close toward smooth close */
      if (lineModeProg > 0.01 && drawLive && st.lineSmoothInited) {
        const blended = drawLive.close + (st.lineSmoothClose - drawLive.close) * lineModeProg
        drawLive = { ...drawLive, close: blended }
        const li = drawCandles.length - 1
        if (li >= 0 && drawCandles[li].time === drawLive.time) {
          drawCandles = drawCandles.slice()
          drawCandles[li] = { ...drawCandles[li], close: blended }
        }
      }

      /** Line mode OHLC collapse */
      if (lineModeProg > 0.01 && lineModeProg < 0.99) {
        const collapseOHLC = (c: CandlePoint): CandlePoint => {
          const inv = 1 - lineModeProg
          return {
            time: c.time,
            open: c.close + (c.open - c.close) * inv,
            high: c.close + (c.high - c.close) * inv,
            low: c.close + (c.low - c.close) * inv,
            close: c.close,
          }
        }
        drawCandles = drawCandles.map(collapseOHLC)
        if (drawOldCandles.length > 0) drawOldCandles = drawOldCandles.map(collapseOHLC)
        if (drawLive) drawLive = collapseOHLC(drawLive)
      }

      /**
       * Build lineVisible for drawLine — value-space points that drawLine
       * converts to screen coords with its own morphY/alpha/color logic.
       * Use tick-level resolution whenever the line is visible (lineModeProg > 0.05),
       * not just when lineDensityProg > 0.01.  The density transition finishes
       * 150ms before the line fades out; without this, lineVisible abruptly drops
       * from ~300 smooth points to ~5 stepped candle-close points while the line
       * is still at ~30% opacity, causing a visible shape jump.
       */
      let lineVisible: LivelinePoint[]
      let lineSmoothValue: number
      if (effectiveLineData && effectiveLineData.length > 0
        && (lineDensityProg > 0.01 || lineModeProg > 0.05)) {
        /** Density transition: blend candle-close values toward tick values */
        const closeRefs: { t: number; v: number }[] = []
        for (const c of drawCandles) {
          closeRefs.push({ t: c.time + displayCandleWidth / 2, v: c.close })
        }
        if (drawLive) closeRefs.push({ t: now, v: drawLive.close })

        lineVisible = []
        let refIdx = 0
        for (const pt of effectiveLineData) {
          if (pt.time < leftEdge || pt.time > rightEdge) continue
          while (refIdx < closeRefs.length - 2 && closeRefs[refIdx + 1].t < pt.time) refIdx++
          let interpClose: number
          if (closeRefs.length === 0) {
            interpClose = pt.value
          } else if (closeRefs.length === 1 || pt.time <= closeRefs[0].t) {
            interpClose = closeRefs[0].v
          } else if (refIdx >= closeRefs.length - 1) {
            interpClose = closeRefs[closeRefs.length - 1].v
          } else {
            const a = closeRefs[refIdx]
            const b = closeRefs[refIdx + 1]
            const span = b.t - a.t
            const frac = span > 0 ? Math.max(0, Math.min(1, (pt.time - a.t) / span)) : 0
            interpClose = a.v + (b.v - a.v) * frac
          }
          const blended = interpClose + (pt.value - interpClose) * lineDensityProg
          lineVisible.push({ time: pt.time, value: blended })
        }

        const smoothTick = st.lineTickSmoothInited
          ? st.lineTickSmooth
          : (effectiveLineValue ?? effectiveLineData[effectiveLineData.length - 1].value)
        /** No explicit live tip — drawLine appends one at toX(now) using lineSmoothValue */
        lineSmoothValue = st.lineSmoothClose
          + (smoothTick - st.lineSmoothClose) * lineDensityProg
      } else {
        /** Candle-close resolution — no live tip; drawLine appends one at toX(now) */
        lineVisible = drawCandles.map(c => ({
          time: c.time + displayCandleWidth / 2,
          value: c.close,
        }))
        lineSmoothValue = st.lineSmoothInited
          ? st.lineSmoothClose
          : (drawLive?.close ?? drawCandles[drawCandles.length - 1]?.close ?? 0)
      }

      /**
       * Pad lineVisible to span full chart width during reveal morph.
       * Without this, data that doesn't fill the window creates a partial-width
       * line that pops when it hands off to the full-width loading squiggly.
       */
      if (chartReveal < 1 && lineVisible.length >= 2) {
        const firstTime = lineVisible[0].time
        const windowSpan = rightEdge - leftEdge
        if (firstTime - leftEdge > windowSpan * 0.05) {
          const firstVal = lineVisible[0].value
          const step = windowSpan / 32
          const padded: LivelinePoint[] = []
          for (let t = leftEdge; t < firstTime - step * 0.5; t += step) {
            padded.push({ time: t, value: firstVal })
          }
          lineVisible = [...padded, ...lineVisible]
        }
      }

      /** --- Draw --- */
      drawCandleFrame(ctx, layout, cfg.palette, {
        candles: drawCandles,
        displayCandleWidth,
        oldCandles: drawOldCandles,
        oldWidth: cwt.oldWidth,
        morphT,
        liveCandle: drawLive,
        closePriceCandle: st.closeLineSmoothInited && rawLive
          ? { ...rawLive, close: st.closeLineSmooth }
          : rawLive,
        liveTime: effectiveLive?.time ?? -1,
        liveBirthAlpha: st.liveBirthAlpha,
        liveBullBlend: st.liveBull,
        lineModeProg,
        chartReveal,
        now_ms,
        now,
        pauseProgress,
        showGrid: cfg.showGrid,
        scrubAmount,
        hoverX: drawHoverX,
        hoverValue: drawHoverCandle?.close ?? null,
        hoverTime: drawHoverTime,
        hoveredCandle: drawHoverCandle,
        formatValue: cfg.formatValue,
        formatTime: cfg.formatTime,
        gridState: st.gridState,
        timeAxisState: st.timeAxisState,
        dt: pausedDt,
        targetWindowSecs: cfg.windowSecs,
        tooltipY: cfg.tooltipY,
        tooltipOutline: cfg.tooltipOutline,
        lineVisible,
        lineSmoothValue,
        emptyText: cfg.emptyText,
        loadingAlpha,
        /**
         * Show empty overlay when not loading AND loadingAlpha has fully
         * decayed. This prevents the gradient gap from flashing during
         * loading→live (where loadingAlpha starts at ~1), while still
         * allowing smooth fade-out during empty→live (loadingAlpha is 0).
         */
        showEmptyOverlay: !(cfg.loading ?? false) && loadingAlpha < 0.01,
      })

      /** Badge in candle mode — only when in line mode (lineModeProg > 0.5) */
      if (st.badge) {
        if (lineModeProg > 0.5 && cfg.showBadge) {
          const momentum = detectMomentum(lineVisible)
          st.badgeY = updateBadgeDOM(
            st.badge, cfg, lineSmoothValue, layout, momentum,
            st.badgeY, st.badgeColor,
            isWindowTransitioning, noMotion, ctx, pausedDt,
            chartReveal,
          )
          /** Fade badge in/out with lineModeProg (0.5→1 maps to 0→1) */
          const badgeFade = (lineModeProg - 0.5) * 2
          if (st.badge.container.style.display !== 'none') {
            const base = st.badge.container.style.opacity
              ? parseFloat(st.badge.container.style.opacity) : 1
            st.badge.container.style.opacity = String(
              base * badgeFade * (1 - pauseProgress),
            )
          }
        } else {
          st.badge.container.style.display = 'none'
        }
      }

    } else if ((cfg.isMultiSeries && cfg.multiSeries && cfg.multiSeries.length > 0) || useMultiStash) {
    /**
     * ═══════════════════════════════════════════════════════
     * MULTI-SERIES LINE MODE PIPELINE
     * ═══════════════════════════════════════════════════════
     */

    const effectiveMultiSeries = useMultiStash ? st.lastMultiSeries : cfg.multiSeries!

    /**
     * Reserve just enough right-side space so endpoint labels don't overlap
     * grid value text (which starts at w - pad.right + 8). Labels are drawn
     * at lineEnd + 6, so overlap = labelW + 6 - 8 = labelW - 2.
     * Scale with chartReveal so layout doesn't shift during loading collapse.
     */
    let labelReserve = 0
    if (effectiveMultiSeries.some(s => s.label)) {
      ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif'
      let maxLabelW = 0
      for (const s of effectiveMultiSeries) {
        if (s.label) {
          const lw = ctx.measureText(s.label).width
          if (lw > maxLabelW) maxLabelW = lw
        }
      }
      labelReserve = Math.max(0, maxLabelW - 2) * chartReveal
    }

    const chartW = w - pad.left - pad.right - labelReserve
    const buffer = cfg.showBadge ? WINDOW_BUFFER : WINDOW_BUFFER_NO_BADGE

    /** Clean stale entries from displayValues (series that were removed) */
    if (!useMultiStash) {
      const currentIds = new Set(effectiveMultiSeries.map(s => s.id))
      for (const key of st.displayValues.keys()) {
        if (!currentIds.has(key)) st.displayValues.delete(key)
      }
    }

    /** Use first series data for window transition seeding */
    const firstSeries = effectiveMultiSeries[0]
    const transition = st.windowTransition
    if (hasData) st.frozenNow = Date.now() / 1000 - st.timeDebt
    const now = useMultiStash ? st.frozenNow : Date.now() / 1000 - st.timeDebt

    /** Per-series smooth values (freeze when using stash) */
    const smoothValues = new Map<string, number>()
    for (const s of effectiveMultiSeries) {
      let dv = st.displayValues.get(s.id)
      if (dv === undefined) dv = s.value
      if (!useMultiStash) {
        const adaptiveSpeed = computeAdaptiveSpeed(
          s.value, dv,
          st.displayMin, st.displayMax,
          cfg.lerpSpeed, noMotion,
        )
        dv = lerp(dv, s.value, adaptiveSpeed, pausedDt)
        const prevRange = st.displayMax - st.displayMin || 1
        if (Math.abs(dv - s.value) < prevRange * VALUE_SNAP_THRESHOLD) dv = s.value
        st.displayValues.set(s.id, dv)
      }
      smoothValues.set(s.id, dv)
    }

    /** Per-series visibility alpha (lerp toward 0 for hidden, 1 for visible) */
    const hiddenIds = cfg.hiddenSeriesIds
    const seriesAlphas = st.seriesAlpha
    for (const s of effectiveMultiSeries) {
      let alpha = seriesAlphas.get(s.id) ?? 1
      const target = hiddenIds?.has(s.id) ? 0 : 1
      alpha = noMotion ? target : lerp(alpha, target, SERIES_TOGGLE_SPEED, pausedDt)
      if (alpha < 0.01) alpha = 0
      if (alpha > 0.99) alpha = 1
      seriesAlphas.set(s.id, alpha)
    }

    /** Window transition — seed with all series data for accurate range */
    const firstData = st.pausedMultiData?.get(firstSeries.id)?.data ?? firstSeries.data
    const windowResult = updateWindowTransition(
      cfg, transition, st.displayWindow,
      st.displayMin, st.displayMax,
      noMotion, now_ms, now, firstData, smoothValues.get(firstSeries.id) ?? firstSeries.value, buffer,
    )
    /** Override range target with union of ALL series (not just first) */
    if (transition.startMs > 0 && effectiveMultiSeries.length > 1) {
      const targetRightEdge = now + cfg.windowSecs * buffer
      const targetLeftEdge = targetRightEdge - cfg.windowSecs
      let unionMin = Infinity
      let unionMax = -Infinity
      for (const s of effectiveMultiSeries) {
        const sData = st.pausedMultiData?.get(s.id)?.data ?? s.data
        const sv = smoothValues.get(s.id) ?? s.value
        const targetVisible: LivelinePoint[] = []
        for (const p of sData) {
          if (p.time >= targetLeftEdge - 2 && p.time <= targetRightEdge) targetVisible.push(p)
        }
        if (targetVisible.length > 0) {
          const range = computeRange(targetVisible, sv, cfg.referenceLine?.value, cfg.exaggerate)
          if (range.min < unionMin) unionMin = range.min
          if (range.max > unionMax) unionMax = range.max
        }
      }
      if (isFinite(unionMin) && isFinite(unionMax)) {
        transition.rangeToMin = unionMin
        transition.rangeToMax = unionMax
      }
    }
    st.displayWindow = windowResult.windowSecs
    const windowSecs = windowResult.windowSecs
    const windowTransProgress = windowResult.windowTransProgress
    const isWindowTransitioning = transition.startMs > 0

    const rightEdge = now + windowSecs * buffer
    const leftEdge = rightEdge - windowSecs
    const filterRight = rightEdge - (rightEdge - now) * pauseProgress

    /**
     * Build per-series visible arrays and compute global range
     * Use paused snapshots when available to prevent left-edge erosion
     * Exclude hidden series (alpha < 0.01) from range so Y-axis adjusts
     */
    const seriesEntries: MultiSeriesEntry[] = []
    let globalMin = Infinity
    let globalMax = -Infinity
    for (const s of effectiveMultiSeries) {
      const snap = st.pausedMultiData?.get(s.id)
      const seriesData = snap?.data ?? s.data
      const visible: LivelinePoint[] = []
      for (const p of seriesData) {
        if (p.time >= leftEdge - 2 && p.time <= filterRight) visible.push(p)
      }
      const sv = smoothValues.get(s.id) ?? s.value
      const alpha = seriesAlphas.get(s.id) ?? 1
      if (visible.length >= 2) {
        /** Only include in range if series is at least partially visible */
        if (alpha > 0.01) {
          const range = computeRange(visible, sv, cfg.referenceLine?.value, cfg.exaggerate)
          if (range.min < globalMin) globalMin = range.min
          if (range.max > globalMax) globalMax = range.max
        }
        /** Always push to entries (drawMultiFrame skips via alpha) */
        seriesEntries.push({ visible, smoothValue: sv, palette: s.palette, label: s.label, alpha })
      }
    }

    if (seriesEntries.length === 0) {
      /**
       * No visible data — draw loading/empty fallback (matching single-series behavior)
       * Grey loading line for multi-series (no single accent color to use)
       */
      if (loadingAlpha > 0.01) {
        drawLoading(ctx, w, h, pad, cfg.palette, now_ms, loadingAlpha, cfg.palette.gridLabel)
      }
      if ((1 - loadingAlpha) > 0.01) {
        drawEmpty(ctx, w, h, pad, cfg.palette, 1 - loadingAlpha, now_ms, false, cfg.emptyText)
      }
      ctx.save()
      ctx.globalCompositeOperation = 'destination-out'
      const fadeGrad = ctx.createLinearGradient(pad.left, 0, pad.left + FADE_EDGE_WIDTH, 0)
      fadeGrad.addColorStop(0, 'rgba(0, 0, 0, 1)')
      fadeGrad.addColorStop(1, 'rgba(0, 0, 0, 0)')
      ctx.fillStyle = fadeGrad
      ctx.fillRect(0, 0, pad.left + FADE_EDGE_WIDTH, h)
      ctx.restore()
      if (st.badge) st.badge.container.style.display = 'none'
      st.raf = requestAnimationFrame(draw)
      return
    }

    /** Smooth global range */
    const computedRange = { min: isFinite(globalMin) ? globalMin : 0, max: isFinite(globalMax) ? globalMax : 1 }
    const adaptiveSpeed = cfg.lerpSpeed + ADAPTIVE_SPEED_BOOST * 0.5
    const rangeResult = updateRange(
      computedRange, st.rangeInited,
      st.targetMin, st.targetMax,
      st.displayMin, st.displayMax,
      isWindowTransitioning, windowTransProgress, transition,
      adaptiveSpeed, chartH, pausedDt,
    )
    st.rangeInited = rangeResult.rangeInited
    st.targetMin = rangeResult.targetMin
    st.targetMax = rangeResult.targetMax
    st.displayMin = rangeResult.displayMin
    st.displayMax = rangeResult.displayMax
    const { minVal, maxVal, valRange } = rangeResult

    const layout: ChartLayout = {
      w, h, pad,
      chartW, chartH,
      leftEdge, rightEdge,
      minVal, maxVal, valRange,
      toX: (t: number) => pad.left + ((t - leftEdge) / (rightEdge - leftEdge)) * chartW,
      toY: (v: number) => pad.top + (1 - (v - minVal) / valRange) * chartH,
    }

    /** Hover — interpolate value at hover time for each series */
    const hoverPx = st.hoverX
    let drawHoverX: number | null = null
    let drawHoverTime: number | null = null
    let isActiveHover = false
    let hoverEntries: { color: string; label: string; value: number }[] = []

    if (hoverPx !== null && hoverPx >= pad.left && hoverPx <= w - pad.right) {
      const maxHoverX = layout.toX(now)
      const clampedX = Math.min(hoverPx, maxHoverX)
      const t = leftEdge + ((clampedX - pad.left) / chartW) * (rightEdge - leftEdge)
      drawHoverX = clampedX
      drawHoverTime = t
      isActiveHover = true

      for (const entry of seriesEntries) {
        /** Skip hidden series from crosshair tooltip */
        if ((entry.alpha ?? 1) < 0.5) continue
        const v = interpolateAtTime(entry.visible, t)
        if (v !== null) {
          hoverEntries.push({ color: entry.palette.line, label: entry.label ?? '', value: v })
        }
      }
      st.lastHover = { x: clampedX, value: hoverEntries[0]?.value ?? 0, time: t }
      st.lastHoverEntries = hoverEntries
      cfg.onHover?.({ time: t, value: hoverEntries[0]?.value ?? 0, x: clampedX, y: layout.toY(hoverEntries[0]?.value ?? 0) })
    }

    /** Scrub amount */
    const scrubTarget = isActiveHover ? 1 : 0
    if (noMotion) {
      st.scrubAmount = scrubTarget
    } else {
      st.scrubAmount += (scrubTarget - st.scrubAmount) * SCRUB_LERP_SPEED
      if (st.scrubAmount < 0.01) st.scrubAmount = 0
      if (st.scrubAmount > 0.99) st.scrubAmount = 1
    }

    /** Fade-out: use last known hover position + cached entries */
    if (!isActiveHover && st.scrubAmount > 0 && st.lastHover) {
      drawHoverX = st.lastHover.x
      drawHoverTime = st.lastHover.time
      hoverEntries = st.lastHoverEntries
    }

    /** Draw multi-series frame */
    drawMultiFrame(ctx, layout, {
      series: seriesEntries,
      now,
      showGrid: cfg.showGrid,
      showPulse: cfg.showPulse,
      referenceLine: cfg.referenceLine,
      hoverX: drawHoverX,
      hoverTime: drawHoverTime,
      hoverEntries,
      scrubAmount: st.scrubAmount,
      windowSecs,
      formatValue: cfg.formatValue,
      formatTime: cfg.formatTime,
      gridState: st.gridState,
      timeAxisState: st.timeAxisState,
      dt,
      targetWindowSecs: cfg.windowSecs,
      tooltipY: cfg.tooltipY,
      tooltipOutline: cfg.tooltipOutline,
      chartReveal,
      pauseProgress,
      now_ms,
      primaryPalette: cfg.palette,
    })

    /**
     * During reverse morph (chart → loading/empty), overlay the empty text
     * as chartReveal drops — identical to single-series behavior
     */
    const bgAlpha = 1 - chartReveal
    if (bgAlpha > 0.01 && revealTarget === 0 && !cfg.loading) {
      const bgEmptyAlpha = (1 - loadingAlpha) * bgAlpha
      if (bgEmptyAlpha > 0.01) {
        drawEmpty(ctx, w, h, pad, cfg.palette, bgEmptyAlpha, now_ms, true, cfg.emptyText)
      }
    }

    /** Hide badge in multi-series mode */
    if (st.badge) st.badge.container.style.display = 'none'

    } else {
    /**
     * ═══════════════════════════════════════════════════════
     * LINE MODE PIPELINE (existing)
     * ═══════════════════════════════════════════════════════
     */

    const effectivePoints = useStash ? st.lastData : points

    /** Adaptive speed + smooth value (freeze lerp when using stashed data) */
    const adaptiveSpeed = computeAdaptiveSpeed(
      cfg.value, st.displayValue,
      st.displayMin, st.displayMax,
      cfg.lerpSpeed, noMotion,
    )
    if (!useStash) {
      st.displayValue = lerp(st.displayValue, cfg.value, adaptiveSpeed, pausedDt)
      /**
       * Skip snap when pausing — cfg.value keeps changing from the consumer,
       * so the snap would cause visible jumps in a supposedly frozen chart
       */
      if (pauseProgress < 0.5) {
        const prevRange = st.displayMax - st.displayMin || 1
        if (Math.abs(st.displayValue - cfg.value) < prevRange * VALUE_SNAP_THRESHOLD) {
          st.displayValue = cfg.value
        }
      }
    }
    const smoothValue = st.displayValue

    const chartW = w - pad.left - pad.right

    /**
     * Dynamic buffer: when badge is off, use a smaller buffer so the dot
     * sits closer to the right edge. When momentum arrows + badge are both
     * on, ensure enough gap for the arrows to fit.
     */
    const baseBuffer = cfg.showBadge ? WINDOW_BUFFER : WINDOW_BUFFER_NO_BADGE
    const needsArrowRoom = cfg.showMomentum && cfg.showBadge
    const buffer = needsArrowRoom
      ? Math.max(baseBuffer, 37 / Math.max(chartW, 1))
      : baseBuffer

    /** Window transition */
    const transition = st.windowTransition
    if (hasData) st.frozenNow = Date.now() / 1000 - st.timeDebt
    const now = useStash ? st.frozenNow : Date.now() / 1000 - st.timeDebt
    const windowResult = updateWindowTransition(
      cfg, transition, st.displayWindow,
      st.displayMin, st.displayMax,
      noMotion, now_ms, now, effectivePoints, smoothValue, buffer,
    )
    st.displayWindow = windowResult.windowSecs
    const windowSecs = windowResult.windowSecs
    const windowTransProgress = windowResult.windowTransProgress

    const rightEdge = now + windowSecs * buffer
    const leftEdge = rightEdge - windowSecs

    /**
     * Filter visible points — when pausing, contract right edge to `now`
     * so new data (with real-time timestamps) can't appear past the live dot
     */
    const filterRight = rightEdge - (rightEdge - now) * pauseProgress
    const visible: LivelinePoint[] = []
    for (const p of effectivePoints) {
      if (p.time >= leftEdge - 2 && p.time <= filterRight) {
        visible.push(p)
      }
    }

    if (visible.length < 2) {
      if (st.badge) st.badge.container.style.display = 'none'
      st.raf = requestAnimationFrame(draw)
      return
    }

    /** Compute + smooth Y range */
    const computedRange = computeRange(visible, smoothValue, cfg.referenceLine?.value, cfg.exaggerate)
    const isWindowTransitioning = transition.startMs > 0
    const rangeResult = updateRange(
      computedRange, st.rangeInited,
      st.targetMin, st.targetMax,
      st.displayMin, st.displayMax,
      isWindowTransitioning, windowTransProgress, transition,
      adaptiveSpeed, chartH, pausedDt,
    )
    st.rangeInited = rangeResult.rangeInited
    st.targetMin = rangeResult.targetMin
    st.targetMax = rangeResult.targetMax
    st.displayMin = rangeResult.displayMin
    st.displayMax = rangeResult.displayMax
    const { minVal, maxVal, valRange } = rangeResult

    const layout: ChartLayout = {
      w, h, pad,
      chartW, chartH,
      leftEdge, rightEdge,
      minVal, maxVal, valRange,
      toX: (t: number) => pad.left + ((t - leftEdge) / (rightEdge - leftEdge)) * chartW,
      toY: (v: number) => pad.top + (1 - (v - minVal) / valRange) * chartH,
    }

    /** Momentum */
    const momentum: Momentum = cfg.momentumOverride ?? detectMomentum(visible)

    /** Hover + scrub */
    const hoverResult = updateHoverState(
      st.hoverX, pad, w, layout, now, visible,
      st.scrubAmount, st.lastHover,
      cfg, noMotion, leftEdge, rightEdge, chartW, dt,
    )
    st.scrubAmount = hoverResult.scrubAmount
    st.lastHover = hoverResult.lastHover
    const { hoverX: drawHoverX, hoverValue: drawHoverValue, hoverTime: drawHoverTime } = hoverResult

    /** Compute swing magnitude for particles (recent velocity / visible range) */
    const lookback = Math.min(5, visible.length - 1)
    const recentDelta = lookback > 0
      ? Math.abs(visible[visible.length - 1].value - visible[visible.length - 1 - lookback].value)
      : 0
    const swingMagnitude = valRange > 0 ? Math.min(recentDelta / valRange, 1) : 0

    /** Draw canvas content (everything except badge) */
    drawFrame(ctx, layout, cfg.palette, {
      visible,
      smoothValue,
      now,
      momentum,
      arrowState: st.arrowState,
      showGrid: cfg.showGrid,
      showMomentum: cfg.showMomentum,
      showPulse: cfg.showPulse,
      showFill: cfg.showFill,
      referenceLine: cfg.referenceLine,
      hoverX: drawHoverX,
      hoverValue: drawHoverValue,
      hoverTime: drawHoverTime,
      scrubAmount: st.scrubAmount,
      windowSecs,
      formatValue: cfg.formatValue,
      formatTime: cfg.formatTime,
      gridState: st.gridState,
      timeAxisState: st.timeAxisState,
      dt,
      targetWindowSecs: cfg.windowSecs,
      tooltipY: cfg.tooltipY,
      tooltipOutline: cfg.tooltipOutline,
      orderbookData: cfg.orderbookData,
      orderbookState: cfg.orderbookData ? st.orderbookState : undefined,
      particleState: cfg.degenOptions ? st.particleState : undefined,
      particleOptions: cfg.degenOptions,
      swingMagnitude,
      shakeState: cfg.degenOptions ? st.shakeState : undefined,
      chartReveal,
      pauseProgress,
      now_ms,
    })

    /**
     * During morph (chart ↔ empty), overlay the gradient gap + text on
     * top of the morphing chart line. skipLine=true avoids double-drawing
     * the squiggly. The gap fades in smoothly as chartReveal drops.
     */
    const bgAlpha = 1 - chartReveal
    if (bgAlpha > 0.01 && revealTarget === 0 && !cfg.loading) {
      const bgEmptyAlpha = (1 - loadingAlpha) * bgAlpha
      if (bgEmptyAlpha > 0.01) {
        drawEmpty(ctx, w, h, pad, cfg.palette, bgEmptyAlpha, now_ms, true, cfg.emptyText)
      }
    }

    /** Badge (DOM element, floats above container) */
    const badge = st.badge
    if (badge) {
      st.badgeY = updateBadgeDOM(
        badge, cfg, smoothValue, layout, momentum,
        st.badgeY, st.badgeColor,
        isWindowTransitioning, noMotion, ctx, pausedDt,
        chartReveal,
      )
      /** Hide badge during pause — fully fades out as pauseProgress → 1 */
      if (pauseProgress > 0.01 && badge.container.style.display !== 'none') {
        const base = badge.container.style.opacity ? parseFloat(badge.container.style.opacity) : 1
        badge.container.style.opacity = String(base * (1 - pauseProgress))
      }
    }

    /** --- Live value display (DOM element, updated directly — no component re-renders) --- */
    const valEl = cfg.valueDisplayEl
    if (valEl) {
      /** When momentum colour is on, strip sign — colour already communicates direction */
      const displayVal = cfg.valueMomentumColor ? Math.abs(smoothValue) : smoothValue
      valEl.textContent = cfg.formatValue(displayVal)
      if (cfg.valueMomentumColor) {
        const mc = momentum === 'up' ? '#22c55e' : momentum === 'down' ? '#ef4444' : ''
        if (mc) valEl.style.color = mc
        else valEl.style.removeProperty('color')
      }
    }

    /** end else (line mode) */
    }

    st.raf = requestAnimationFrame(draw)
  }

  /** Start loop */
  st.raf = requestAnimationFrame(draw)

  return {
    destroy() {
      cancelAnimationFrame(st.raf)
      st.raf = 0
      ro.disconnect()
      container.removeEventListener('mousemove', onMove)
      container.removeEventListener('mouseleave', onLeave)
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('touchend', onTouchEnd)
      container.removeEventListener('touchcancel', onTouchEnd)
      mql.removeEventListener('change', onMqlChange)
      document.removeEventListener('visibilitychange', onVisibility)
      container.removeChild(badgeContainer)
      st.badge = null
    },
  }
}
