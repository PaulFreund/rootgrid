export function computeVirtualWindow(items, {
  scrollTop = 0,
  viewportHeight = 0,
  rowHeight = 68,
  overscan = 8
} = {}) {
  const list = Array.isArray(items) ? items : []
  const itemHeight = Math.max(1, Number(rowHeight) || 68)
  const extra = Math.max(0, Number(overscan) || 0)
  const top = Math.max(0, Number(scrollTop) || 0)
  const viewHeight = Math.max(itemHeight, Number(viewportHeight) || itemHeight)

  const visibleCount = Math.ceil(viewHeight / itemHeight)
  const start = Math.max(0, Math.floor(top / itemHeight) - extra)
  const end = Math.min(list.length, start + visibleCount + extra * 2)

  return {
    start,
    end,
    offsetTop: start * itemHeight,
    offsetBottom: Math.max(0, (list.length - end) * itemHeight),
    items: list.slice(start, end)
  }
}
