import Database from 'better-sqlite3';
import { env } from '../config/env.js';
import { DatabaseError } from '../shared/errors/index.js';

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

let unica: Database.Database | null = null;

export function db(): Database.Database {
  unica ??= openDatabase();
  return unica;
}

export function fecharDb(): void {
  unica?.close();
  unica = null;
}
