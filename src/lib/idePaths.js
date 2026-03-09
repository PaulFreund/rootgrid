export function buildIdeBasePath(ideId) {
  const sid = String(ideId ?? '').trim()
  return sid ? `/vscode/${sid}` : '/vscode'
}

export function buildIdeUrlPath(ideId, cwd = '') {
  const basePath = `${buildIdeBasePath(ideId)}/`
  const folder = String(cwd ?? '').trim()
  if (!folder) return basePath
  const params = new URLSearchParams({ folder })
  return `${basePath}?${params.toString()}`
}

export function stripIdeBasePath(pathname, ideId) {
  const path = String(pathname ?? '').trim() || '/'
  const basePath = buildIdeBasePath(ideId)
  if (!path.startsWith(basePath)) return path
  const rest = path.slice(basePath.length)
  if (!rest) return '/'
  return rest.startsWith('/') ? rest : `/${rest}`
}
