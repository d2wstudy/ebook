// Backward-compatible application import. The implementation is now public,
// provider-independent core code under packages/core.
export {
  DEFAULT_IGNORED_TEXT_SELECTOR,
  captureSelector,
  createContentTextWalker,
  getFullText,
  getTextOffset,
  resolveSelector,
  type ResolvedRange,
  type TextQuoteSelector,
  type TextWalkerOptions,
} from '@github-reader/core'
