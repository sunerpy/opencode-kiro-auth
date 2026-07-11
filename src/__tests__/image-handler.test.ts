import { describe, expect, test } from 'bun:test'
import {
  convertImagesToKiroFormat,
  extractAllImages,
  extractTextFromParts
} from '../plugin/image-handler.js'

// "Hello" -> base64 "SGVsbG8=" -> bytes [72,101,108,108,111]
const HELLO_B64 = 'SGVsbG8='
const HELLO_BYTES = [72, 101, 108, 108, 111]

describe('extractAllImages', () => {
  test('returns [] for non-array content', () => {
    expect(extractAllImages('a string')).toEqual([])
    expect(extractAllImages(null)).toEqual([])
    expect(extractAllImages(undefined)).toEqual([])
    expect(extractAllImages({ type: 'image' })).toEqual([])
  })

  test('extracts Anthropic base64 image with declared media_type', () => {
    const content = [
      { type: 'text', text: 'hi' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: HELLO_B64 } }
    ]
    expect(extractAllImages(content)).toEqual([{ mediaType: 'image/png', data: HELLO_B64 }])
  })

  test('Anthropic image without media_type defaults to image/jpeg', () => {
    const content = [{ type: 'image', source: { type: 'base64', data: HELLO_B64 } }]
    expect(extractAllImages(content)).toEqual([{ mediaType: 'image/jpeg', data: HELLO_B64 }])
  })

  test('ignores Anthropic image whose source type is not base64', () => {
    const content = [{ type: 'image', source: { type: 'url', url: 'http://x/y.png' } }]
    expect(extractAllImages(content)).toEqual([])
  })

  test('extracts OpenAI data-URL image and parses media type from header', () => {
    const content = [
      { type: 'image_url', image_url: { url: `data:image/webp;base64,${HELLO_B64}` } }
    ]
    expect(extractAllImages(content)).toEqual([{ mediaType: 'image/webp', data: HELLO_B64 }])
  })

  test('OpenAI data URL with no explicit media type defaults to image/jpeg', () => {
    // header "data:" -> split(';')[0] -> "data:" -> replace("data:","") -> "" -> fallback jpeg
    const content = [{ type: 'image_url', image_url: { url: `data:;base64,${HELLO_B64}` } }]
    expect(extractAllImages(content)).toEqual([{ mediaType: 'image/jpeg', data: HELLO_B64 }])
  })

  test('ignores OpenAI image_url that is not a data URL (http)', () => {
    const content = [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }]
    expect(extractAllImages(content)).toEqual([])
  })

  test('ignores data URL with no data portion after the comma', () => {
    const content = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' } }]
    expect(extractAllImages(content)).toEqual([])
  })

  test('combines Anthropic then OpenAI images in that order', () => {
    const content = [
      { type: 'image_url', image_url: { url: `data:image/gif;base64,${HELLO_B64}` } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: HELLO_B64 } }
    ]
    // Anthropic extraction runs first, then OpenAI
    expect(extractAllImages(content)).toEqual([
      { mediaType: 'image/png', data: HELLO_B64 },
      { mediaType: 'image/gif', data: HELLO_B64 }
    ])
  })
})

describe('convertImagesToKiroFormat', () => {
  test('decodes base64 to exact byte values and derives format from media type', () => {
    const result = convertImagesToKiroFormat([{ mediaType: 'image/png', data: HELLO_B64 }])
    expect(result.omitted).toBe(0)
    expect(result.images).toHaveLength(1)
    expect(result.images[0]!.format).toBe('png')
    expect(Array.from(result.images[0]!.source.bytes)).toEqual(HELLO_BYTES)
    expect(result.images[0]!.source.bytes).toBeInstanceOf(Uint8Array)
  })

  test('media type without a subtype falls back to format png', () => {
    const result = convertImagesToKiroFormat([{ mediaType: 'image', data: HELLO_B64 }])
    expect(result.images[0]!.format).toBe('png')
  })

  test('caps at 4 images and reports the omitted count', () => {
    const imgs = Array.from({ length: 6 }, () => ({ mediaType: 'image/png', data: HELLO_B64 }))
    const result = convertImagesToKiroFormat(imgs)
    expect(result.images).toHaveLength(4)
    expect(result.omitted).toBe(2)
  })

  test('stops before exceeding the total byte budget', () => {
    // one image whose base64 length exceeds the 3_750_000 char cap is still
    // taken first (selected.length starts 0, budget check is on running total),
    // but a second oversized one is rejected.
    const big = 'A'.repeat(2_000_000)
    const result = convertImagesToKiroFormat([
      { mediaType: 'image/png', data: big },
      { mediaType: 'image/png', data: big }
    ])
    expect(result.images).toHaveLength(1)
    expect(result.omitted).toBe(1)
  })

  test('empty input yields no images and zero omitted', () => {
    expect(convertImagesToKiroFormat([])).toEqual({ images: [], omitted: 0 })
  })
})

describe('extractTextFromParts', () => {
  test('joins text fields with no separator', () => {
    expect(extractTextFromParts([{ text: 'foo' }, { text: 'bar' }])).toBe('foobar')
  })

  test('handles explicit type:text parts', () => {
    expect(
      extractTextFromParts([
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' }
      ])
    ).toBe('hello world')
  })

  test('skips parts with no text', () => {
    expect(extractTextFromParts([{ type: 'image' }, { text: 'kept' }, {}])).toBe('kept')
  })

  test('ignores non-string text values', () => {
    // part.text is a number => first branch false; type !== 'text' => skipped
    expect(extractTextFromParts([{ text: 123 }, { text: 'ok' }])).toBe('ok')
  })

  test('empty array yields empty string', () => {
    expect(extractTextFromParts([])).toBe('')
  })
})
