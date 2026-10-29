# Jungle Gaming — Backend Challenge

API backend para gerenciamento de carteiras e processamento de transações de wagering, desenvolvida com **NestJS**, **TypeScript** e **PostgreSQL**, com foco em consistência financeira, idempotência e publicação confiável de eventos.

## Tecnologias

- **NestJS 12** e **TypeScript**
- **Bun** para instalação de dependências e execução de scripts
- **PostgreSQL 16** e **MikroORM 7**
- **Decimal.js** para cálculos monetários
- **LocalStack** para emulação local do Amazon SQS
- **Vitest** e **Supertest** para testes automatizados
- **Docker Compose** para infraestrutura local

## Estrutura do projeto

```text
src/
├── modules/
│   ├── wallet/       # Criação de carteiras e ledger financeiro
│   ├── wagering/     # Transações, idempotência e referências pendentes
│   └── outbox/       # Persistência e publicação de eventos no SQS
├── shared/
│   └── domain/value-objects/money.ts
└── migrations/       # Evolução do esquema do PostgreSQL

test/                 # Testes E2E
docker/postgres/init/  # Inicialização do banco de testes
localstack/init/      # Criação da fila SQS
```

## Pré-requisitos

- Docker com Docker Compose
- Bun instalado

A API é executada localmente; PostgreSQL e LocalStack são disponibilizados via Docker.

## Configuração e execução

### 1. Instalar as dependências

```bash
bun install
```

### 2. Configurar as variáveis de ambiente

Crie um arquivo `.env` na raiz do projeto:

```dotenv
DATABASE_URL=postgresql://jungle:jungle123@localhost:5432/jungle_db
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
SQS_ENDPOINT=http://localhost:4566
SQS_QUEUE_URL=http://localhost:4566/000000000000/wager-transactions
```

Os valores acima são **exclusivamente para desenvolvimento local**. O arquivo `.env` não deve ser versionado.

Para os testes, utilize `.env.test` com os mesmos parâmetros de AWS/LocalStack e:

```dotenv
DATABASE_URL=postgresql://jungle:jungle123@localhost:5432/jungle_test_db
PENDING_REFERENCE_WORKER_ENABLED=false
```

> O `.env.test` do projeto usa credenciais fictícias e um banco separado. Confirme as variáveis antes de executar migrations ou testes. A configuração do MikroORM respeita `DATABASE_URL` já definida no ambiente.

### 3. Subir a infraestrutura

```bash
docker compose up -d
docker compose ps
```

Os serviços `jungle-postgres` e `jungle-localstack` devem apresentar estado saudável (`healthy`).

- O PostgreSQL expõe a porta `5432` e utiliza o banco `jungle_db`.
- O script `docker/postgres/init/01-create-test-db.sql` cria `jungle_test_db` **na primeira inicialização de um volume vazio**.
- O script `localstack/init/01-create-queues.py` cria a fila SQS `wager-transactions`.

Para consultar as filas:

```bash
docker exec jungle-localstack awslocal sqs list-queues
```

> A URL listada pelo LocalStack pode usar o domínio `sqs.us-east-1.localhost.localstack.cloud`, em vez de `localhost`. Verifique a compatibilidade da `SQS_QUEUE_URL` configurada com o ambiente em que a aplicação está sendo executada.

### 4. Executar as migrations

No banco de desenvolvimento, com o `.env` configurado:

```bash
bunx mikro-orm migration:up
```

No banco de testes, usando as variáveis de `.env.test`:

```bash
NODE_ENV=test bun --env-file=.env.test x mikro-orm migration:up
```

Para consultar migrations pendentes no banco de testes:

```bash
NODE_ENV=test bun --env-file=.env.test x mikro-orm migration:pending
```

**Atenção:** scripts de inicialização do PostgreSQL não são reaplicados automaticamente quando o volume já existe. Não execute `docker compose down -v` em ambientes com dados que precisam ser preservados.

### 5. Iniciar a aplicação

```bash
bun run start:dev
```

A URL padrão do NestJS, caso a porta não tenha sido alterada, é `http://localhost:3000`.

## API HTTP

### Criar carteira

**`POST /wallets`**

