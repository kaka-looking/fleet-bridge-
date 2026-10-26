import { describe, expect, it } from 'vitest'
import { paginationItems } from '../src/renderer/src/pagination'

describe('request log pagination', () => {
  it.each([
    { page: 1, pages: 1, expected: [1] },
    { page: 3, pages: 5, expected: [1, 2, 3, 4, 5] },
    { page: 1, pages: 6, expected: [1, 2, 3, 4, 5, 6] },
    { page: 6, pages: 6, expected: [1, 2, 3, 4, 5, 6] },
    { page: 1, pages: 50, expected: [1, 2, 3, 4, 5, 'ellipsis', 50] },
    { page: 4, pages: 50, expected: [1, 2, 3, 4, 5, 6, 'ellipsis', 50] },
    { page: 25, pages: 50, expected: [1, 'ellipsis', 23, 24, 25, 26, 27, 'ellipsis', 50] },
    { page: 47, pages: 50, expected: [1, 'ellipsis', 45, 46, 47, 48, 49, 50] },
    { page: 50, pages: 50, expected: [1, 'ellipsis', 46, 47, 48, 49, 50] }
  ])('shows reachable endpoints on page $page of $pages', ({ page, pages, expected }) => {
    expect(paginationItems(page, pages)).toEqual(expected)
  })

  it('keeps the current page and both endpoints visible without duplicates on every page', () => {
    for (let pages = 1; pages <= 50; pages++) {
      for (let page = 1; page <= pages; page++) {
        const items = paginationItems(page, pages)
        const numbers = items.filter((item): item is number => typeof item === 'number')
        expect(items[0]).toBe(1)
        expect(items.at(-1)).toBe(pages)
        expect(numbers).toContain(page)
        expect(numbers).toEqual([...new Set(numbers)].sort((a, b) => a - b))
        expect(numbers.length).toBeLessThanOrEqual(7)
        for (let index = 1; index < items.length - 1; index++) {
          if (items[index] === 'ellipsis') {
            expect(typeof items[index - 1]).toBe('number')
            expect(typeof items[index + 1]).toBe('number')
            expect(Number(items[index + 1]) - Number(items[index - 1])).toBeGreaterThan(1)
          }
        }
      }
    }
  })
})
