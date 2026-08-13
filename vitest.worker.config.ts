import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineProject } from 'vitest/config'

export default defineProject({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          GITHUB_PAT: 'test-pat',
          GITHUB_CLIENT_ID: 'test-client',
          GITHUB_CLIENT_SECRET: 'test-secret',
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
