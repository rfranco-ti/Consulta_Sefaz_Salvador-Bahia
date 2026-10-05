import { InternalError } from '../../shared/errors/index.js';

export type ExtratorTextoPdf = (caminho: string) => Promise<string>;

let extratorAtual: ExtratorTextoPdf | null = null;

export function registrarExtratorTextoPdf(extrator: ExtratorTextoPdf): void {
  extratorAtual = extrator;
}

export function removerExtratorTextoPdf(): void {
  extratorAtual = null;
}

export function obterExtratorTextoPdf(): ExtratorTextoPdf {
  const registrado = extratorAtual;
  if (registrado !== null) {
    return registrado;
  }
  return async () => {
    throw new InternalError('Extrator de texto do PDF não implementado: a extração por OCR será conectada na Fase 5');
  };
}
