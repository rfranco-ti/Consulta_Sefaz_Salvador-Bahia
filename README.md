# api-sefaz-ssa

API HTTP para consultas automatizadas em portais da SEFAZ Bahia e da Prefeitura de Salvador. A automacao roda em um navegador headless controlado por Playwright, no servidor, e devolve os dados estruturados em JSON — com opcao de retornar tambem o PDF ou o print da pagina.

Projetada para uso interno de uma equipe pequena (ate 10 usuarios simultaneos), em servidor simples, com consumo controlado de recursos.

## Origem

As consultas aos portais da SEFAZ Bahia e da Prefeitura de Salvador eram feitas manualmente, uma a uma. Para acelerar, foi criada uma suite de automacoes em Python que rodava localmente na maquina de cada usuario: o processo ficou mais rapido, mas o navegador headless consumia CPU e memoria da propria estacao de trabalho, deixando o computador inoperante durante a execucao.

Este projeto e a reescrita desse modelo como API. A automacao roda em um servidor (local ou em nuvem); as maquinas dos usuarios apenas enviam a requisicao HTTP e recebem o resultado. O custo do navegador passa a ser do servidor, concentrado em um pool de browser reutilizado, com limite de concorrencia e cache de resultados.

Mantivemos o mesmo proposito tecnico da suite Python, com o runtime corrigido:

- eliminar a dependencia de maquina local dedicada (a consulta roda no servidor);
- concentrar o custo de navegador num pool com contexto isolado por execucao;
- fila FIFO persistida e limite de concorrencia por portal, para nao martelar os portais;
- cache de resultados com TTL por tipo de consulta (evita reexecucao desnecessaria);
- historico, auditoria e controle de acesso centralizados (SQLite + API key por colaborador).

## Escopo

Somente consultas aos portais da SEFAZ Bahia e da Prefeitura de Salvador:

| Automaacao | Portal | Entrada principal |
|---|---|---|
| `sefaz-bahia` | SEFAZ Bahia | CNPJ |
| `sefaz-bahia-inscricao` | SEFAZ Bahia | Inscricao Estadual |
| `sefaz-bahia-socio` | SEFAZ Bahia | CPF do socio |
| `consulta-inscricoes` | SEFAZ Bahia + Prefeitura | CNPJ (IE + IM) |
| `iptu-salvador` | Prefeitura de Salvador | Numero do IPTU |
| `ficha-cadastral` | Prefeitura de Salvador | CNPJ |
| `alvara-funcionamento` | Prefeitura de Salvador | CNPJ / inscricao municipal |
| `cadin-salvador` | Prefeitura de Salvador | CPF ou CNPJ |
| `dam-tff-tll` | Prefeitura de Salvador | Inscricao municipal + exercicio |
| `dam-tll` | Prefeitura de Salvador | CGA + exercicio |

Nao faz: login em outros sistemas, escrita em portais, envio de documentos, ou qualquer operacao que altere dados.

## Como funciona

1. O cliente envia uma requisicao POST com os parametros da consulta.
2. A API valida, cria uma execucao e responde imediatamente com o ID (padrao assincrono).
3. Um worker interno executa a automacao no navegador, na ordem de chegada (FIFO), respeitando limite de concorrencia por global e por portal.
4. O cliente acompanha por polling ou por SSE, e ao final recebe os dados e os links dos documentos (PDF/print).
5. O resultado fica em cache por um periodo configuravel por tipo de consulta.

Autenticacao por API key: cada usuario possui a propria chave (header `X-API-Key`). Chaves sao gerenciadas por uma chave administrativa.

## Requisitos

- Node.js 20 ou superior
- npm
- Linux ou macOS (o Playwright precisa de algumas bibliotecas de sistema no Linux)

## Instalacao

```bash
npm install
npm run browser:install
cp .env.example .env
# edite .env: defina ADMIN_KEY e gere ENCRYPTION_KEY
```

`npm run browser:install` baixa apenas o `chromium-headless-shell` (binario minimo de
headless, ~90 MB — sem Firefox, sem WebKit, sem Chromium completo).

Em Linux pode ser necessario instalar as bibliotecas de sistema uma unica vez:

```bash
npx playwright-core install-deps chromium
```

Gerar a `ENCRYPTION_KEY`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Build e execucao

```bash
npm run typecheck   # verificacao de tipos
npm test            # testes
npm run build       # compila para dist/
npm start           # producao (dist/)
npm run dev         # desenvolvimento com reload
```

A API sobe em `http://localhost:3000` (configure `PORT` no `.env`).

## Configuracao

Todas as variaveis estao descritas em `.env.example`. As mais relevantes:

