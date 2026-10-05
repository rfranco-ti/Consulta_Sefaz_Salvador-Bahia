import Database from 'better-sqlite3';
import { env } from '../config/env.js';
import { DatabaseError } from '../shared/errors/index.js';

/**
 * Cliente SQLite unico da aplicacao (.docs/DATABASE.md).
 * WAL + foreign keys em toda conexao.
 */
export function openDatabase(caminho: string = env.DATABASE_PATH): Database.Database {
  try {
    const db = new Database(caminho);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    return db;
  } catch (erro) {
    throw new DatabaseError('Falha ao abrir o banco SQLite', { cause: erro });
  }
}

/** Instancia unica (singleton simples; suficiente para SQLite local). */
let unica: Database.Database | null = null;

export function db(): Database.Database {
  unica ??= openDatabase();
  return unica;
}

/** Fecha a instancia (desligamento gracioso / testes). */
export function fecharDb(): void {
  unica?.close();
  unica = null;
}
