export function paginationItems(page: number, pages: number): (number | 'ellipsis')[] {
  const start = Math.max(1, Math.min(page - 2, pages - 4))
  const end = Math.min(pages, start + 4)
  const items: (number | 'ellipsis')[] = []
  if (start > 1) items.push(1)
  if (start > 2) items.push('ellipsis')
  for (let current = start; current <= end; current++) items.push(current)
  if (end < pages - 1) items.push('ellipsis')
  if (end < pages) items.push(pages)
  return items
}
