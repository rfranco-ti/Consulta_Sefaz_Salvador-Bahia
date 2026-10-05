import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { carregarPortalConfig } from '../../src/modules/browser/portal-config.js';
import { NotFoundError, ValidationError } from '../../src/shared/errors/index.js';

const diretorioFixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
);

describe('carregarPortalConfig', () => {
  it('carrega fixture válido com tipos, hosts e navegação', async () => {
    const config = await carregarPortalConfig('portal-exemplo', diretorioFixtures);
    expect(config.metadata.sigla).toBe('EXEMPLO');
    expect(config.navegacao.url).toBe('https://exemplo.test/consulta');
    expect(config.recursos?.bloquearTipos).toContain('image');
    expect(config.recursos?.bloquearTipos).toContain('font');
    expect(config.recursos?.bloquearHosts).toContain('analytics.exemplo.test');
    expect(config.human?.perfil).toBe('normal');
  });

  it('aceita o nome com sufixo .portal.json', async () => {
    const config = await carregarPortalConfig(
      'portal-exemplo.portal.json',
      diretorioFixtures,
    );
    expect(config.metadata.sigla).toBe('EXEMPLO');
  });

  it('arquivo inexistente rejeita com NotFoundError', async () => {
    await expect(
      carregarPortalConfig('portal-que-nao-existe', diretorioFixtures),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      carregarPortalConfig('portal-que-nao-existe', diretorioFixtures),
    ).rejects.toThrow(/não encontrada/);
  });

  it('JSON inválido rejeita com ValidationError', async () => {
    await expect(
      carregarPortalConfig('portal-json-invalido', diretorioFixtures),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      carregarPortalConfig('portal-json-invalido', diretorioFixtures),
    ).rejects.toThrow(/JSON inválido/);
  });

  it('JSON sem metadata.sigla rejeita com ValidationError', async () => {
    await expect(
      carregarPortalConfig('portal-sem-sigla', diretorioFixtures),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      carregarPortalConfig('portal-sem-sigla', diretorioFixtures),
    ).rejects.toThrow(/inválida/);
  });
});
