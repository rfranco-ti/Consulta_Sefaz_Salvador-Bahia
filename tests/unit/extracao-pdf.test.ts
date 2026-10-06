import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InternalError } from '../../src/shared/errors/index.js';
import {
  cadeiaExtracaoTextoPdf,
  extrairTextoNativoPdf,
  renderizarPaginasPdf,
  textoSuficiente,
} from '../../src/automations/base/ocr/extracao-pdf.js';
import type { CadeiaOcrDeps } from '../../src/automations/base/ocr/extracao-pdf.js';

function escaparTextoPdf(texto: string): string {
  return texto.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function quebrarLinhas(texto: string, largura: number): string[] {
  const palavras = texto.split(' ');
  const linhas: string[] = [];
  let atual = '';
  for (const palavra of palavras) {
    const candidata = atual === '' ? palavra : `${atual} ${palavra}`;
    if (candidata.length > largura && atual !== '') {
      linhas.push(atual);
      atual = palavra;
    } else {
      atual = candidata;
    }
  }
  if (atual !== '') {
    linhas.push(atual);
  }
  return linhas;
}

function montarPdfComTexto(texto: string): Buffer {
  const linhas = quebrarLinhas(texto, 60);
  const comandos = linhas.map((linha) => `(${escaparTextoPdf(linha)}) Tj T*`).join('\n');
  const conteudo = `BT /F1 12 Tf 14 TL 72 720 Td\n${comandos}\nET\n`;
  const tamanho = Buffer.byteLength(conteudo, 'latin1');
  const objetos: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${tamanho} >>\nstream\n${conteudo}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const deslocamentos: number[] = [];
  let numero = 1;
  for (const corpo of objetos) {
    deslocamentos.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${numero} 0 obj\n${corpo}\nendobj\n`;
    numero += 1;
  }
  const inicioXref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objetos.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const deslocamento of deslocamentos) {
    pdf += `${deslocamento.toString().padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${inicioXref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

async function gravarPdfTemporario(bytes: Buffer): Promise<{ diretorio: string; caminho: string }> {
  const diretorio = await mkdtemp(path.join(tmpdir(), 'extracao-pdf-'));
  const caminho = path.join(diretorio, 'documento.pdf');
  await writeFile(caminho, bytes);
  return { diretorio, caminho };
}

describe('textoSuficiente', () => {
  it('rejeita 99 caracteres nao-espaco', () => {
    expect(textoSuficiente('a'.repeat(99))).toBe(false);
  });

  it('aceita 100 caracteres nao-espaco', () => {
    expect(textoSuficiente('a'.repeat(100))).toBe(true);
  });

  it('desconsidera espacos em branco na contagem', () => {
    expect(textoSuficiente(`${'a'.repeat(99)}   \n\t  `)).toBe(false);
    expect(textoSuficiente(`  ${'b'.repeat(100)} \n `)).toBe(true);
    expect(textoSuficiente('   \n\t  ')).toBe(false);
  });
});

describe('cadeiaExtracaoTextoPdf com dependencias falsas', () => {
  it('retorna o texto nativo suficiente sem acionar renderizacao nem OCR', async () => {
    const nativo = 'x'.repeat(120);
    let renderizacoes = 0;
    let reconhecimentos = 0;
    const deps: CadeiaOcrDeps = {
      extrairNativo: async (_caminho: string): Promise<string> => nativo,
      renderizar: async (_caminho: string): Promise<Buffer[]> => {
        renderizacoes += 1;
        return [Buffer.from('pagina')];
      },
      reconhecer: async (_buffer: Buffer): Promise<string> => {
        reconhecimentos += 1;
        return 'ocr';
      },
    };
    const resultado = await cadeiaExtracaoTextoPdf('/fake/documento.pdf', deps);
    expect(resultado).toBe(nativo);
    expect(renderizacoes).toBe(0);
    expect(reconhecimentos).toBe(0);
  });

  it('usa renderizacao e OCR quando o texto nativo e insuficiente', async () => {
    const ocrPaginaUm = `resultado ocr ${'r'.repeat(120)}`;
    const ocrPaginaDois = `segunda pagina ${'s'.repeat(120)}`;
    const chamadasReconhecer: number[] = [];
    const deps: CadeiaOcrDeps = {
      extrairNativo: async (_caminho: string): Promise<string> => 'curto',
      renderizar: async (_caminho: string): Promise<Buffer[]> => {
        return [Buffer.from([1]), Buffer.from([2])];
      },
      reconhecer: async (buffer: Buffer): Promise<string> => {
        chamadasReconhecer.push(buffer[0] as number);
        return buffer[0] === 1 ? ocrPaginaUm : ocrPaginaDois;
      },
    };
    const resultado = await cadeiaExtracaoTextoPdf('/fake/escaneado.pdf', deps);
    expect(resultado).toBe(`${ocrPaginaUm}\n${ocrPaginaDois}`);
    expect(chamadasReconhecer).toEqual([1, 2]);
  });

  it('retorna o nativo como melhor esforco quando o OCR nao produz texto', async () => {
    const nativo = 'texto curto do nativo';
    const deps: CadeiaOcrDeps = {
      extrairNativo: async (_caminho: string): Promise<string> => nativo,
      renderizar: async (_caminho: string): Promise<Buffer[]> => [Buffer.from('pagina')],
      reconhecer: async (_buffer: Buffer): Promise<string> => '',
    };
    const resultado = await cadeiaExtracaoTextoPdf('/fake/vazio.pdf', deps);
    expect(resultado).toBe(nativo);
  });

  it('propaga o InternalError do extrator nativo sem acionar as demais etapas', async () => {
    let renderizacoes = 0;
    let reconhecimentos = 0;
    const deps: CadeiaOcrDeps = {
      extrairNativo: async (_caminho: string): Promise<string> => {
        throw new InternalError('Não foi possível ler o PDF em /fake/quebrado.pdf');
      },
      renderizar: async (_caminho: string): Promise<Buffer[]> => {
        renderizacoes += 1;
        return [];
      },
      reconhecer: async (_buffer: Buffer): Promise<string> => {
        reconhecimentos += 1;
        return '';
      },
    };
    await expect(cadeiaExtracaoTextoPdf('/fake/quebrado.pdf', deps)).rejects.toThrow(
      InternalError,
    );
    expect(renderizacoes).toBe(0);
    expect(reconhecimentos).toBe(0);
  });
});

describe('extrairTextoNativoPdf com arquivos reais', () => {
  it('lança InternalError em pt-BR para caminho inexistente', async () => {
    await expect(extrairTextoNativoPdf('/nao/existe/documento.pdf')).rejects.toThrow(
      /Não foi possível ler o PDF em/,
    );
  });

  it('lança InternalError em pt-BR para conteudo invalido', async () => {
    const { diretorio, caminho } = await gravarPdfTemporario(Buffer.from('nao e um pdf'));
    try {
      await expect(extrairTextoNativoPdf(caminho)).rejects.toThrow(
        /Não foi possível ler o PDF em/,
      );
    } finally {
      await rm(diretorio, { recursive: true, force: true });
    }
  });

  it('extrai o texto de um PDF real e o gate nativo evita o OCR', async () => {
    const frase = 'Certidao negativa de debitos municipais emitida pela Secretaria da Fazenda ';
    const textoLongo = `${frase.repeat(3).trim()} numero 987654`;
    expect(textoSuficiente(textoLongo)).toBe(true);
    const { diretorio, caminho } = await gravarPdfTemporario(montarPdfComTexto(textoLongo));
    try {
      let reconhecimentos = 0;
      const resultado = await cadeiaExtracaoTextoPdf(caminho, {
        reconhecer: async (_buffer: Buffer): Promise<string> => {
          reconhecimentos += 1;
          throw new Error('OCR nao deveria ser acionado');
        },
      });
      expect(resultado.replace(/\s+/g, ' ')).toContain('Certidao negativa de debitos');
      expect(textoSuficiente(resultado)).toBe(true);
      expect(reconhecimentos).toBe(0);
    } finally {
      await rm(diretorio, { recursive: true, force: true });
    }
  });

  it('renderiza a pagina do PDF real em PNG valido', async () => {
    const frase = 'Comprovante de inscricao municipal valido para apresentacao ';
    const { diretorio, caminho } = await gravarPdfTemporario(
      montarPdfComTexto(frase.repeat(3).trim()),
    );
    try {
      const imagens = await renderizarPaginasPdf(caminho);
      expect(imagens).toHaveLength(1);
      const primeira = imagens[0] as Buffer;
      expect(Buffer.isBuffer(primeira)).toBe(true);
      expect(primeira[0]).toBe(0x89);
      expect(primeira.subarray(1, 4).toString('latin1')).toBe('PNG');
    } finally {
      await rm(diretorio, { recursive: true, force: true });
    }
  });
});
