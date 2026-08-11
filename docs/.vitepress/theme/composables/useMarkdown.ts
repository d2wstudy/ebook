import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({
  breaks: true,
  gfm: true,
})

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'del', 'code', 'pre',
  'blockquote', 'ul', 'ol', 'li', 'a', 'h1', 'h2',
  'h3', 'h4', 'hr', 'img', 'table', 'thead', 'tbody',
  'tr', 'th', 'td',
]

const ALLOWED_ATTR = ['href', 'src', 'alt', 'title', 'target']

/**
 * Convert @username mentions to styled spans.
 * Skips content inside <code>, <pre>, <a> tags to avoid false matches.
 */
function highlightMentions(html: string): string {
  // Split HTML by tags to avoid replacing inside code/pre/a
  const parts = html.split(/(<\/?(?:code|pre|a)[^>]*>)/i)
  let depth = 0
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      // This is a tag
      if (/^<\/(code|pre|a)/i.test(part)) depth--
      else if (/^<(code|pre|a)/i.test(part)) depth++
      return part
    }
    // Text node — only replace when not inside code/pre/a
    if (depth > 0) return part
    return part.replace(
      /@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)\b/g,
      '<a class="mention" href="https://github.com/$1" target="_blank" rel="noopener noreferrer">@$1</a>'
    )
  }).join('')
}

export function useMarkdown() {
  function renderMarkdown(src: string): string {
    if (!src) return ''
    const raw = marked.parse(src) as string
    const clean = DOMPurify.sanitize(raw, { ALLOWED_TAGS, ALLOWED_ATTR })
    return hardenRenderedHtml(highlightMentions(clean))
  }

  return { renderMarkdown }
}

function hardenRenderedHtml(html: string): string {
  if (typeof document === 'undefined') return html

  const template = document.createElement('template')
  template.innerHTML = html

  template.content.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(link => {
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  })

  template.content.querySelectorAll<HTMLImageElement>('img[src]').forEach(image => {
    const src = image.getAttribute('src') || ''
    const explicitHttps = /^https:\/\//i.test(src)
    const localAbsolutePath = src.startsWith('/') && !/^[/\\]{2}/.test(src)
    if (!explicitHttps && !localAbsolutePath) {
      image.remove()
      return
    }
    image.loading = 'lazy'
    image.decoding = 'async'
    image.referrerPolicy = 'no-referrer'
  })

  return template.innerHTML
}
