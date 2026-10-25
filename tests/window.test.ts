import { describe, expect, it } from 'vitest'
import { initialWindowBounds } from '../src/main/window'

describe('initial window placement', () => {
  it.each([
    { x: 0, y: 0, width: 1536, height: 816 },
    { x: 0, y: 0, width: 1920, height: 1040 },
    { x: -1536, y: 0, width: 1536, height: 816 },
    { x: 1920, y: 40, width: 1280, height: 680 }
  ])('opens centered with space around it on display %j', area => {
    const bounds = initialWindowBounds(area)
    expect(bounds.width).toBeLessThan(area.width)
    expect(bounds.height).toBeLessThan(area.height)
    expect(bounds.width).toBeLessThanOrEqual(1280)
    expect(bounds.height).toBeLessThanOrEqual(800)
    expect(Math.abs(bounds.x + bounds.width / 2 - (area.x + area.width / 2))).toBeLessThanOrEqual(1)
    expect(Math.abs(bounds.y + bounds.height / 2 - (area.y + area.height / 2))).toBeLessThanOrEqual(1)
    expect(bounds.x).toBeGreaterThan(area.x)
    expect(bounds.y).toBeGreaterThan(area.y)
    expect(bounds.x + bounds.width).toBeLessThan(area.x + area.width)
    expect(bounds.y + bounds.height).toBeLessThan(area.y + area.height)
  })
})
