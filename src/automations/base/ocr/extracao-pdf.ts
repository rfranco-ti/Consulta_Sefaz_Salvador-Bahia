import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { InternalError } from '../../../shared/errors/index.js';
import { reconhecerTextoTesseract } from './tesseract.js';

export type CadeiaOcrDeps = {
  extrairNativo?: (caminho: string) => Promise<string>;
  renderizar?: (caminho: string) => Promise<Buffer[]>;
  reconhecer?: (buffer: Buffer) => Promise<string>;
};

type ParametrosDocumento = NonNullable<Parameters<typeof getDocument>[0]> & {
  isEvalSupported: boolean;
};

const ESCALA_RENDERIZACAO = 2;

const require = createRequire(import.meta.url);
const diretorioPdfjs = path.dirname(require.resolve('pdfjs-dist/package.json'));
const fontesPadraoUrl = pathToFileURL(
  diretorioPdfjs + path.sep + 'standard_fonts' + path.sep,
).href;

export function textoSuficiente(texto: string): boolean {
  return texto.replace(/\s+/g, '').length >= 100;
}

export async function extrairTextoNativoPdf(caminho: string): Promise<string> {
  try {
    const arquivo = await readFile(caminho);
    const dados = new Uint8Array(arquivo);
    const parametros: ParametrosDocumento = {
      data: dados,
      useWorkerFetch: false,
      isEvalSupported: false,
      verbosity: 0,
    };
    const documento = await getDocument(parametros).promise;
    try {
      const paginas: string[] = [];
      for (let numero = 1; numero <= documento.numPages; numero += 1) {
        const pagina = await documento.getPage(numero);
        const conteudo = await pagina.getTextContent();
        const fragmentos: string[] = [];
        for (const item of conteudo.items) {
          if ('str' in item && typeof item.str === 'string') {
            fragmentos.push(item.str);
          }
        }
        paginas.push(fragmentos.join(' '));
      }
      return paginas.join('\n');
    } finally {
      await documento.cleanup();
    }
  } catch (erro) {
    if (erro instanceof InternalError) {
      throw erro;
    }
    throw new InternalError(`Não foi possível ler o PDF em ${caminho}`, { cause: erro });
  }
}

export async function renderizarPaginasPdf(caminho: string): Promise<Buffer[]> {
  try {
    const arquivo = await readFile(caminho);
    const dados = new Uint8Array(arquivo);
    const parametros: ParametrosDocumento = {
      data: dados,
      standardFontDataUrl: fontesPadraoUrl,
      useWorkerFetch: false,
      isEvalSupported: false,
      verbosity: 0,
    };
    const documento = await getDocument(parametros).promise;
    try {
      const imagens: Buffer[] = [];
      for (let numero = 1; numero <= documento.numPages; numero += 1) {
        const pagina = await documento.getPage(numero);
        const viewport = pagina.getViewport({ scale: ESCALA_RENDERIZACAO });
        const tela = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const contexto = tela.getContext('2d');
        await pagina.render({ canvas: null, canvasContext: contexto, viewport }).promise;
        imagens.push(tela.toBuffer('image/png'));
      }
      return imagens;
    } finally {
      await documento.cleanup();
    }
  } catch (erro) {
    if (erro instanceof InternalError) {
      throw erro;
    }
    throw new InternalError(`Não foi possível renderizar o PDF em ${caminho}`, { cause: erro });
  }
}

export async function cadeiaExtracaoTextoPdf(
  caminho: string,
  deps?: CadeiaOcrDeps,
): Promise<string> {
  const extrairNativo = deps?.extrairNativo ?? extrairTextoNativoPdf;
  const renderizar = deps?.renderizar ?? renderizarPaginasPdf;
  const reconhecer = deps?.reconhecer ?? reconhecerTextoTesseract;
  const nativo = await extrairNativo(caminho);
  if (textoSuficiente(nativo)) {
    return nativo;
  }
  const paginas = await renderizar(caminho);
  const reconhecidos: string[] = [];
  for (const pagina of paginas) {
    reconhecidos.push(await reconhecer(pagina));
  }
  const ocr = reconhecidos.join('\n');
  if (textoSuficiente(ocr)) {
    return ocr;
  }
  return nativo;
}
