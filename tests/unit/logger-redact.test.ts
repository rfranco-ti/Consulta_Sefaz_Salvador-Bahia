import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  APIKEY_REDACTED,
  loggerOptions,
  redactApikeyFromUrl,
  serializeRequest,
  type RequisicaoSerializavel,
} from '../../src/shared/logger/index.js';

function requisicaoFalsa(
  url: string,
  headers: Record<string, string> = {},
): RequisicaoSerializavel {
  return {
    method: 'GET',
    url,
    headers,
    host: 'localhost:3000',
    ip: '127.0.0.1',
    socket: { remotePort: 52341 },
  };
}

describe('redacao de apikey na URL logada', () => {
  it('redige o valor de ?apikey= preservando os demais query params', () => {
    const serializada = serializeRequest(
      requisicaoFalsa('/v1/consultas?tipo=nada&apikey=SEGREDO&pagina=2'),
    );
    expect(serializada.url).toBe(
      `/v1/consultas?tipo=nada&apikey=${APIKEY_REDACTED}&pagina=2`,
    );
    expect(serializada.url).not.toContain('SEGREDO');
    expect(serializada.url).toContain(APIKEY_REDACTED);
    expect(serializada.url).toContain('tipo=nada');
    expect(serializada.url).toContain('pagina=2');
  });

  it('redige apikey como unico parametro e no fim da query string', () => {
    expect(redactApikeyFromUrl('/v1/x?apikey=SOZINHA')).toBe(
      `/v1/x?apikey=${APIKEY_REDACTED}`,
    );
    expect(redactApikeyFromUrl('/v1/x?foo=1&apikey=FIM')).toBe(
      `/v1/x?foo=1&apikey=${APIKEY_REDACTED}`,
    );
  });

  it('redige valores percent-encoded por inteiro', () => {
    const codificado = 'se%2Fcre%3Dto%26x';
    const url = `/v1/x?foo=1&apikey=${codificado}&bar=2`;
    const redigida = redactApikeyFromUrl(url);
    expect(redigida).toBe(`/v1/x?foo=1&apikey=${APIKEY_REDACTED}&bar=2`);
    expect(redigida).not.toContain(codificado);
    expect(redigida).toContain('foo=1');
    expect(redigida).toContain('bar=2');
  });

  it('nao altera URL sem parametro apikey', () => {
    const url = '/v1/consultas?tipo=nada&pagina=2';
    expect(redactApikeyFromUrl(url)).toBe(url);
    expect(redactApikeyFromUrl('/health')).toBe('/health');
  });

  it('nao toca em parametros com nomes parecidos', () => {
    expect(redactApikeyFromUrl('/v1/x?apikey2=SEGREDO')).toBe(
      '/v1/x?apikey2=SEGREDO',
    );
    expect(redactApikeyFromUrl('/v1/x?xapikey=SEGREDO')).toBe(
      '/v1/x?xapikey=SEGREDO',
    );
  });

  it('mantem os headers na requisicao serializada (auth por header intacta)', () => {
    const serializada = serializeRequest(
      requisicaoFalsa('/v1/x?foo=1', {
        'x-api-key': 'CHAVE-DO-CABECALHO',
        'content-type': 'application/json',
      }),
    );
    expect(serializada.headers).toMatchObject({
      'x-api-key': 'CHAVE-DO-CABECALHO',
      'content-type': 'application/json',
    });
    expect(serializada.method).toBe('GET');
    expect(serializada.url).toBe('/v1/x?foo=1');
  });

  it('linha JSON real nao contem o segredo da query nem do header', async () => {
    const linhas: string[] = [];
    const destino = new Writable({
      write(chunk, _encoding, callback) {
        linhas.push(chunk.toString());
        callback();
      },
    });
    const log = pino(loggerOptions, destino);
    log.info(
      {
        req: requisicaoFalsa(
          '/v1/consultas?tipo=nada&apikey=SEGREDO-QUERY-123',
          { 'x-api-key': 'SEGREDO-HEADER-456' },
        ),
      },
      'requisicao recebida',
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(linhas.length).toBeGreaterThan(0);
    const linha = linhas.join('');
    expect(linha).not.toContain('SEGREDO-QUERY-123');
    expect(linha).not.toContain('SEGREDO-HEADER-456');
    expect(linha).toContain(APIKEY_REDACTED);
    expect(linha).toContain('tipo=nada');
  });
});
