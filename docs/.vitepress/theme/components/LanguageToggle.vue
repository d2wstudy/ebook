<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import {
  languageLabel,
  languageShort,
  useLang,
} from '../composables/useLang'

const {
  defaultLanguage,
  availableLanguages,
  setDefaultLanguage,
  refreshLanguages,
} = useLang()
const open = ref(false)
const wrapper = ref<HTMLElement | null>(null)

function choose(language: string) {
  setDefaultLanguage(language)
  open.value = false
}

function onDocumentClick(event: MouseEvent) {
  if (!wrapper.value?.contains(event.target as Node)) open.value = false
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') open.value = false
}

onMounted(() => {
  refreshLanguages()
  document.addEventListener('click', onDocumentClick, true)
  document.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick, true)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div v-if="availableLanguages.length > 1" ref="wrapper" class="lang-switch-wrapper">
    <button
      type="button"
      class="lang-switch"
      :aria-expanded="open"
      aria-haspopup="menu"
      :title="`阅读语言：${languageLabel(defaultLanguage)}`"
      @click="open = !open"
    >
      <svg class="lang-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" />
        <ellipse cx="8" cy="8" rx="3" ry="6.5" />
        <line x1="1.5" y1="8" x2="14.5" y2="8" />
      </svg>
      <span class="lang-label">{{ languageShort(defaultLanguage) }}</span>
      <svg class="chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path d="m3 4.5 3 3 3-3" />
      </svg>
    </button>

    <div v-if="open" class="lang-menu" role="menu" aria-label="选择阅读语言">
      <button
        v-for="language in availableLanguages"
        :key="language"
        type="button"
        class="lang-option"
        :class="{ active: defaultLanguage === language }"
        role="menuitemradio"
        :aria-checked="defaultLanguage === language"
        @click="choose(language)"
      >
        <span class="option-check">{{ defaultLanguage === language ? '✓' : '' }}</span>
        <span>
          <strong>{{ languageShort(language) }}</strong>
          <small>{{ languageLabel(language) }}</small>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.lang-switch-wrapper { position: relative; }

.lang-switch {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 76px;
  padding: 3px 9px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.2s, color 0.2s, background 0.2s;
}

.lang-switch:hover,
.lang-switch[aria-expanded="true"] {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}

.lang-icon { flex-shrink: 0; }
.chevron { transition: transform 0.15s; }
.lang-switch[aria-expanded="true"] .chevron { transform: rotate(180deg); }

.lang-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 1000;
  width: 220px;
  padding: 6px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-elv);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.14);
}

.lang-option {
  display: grid;
  grid-template-columns: 20px 1fr;
  gap: 4px;
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--vp-c-text-1);
  text-align: left;
  cursor: pointer;
}

.lang-option:hover,
.lang-option.active { background: var(--vp-c-bg-soft); }
.lang-option.active strong { color: var(--vp-c-brand-1); }
.option-check { color: var(--vp-c-brand-1); font-weight: 700; }
.lang-option strong { display: block; font-size: 13px; }
.lang-option small { display: block; margin-top: 2px; color: var(--vp-c-text-2); font-size: 11px; }

@media (max-width: 640px) {
  .lang-switch {
    width: 72px;
    min-width: 72px;
    padding-inline: 6px;
    gap: 4px;
    font-size: 12px;
  }
  .lang-switch .chevron { display: none; }
  .lang-menu { position: fixed; top: 56px; right: 12px; }
}
</style>