```json
{
  "playerId": "550e8400-e29b-41d4-a716-446655440000",
  "currency": "BRL",
  "initialBalance": "100.00"
}
```

| Campo | Obrigatório | Validação |
| --- | --- | --- |
| `playerId` | Sim | UUID válido |
| `currency` | Sim | Três letras maiúsculas, como `BRL` |
| `initialBalance` | Não | String decimal não negativa, com até duas casas decimais |

O valor de `initialBalance`, quando omitido, é tratado pelo caso de uso de criação da carteira.

### Processar transação de wagering

**`POST /wagering/transactions`**

O header `Idempotency-Key` é **obrigatório** e deve conter um valor não vazio.

```http
POST /wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-001-bet-001
```

Exemplo de payload para uma aposta (`BET`):

```json
{
  "providerId": "provider-001",
  "externalTransactionId": "bet-001",
  "walletId": "550e8400-e29b-41d4-a716-446655440001",
  "playerId": "550e8400-e29b-41d4-a716-446655440000",
  "roundId": "round-001",
  "gameId": "game-001",
  "kind": "BET",
  "amount": "30.00",
  "currency": "BRL"
}
```

| Campo | Obrigatório | Validação |
| --- | --- | --- |
| `providerId` | Sim | String |
| `externalTransactionId` | Sim | String |
| `walletId` | Sim | UUID válido |
| `playerId` | Sim | UUID válido |
| `roundId` | Sim | String |
| `gameId` | Sim | String |
| `kind` | Sim | `BET`, `WIN`, `LOSS`, `REFUND` ou `ROLLBACK` |
| `amount` | Sim | String decimal, positiva, com exatamente duas casas decimais |
| `currency` | Sim | Três letras maiúsculas |
| `referenceExternalTransactionId` | Condicional | Obrigatória para `REFUND` e `ROLLBACK`; não permitida nas demais operações |

Exemplo de reembolso (`REFUND`) que referencia a aposta anterior:

```json
{
  "providerId": "provider-001",
  "externalTransactionId": "refund-001",
  "walletId": "550e8400-e29b-41d4-a716-446655440001",
  "playerId": "550e8400-e29b-41d4-a716-446655440000",
  "roundId": "round-001",
  "gameId": "game-001",
  "kind": "REFUND",
  "amount": "30.00",
  "currency": "BRL",
  "referenceExternalTransactionId": "bet-001"
}
```

> Os UUIDs e identificadores acima são ilustrativos. Para executar o exemplo, use o `walletId` retornado pela criação da carteira e mantenha o mesmo `playerId` e a mesma moeda.

### Regras das operações

| Operação | Comportamento |
| --- | --- |
| `BET` | Debita o valor da carteira |
| `WIN` | Credita o valor na carteira |
| `LOSS` | Registra a transação sem movimentar o saldo |
| `REFUND` | Credita o valor de uma `BET` processada |
| `ROLLBACK` de `BET` | Credita o valor anteriormente debitado |
| `ROLLBACK` de `WIN` ou `REFUND` | Debita o valor anteriormente creditado |

As compensações (`REFUND` e `ROLLBACK`) exigem uma referência válida, processada, do mesmo provedor, jogador, carteira, rodada, jogo e moeda. O valor da compensação deve ser igual ao da transação referenciada; **compensações parciais não são suportadas**. Uma transação não pode receber duas compensações diretas processadas.

### Idempotência e respostas

A API identifica transações por provedor, chave de idempotência e identificador externo. Repetir uma requisição com a mesma identidade e conteúdo não duplica a movimentação financeira; a resposta indica `replayed: true`.

Exemplo ilustrativo de resposta de uma transação processada:

```json
{
  "transactionId": "550e8400-e29b-41d4-a716-446655440002",
  "status": "PROCESSED",
  "balance": "70.00",
  "version": 1,
  "replayed": false
}
```

Os principais comportamentos HTTP observáveis nos controllers e no caso de uso são:

