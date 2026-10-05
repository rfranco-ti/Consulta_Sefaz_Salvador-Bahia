// Ponto de entrada da API.
// Carrega o .env (se existir) ANTES de importar qualquer modulo que leia env.

try {
  process.loadEnvFile();
} catch {
  // sem .env: segue com padroes (src/config/env.ts)
}

const { startServer } = await import('./app/server.js');
await startServer();
