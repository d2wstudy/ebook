import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineProject } from 'vitest/config'

export default defineProject({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          GITHUB_PAT: 'test-pat',
          GITHUB_REPOSITORY_ID: '1330540843',
          GITHUB_AUTH_APP_CLIENT_ID: 'test-client',
          GITHUB_AUTH_APP_CLIENT_SECRET: 'test-secret',
          AUTH_SESSION_SECRET: 'test-session-secret-at-least-32-bytes',
          GITHUB_WEBHOOK_SECRET: 'test-webhook-secret',
        },
      },
      wrangler: {
        configPath: './worker/wrangler.jsonc',
      },
    }),
  ],
  test: {
    include: ['tests/worker-runtime.test.ts'],
    restoreMocks: true,
  },
})
