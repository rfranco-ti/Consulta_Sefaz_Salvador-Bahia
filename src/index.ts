try {
  process.loadEnvFile();
} catch {
}

const { startServer } = await import('./app/server.js');
await startServer();