| HTTP | Situação |
| --- | --- |
| `201` | Requisição POST concluída pelo controller NestJS, inclusive quando retorna uma transação pendente |
| `400` | Header de idempotência ausente, referência inválida para a operação ou valor inválido |
| `404` | Carteira não encontrada |
| `409` | Conflito de idempotência, jogador/moeda divergente ou referência incompatível em determinados fluxos |
| `422` | Transação com status `REJECTED`, por exemplo saldo insuficiente |

A resposta de processamento pode ter status de domínio `PROCESSED`, `PENDING_REFERENCE`, `REJECTED` ou `FAILED`, dependendo do fluxo. Os detalhes de validação de payload dependem da configuração global de validação do NestJS.

## Consistência financeira

- Operações financeiras executadas dentro de transações do PostgreSQL.
- Bloqueio pessimista (`PESSIMISTIC_WRITE`) da carteira antes de consultar e atualizar seu saldo.
- Cálculos com `Decimal.js`, evitando operações monetárias com ponto flutuante nativo.
- Proteção contra saldo negativo em operações de débito.
- Registro de débitos e créditos no ledger, incluindo saldo anterior e posterior.
- Incremento de versão da carteira nas movimentações de saldo.
- Persistência de evento na Outbox na mesma transação de banco da operação financeira.

A operação `LOSS` não altera o saldo e não gera lançamento de débito/crédito no ledger.

## Referências pendentes e reprocessamento

Quando um `REFUND` ou `ROLLBACK` referencia uma transação ainda inexistente, o registro pode ser armazenado com status `PENDING_REFERENCE` para processamento posterior.

O processador de referências pendentes implementa:

- Backoff exponencial, começando em **10 segundos** e limitado a **5 minutos**.
- Limite de **10 tentativas**.
- Expiração após **24 horas**.
- Marcação de falha com códigos como `REFERENCE_RETRY_EXHAUSTED` e `REFERENCE_TTL_EXPIRED`.
- Seleção de lotes com `FOR UPDATE SKIP LOCKED`, reduzindo disputa entre workers na etapa de reivindicação.

A seleção concorrente e a idempotência contribuem para a segurança do reprocessamento; não representam, por si só, uma garantia de execução exatamente uma vez em cenários distribuídos.

## Transactional Outbox e SQS

Ao processar uma transação financeira, a aplicação persiste um evento `wager.transaction.processed` na tabela `outbox_events`. Um serviço separado é responsável pela publicação assíncrona no SQS, permitindo novas tentativas quando a publicação falha.

A infraestrutura local usa o LocalStack para disponibilizar a fila `wager-transactions`. A persistência do evento na Outbox e a publicação na fila são etapas separadas, evitando depender da disponibilidade imediata do SQS durante a atualização financeira.

## Testes e qualidade

Execute:

```bash
bunx tsc --noEmit
bun run lint
bun run test
bun run test:e2e
```

**Última validação compartilhada (29/10/2026):**

| Verificação | Resultado |
| --- | --- |
| TypeScript | Sem erros |
| Oxlint | 0 erros e 0 warnings |
| Testes E2E | **34 aprovados em 4 suítes** |
| Migrations | **5 aplicadas** com sucesso em banco temporário vazio |
| Reexecução das migrations | Sem alterações pendentes |
| LocalStack | Script de criação da fila executado com sucesso |

Suítes E2E:

- `test/wagering.e2e-spec.ts`: 23 testes.
- `test/outbox.e2e-spec.ts`: 4 testes.
- `test/pending-reference-worker.e2e-spec.ts`: 1 teste.
- `test/pending-reference-retry.e2e-spec.ts`: 6 testes.

> A suíte de Outbox simula intencionalmente uma falha `SQS unavailable` para validar o tratamento de erros. Esse log pode aparecer mesmo quando os testes passam.

## Notas para avaliação

- A criação automática de `jungle_test_db` depende da inicialização de um volume PostgreSQL novo. Em volumes preexistentes, crie o banco separadamente se necessário.
- Execute migrations explicitamente no banco de desenvolvimento **e** no banco de testes antes de rodar os testes E2E em uma instalação nova.
- Não use credenciais de produção nos arquivos `.env` ou `.env.test`.
- A configuração e as regras descritas aqui refletem o código e as verificações realizadas; a aderência integral ao enunciado original do desafio deve ser conferida separadamente.
