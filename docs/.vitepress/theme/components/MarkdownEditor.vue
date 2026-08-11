<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue'
import { useMarkdown } from '../composables/useMarkdown'

const props = withDefaults(defineProps<{
  placeholder?: string
  submitLabel?: string
  initialValue?: string
  busy?: boolean
  maxLength?: number
}>(), {
  placeholder: '写下你的想法... 支持 Markdown 语法',
  submitLabel: '提交',
  initialValue: '',
  busy: false,
  maxLength: 10000,
})

const emit = defineEmits<{
  submit: [text: string]
  cancel: []
}>()

const { renderMarkdown } = useMarkdown()
const text = ref(props.initialValue)
const previewHtml = computed(() => renderMarkdown(text.value))
const activeTab = ref<'edit' | 'preview'>('edit')
const textareaRef = ref<HTMLTextAreaElement | null>(null)

watch(() => props.initialValue, value => {
  text.value = value
  void nextTick(resizeTextarea)
})

const tools = [
  { icon: 'B', title: '粗体', cls: 'tool-bold', action: () => wrap('**', '**') },
  { icon: 'I', title: '斜体', cls: 'tool-italic', action: () => wrap('*', '*') },
  { icon: 'H', title: '标题', cls: '', action: () => wrap('### ', '') },
  { icon: '~', title: '删除线', cls: '', action: () => wrap('~~', '~~') },
  { icon: '|', title: '', cls: 'tool-sep', action: null },
  { icon: '\u{1F517}', title: '链接', cls: '', action: () => wrap('[', '](url)') },
  { icon: '</>', title: '代码', cls: 'tool-code', action: () => wrap('`', '`') },
  { icon: '\u275D', title: '引用', cls: '', action: () => wrap('> ', '') },
  { icon: '\u2022', title: '列表', cls: '', action: () => wrap('- ', '') },
]

function wrap(before: string, after: string) {
  if (props.busy) return
  const el = textareaRef.value
  if (!el) return
  const start = el.selectionStart
  const end = el.selectionEnd
  const selected = text.value.slice(start, end)
  const ph = selected || '文本'
  text.value = text.value.slice(0, start) + before + ph + after + text.value.slice(end)
  nextTick(() => {
    el.focus()
    el.selectionStart = start + before.length
    el.selectionEnd = start + before.length + ph.length
    resizeTextarea()
  })
}

function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault()
    doSubmit()
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('cancel')
  }
}

function doSubmit() {
  if (!text.value.trim() || props.busy) return
  emit('submit', text.value.trim())
}

function resizeTextarea() {
  const element = textareaRef.value
  if (!element) return
  element.style.height = 'auto'
  element.style.height = `${Math.min(element.scrollHeight, window.innerHeight * 0.4)}px`
}

defineExpose({
  focus: () => textareaRef.value?.focus(),
  clear: () => { text.value = '' },
})
</script>

<template>
  <div class="md-editor" @keydown="onKeydown">
    <div class="md-editor-toolbar">
      <template v-for="(t, i) in tools" :key="i">
        <div v-if="!t.action" class="tool-divider" />
        <button v-else type="button" class="tool-btn" :class="t.cls" :title="t.title" :disabled="busy" @click="t.action">{{ t.icon }}</button>
      </template>
      <div class="tool-spacer" />
      <div class="tab-switch">
        <button type="button" class="tab-btn" :class="{ active: activeTab === 'edit' }" @click="activeTab = 'edit'">编辑</button>
        <button type="button" class="tab-btn" :class="{ active: activeTab === 'preview' }" @click="activeTab = 'preview'">预览</button>
      </div>
    </div>

    <div class="md-editor-body">
      <textarea
        v-show="activeTab === 'edit'"
        ref="textareaRef"
        v-model="text"
        class="md-textarea"
        :placeholder="placeholder"
        :maxlength="maxLength"
        :disabled="busy"
        aria-label="Markdown 编辑器"
        @input="resizeTextarea"
      />
      <div
        v-show="activeTab === 'preview'"
        class="md-preview"
        v-html="previewHtml || '<span class=&quot;preview-empty&quot;>预览区域</span>'"
      />
    </div>

    <div class="md-editor-actions">
      <span class="char-count" :class="{ nearLimit: text.length > maxLength * 0.9 }">
        {{ text.length }} / {{ maxLength }}
      </span>
      <button type="button" class="btn-cancel" :disabled="busy" @click="emit('cancel')">取消</button>
      <button type="button" class="btn-submit" :disabled="!text.trim() || busy" @click="doSubmit">
        {{ submitLabel }} <span class="shortcut">Ctrl/⌘+Enter</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.md-editor {
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-elv);
  overflow: hidden;
}

