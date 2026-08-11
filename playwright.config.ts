import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:15692/ebook/',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx vitepress dev docs --host 127.0.0.1 --port 15692',
    url: 'http://127.0.0.1:15692/ebook/',
    env: {
      VITE_WORKER_URL: 'http://127.0.0.1:15692/mock-worker',
    },
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
