import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { SessionStore } from '../../src/modules/browser/session-store.js';
import { ValidationError } from '../../src/shared/errors/index.js';

const CHAVE_CRIPTO_TESTE = randomBytes(32).toString('hex');

const ESTADO_EXEMPLO = {
  cookies: [{ name: 'sessao', value: 'abc123', domain: 'portal.exemplo.br', path: '/' }],
  origins: [],
};

function criarStore(diretorio: string): SessionStore {
  return new SessionStore({ diretorio, logger: pino({ level: 'silent' }) });
}

function cifrarParaTeste(texto: string): string {
  const iv = randomBytes(12);
  const chave = createHash('sha256').update(CHAVE_CRIPTO_TESTE, 'utf8').digest();
  const cifra = createCipheriv('aes-256-gcm', chave, iv);
  const dados = Buffer.concat([cifra.update(texto, 'utf8'), cifra.final()]);
  return Buffer.concat([iv, cifra.getAuthTag(), dados]).toString('base64');
}

describe('SessionStore', () => {
  let diretorio = '';
  let store: SessionStore;
  let encryptionKeyOriginal: string | undefined;
  let ttlOriginal: string | undefined;

  beforeEach(() => {
    encryptionKeyOriginal = process.env.ENCRYPTION_KEY;
    ttlOriginal = process.env.SESSION_TTL_HORAS;
    process.env.ENCRYPTION_KEY = CHAVE_CRIPTO_TESTE;
    delete process.env.SESSION_TTL_HORAS;
    diretorio = mkdtempSync(join(tmpdir(), 'session-store-'));
    store = criarStore(diretorio);
  });

  afterEach(() => {
    if (encryptionKeyOriginal === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = encryptionKeyOriginal;
    if (ttlOriginal === undefined) delete process.env.SESSION_TTL_HORAS;
    else process.env.SESSION_TTL_HORAS = ttlOriginal;
    rmSync(diretorio, { recursive: true, force: true });
  });

  it('salvar e carregar devolvem o storageState integro', async () => {
    await store.salvar('sessao-abc', ESTADO_EXEMPLO);

    const carregado = await store.carregar('sessao-abc');

    expect(carregado).not.toBeNull();
    expect(JSON.parse(carregado as string)).toEqual(ESTADO_EXEMPLO);
  });

  it('arquivo corrompido retorna null e remove o arquivo', async () => {
    await store.salvar('sessao-abc', ESTADO_EXEMPLO);
    const arquivo = join(diretorio, 'sessao-abc.bin');
    expect(existsSync(arquivo)).toBe(true);
    writeFileSync(arquivo, 'conteudo-que-nao-e-json');

    const carregado = await store.carregar('sessao-abc');

    expect(carregado).toBeNull();
    expect(existsSync(arquivo)).toBe(false);
  });

  it('chave de criptografia errada retorna null sem lancar erro', async () => {
    await store.salvar('sessao-abc', ESTADO_EXEMPLO);
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');

    const carregado = await store.carregar('sessao-abc');

    expect(carregado).toBeNull();
  });

  it('sessao com TTL expirado retorna null e remove o arquivo', async () => {
    await store.salvar('sessao-abc', ESTADO_EXEMPLO);
    const arquivo = join(diretorio, 'sessao-abc.bin');
    expect(existsSync(arquivo)).toBe(true);
    process.env.SESSION_TTL_HORAS = '-1';

    const carregado = await store.carregar('sessao-abc');

    expect(carregado).toBeNull();
    expect(existsSync(arquivo)).toBe(false);
  });

  it('sem ENCRYPTION_KEY nao persiste e nao lanca erro', async () => {
    delete process.env.ENCRYPTION_KEY;

    await store.salvar('sessao-abc', ESTADO_EXEMPLO);
    const carregado = await store.carregar('sessao-abc');

    expect(readdirSync(diretorio)).toEqual([]);
    expect(carregado).toBeNull();
  });

  it('conteudo descriptografado invalido retorna null e remove o arquivo', async () => {
    await store.salvar('sessao-abc', ESTADO_EXEMPLO);
    const arquivo = join(diretorio, 'sessao-abc.bin');
    const registro = JSON.parse(readFileSync(arquivo, 'utf8')) as { estado: string; salvoEm: string };
    registro.estado = cifrarParaTeste('"apenas-uma-string"');
    writeFileSync(arquivo, JSON.stringify(registro));

    expect(await store.carregar('sessao-abc')).toBeNull();
    expect(existsSync(arquivo)).toBe(false);
  });

  it('chave de sessao invalida lanca erro tipado', async () => {
    await expect(store.salvar('', ESTADO_EXEMPLO)).rejects.toBeInstanceOf(ValidationError);
    await expect(store.salvar('../fora-do-diretorio', ESTADO_EXEMPLO)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(store.carregar('sessao invalida!')).rejects.toBeInstanceOf(ValidationError);
  });

  it('limpar remove a sessao persistida', async () => {
    await store.salvar('sessao-abc', ESTADO_EXEMPLO);
    expect(await store.carregar('sessao-abc')).not.toBeNull();

    await store.limpar('sessao-abc');

    expect(await store.carregar('sessao-abc')).toBeNull();
    expect(existsSync(join(diretorio, 'sessao-abc.bin'))).toBe(false);
  });
});
