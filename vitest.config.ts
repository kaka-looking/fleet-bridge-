import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], testTimeout: 20000, env: { OPENAI_API_KEY: '', OPENAI_BASE_URL: '' } } })
