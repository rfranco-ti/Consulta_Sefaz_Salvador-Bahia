import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app/app.js';

describe('saude da aplicacao', () => {
  it('GET /health responde 200 com status ok', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    await app.close();
  });

  it('GET /ready sinaliza 503 enquanto o worker nao roda', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    const corpo = res.json();
    expect(corpo.status).toBe('falha');
    expect(corpo.dependencias.fila).toMatchObject({
      status: 'falha',
      workerVivo: false,
    });
    await app.close();
  });
});
