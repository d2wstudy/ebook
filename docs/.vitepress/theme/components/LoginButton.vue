<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { useAuth } from '../composables/useAuth'

const { user, loading, error, login, logout, clearError } = useAuth()
const showMenu = ref(false)
const btnRef = ref<HTMLElement | null>(null)
const menuStyle = ref({ top: '0px', right: '0px' })
let hideTimer: ReturnType<typeof setTimeout> | null = null

function updateMenuPos() {
  if (!btnRef.value) return
  const rect = btnRef.value.getBoundingClientRect()
  menuStyle.value = {
    top: rect.bottom + 4 + 'px',
    right: window.innerWidth - rect.right + 'px',
  }
}

function onEnter() {
  if (!user.value) return
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
  showMenu.value = true
  nextTick(updateMenuPos)
}

function onLeave() {
  hideTimer = setTimeout(() => { showMenu.value = false }, 150)
}

function onMenuEnter() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
}

function onMenuLeave() {
  showMenu.value = false
}

function handleLogout() {
  showMenu.value = false
  logout()
}

function toggleMenu() {
  if (!user.value) return
  showMenu.value = !showMenu.value
  if (showMenu.value) nextTick(updateMenuPos)
}

function onClickOutside(e: MouseEvent) {
  if (!showMenu.value) return
  if (btnRef.value?.contains(e.target as Node)) return
  const menu = document.querySelector('.login-menu-portal')
  if (menu?.contains(e.target as Node)) return
  showMenu.value = false
}

onMounted(() => document.addEventListener('click', onClickOutside, true))
onUnmounted(() => {
  document.removeEventListener('click', onClickOutside, true)
  if (hideTimer) clearTimeout(hideTimer)
})
</script>

<template>
  <div class="login-btn-wrapper">
    <span v-if="loading" class="avatar-placeholder" />
    <button
      v-else-if="!user"
      type="button"
      class="sign-in-btn"
      :disabled="loading"
      @click="login"
    >登录 GitHub</button>
    <button
      v-else
      ref="btnRef"
      type="button"
      class="avatar-btn"
      aria-haspopup="menu"
      :aria-expanded="showMenu"
      aria-label="打开 GitHub 用户菜单"
      @mouseenter="onEnter"
      @mouseleave="onLeave"
      @click="toggleMenu"
    >
      <img :src="user.avatar_url" :alt="user.login" class="user-avatar" />
    </button>

    <Teleport to="body">
      <div
        v-if="showMenu && user"
        class="login-menu-portal"
        :style="menuStyle"
        @mouseenter="onMenuEnter"
        @mouseleave="onMenuLeave"
      >
        <div class="menu-header">
          <img :src="user.avatar_url" class="menu-avatar" />
          <a :href="user.html_url" target="_blank" rel="noopener noreferrer" class="menu-name">{{ user.login }}</a>
        </div>
        <div class="menu-divider" />
        <button type="button" class="menu-item danger" @click="handleLogout">退出并撤销授权</button>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="error" class="auth-error-toast" role="alert">
        <span>{{ error }}</span>
        <button type="button" aria-label="关闭提示" @click="clearError">×</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.login-btn-wrapper {
  display: flex;
  align-items: center;
}

.avatar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  border-radius: 50%;
  transition: opacity 0.2s;
}

.avatar-btn:hover {
  opacity: 0.8;
}

.user-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
}

.sign-in-btn {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-size: 13px;
  padding: 2px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.sign-in-btn:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
.sign-in-btn:disabled { opacity: .55; cursor: wait; }

.avatar-placeholder {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--vp-c-bg-soft);
}
</style>

<style>
.login-menu-portal {
  position: fixed;
  min-width: 160px;
  background: var(--vp-c-bg-elv);
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  z-index: 9999;
  padding: 6px 0;
}

.login-menu-portal .menu-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
}

.login-menu-portal .menu-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
}

.login-menu-portal .menu-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--vp-c-text-1);
  text-decoration: none;
}

.auth-error-toast {
  position: fixed;
  top: 70px;
  right: 18px;
  z-index: 10000;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(380px, calc(100vw - 36px));
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--vp-c-danger-1) 40%, var(--vp-c-divider));
  border-radius: 9px;
  background: var(--vp-c-bg-elv);
  color: var(--vp-c-danger-1);
  box-shadow: 0 10px 28px rgba(0,0,0,.15);
  font-size: 12px;
}
.auth-error-toast button { border: 0; background: transparent; color: inherit; font-size: 18px; cursor: pointer; }

.login-menu-portal .menu-divider {
  height: 1px;
  background: var(--vp-c-divider);
  margin: 4px 0;
}

.login-menu-portal .menu-item {
  display: block;
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: none;
  color: var(--vp-c-text-2);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.login-menu-portal .menu-item:hover {
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
}

.login-menu-portal .menu-item.danger:hover {
  color: var(--vp-c-danger-1, #e5484d);
}
</style>
