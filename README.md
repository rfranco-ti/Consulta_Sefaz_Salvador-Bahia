# Consulta SEFAZ SSA/BA

API interna que consulta portais da SEFAZ Bahia e da Prefeitura de Salvador e devolve os dados em JSON — com opção de devolver também o PDF ou o print da página.

Feita para uma equipe pequena (até ~10 pessoas) em servidor simples, com consumo de recursos controlado.

## O problema

As consultas eram manuais, uma a uma. Depois passaram por uma suíte de automações em Python que rodava local, na máquina de cada usuário: mais rápida, mas o navegador headless tomava CPU e memória da estação e deixava o computador inoperante durante a execução.

Este projeto mantém o mesmo propósito com outro runtime: a automação roda no servidor (local ou em nuvem) e a estação do usuário só faz a chamada HTTP e recebe o resultado. O custo do navegador passa a ser do servidor, concentrado num pool reutilizado, com limite de concorrência e cache de resultados.

As decisões que vieram daí:

- eliminar a dependência de máquina local dedicada;
- concentrar o custo do navegador num pool com contexto isolado por execução;
- fila FIFO e limite de concorrência por portal, para não martelar os portais;
- cache com TTL por tipo de consulta, para não reexecutar o mesmo pedido;
- histórico, auditoria e controle de acesso centralizados (SQLite + API key por colaborador).

Escopo: apenas leitura desses portais. Não faz login em outros sistemas, não escreve em portais, não envia documentos.

## O que faz

| Automação (slug público) | Portal | Entrada |
|---|---|---|
| `sefaz-bahia-cadastro-cnpj` | SEFAZ Bahia | CNPJ |
| `sefaz-bahia-cadastro-inscricao-estadual` | SEFAZ Bahia | Inscrição Estadual (9 dígitos) |
| `sefaz-bahia-socio-por-cpf` | SEFAZ Bahia | CPF do sócio |
| `consulta-inscricoes-cnpj` | SEFAZ Bahia + Salvador | CNPJ (busca IE e IM) |
| `iptu-dados-cadastrais` | SEFAZ Salvador | Número do IPTU |
| `ficha-cadastral-resumida` | SEFAZ Salvador | CNPJ |
| `alvara-funcionamento` | SEFAZ Salvador | CNPJ + inscrição municipal (CGA) |
| `cadin-salvador-pendencias` | SEFAZ Salvador | CPF ou CNPJ |
| `dam-tff-tll` | SEFAZ Salvador | Inscrição municipal (CGA) + exercício |

O slug é a forma pública de chamar a automação. Existe um id interno (`ficha-cadastral`, `sefaz-bahia`, `iptu-salvador`, ...) que também é aceito nas rotas — mas use o slug: é o que está documentado no Swagger.

## Como funciona

1. **Requisição.** `GET /v1/<slug>` ou `POST /v1/automacoes/<slug>`. A API valida os parâmetros e autentica a chave.
2. **Cache primeiro.** Se existir entrada válida para o mesmo tipo e os mesmos parâmetros, ela volta na hora, com os documentos da execução original. Nenhum robô roda.
3. **Miss.** A API cria uma execução `PENDING` e a coloca na fila.
4. **Worker.** Um portal executa uma consulta por vez (FIFO); portais diferentes rodam em paralelo; o servidor nunca passa de `SEMAFORO_GLOBAL` execuções simultâneas.
5. **Robô.** Abre o navegador, resolve o captcha localmente (Tesseract, sem serviço externo) e lê o resultado.
6. **Persistência.** Dados e artefatos (PDF/print) vão para o banco e para o disco.
7. **Escrita no cache.** A entrada é gravada com o TTL do tipo. Falha não é gravada.
8. **Resposta.** Volta na própria chamada, se ela ainda estiver esperando, ou por `GET /v1/execucoes/:id`.

Concorrência, na prática:

- consultas idênticas em andamento compartilham uma única execução;
- uma chave de API tem 1 execução ativa por vez — a segunda concorrente leva `429`;
- uma execução que espera mais que `FILA_TIMEOUT_SEG` (padrão 90 s) na fila falha com timeout.

## Conceitos que o cliente precisa saber

