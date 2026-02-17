import { describe, expect, it } from 'bun:test'

import { rewriteRootAbsoluteUrlsToRelative } from './preview.js'

describe('preview rewrite', () => {
  it('rewrites quoted root-absolute urls', () => {
    const input = '<script src="/@vite/client"></script><link href="/assets/app.css" />'
    const out = rewriteRootAbsoluteUrlsToRelative(input)
    expect(out.includes('"@vite/client"')).toBe(true)
    expect(out.includes('"assets/app.css"')).toBe(true)
  })

  it('does not rewrite protocol-relative urls', () => {
    const input = '<script src="//cdn.example.com/x.js"></script>'
    const out = rewriteRootAbsoluteUrlsToRelative(input)
    expect(out).toBe(input)
  })

  it('rewrites css url(/...)', () => {
    const input = 'body{background:url(/img/bg.png)}'
    const out = rewriteRootAbsoluteUrlsToRelative(input)
    expect(out.includes('url(img/bg.png)')).toBe(true)
  })

  it('rewrites srcset values', () => {
    const input = '<img srcset="/a.png 1x, /b.png 2x" />'
    const out = rewriteRootAbsoluteUrlsToRelative(input)
    expect(out.includes('srcset="a.png 1x, b.png 2x"')).toBe(true)
  })
})
