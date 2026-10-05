export { db, fecharDb, inicializarBanco, openDatabase } from './client.js';
export { aplicarMigrations, listarMigrationsAplicadas } from './migrations/index.js';
export type { Migracao } from './migrations/index.js';
export * from './repositories/index.js';
