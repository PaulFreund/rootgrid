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

export function computeVirtualWindowVariable(items, {
  scrollTop = 0,
  viewportHeight = 0,
  getItemHeight = null,
  defaultItemHeight = 56,
  overscanPx = 0
} = {}) {
  const list = Array.isArray(items) ? items : []
  const fallbackHeight = Math.max(1, Number(defaultItemHeight) || 56)
  const top = Math.max(0, Number(scrollTop) || 0)
  const viewHeight = Math.max(fallbackHeight, Number(viewportHeight) || fallbackHeight)
  const extra = Math.max(0, Number(overscanPx) || 0)
  const minTop = Math.max(0, top - extra)
  const maxBottom = top + viewHeight + extra
  const heightOf = typeof getItemHeight === 'function'
    ? (item, index) => Math.max(1, Number(getItemHeight(item, index)) || fallbackHeight)
    : () => fallbackHeight

  let start = 0
  let end = 0
  let offsetTop = 0
  let cursor = 0
  let foundStart = false

  for (let i = 0; i < list.length; i++) {
    const itemHeight = heightOf(list[i], i)
    const nextCursor = cursor + itemHeight

    if (!foundStart && nextCursor > minTop) {
      start = i
      offsetTop = cursor
      foundStart = true
    }

    if (nextCursor >= maxBottom) {
      end = i + 1
      cursor = nextCursor
      break
    }

    cursor = nextCursor
  }

  if (!foundStart) {
    start = list.length
    end = list.length
    offsetTop = cursor
  } else if (end === 0) {
    end = list.length
  }

  let totalHeight = cursor
  for (let i = end; i < list.length; i++) {
    totalHeight += heightOf(list[i], i)
  }

  const visibleHeight = list
    .slice(start, end)
    .reduce((sum, item, index) => sum + heightOf(item, start + index), 0)

  return {
    start,
    end,
    offsetTop,
    offsetBottom: Math.max(0, totalHeight - offsetTop - visibleHeight),
    items: list.slice(start, end)
  }
}
