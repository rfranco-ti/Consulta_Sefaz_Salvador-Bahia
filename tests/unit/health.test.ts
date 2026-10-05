import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app/app.js';

describe('saude da aplicacao', () => {
  it('GET /health responde 200', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('GET /ready responde 200', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