### Cache

- Um hit devolve os mesmos dados **e** os mesmos documentos da execução original. O campo `cache` traz `{hit, camada, ttlRestanteSeg}`.
- TTL por tipo: **7 dias** para a maioria, **3 dias** para `cadin-salvador-pendencias`, **12 horas** para `dam-tff-tll`. Falha não é cacheada.
- Para mudar o TTL de um tipo, use o `.env`: `CACHE_<ID INTERNO>` no formato `30s|45m|12h|7d`. Ex.: `CACHE_SEFAZ_BAHIA=14d`, `CACHE_DAM_TFF_TLL=24h`. Atenção: o nome é o **id interno**, não o slug — `CACHE_CADIN_SALVADOR`, não `CACHE_CADIN_SALVADOR_PENDENCIAS`. Nome que não bate com um tipo é ignorado em silêncio. Padrões em `src/config/cache.ts`.
- `forceRefresh=true` pula a leitura do cache e executa de verdade. Se der certo, a entrada é substituída e o TTL recomeça. Se falhar, a entrada anterior fica intacta e os outros clientes continuam sendo atendidos por ela — durante uma queda do portal, o cache serve o dado bom em vez de somar carga num portal já fora do ar.
- Documentos carregam o mesmo instante de expiração da entrada de cache que os gerou: um PDF nunca expira antes do dado que o produziu. Um job periódico (a cada `HIGIENE_INTERVALO_MIN`, padrão 60 min) remove as entradas vencidas, os documentos vencidos e apaga os arquivos do disco.

### Artefatos

`artefatos` controla a **geração**: `nenhum` (padrão), `pdf`, `print` ou `ambos`.
`file` controla a **entrega**: ausente ou `false` (padrão), `true`, `pdf` ou `print`. Qualquer outro valor dá 400.

- Com `file`, a resposta é o arquivo bruto: `Content-Type` do documento e `Content-Disposition: attachment; filename="..."`. Como o envelope JSON não existe, os metadados vêm em headers: `X-Execucao-Id`, `X-Cache-Hit`, `X-Cache-Camada`, `X-Cache-TTL-Restante-Seg`.
- Cache primeiro: se a entrada em cache não tiver artefato do tipo pedido, isso conta como miss **só para este pedido** — a API reexecuta com os artefatos implícitos. Pedir arquivo nunca cria entrada de cache separada.
- `file` implica os artefatos necessários (`true` implica `ambos`; `pdf`/`print` implica o respectivo). Mas `artefatos=nenhum` explícito junto com `file` verdadeiro é um pedido contraditório e dá 400.
- Erros: `410 ARQUIVO_EXPIRADO` quando a referência existia mas a linha ou o arquivo sumiu (repita com `forceRefresh=true`); `404 NOT_FOUND` quando o artefato nunca foi gerado. Com `file` pedido e resultado SUCCESS, a rota nunca devolve JSON no lugar do arquivo. `PENDING`/`RUNNING` seguem devolvendo o JSON normal de acompanhamento.
- `inline=true` (legado) embute `pdfBase64`/`printBase64` no JSON e é best-effort — nunca falha a requisição. Em integração nova, prefira `file`.
- Uma resposta SUCCESS pode trazer `avisos: string[]`. Aparece num único caso: artefatos foram pedidos e nenhum pôde ser gerado — o robô registra a falha e segue sem artefato, em vez de derrubar a consulta. Nos demais casos o campo é omitido, então a ausência de `avisos` quer dizer "artefatos ok".

## Instalação

Requisitos: Node.js 20 ou superior, npm, Linux ou macOS.

```bash
npm install
npm run browser:install
cp .env.example .env
```

`browser:install` baixa apenas o `chromium-headless-shell` (~90 MB, sem Firefox, WebKit ou Chromium completo). No Linux, instale as bibliotecas de sistema uma única vez:

```bash
npx playwright-core install-deps chromium
```

