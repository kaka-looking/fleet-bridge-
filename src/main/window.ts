import type { Rectangle } from 'electron'

export function initialWindowBounds(workArea: Rectangle): Rectangle {
  const width = Math.max(1, Math.min(1280, Math.floor(workArea.width * 0.82)))
  const height = Math.max(1, Math.min(800, Math.floor(workArea.height * 0.84)))
  return {
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    width,
    height
  }
}
