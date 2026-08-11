<script setup lang="ts">
defineProps<{
  visible: boolean
  x: number
  y: number
  placement: 'above' | 'below'
  loggedIn: boolean
  error?: string | null
}>()

defineEmits<{
  'open-editor': []
  login: []
}>()
</script>

<template>
  <Teleport to="body">
    <Transition name="bubble-fade">
      <div
        v-if="visible"
        class="note-bubble"
        :class="`placement-${placement}`"
        :style="{ left: `${x}px`, top: `${y}px` }"
        data-annotation-ui="true"
        role="toolbar"
        aria-label="划词操作"
        @pointerdown.prevent
      >
        <div v-if="error" class="note-bubble-error" role="status">{{ error }}</div>
        <button
          v-else-if="loggedIn"
          type="button"
          class="note-bubble-btn"
          @click="$emit('open-editor')"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
          添加笔记
        </button>
        <button
          v-else
          type="button"
          class="note-bubble-btn login-bubble-btn"
          @click="$emit('login')"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
            <polyline points="10 17 15 12 10 7" />
            <line x1="15" y1="12" x2="3" y2="12" />
          </svg>
          登录并添加笔记
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.note-bubble {
  position: fixed;
  z-index: 300;
  max-width: min(360px, calc(100vw - 24px));
  pointer-events: auto;
}

.placement-above { transform: translate(-50%, -100%); }
.placement-below { transform: translate(-50%, 0); }

.note-bubble::after {
  content: '';
  position: absolute;
  left: 50%;
  width: 8px;
  height: 8px;
  background: var(--vp-c-bg-elv);
  border-right: 1px solid var(--vp-c-divider);
  border-bottom: 1px solid var(--vp-c-divider);
}

.placement-above::after {
  bottom: -5px;
  transform: translateX(-50%) rotate(45deg);
}

.placement-below::after {
  top: -5px;
  transform: translateX(-50%) rotate(225deg);
}

.note-bubble-btn,
.note-bubble-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 9px;
  background: var(--vp-c-bg-elv);
  color: var(--vp-c-text-1);
  font-size: 13px;
  line-height: 1.4;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
}

.note-bubble-btn {
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, transform 0.15s;
}

.note-bubble-btn:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
  transform: translateY(-1px);
}

.login-bubble-btn { color: var(--vp-c-text-2); }
.note-bubble-error { color: var(--vp-c-danger-1); font-size: 12px; }

.bubble-fade-enter-active,
.bubble-fade-leave-active { transition: opacity 0.14s; }
.bubble-fade-enter-from,
.bubble-fade-leave-to { opacity: 0; }

@media (prefers-reduced-motion: reduce) {
  .bubble-fade-enter-active,
  .bubble-fade-leave-active,
  .note-bubble-btn { transition: none; }
}
</style>
