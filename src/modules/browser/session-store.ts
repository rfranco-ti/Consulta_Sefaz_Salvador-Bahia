import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { ValidationError } from '../../shared/errors/index.js';
import { logger as loggerPadrao } from '../../shared/logger/index.js';

export interface SessionStoreOptions {
  diretorio?: string;
  ttlHoras?: number;
  logger?: Logger;
}

interface SessaoSalva {
  estado: string;
  salvoEm: string;
}

const DIRETORIO_PADRAO = 'profiles';
const TTL_HORAS_PADRAO = 12;
const MS_POR_HORA = 3_600_000;
const CHAVE_VALIDA = /^[A-Za-z0-9._-]+$/;

function ttlHorasDaEnv(): number | undefined {
  const bruto = process.env.SESSION_TTL_HORAS;
  if (bruto === undefined) return undefined;
  const numero = Number(bruto);
  return Number.isNaN(numero) ? undefined : numero;
}

export class SessionStore {
  private readonly diretorio: string;
  private readonly ttlHoras: number | undefined;
  private readonly logger: Logger;

  constructor(opcoes: SessionStoreOptions = {}) {
    this.diretorio = opcoes.diretorio ?? path.resolve(process.cwd(), DIRETORIO_PADRAO);
    this.ttlHoras = opcoes.ttlHoras;
    this.logger = (opcoes.logger ?? loggerPadrao).child({ modulo: 'SessionStore' });
  }

  async salvar(chave: string, estado: unknown): Promise<void> {
    this.validarChave(chave);
    const segredo = process.env.ENCRYPTION_KEY ?? null;
    if (segredo === null) {
      this.logger.warn({ chave }, 'Sessão não persistida: ENCRYPTION_KEY ausente');
      return;
    }
    try {
      const texto = JSON.stringify(estado);
      const iv = randomBytes(12);
      const cifra = createCipheriv('aes-256-gcm', this.derivarChave(segredo), iv);
      const dados = Buffer.concat([cifra.update(texto, 'utf8'), cifra.final()]);
      const pacote = Buffer.concat([iv, cifra.getAuthTag(), dados]).toString('base64');
      const registro: SessaoSalva = { estado: pacote, salvoEm: new Date().toISOString() };
      await mkdir(this.diretorio, { recursive: true, mode: 0o700 });
      await writeFile(this.arquivo(chave), JSON.stringify(registro), { mode: 0o600 });
      this.logger.info({ chave }, 'Sessão salva');
    } catch (erro) {
      this.logger.warn({ chave, err: erro }, 'Falha ao salvar sessão');
    }
  }

  async carregar(chave: string): Promise<string | null> {
    this.validarChave(chave);
    try {
      const bruto = await readFile(this.arquivo(chave), 'utf8');
      const registro = JSON.parse(bruto) as Partial<SessaoSalva>;
      if (!this.dentroDoTtl(registro.salvoEm)) {
        this.logger.info({ chave }, 'Sessão expirada');
        await this.limpar(chave);
        return null;
      }
      const segredo = process.env.ENCRYPTION_KEY ?? null;
      if (segredo === null) return null;
      if (typeof registro.estado !== 'string') {
        await this.limpar(chave);
        return null;
      }
      const texto = this.decifrar(registro.estado, segredo);
      const parsed: unknown = JSON.parse(texto);
      if (typeof parsed !== 'object' || parsed === null) {
        await this.limpar(chave);
        return null;
      }
      this.logger.info({ chave }, 'Sessão carregada');
      return texto;
    } catch {
      await this.removerSilencioso(chave);
      return null;
    }
  }

  async limpar(chave: string): Promise<void> {
    this.validarChave(chave);
    await this.removerSilencioso(chave);
    this.logger.info({ chave }, 'Sessão removida');
  }

  private validarChave(chave: string): void {
    if (chave.length === 0 || !CHAVE_VALIDA.test(chave)) {
      throw new ValidationError('Chave de sessão inválida');
    }
  }

  private arquivo(chave: string): string {
    return path.join(this.diretorio, `${chave}.bin`);
  }

  private derivarChave(segredo: string): Buffer {
    return createHash('sha256').update(segredo, 'utf8').digest();
  }

  private decifrar(pacoteBase64: string, segredo: string): string {
    const pacote = Buffer.from(pacoteBase64, 'base64');
    const iv = pacote.subarray(0, 12);
    const tag = pacote.subarray(12, 28);
    const dados = pacote.subarray(28);
    const decifra = createDecipheriv('aes-256-gcm', this.derivarChave(segredo), iv);
    decifra.setAuthTag(tag);
    return Buffer.concat([decifra.update(dados), decifra.final()]).toString('utf8');
  }

  private dentroDoTtl(salvoEm: string | undefined): boolean {
    if (salvoEm === undefined) return false;
    const instante = Date.parse(salvoEm);
    if (Number.isNaN(instante)) return false;
    const ttlMs = (this.ttlHoras ?? ttlHorasDaEnv() ?? TTL_HORAS_PADRAO) * MS_POR_HORA;
    return Date.now() - instante <= ttlMs;
  }

  private async removerSilencioso(chave: string): Promise<void> {
    try {
      await rm(this.arquivo(chave), { force: true });
    } catch (erro) {
      this.logger.warn({ chave, err: erro }, 'Falha ao remover sessão');
    }
  }
}
