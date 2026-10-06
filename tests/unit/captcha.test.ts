import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { preprocessarCaptchaImagem } from '../../src/automations/base/captcha/preprocessamento.js';
import {
  resolverCaptchaLocal,
  type ResultadoReconhecimento,
} from '../../src/automations/base/captcha/resolvedor.js';
import { InternalError } from '../../src/shared/errors/index.js';

const LARGURA_BASE = 120;
const ALTURA_BASE = 40;
const FATOR_ESCALA_ESPERADO = 2;
const ASSINATURA_PNG = [137, 80, 78, 71];

function gerarCaptchaSintetico(): Buffer {
  const tela = createCanvas(LARGURA_BASE, ALTURA_BASE);
  const contexto = tela.getContext('2d');
  contexto.fillStyle = '#ffffff';
  contexto.fillRect(0, 0, LARGURA_BASE, ALTURA_BASE);
  contexto.fillStyle = '#000000';
  contexto.font = 'bold 32px sans-serif';
  contexto.fillText('AB12', 18, 30);
  return tela.toBuffer('image/png');
}

const DIRETORIO_TEMPORARIO: string = path.join(tmpdir(), 'api-sefaz-ssa-testes-captcha');
let caminhoCaptchaValido = '';

beforeAll(async (): Promise<void> => {
  await mkdir(DIRETORIO_TEMPORARIO, { recursive: true });
  caminhoCaptchaValido = path.join(DIRETORIO_TEMPORARIO, 'captcha-valido.png');
  await writeFile(caminhoCaptchaValido, gerarCaptchaSintetico());
});

afterAll(async (): Promise<void> => {
  await unlink(caminhoCaptchaValido).catch(() => undefined);
});

describe('preprocessamento de captcha', () => {
  it('gera PNG com o dobro das dimensões e pixels binarizados', async (): Promise<void> => {
    const entrada: Buffer = gerarCaptchaSintetico();
    const saida: Buffer = await preprocessarCaptchaImagem(entrada);
    expect(saida.subarray(0, 4)).toEqual(Buffer.from(ASSINATURA_PNG));
    const lida = await loadImage(saida);
    expect(lida.width).toBe(LARGURA_BASE * FATOR_ESCALA_ESPERADO);
    expect(lida.height).toBe(ALTURA_BASE * FATOR_ESCALA_ESPERADO);
    const tela = createCanvas(lida.width, lida.height);
    const contexto = tela.getContext('2d');
    contexto.drawImage(lida, 0, 0);
    const dados = contexto.getImageData(0, 0, lida.width, lida.height);
    const pixels: Uint8ClampedArray = dados.data;
    expect(pixels.length).toBeGreaterThan(0);
    let invalidos = 0;
    for (let indice = 0; indice < pixels.length; indice += 4) {
      const vermelho: number = pixels[indice] ?? -1;
      const verde: number = pixels[indice + 1] ?? -2;
      const azul: number = pixels[indice + 2] ?? -3;
      const alfa: number = pixels[indice + 3] ?? -4;
      const binario: boolean = vermelho === 0 || vermelho === 255;
      if (!binario || verde !== vermelho || azul !== vermelho || alfa !== 255) {
        invalidos += 1;
      }
    }
    expect(invalidos).toBe(0);
  });
});

describe('resolvedor local de captcha', () => {
  it('retorna o texto limpo em maiúsculas quando a confiança é alta', async (): Promise<void> => {
    const recebidos: Buffer[] = [];
    const texto: string = await resolverCaptchaLocal(caminhoCaptchaValido, {
      reconhecer: async (buffer: Buffer): Promise<ResultadoReconhecimento> => {
        recebidos.push(buffer);
        return { texto: 'ab12!', confianca: 90 };
      },
    });
    expect(texto).toBe('AB12');
    expect(recebidos).toHaveLength(1);
    const primeira: Buffer | undefined = recebidos[0];
    expect(primeira).toBeDefined();
    if (primeira !== undefined) {
      const processada = await loadImage(primeira);
      expect(processada.width).toBe(LARGURA_BASE * FATOR_ESCALA_ESPERADO);
      expect(processada.height).toBe(ALTURA_BASE * FATOR_ESCALA_ESPERADO);
    }
  });

  it('aceita confiança na escala de zero a um', async (): Promise<void> => {
    const texto: string = await resolverCaptchaLocal(caminhoCaptchaValido, {
      reconhecer: async (): Promise<ResultadoReconhecimento> => {
        return { texto: 'xy34', confianca: 0.9 };
      },
    });
    expect(texto).toBe('XY34');
  });

  it('retorna vazio quando a confiança está abaixo do limiar', async (): Promise<void> => {
    const texto: string = await resolverCaptchaLocal(caminhoCaptchaValido, {
      reconhecer: async (): Promise<ResultadoReconhecimento> => {
        return { texto: 'ab12', confianca: 50 };
      },
    });
    expect(texto).toBe('');
  });

  it('retorna vazio quando o texto passa de oito caracteres', async (): Promise<void> => {
    const texto: string = await resolverCaptchaLocal(caminhoCaptchaValido, {
      reconhecer: async (): Promise<ResultadoReconhecimento> => {
        return { texto: 'abc123xyz', confianca: 95 };
      },
    });
    expect(texto).toBe('');
  });

  it('retorna vazio quando o texto tem menos de três caracteres', async (): Promise<void> => {
    const texto: string = await resolverCaptchaLocal(caminhoCaptchaValido, {
      reconhecer: async (): Promise<ResultadoReconhecimento> => {
        return { texto: 'a1', confianca: 99 };
      },
    });
    expect(texto).toBe('');
  });

  it('retorna vazio quando o reconhecimento falha', async (): Promise<void> => {
    const texto: string = await resolverCaptchaLocal(caminhoCaptchaValido, {
      reconhecer: async (): Promise<ResultadoReconhecimento> => {
        throw new Error('falha instável do motor');
      },
    });
    expect(texto).toBe('');
  });

  it('lança InternalError em português quando o arquivo não existe', async (): Promise<void> => {
    const caminhoInexistente: string = path.join(DIRETORIO_TEMPORARIO, 'nao-existe-xyz.png');
    await expect(resolverCaptchaLocal(caminhoInexistente)).rejects.toBeInstanceOf(InternalError);
    await expect(resolverCaptchaLocal(caminhoInexistente)).rejects.toThrow(
      'Não foi possível ler a imagem do captcha',
    );
  });
});