Edite o `.env` com as duas chaves obrigatórias. `ADMIN_KEY` pode ser qualquer texto longo (mínimo 16 caracteres). `ENCRYPTION_KEY` precisa de 64 hex — gere com:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Script | O que faz |
|---|---|
| `npm run dev` | desenvolvimento com reload |
| `npm run build` | compila para `dist/` |
| `npm start` | produção (`node dist/index.js`) |
| `npm run typecheck` | verificação de tipos |
| `npm test` / `npm run test:watch` | testes (uma vez / em watch) |
| `npm run smoke` | `tsx scripts/smoke.ts` |
| `npm run sonda` | `tsx scripts/sonda-seletores.ts` |
| `npm run db:backup` | `tsx scripts/backup.ts` |

O servidor sobe em `http://localhost:3000` (`PORT` no `.env`).

## Configuração

| Variável | O que é | Padrão |
|---|---|---|
| `ADMIN_KEY` | gerencia API keys | obrigatória (mín. 16 caracteres) |
| `ENCRYPTION_KEY` | criptografia das sessões de navegador | obrigatória (64 hex) |
| `PORT` | porta HTTP | `3000` |
| `LOG_LEVEL` | nível de log | `info` |
| `SEMAFORO_GLOBAL` | execuções simultâneas no servidor | `5` |
| `SEMAFORO_POR_PORTAL` | por portal (1 = fila FIFO) | `1` |
| `FILA_TIMEOUT_SEG` | espera máxima na fila | `90` |
| `RATE_LIMIT_POR_MINUTO` | requisições por minuto por chave | `60` |
| `DATABASE_PATH` | banco SQLite | `./data/app.sqlite` |
| `STORAGE_DIR` | arquivos dos artefatos | `./storage` |
| `HIGIENE_INTERVALO_MIN` | intervalo da limpeza periódica | `60` |
| `CACHE_<ID INTERNO>` | TTL por tipo de consulta | ver seção Cache |

Lista completa em `.env.example`.

## Autenticação

As rotas `/v1/*` exigem chave, de duas formas:

- `X-API-Key: $CHAVE` (recomendado para servidores)
- `?apikey=$CHAVE` (prático no navegador)

As rotas `/v1/admin/*` usam **outro** header: `X-Admin-Key: $ADMIN_KEY`.

```bash
curl -X POST http://localhost:3000/v1/admin/apikeys \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -d '{"nome": "Maria"}'
```

A resposta 201 traz o `apiKey`, exibido só na criação. `GET /v1/admin/apikeys` lista as chaves (sem o token) e `DELETE /v1/admin/apikeys/:id` revoga.

`?apikey=` é prático, mas põe a chave na URL: ela fica no histórico do navegador e no log de qualquer proxy no caminho. A API esconde a chave nos próprios logs de requisição, mas não controla o que passa no meio — em integração, use o header.

`/health`, `/ready` e `/metrics` são públicas.

## Uso

### Consulta síncrona (GET)

Cache-first. Espera até 30 s por padrão (`?wait=N` muda esse valor) e devolve 200 com o resultado. Se não der tempo, responde 504 e a execução continua.

```bash
curl "http://localhost:3000/v1/ficha-cadastral-resumida?apikey=$CHAVE&cnpj=12345678000190"
```

Aceita `&artefatos=pdf|print|ambos`, `&forceRefresh=true`, `&file=pdf`, `&inline=true`.

### Execução assíncrona (POST, padrão)

```bash
curl -X POST http://localhost:3000/v1/automacoes/iptu-dados-cadastrais \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $CHAVE" \
  -d '{"numeroIptu": "12345678", "artefatos": "ambos"}'
```

Responde 202 na hora:

```json
{ "execucaoId": "exe_01H...", "status": "PENDING", "posicaoFila": 2, "cache": { "hit": false } }
```

Para esperar o resultado no POST: `?wait=N` (até 60 s) ou `"async": false` no corpo, que espera 60 s. Sem um dos dois, volta 202. `idempotencyKey` (8 a 128 caracteres) no corpo evita execução duplicada.

### Acompanhar

```bash
curl http://localhost:3000/v1/execucoes/exe_01H... -H "X-API-Key: $CHAVE"                      # status e resultado
curl http://localhost:3000/v1/execucoes/exe_01H.../documentos -H "X-API-Key: $CHAVE"          # documentos
curl -N http://localhost:3000/v1/execucoes/exe_01H.../progresso -H "X-API-Key: $CHAVE"        # progresso (SSE)
```

