import { InternalError } from '../../shared/errors/index.js';

export type ResolvedorCaptcha = (caminhoImagem: string) => Promise<string>;

const MENSAGEM_PADRAO = 'resolvedor de captcha não implementado';

function resolvedorPadrao(): ResolvedorCaptcha {
  return async () => {
    throw new InternalError(MENSAGEM_PADRAO);
  };
}

let resolvedorAtual: ResolvedorCaptcha = resolvedorPadrao();

export function registrarResolvedorCaptcha(resolvedor: ResolvedorCaptcha): void {
  resolvedorAtual = resolvedor;
}

export function limparResolvedorCaptcha(): void {
  resolvedorAtual = resolvedorPadrao();
}

export function resolverCaptcha(caminhoImagem: string): Promise<string> {
  return resolvedorAtual(caminhoImagem);
}
