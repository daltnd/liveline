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
): void {
  const { h, pad, leftEdge, rightEdge, toX, toY } = layout
  const baseline = h - pad.bottom

  for (const m of markers) {
    if (m.time < leftEdge || m.time > rightEdge) continue
    const v = interpolateAtTime(visible, m.time)
    if (v === null) continue
    const x = toX(m.time)
    const y = toY(v)

    /** Vertical dashed line from just below the dot's outer circle */
    if (m.id === activeId && y + 8 < baseline) {
      ctx.save()
      ctx.globalAlpha *= 0.6
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = palette.line
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x, y + 8)
      ctx.lineTo(x, baseline)
      ctx.stroke()
      ctx.restore()
    }

    drawDot(ctx, x, y, palette, false, 0, 0, m.color ?? palette.line)
  }
}