.md-editor-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--vp-c-divider);
  flex-wrap: wrap;
}

.tool-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--vp-c-text-2);
  font-size: 13px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.tool-btn:hover { background: var(--vp-c-bg-soft); color: var(--vp-c-text-1); }
.tool-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.tool-bold { font-weight: 700; }
.tool-italic { font-style: italic; }
.tool-code { font-family: monospace; font-size: 11px; }
.tool-divider { width: 1px; height: 18px; background: var(--vp-c-divider); margin: 0 4px; }
.tool-spacer { flex: 1; }

.tab-switch { display: flex; gap: 2px; background: var(--vp-c-bg-soft); border-radius: 6px; padding: 2px; }
.tab-btn {
  padding: 3px 10px; border: none; border-radius: 4px; background: none;
  color: var(--vp-c-text-2); font-size: 12px; cursor: pointer; transition: all 0.15s;
}
.tab-btn.active { background: var(--vp-c-bg-elv); color: var(--vp-c-text-1); box-shadow: 0 1px 3px rgba(0,0,0,0.08); }

.md-editor-body { min-height: 120px; max-height: 40vh; overflow: auto; }
.md-textarea {
  width: 100%; height: 100%; min-height: 120px; border: none; padding: 12px 16px;
  font-size: 14px; font-family: inherit; line-height: 1.7; resize: vertical;
  background: var(--vp-c-bg); color: var(--vp-c-text-1); outline: none;
}
.md-preview {
  padding: 12px 16px; font-size: 14px; line-height: 1.7;
  color: var(--vp-c-text-1); overflow-y: auto; height: 100%; min-height: 120px;
}
.md-preview :deep(p) { margin: 6px 0; }
.md-preview :deep(code) { background: var(--vp-c-bg-soft); padding: 2px 5px; border-radius: 3px; font-size: 13px; }
.md-preview :deep(pre) { background: var(--vp-c-bg-soft); padding: 10px; border-radius: 6px; overflow-x: auto; margin: 8px 0; }
.md-preview :deep(pre code) { background: none; padding: 0; }
.md-preview :deep(blockquote) { border-left: 3px solid var(--vp-c-divider); padding-left: 10px; color: var(--vp-c-text-2); margin: 8px 0; }
.md-preview :deep(a) { color: var(--vp-c-brand-1); text-decoration: none; }
.md-preview :deep(a:hover) { text-decoration: underline; }
.md-preview :deep(ul), .md-preview :deep(ol) { padding-left: 20px; margin: 6px 0; }
.md-preview :deep(li) { margin: 2px 0; }
.md-preview :deep(h1), .md-preview :deep(h2), .md-preview :deep(h3), .md-preview :deep(h4) {
  margin: 8px 0 4px; font-weight: 600; border: none; padding: 0; line-height: 1.5;
}
.md-preview :deep(h1) { font-size: 17px; }
.md-preview :deep(h2) { font-size: 16px; }
.md-preview :deep(h3) { font-size: 15px; }
.md-preview :deep(h4) { font-size: 14px; }
.md-preview :deep(hr) { margin: 8px 0; border: none; border-top: 1px solid var(--vp-c-divider); }
.md-preview :deep(img) { max-width: 100%; border-radius: 6px; margin: 4px 0; }
.md-preview :deep(table) { border-collapse: collapse; margin: 6px 0; font-size: 13px; }
.md-preview :deep(th), .md-preview :deep(td) { border: 1px solid var(--vp-c-divider); padding: 4px 8px; }
.md-preview :deep(th) { background: var(--vp-c-bg-soft); font-weight: 600; }
.md-preview :deep(.mention) {
  color: var(--vp-c-brand-1); font-weight: 500;
  background: color-mix(in srgb, var(--vp-c-brand-1) 8%, transparent);
  padding: 1px 4px; border-radius: 3px;
}
.preview-empty { color: var(--vp-c-text-2); font-style: italic; }

.md-editor-actions {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--vp-c-divider);
}
.btn-cancel, .btn-submit {
  padding: 6px 16px; border-radius: 6px; font-size: 13px; cursor: pointer;
  border: 1px solid var(--vp-c-divider);
}
.btn-cancel { background: none; color: var(--vp-c-text-2); }
.btn-cancel:hover { background: var(--vp-c-bg-soft); }
.btn-submit { background: var(--vp-c-brand-1); color: #fff; border-color: var(--vp-c-brand-1); }
.btn-submit:disabled { opacity: 0.5; cursor: not-allowed; }
.shortcut { font-size: 11px; opacity: 0.7; }
.char-count { margin-right: auto; color: var(--vp-c-text-2); font-size: 11px; }
.char-count.nearLimit { color: var(--vp-c-warning-1); }
</style>