| Variavel | Descricao | Padrao |
|---|---|---|
| `ADMIN_KEY` | Chave para gerenciar API keys | obrigatoria |
| `ENCRYPTION_KEY` | Criptografia das sessoes de navegador | obrigatoria |
| `SEMAFORO_GLOBAL` | Automacoes simultaneas no servidor | `5` |
| `SEMAFORO_POR_PORTAL` | Simultaneidades por portal | `1` |
| `FILA_TIMEOUT_SEG` | Tempo maximo de espera na fila | `90` |
| `CACHE_<TIPO>` | TTL do cache por automacao (`7d`, `12h`, `45m`) | ver abaixo |

TTLs padrao de cache: 7 dias para a maioria das consultas, 3 dias para CADIN, 12 horas para DAM (com reexecucao forcada por padrao). Erros nunca entram em cache.

## Uso

Todas as rotas exigem o header `X-API-Key`.

### Criar uma API key (admin)

```bash
curl -X POST http://localhost:3000/v1/admin/apikeys \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $ADMIN_KEY" \
  -d '{"nome": "Maria"}'
```

### Executar uma consulta (assincrono, padrao)

```bash
curl -X POST http://localhost:3000/v1/automacoes/sefaz-bahia \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $USER_KEY" \
  -d '{
    "cnpj": "12345678000190",
    "artefatos": "ambos"
  }'
```

Resposta (202):

```json
{
  "execucaoId": "exe_01H...",
  "status": "PENDING",
  "posicaoFila": 2
}
```

### Consultar o resultado

```bash
curl http://localhost:3000/v1/execucoes/exe_01H... \
  -H "X-API-Key: $USER_KEY"
```

Quando `status` for `SUCCESS`, o corpo traz `dados` e `documentos` (quando `artefatos` foi solicitado).

### Acompanhar progresso (SSE)

```bash
curl -N http://localhost:3000/v1/execucoes/exe_01H.../progresso \
  -H "X-API-Key: $USER_KEY"
```

### Baixar um documento (PDF ou print)

```bash
curl -OJ http://localhost:3000/v1/documentos/doc_01H... \
  -H "X-API-Key: $USER_KEY"
```

### Parametro de artefatos

| Valor | Entrega |
|---|---|
| `nenhum` (padrao) | apenas os dados em JSON |
| `pdf` | PDF da pagina ou PDF oficial do portal |
| `print` | imagem da pagina (JPEG) |
| `ambos` | PDF e print |

Com `artefatos`, os documentos ficam disponiveis em `GET /v1/documentos/:id` durante o TTL configurado.

### Resposta sincrona (opcional)

```bash
curl -X POST "http://localhost:3000/v1/automacoes/sefaz-bahia?wait=30" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $USER_KEY" \
  -d '{"cnpj": "12345678000190"}'
```

Espera ate 30 segundos e devolve o resultado pronto; se a execucao demorar, responde 202 com o ID normalmente.

## Endpoints

| Metodo | Rota | Descricao |
|---|---|---|
| POST | `/v1/automacoes/:tipo` | Executa uma consulta |
| GET | `/v1/execucoes/:id` | Status e resultado |
| GET | `/v1/execucoes/:id/progresso` | Progresso em SSE |
| GET | `/v1/execucoes/:id/documentos` | Lista de documentos da execucao |
| GET | `/v1/documentos/:id` | Download do documento |
| POST | `/v1/admin/apikeys` | Cria API key (admin) |
| GET | `/v1/admin/apikeys` | Lista API keys (admin) |
| DELETE | `/v1/admin/apikeys/:id` | Revoga API key (admin) |
| GET | `/health` | Liveness |
| GET | `/ready` | Readiness (browser saudavel) |
| GET | `/metrics` | Metricas basicas |

## Estrutura do projeto

```
src/
  app/          aplicacao Fastify (server, plugins)
  config/       env, constantes, TTLs de cache
  modules/
    automation/ controller, service, repository, cache das consultas
    jobs/       fila, worker, estados das execucoes
    browser/    pool de navegadores, contexto, factory
  automations/
    base/       base dos robos, artefatos, captcha, ocr
    sites/      um diretorio por portal
    registry.ts registro das automacoes
  database/     cliente SQLite, migrations, repositories
  shared/       logger, erros, utilitarios, tipos
tests/          unit, integration, e2e
storage/        screenshots, traces, downloads, artefatos
data/           banco SQLite
```

## Notas de operacao

- A automacao usa `chromium-headless-shell` (modo headless, binario minimo). O navegador e lancado uma vez e reutilizado; cada execucao recebe um contexto isolado. O pool e reciclado periodicamente para manter o consumo de memoria estavel.
- Execucoes do mesmo portal rodam uma por vez (fila FIFO); portais diferentes rodam em paralelo.
- Consultas identicas em andamento sao agrupadas (uma unica execucao serve varios pedidos).
- Captcha e OCR sao resolvidos localmente (Tesseract), sem servicos externos de IA.
- Imagens e fontes dos portais sao bloqueadas por padrao para reduzir consumo; quando a consulta pede PDF/print, os recursos visuais sao liberados.
- O banco (`data/app.sqlite`) e a pasta `storage/` devem ser incluidos em backup junto com o `.env`.
