import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { preprocessarCaptchaImagem } from '../../src/automations/base/captcha/preprocessamento.js';
import {
  combinarLeituras,
  encerrarWorkerCaptcha,
  mediaConfiancaSimbolos,
  resolverCaptchaLocal,
  type BlocoReconhecido,
  type LeituraOcr,
  type ResultadoReconhecimento,
} from '../../src/automations/base/captcha/resolvedor.js';
import { InternalError } from '../../src/shared/errors/index.js';

const LARGURA_BASE = 120;
const ALTURA_BASE = 40;
const FATOR_ESCALA_ESPERADO = 4;
const BORDA_ESPERADA_PX = 10;
const LARGURA_PROCESSADA_ESPERADA = LARGURA_BASE * FATOR_ESCALA_ESPERADO + BORDA_ESPERADA_PX * 2;
const ALTURA_PROCESSADA_ESPERADA = ALTURA_BASE * FATOR_ESCALA_ESPERADO + BORDA_ESPERADA_PX * 2;
const ASSINATURA_PNG = [137, 80, 78, 71];
const CAMINHO_FIXTURE_CAPTCHA_REAL = path.join(process.cwd(), 'tests', 'fixtures', 'captcha-real.png');
const CAMINHO_MODELO_TESSERACT = path.join(process.cwd(), 'data', 'por.traineddata');
const MODELO_TESSERACT_DISPONIVEL = existsSync(CAMINHO_FIXTURE_CAPTCHA_REAL) && existsSync(CAMINHO_MODELO_TESSERACT);
const FIXTURE_CAPTCHA_REAL_DISPONIVEL = existsSync(CAMINHO_FIXTURE_CAPTCHA_REAL);
const TEMPO_LIMITE_OCR_REAL_MS = 120000;
const TEXTO_CAPTCHA_REAL_ESPERADO = 'GPCL3';

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
  it('gera PNG em escala de cinza com quádruplo das dimensões mais borda', async (): Promise<void> => {
    const entrada: Buffer = gerarCaptchaSintetico();
    const saida: Buffer = await preprocessarCaptchaImagem(entrada);
    expect(saida.subarray(0, 4)).toEqual(Buffer.from(ASSINATURA_PNG));
    const lida = await loadImage(saida);
    expect(lida.width).toBe(LARGURA_PROCESSADA_ESPERADA);
    expect(lida.height).toBe(ALTURA_PROCESSADA_ESPERADA);
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
      if (verde !== vermelho || azul !== vermelho || alfa !== 255) {
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
      expect(processada.width).toBe(LARGURA_PROCESSADA_ESPERADA);
      expect(processada.height).toBe(ALTURA_PROCESSADA_ESPERADA);
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
        return { texto: 'ab12', confianca: 20 };
      },
    });
    expect(texto).toBe('');
  });

  it('rejeita confiança de um por cento sem normalizar para cem', async (): Promise<void> => {
    const texto: string = await resolverCaptchaLocal(caminhoCaptchaValido, {
      reconhecer: async (): Promise<ResultadoReconhecimento> => {
        return { texto: 'ab12', confianca: 1 };
      },
    });
    expect(texto).toBe('');
  });

  it.runIf(FIXTURE_CAPTCHA_REAL_DISPONIVEL)(
    'aceita leitura típica do motor no captcha real com mock',
    async (): Promise<void> => {
      const texto: string = await resolverCaptchaLocal(CAMINHO_FIXTURE_CAPTCHA_REAL, {
        reconhecer: async (): Promise<ResultadoReconhecimento> => {
          return { texto: 'GPCL3', confianca: 93.2 };
        },
      });
      expect(texto).toBe(TEXTO_CAPTCHA_REAL_ESPERADO);
    },
  );

  it('aceita a leitura ao vivo com a média de símbolos mesmo quando o gate antigo barraria', async (): Promise<void> => {
    const texto: string = await resolverCaptchaLocal(caminhoCaptchaValido, {
      reconhecer: async (): Promise<ResultadoReconhecimento> => {
        return { texto: 'QVV4A', confianca: 96.8 };
      },
    });
    expect(texto).toBe('QVV4A');
  });

  it('rejeita confiança de setenta e três na escala de centena', async (): Promise<void> => {
    const texto: string = await resolverCaptchaLocal(caminhoCaptchaValido, {
      reconhecer: async (): Promise<ResultadoReconhecimento> => {
        return { texto: 'QVV4A', confianca: 73 };
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

describe('combinação de leituras do ensemble', () => {
  function leitura(texto: string, confiancas: number[]): LeituraOcr {
    return {
      texto,
      simbolos: confiancas.map((confianca, indice) => ({
        texto: texto[indice] ?? '',
        confianca,
      })),
    };
  }

  it('mantém o texto quando as leituras concordam com a média das confianças', () => {
    const saida = combinarLeituras(leitura('GPCL3', [95, 95, 95, 95, 95]), leitura('GPCL3', [90, 90, 90, 90, 90]));
    expect(saida.texto).toBe('GPCL3');
    expect(saida.confianca).toBeCloseTo(95, 5);
  });

  it('prefere a leitura com cinco caracteres quando os comprimentos divergem', () => {
    const saida = combinarLeituras(leitura('ZLA7Z7', [90, 90, 90, 90, 90, 90]), leitura('ZLA77', [80, 80, 80, 80, 80]));
    expect(saida.texto).toBe('ZLA77');
    expect(saida.confianca).toBeCloseTo(80, 5);
  });

  it('vota por símbolo pela maior confiança quando ambas têm cinco caracteres', () => {
    const saida = combinarLeituras(
      leitura('H2GHH', [96, 97, 90, 96, 98]),
      leitura('H26HH', [96, 97, 97, 96, 98]),
    );
    expect(saida.texto).toBe('H26HH');
    expect(saida.confianca).toBeCloseTo(96.8, 5);
  });

  it('volta para a primeira leitura quando os símbolos não fecham cinco', () => {
    const saida = combinarLeituras(leitura('AB12', [90, 90, 90, 90]), leitura('AB13', [99, 99, 99, 99]));
    expect(saida.texto).toBe('AB12');
  });

  it('retorna confiança zero sem símbolos', () => {
    const saida = combinarLeituras({ texto: '', simbolos: [] }, { texto: '', simbolos: [] });
    expect(saida.texto).toBe('');
    expect(saida.confianca).toBe(0);
  });
});

describe('encerramento do worker de captcha', () => {
  it('resolve sem worker iniciado', async (): Promise<void> => {
    await expect(encerrarWorkerCaptcha()).resolves.toBeUndefined();
  });

  it('é idempotente em chamadas seguidas', async (): Promise<void> => {
    await encerrarWorkerCaptcha();
    await expect(encerrarWorkerCaptcha()).resolves.toBeUndefined();
  });

  it('permite resolver com mock após o encerramento', async (): Promise<void> => {
    await encerrarWorkerCaptcha();
    const texto: string = await resolverCaptchaLocal(caminhoCaptchaValido, {
      reconhecer: async (): Promise<ResultadoReconhecimento> => {
        return { texto: 'AB12', confianca: 90 };
      },
    });
    expect(texto).toBe('AB12');
  });
});

describe('média de confiança por símbolo', () => {
  function montarBloco(confiancas: number[]): BlocoReconhecido {
    return {
      paragraphs: [
        {
          lines: [
            {
              words: [
                {
                  symbols: confiancas.map((confianca) => ({ confidence: confianca })),
                },
              ],
            },
          ],
        },
      ],
    };
  }

  it('retorna zero sem blocos', () => {
    expect(mediaConfiancaSimbolos(null)).toBe(0);
    expect(mediaConfiancaSimbolos(undefined)).toBe(0);
    expect(mediaConfiancaSimbolos([])).toBe(0);
  });

  it('retorna zero quando não há símbolos', () => {
    expect(mediaConfiancaSimbolos([montarBloco([])])).toBe(0);
  });

  it('calcula a média das confianças dos símbolos', () => {
    expect(mediaConfiancaSimbolos([montarBloco([98, 85, 87, 98, 98])])).toBeCloseTo(93.2, 5);
  });

  it('ignora confianças inválidas', () => {
    expect(mediaConfiancaSimbolos([montarBloco([80, Number.NaN])])).toBe(80);
  });
});

describe('resolvedor local de captcha com imagem real', () => {
  it.runIf(MODELO_TESSERACT_DISPONIVEL)(
    'resolve o captcha real do portal com o texto esperado',
    { timeout: TEMPO_LIMITE_OCR_REAL_MS },
    async (): Promise<void> => {
      const texto: string = await resolverCaptchaLocal(CAMINHO_FIXTURE_CAPTCHA_REAL);
      expect(texto).toBe(TEXTO_CAPTCHA_REAL_ESPERADO);
    },
  );

  it.runIf(MODELO_TESSERACT_DISPONIVEL)(
    'usa o fallback de segmentação em vez de vazio quando o ensemble não passa no gate',
    { timeout: TEMPO_LIMITE_OCR_REAL_MS },
    async (): Promise<void> => {
      const caminhoDificil: string = path.join(
        process.cwd(),
        'tests',
        'fixtures',
        'captcha-segmentacao-dificil.png',
      );
      const texto: string = await resolverCaptchaLocal(caminhoDificil);
      expect(texto).not.toBe('');
      expect(texto.length).toBeGreaterThanOrEqual(3);
      expect(texto.length).toBeLessThanOrEqual(8);
    },
  );
});
