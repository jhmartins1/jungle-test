import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

const result = config({
  path: '.env.test',
  override: true,
});

if (result.error) {
  throw new Error('Could not load .env.test');
}

if (!process.env.DATABASE_URL?.includes('/jungle_test_db')) {
  throw new Error('E2E tests must use jungle_test_db');
}

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.DATABASE_URL,
    },
  },
});