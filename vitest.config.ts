import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Testes de integracao usam SQLite em arquivo temporario; unit rodam puros.
    globals: false,
  },
});
