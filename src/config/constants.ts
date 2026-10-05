/** Constantes operacionais (fora de env; mudanca = revisao). */

/** Teto do corpo HTTP em bytes (API.md). */
export const BODY_LIMIT_BYTES = 32 * 1024;

/** Teto de `?wait=` em segundos. */
export const WAIT_MAX_SEG = 60;

/** Rate limit padrao por API key. */
export const RATE_LIMIT_POR_KEY = 60;

/** Teto de execucoes ativas por API key (anti-flood). */
export const EXECUCOES_ATIVAS_POR_KEY = 1;

/** Tentativas extras apenas para erros recuperaveis (JOBS.md). */
export const MAX_TENTATIVAS = 2;
