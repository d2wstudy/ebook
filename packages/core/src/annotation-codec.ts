import type { AnnotationAnchor, AnnotationRecord } from './types'

export const ANNOTATION_PROTOCOL = 'github-reader-annotation'
export const CURRENT_ANNOTATION_SCHEMA_VERSION = 3
export const ANNOTATION_NOTE_MARKER = '<!-- github-reader-note -->'

const METADATA_PREFIX = '<!-- github-reader-annotation:v3:'
const METADATA_PATTERN = /^<!-- github-reader-annotation:v3:([A-Za-z0-9_-]+) -->/
const MAX_ANCHOR_TEXT_LENGTH = 5000
const MAX_BLOCK_ID_LENGTH = 300
const MAX_DOCUMENT_ID_LENGTH = 400
const MAX_SEGMENTS = 128
const MAX_OFFSET = 1_000_000
const MAX_LANGUAGE_LENGTH = 64

interface AnnotationTargetV3 {
  blockId: string
  language?: string
  textQuote: {
    exact: string
    prefix: string
    suffix: string
  }
  textPosition: {
    start: number
    end: number
  }
}

interface AnnotationMetadataV3 {
  protocol: typeof ANNOTATION_PROTOCOL
  schemaVersion: 3
  documentId?: string
  targets: AnnotationTargetV3[]
}

export function encodeAnnotationBody(
  record: Omit<AnnotationRecord, 'schemaVersion'> & { schemaVersion?: number },
  format: 'github-markdown' | 'legacy-json' = 'github-markdown',
): string {
  if (format === 'legacy-json') {
    return JSON.stringify({
      schemaVersion: 2,
      type: 'annotation',
      ...record.anchor,
      note: record.note,
      ...(record.segments?.length ? { segments: record.segments } : {}),
    })
  }

  const anchors = record.segments?.length ? record.segments : [record.anchor]
  const metadata: AnnotationMetadataV3 = {
    protocol: ANNOTATION_PROTOCOL,
    schemaVersion: 3,
    ...(record.documentId ? { documentId: record.documentId } : {}),
    targets: anchors.map(anchor => ({
      blockId: anchor.paragraphId,
      ...(anchor.language ? { language: anchor.language } : {}),
      textQuote: {
        exact: anchor.selectedText,
        prefix: anchor.prefix,
        suffix: anchor.suffix,
      },
      textPosition: {
        start: anchor.startOffset,
        end: anchor.endOffset,
      },
    })),
  }

  const encoded = encodeBase64Url(JSON.stringify(metadata))
  const selectedText = anchors.map(anchor => anchor.selectedText).join(' … ').slice(0, 1200)
  const quote = selectedText
    .split(/\r?\n/)
    .map(line => `> ${line}`)
    .join('\n')

  return `${METADATA_PREFIX}${encoded} -->\n\n${quote}\n\n${ANNOTATION_NOTE_MARKER}\n${record.note}`
}

export function decodeAnnotationBody(body: string): AnnotationRecord | null {
  if (typeof body !== 'string') return null
  const trimmed = body.trimStart()

  if (trimmed.startsWith('{')) return decodeLegacyBody(trimmed)

  const match = trimmed.match(METADATA_PATTERN)
  if (!match) return null

  try {
    const metadata = JSON.parse(decodeBase64Url(match[1])) as AnnotationMetadataV3
    if (
      metadata?.protocol !== ANNOTATION_PROTOCOL
      || metadata.schemaVersion !== 3
      || !Array.isArray(metadata.targets)
      || !metadata.targets.length
      || metadata.targets.length > MAX_SEGMENTS
    ) {
      return null
    }

    if (
      metadata.documentId !== undefined
      && (!isSafeString(metadata.documentId, MAX_DOCUMENT_ID_LENGTH) || /[\r\n]/.test(metadata.documentId))
    ) {
      return null
    }

    const anchors = metadata.targets.map(mapV3Target)
    if (anchors.some(anchor => !anchor)) return null

    const noteMarkerIndex = trimmed.indexOf(ANNOTATION_NOTE_MARKER)
    const note = noteMarkerIndex >= 0
      ? trimmed.slice(noteMarkerIndex + ANNOTATION_NOTE_MARKER.length).replace(/^\r?\n/, '')
      : ''

    const validAnchors = anchors as AnnotationAnchor[]
    return {
      schemaVersion: 3,
      ...(metadata.documentId ? { documentId: metadata.documentId } : {}),
      anchor: validAnchors[0],
      ...(validAnchors.length > 1 ? { segments: validAnchors } : {}),
      note,
    }
  } catch {
    return null
  }
}

function decodeLegacyBody(body: string): AnnotationRecord | null {
  try {
    const data = JSON.parse(body)
    if (!data || typeof data !== 'object' || data.type !== 'annotation') return null

    const language = normalizeLanguage(data.language)
    const anchor = mapLegacyAnchor(data, language)
    if (!anchor) return null

    let segments: AnnotationAnchor[] | undefined
    if (Array.isArray(data.segments) && data.segments.length) {
      if (data.segments.length > MAX_SEGMENTS) return null
      const mapped: (AnnotationAnchor | null)[] = data.segments.map((segment: unknown) => {
        const value = segment as Record<string, unknown>
        return mapLegacyAnchor(value, normalizeLanguage(value?.language) || language)
      })
      if (mapped.some(segment => !segment)) return null
      segments = mapped as AnnotationAnchor[]
    }

    return {
      schemaVersion: Number.isInteger(data.schemaVersion) ? data.schemaVersion : 1,
      anchor,
      ...(segments?.length ? { segments } : {}),
      note: typeof data.note === 'string' ? data.note : '',
    }
  } catch {
    return null
  }
}

function mapV3Target(raw: AnnotationTargetV3): AnnotationAnchor | null {
  if (!raw || typeof raw !== 'object') return null
  return validateAnchor({
    paragraphId: raw.blockId,
    startOffset: raw.textPosition?.start,
    endOffset: raw.textPosition?.end,
    selectedText: raw.textQuote?.exact,
    prefix: raw.textQuote?.prefix,
    suffix: raw.textQuote?.suffix,
    language: raw.language,
  })
}

function mapLegacyAnchor(raw: Record<string, unknown>, language?: string): AnnotationAnchor | null {
  return validateAnchor({ ...raw, language })
}

function validateAnchor(raw: Record<string, unknown>): AnnotationAnchor | null {
  const paragraphId = typeof raw.paragraphId === 'string' ? raw.paragraphId.trim() : ''
  const selectedText = typeof raw.selectedText === 'string' ? raw.selectedText : ''
  const startOffset = Number(raw.startOffset)
  const endOffset = Number(raw.endOffset)
  const language = normalizeLanguage(raw.language)

  if (!paragraphId || paragraphId.length > MAX_BLOCK_ID_LENGTH || /[\r\n]/.test(paragraphId)) return null
  if (!selectedText || selectedText.length > MAX_ANCHOR_TEXT_LENGTH) return null
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)) return null
  if (startOffset < 0 || endOffset <= startOffset || endOffset > MAX_OFFSET) return null

  return {
    paragraphId,
    startOffset,
    endOffset,
    selectedText,
    prefix: typeof raw.prefix === 'string' ? raw.prefix.slice(-128) : '',
    suffix: typeof raw.suffix === 'string' ? raw.suffix.slice(0, 128) : '',
    ...(language ? { language } : {}),
  }
}

function normalizeLanguage(value: unknown): string | undefined {
  if (!isSafeString(value, MAX_LANGUAGE_LENGTH) || /[\r\n]/.test(value)) return undefined
  return value
}

function isSafeString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}
