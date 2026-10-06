import { readFile } from 'node:fs/promises';
import Tesseract = require('tesseract.js');
import { InternalError } from '../../../shared/errors/index.js';
import { preprocessarCaptchaImagem } from './preprocessamento.js';

export interface ResultadoReconhecimento {
  texto: string;
  confianca: number;
}

export interface DepsResolvedorCaptcha {
  reconhecer?: (buffer: Buffer) => Promise<ResultadoReconhecimento>;
}

const IDIOMA_OCR = 'por';
const DIRETORIO_CACHE_MODELO = './data';
const LISTA_BRANCA_CARACTERES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const LIMIAR_CONFIANCA = 0.75;
const TAMANHO_MINIMO_TEXTO = 3;
const TAMANHO_MAXIMO_TEXTO = 8;
const PADRAO_LIMPEZA_TEXTO = /[^A-Z0-9]/g;

let workerCaptcha: Tesseract.Worker | null = null;
let promessaWorkerCaptcha: Promise<Tesseract.Worker> | null = null;
let filaReconhecimento: Promise<void> = Promise.resolve();

async function criarWorkerCaptcha(): Promise<Tesseract.Worker> {
  const worker: Tesseract.Worker = await Tesseract.createWorker(IDIOMA_OCR, undefined, {
    cachePath: DIRETORIO_CACHE_MODELO,
  });
  await worker.setParameters({
    tessedit_char_whitelist: LISTA_BRANCA_CARACTERES,
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
  });
  return worker;
}

async function obterWorkerCaptcha(): Promise<Tesseract.Worker> {
  if (workerCaptcha !== null) {
    return workerCaptcha;
  }
  if (promessaWorkerCaptcha === null) {
    promessaWorkerCaptcha = criarWorkerCaptcha();
  }
  try {
    const pronto: Tesseract.Worker = await promessaWorkerCaptcha;
    workerCaptcha = pronto;
    return pronto;
  } catch (erro: unknown) {
    promessaWorkerCaptcha = null;
    throw erro;
  }
}

async function executarComFila<Tipo>(operacao: () => Promise<Tipo>): Promise<Tipo> {
  const anterior: Promise<void> = filaReconhecimento;
  let liberarFila: () => void = () => undefined;
  filaReconhecimento = new Promise<void>((resolver) => {
    liberarFila = resolver;
  });
  await anterior;
  try {
    return await operacao();
  } finally {
    liberarFila();
  }
}

async function reconhecerViaTesseract(buffer: Buffer): Promise<ResultadoReconhecimento> {
  const worker: Tesseract.Worker = await obterWorkerCaptcha();
  const saida: Tesseract.RecognizeResult = await worker.recognize(buffer);
  const textoBruto: unknown = saida.data.text;
  const confiancaBruta: unknown = saida.data.confidence;
  const texto: string = typeof textoBruto === 'string' ? textoBruto : '';
  const confiancaCentena: number =
    typeof confiancaBruta === 'number' && Number.isFinite(confiancaBruta)
      ? confiancaBruta
      : 0;
  return { texto, confianca: confiancaCentena };
}

export async function resolverCaptchaLocal(
  caminhoImagem: string,
  deps?: DepsResolvedorCaptcha,
): Promise<string> {
  let original: Buffer;
  try {
    original = await readFile(caminhoImagem);
  } catch {
    throw new InternalError(
      `Não foi possível ler a imagem do captcha em "${caminhoImagem}".`,
    );
  }
  let processado: Buffer;
  try {
    processado = await preprocessarCaptchaImagem(original);
  } catch {
    return '';
  }
  const reconhecer: (buffer: Buffer) => Promise<ResultadoReconhecimento> =
    deps?.reconhecer ?? reconhecerViaTesseract;
  let resultado: ResultadoReconhecimento;
  try {
    resultado = await executarComFila(() => reconhecer(processado));
  } catch {
    return '';
  }
  const confiancaCentena: number = resultado.confianca;
  const confiancaNormalizadaZeroUm: number =
    confiancaCentena > 1 ? confiancaCentena / 100 : confiancaCentena;
  const textoLimpo: string = resultado.texto.toUpperCase().replace(PADRAO_LIMPEZA_TEXTO, '');
  if (confiancaNormalizadaZeroUm < LIMIAR_CONFIANCA) {
    return '';
  }
  if (textoLimpo.length < TAMANHO_MINIMO_TEXTO || textoLimpo.length > TAMANHO_MAXIMO_TEXTO) {
    return '';
  }
  return textoLimpo;
}
