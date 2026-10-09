import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { caminhoBancoAbsoluto } from '../config/env.js';
import { DatabaseError } from '../shared/errors/index.js';
import { aplicarMigrations } from './migrations/index.js';

function garantirDiretorio(caminho: string): void {
  if (caminho === ':memory:') {
    return;
  }
  mkdirSync(dirname(resolve(caminho)), { recursive: true });
}

export function openDatabase(caminho: string = caminhoBancoAbsoluto()): Database.Database {
  try {
    garantirDiretorio(caminho);
    const banco = new Database(caminho);
    banco.pragma('journal_mode = WAL');
    banco.pragma('foreign_keys = ON');
    banco.pragma('synchronous = NORMAL');
    banco.pragma('busy_timeout = 5000');
    return banco;
  } catch (erro) {
    throw new DatabaseError('Falha ao abrir o banco de dados SQLite', { cause: erro });
  }
}

export function inicializarBanco(caminho: string = caminhoBancoAbsoluto()): Database.Database {
  const banco = openDatabase(caminho);
  aplicarMigrations(banco);
  return banco;
}

let unica: Database.Database | null = null;

export function db(): Database.Database {
  if (unica === null) {
    unica = inicializarBanco();
  }
  return unica;
}

export function fecharDb(): void {
  unica?.close();
  unica = null;
}
