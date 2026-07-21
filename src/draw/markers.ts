import type { LivelinePalette, ChartLayout, LivelinePoint, Marker } from '../types.js'
import { interpolateAtTime } from '../math/interpolate.js'
import { drawDot } from './dot.js'

/**
 * Draw marker dots pinned to the line at each marker's time — the active one
 * gets a dashed vertical line down to the time axis.
 */
export function drawMarkers(
  ctx: CanvasRenderingContext2D,
  layout: ChartLayout,
  palette: LivelinePalette,
  markers: Marker[],
  visible: LivelinePoint[],
  activeId: string | null,
  scrubX: number | null = null,
  scrubAmount: number = 0,
): void {
  const { h, pad, leftEdge, rightEdge, toX, toY } = layout
  const baseline = h - pad.bottom
  /** The right edge sits ahead of `now` (badge breathing room), and
   *  interpolateAtTime clamps past the ends — gate on the plotted head so
   *  a marker only appears once the line reaches it. */
  const headTime = visible.length > 0 ? visible[visible.length - 1].time : -Infinity
  const baseAlpha = ctx.globalAlpha

  for (const m of markers) {
    if (m.time < leftEdge || m.time > rightEdge || m.time > headTime) continue
    const v = interpolateAtTime(visible, m.time)
    if (v === null) continue
    const x = toX(m.time)
    const y = toY(v)

    /** Match the line's dimming right of the crosshair while scrubbing */
    ctx.globalAlpha =
      scrubX !== null && x > scrubX ? baseAlpha * (1 - scrubAmount * 0.6) : baseAlpha

    /** Vertical dashed line from just below the dot's outer circle */
    if (m.id === activeId && y + 8 < baseline) {
      ctx.save()
      ctx.globalAlpha *= 0.6
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = m.color ?? palette.line
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x, y + 8)
      ctx.lineTo(x, baseline)
      ctx.stroke()
      ctx.restore()
    }

    drawDot(ctx, x, y, palette, false, 0, 0, m.color ?? palette.line)
  }

  ctx.globalAlpha = baseAlpha
}