O SSE emite eventos `status` e `etapa` e fecha com `done` ou `erro`.

### Baixar o PDF

```bash
# dois passos: pega documentos[].url e baixa
curl -OJ http://localhost:3000/v1/documentos/doc_a1... -H "X-API-Key: $CHAVE"

# direto na consulta: a resposta já é o arquivo
curl -OJ "http://localhost:3000/v1/iptu-dados-cadastrais?numeroIptu=12345678&file=pdf" \
  -H "X-API-Key: $CHAVE"
```

`GET /v1/documentos/:id` é autenticado e checa a participação na execução.

### Respostas

Cache hit (GET, `ficha-cadastral-resumida`):

```json
{
  "execucaoId": "exe_9f3ac2...",
  "status": "SUCCESS",
  "sucesso": true,
  "dados": { "situacao": "REGULAR", "cnpj": "12345678000190" },
  "documentos": [
    {
      "id": "doc_a1...",
      "tipo": "pdf_oficial",
      "nome": "ficha-exe_71bd.pdf",
      "contentType": "application/pdf",
      "tamanhoBytes": 48210,
      "url": "/v1/documentos/doc_a1..."
    }
  ],
  "cache": { "hit": true, "camada": "sqlite", "ttlRestanteSeg": 604738 }
}
```

Erro:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "..." } }
```

| Status | Quando |
|---|---|
| 200 | sucesso |
| 202 | ainda na fila ou rodando |
| 400 | parâmetro inválido |
| 401 | chave ausente ou inválida |
| 403 | chave revogada |
| 404 | não encontrado |
| 429 | rate limit ou segunda execução ativa na mesma chave |
| 502 | falha do portal |
| 503 | fila cheia ou portal indisponível |
| 504 | estourou a espera |

### Endpoints

| Rota | O que faz |
|---|---|
| `GET /v1/:slug` | consulta síncrona, cache-first |
| `POST /v1/automacoes/:slug` | inicia uma execução (202 por padrão) |
| `GET /v1/execucoes/:id` | status e resultado; aceita `?file=` |
| `GET /v1/execucoes/:id/documentos` | documentos da execução |
| `GET /v1/execucoes/:id/progresso` | progresso ao vivo (SSE) |
| `DELETE /v1/execucoes/:id` | cancela a execução |
| `GET /v1/documentos/:id` | baixa um documento |
| `POST` / `GET` / `DELETE /v1/admin/apikeys` | cria / lista / revoga chaves (header `X-Admin-Key`) |
| `GET /docs` | Swagger UI, com "Try it out" |
| `GET /health` `/ready` `/metrics` | vive / pronto / métricas básicas (públicas) |

## Estrutura do projeto

```
src/
  app/          aplicação Fastify (server, plugins, rotas)
  config/       env, constantes, TTLs de cache
  modules/
    automation/ controller, service, repository, cache das consultas
    jobs/       fila, worker, estados das execuções
    browser/    pool de navegadores, contexto, factory
  automations/
    base/       base dos robôs, artefatos, captcha, ocr
    sites/      um diretório por portal
    registry.ts registro das automações
  database/     cliente SQLite, migrations, repositories
  shared/       logger, erros, utilitários, tipos
tests/          unit, integration, e2e
storage/        screenshots, traces, downloads, artefatos
data/           banco SQLite
```

## Notas de operação

- A automação usa `chromium-headless-shell`. O navegador é lançado uma vez e reutilizado; cada execução recebe um contexto isolado. O pool é reciclado periodicamente para manter o consumo de memória estável.
- Execuções do mesmo portal rodam uma por vez (fila FIFO); portais diferentes rodam em paralelo.
- Consultas idênticas em andamento são agrupadas (uma única execução serve vários pedidos).
- Captcha e OCR são resolvidos localmente (Tesseract), sem serviços externos de IA.
- Imagens e fontes dos portais são bloqueadas por padrão para reduzir consumo; quando a consulta pede PDF ou print, os recursos visuais são liberados.
- Faça backup de `data/app.sqlite`, `storage/` e `.env` juntos.
