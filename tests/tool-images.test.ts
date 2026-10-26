import { describe, expect, it } from 'vitest'
import { PRESETS } from '../src/shared/presets'
import { toChat } from '../src/main/translate'

const provider = { ...PRESETS.deepseek, id: 'vision-test', apiKeySet: false }
const model = 'deepseek-flash'
const imageUrl = 'data:image/png;base64,aW1hZ2U='
const image = { type: 'input_image', image_url: imageUrl, detail: 'high' }
const call = { type: 'function_call', name: 'view_image', call_id: 'image-call', arguments: '{}' }

describe('multimodal tool results', () => {
  it.each(['function_call_output', 'custom_tool_call_output', 'tool_search_output'])('preserves images in %s instead of serializing them', type => {
    const toolCall = type === 'custom_tool_call_output'
      ? { type: 'custom_tool_call', name: 'view_image', call_id: call.call_id, input: 'picture.png' }
      : type === 'tool_search_output' ? { type: 'tool_search_call', call_id: call.call_id, arguments: {} } : call
    const request = { input: [
      toolCall, { type, call_id: call.call_id, output: [{ type: 'input_text', text: 'Tool screenshot' }, image] }
    ] }
    const before = structuredClone(request)
    const { body } = toChat(request, provider, model)
    expect(body.messages.map((message: any) => message.role)).toEqual(['assistant', 'tool', 'user'])
    expect(body.messages[1]).toMatchObject({ tool_call_id: call.call_id })
    expect(body.messages[1].content).toContain('Tool screenshot')
    expect(body.messages[1].content).not.toContain(imageUrl)
    expect(body.messages[1].content).not.toContain('"input_image"')
    expect(body.messages[2].content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(call.call_id) })
    expect(body.messages[2].content[1]).toEqual({ type: 'image_url', image_url: { url: imageUrl, detail: 'high' } })
    expect(request).toEqual(before)
  })
  it('keeps all parallel tool replies together before the associated image messages', () => {
    const { body } = toChat({ input: [
      call, { ...call, call_id: 'second-call' },
      { type: 'function_call_output', call_id: call.call_id, output: [image] },
      { type: 'function_call_output', call_id: 'second-call', output: [
        { type: 'input_image', image_url: 'https://example.test/second.png', detail: 'low' },
        { type: 'input_image', image_url: 'https://example.test/third.png' }
      ] }
    ] }, provider, model)
    expect(body.messages.map((message: any) => message.role)).toEqual(['assistant', 'tool', 'tool', 'user', 'user'])
    expect(body.messages[0].tool_calls.map((tool: any) => tool.id)).toEqual([call.call_id, 'second-call'])
    expect(body.messages.slice(1, 3).map((message: any) => message.tool_call_id)).toEqual([call.call_id, 'second-call'])
    expect(body.messages[3].content[0].text).toContain(call.call_id)
    expect(body.messages[4].content[0].text).toContain('second-call')
    expect(body.messages[4].content.filter((part: any) => part.type === 'image_url')).toEqual([
      { type: 'image_url', image_url: { url: 'https://example.test/second.png', detail: 'low' } },
      { type: 'image_url', image_url: { url: 'https://example.test/third.png' } }
    ])
  })
  it.each([
    { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
    { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }
  ])('supports Chat and MCP image blocks: $type', part => {
    const { body } = toChat({ input: [call, { type: 'function_call_output', call_id: call.call_id, output: [part] }] }, provider, model)
    expect(body.messages[2].content[1].image_url.url).toBe(imageUrl)
    expect(body.messages[1].content).not.toContain('aW1hZ2U=')
  })
  it('supports MCP content envelopes without losing metadata or unknown output blocks', () => {
    const { body } = toChat({ input: [call, {
      type: 'function_call_output', call_id: call.call_id,
      output: { content: [{ type: 'text', text: 'MCP screenshot' }, image, { type: 'resource_link', uri: 'file:///result' }], isError: false }
    }] }, provider, model)
    expect(body.messages[1].content).toContain('MCP screenshot')
    expect(body.messages[1].content).toContain('"isError":false')
    expect(body.messages[1].content).toContain('"uri":"file:///result"')
    expect(body.messages[2].content[1].image_url.url).toBe(imageUrl)
  })
  it.each([
    'original text\nwith formatting',
    { result: 'structured JSON', count: 2 },
    [{ result: 1 }, { result: 2 }],
    [],
    '[{"type":"input_image","image_url":"not an actual image block"}]'
  ])('does not reinterpret ordinary strings or JSON objects as multimodal results', output => {
    const { body } = toChat({ input: [call, { type: 'function_call_output', call_id: call.call_id, output }] }, provider, model)
    expect(body.messages).toHaveLength(2)
    expect(body.messages[1].content).toBe(typeof output === 'string' ? output : JSON.stringify(output))
  })
  it('flattens text content blocks without dropping unrecognized JSON results', () => {
    const { body } = toChat({ input: [call, {
      type: 'function_call_output', call_id: call.call_id,
      output: [{ type: 'input_text', text: 'first' }, { type: 'text', text: 'second' }, { result: 3 }, null]
    }] }, provider, model)
    expect(body.messages).toHaveLength(2)
    expect(body.messages[1].content).toBe('first\nsecond\n{"result":3}\nnull')
  })
  it('checks tool images against the selected model vision capability', () => {
    const request = { input: [call, { type: 'function_call_output', call_id: call.call_id, output: [image] }] }
    expect(() => toChat(request, provider, 'deepseek-v4-pro')).toThrow('图片')
    expect(() => toChat(request, { ...provider, vision: false }, model)).not.toThrow()
  })
  it('rejects unresolvable image file IDs instead of silently forwarding an empty URL', () => {
    const request = { input: [call, { type: 'function_call_output', call_id: call.call_id, output: [{ type: 'input_image', file_id: 'file-only' }] }] }
    expect(() => toChat(request, provider, model)).toThrow('image_url')
  })
})
