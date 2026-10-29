
import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import {
    INestApplication,
    ValidationPipe,
} from '@nestjs/common';

import { MikroORM } from '@mikro-orm/postgresql';
import request from 'supertest';

import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';

import { AppModule } from '../src/app.module.js';

import { PendingReferenceWorkerService } from '../src/modules/wagering/application/pending-reference-worker.service.js';

import { PendingReferenceProcessorService } from '../src/modules/wagering/application/pending-reference-processor.service.js';

import {
    WagerTransactionEntity,
    WagerTransactionStatus,
} from '../src/modules/wagering/infrastructure/persistence/wager-transaction.entity.js';

import { WalletEntity } from '../src/modules/wallet/infrastructure/persistence/wallet.entity.js';

import {
    WalletLedgerEntryEntity,
} from '../src/modules/wallet/infrastructure/persistence/wallet-ledger-entry.entity.js';

import {
    OutboxEventEntity,
} from '../src/modules/outbox/infrastructure/persistence/outbox-event.entity.js';

describe('PendingReferenceWorker (e2e)', () => {
    let app: INestApplication;
    let orm: MikroORM;
    let processor: PendingReferenceProcessorService;

    const originalNodeEnv = process.env.NODE_ENV;

    const originalWorkerEnabled =
        process.env.PENDING_REFERENCE_WORKER_ENABLED;

    const originalWorkerInterval =
        process.env.PENDING_REFERENCE_INTERVAL_MS;

    beforeAll(async () => {
        process.env.NODE_ENV = 'test';

        // Impede que o worker do AppModule seja iniciado.
        process.env.PENDING_REFERENCE_WORKER_ENABLED =
            'false';

        const moduleRef = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleRef.createNestApplication();

        app.useGlobalPipes(
            new ValidationPipe({
                whitelist: true,
                transform: true,
            }),
        );

        await app.init();

        orm = app.get(MikroORM);

        processor = app.get(
            PendingReferenceProcessorService,
        );
    });

    afterAll(async () => {
        if (app) {
            await app.close();
        }

        if (originalNodeEnv === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = originalNodeEnv;
        }

        if (originalWorkerEnabled === undefined) {
            delete process.env.PENDING_REFERENCE_WORKER_ENABLED;
        } else {
            process.env.PENDING_REFERENCE_WORKER_ENABLED =
                originalWorkerEnabled;
        }

        if (originalWorkerInterval === undefined) {
            delete process.env.PENDING_REFERENCE_INTERVAL_MS;
        } else {
            process.env.PENDING_REFERENCE_INTERVAL_MS =
                originalWorkerInterval;
        }
    });

    it(
        'automatically processes a pending REFUND after its BET exists',
        async () => {
            const walletId = randomUUID();
            const playerId = randomUUID();

            const providerId = `provider-${randomUUID()}`;
            const roundId = `round-${randomUUID()}`;
            const gameId = 'integration-game';

            const betExternalId = `bet-${randomUUID()}`;
            const refundExternalId = `refund-${randomUUID()}`;

            const now = new Date();

            const em = orm.em.fork();

            const wallet = em.create(WalletEntity, {
                id: walletId,
                playerId,
                currency: 'BRL',
                balance: '100.00',
                version: 1,
                createdAt: now,
                updatedAt: now,
            });

            em.persist(wallet);
            await em.flush();

            const server = app.getHttpServer();

            const refundIdempotencyKey = randomUUID();

            const pendingResponse = await request(server)
                .post('/wagering/transactions')
                .set(
                    'Idempotency-Key',
                    refundIdempotencyKey,
                )
                .send({
                    providerId,
                    externalTransactionId: refundExternalId,
                    walletId,
                    playerId,
                    roundId,
                    gameId,
                    kind: 'REFUND',
                    amount: '30.00',
                    currency: 'BRL',
                    referenceExternalTransactionId:
                        betExternalId,
                });

            expect(pendingResponse.status).toBe(201);

            expect(pendingResponse.body.status).toBe(
                WagerTransactionStatus.PENDING_REFERENCE,
            );

            const pendingTransactionId: string =
                pendingResponse.body.transactionId;

            expect(pendingTransactionId).toBeDefined();

            const betResponse = await request(server)
                .post('/wagering/transactions')
                .set('Idempotency-Key', randomUUID())
                .send({
                    providerId,
                    externalTransactionId: betExternalId,
                    walletId,
                    playerId,
                    roundId,
                    gameId,
                    kind: 'BET',
                    amount: '30.00',
                    currency: 'BRL',
                });

            expect(betResponse.status).toBe(201);

            expect(betResponse.body.status).toBe(
                WagerTransactionStatus.PROCESSED,
            );

            expect(betResponse.body.balance).toBe(
                '70.00',
            );

            const betTransactionId: string =
                betResponse.body.transactionId;
            process.env.NODE_ENV = 'development';

            process.env.PENDING_REFERENCE_WORKER_ENABLED =
                'true';

            process.env.PENDING_REFERENCE_INTERVAL_MS =
                '1000';

            let automaticWorker:
                | PendingReferenceWorkerService
                | undefined;

            try {
                automaticWorker =
                    new PendingReferenceWorkerService(
                        processor,
                    );
            } finally {
                process.env.NODE_ENV = 'test';

                process.env.PENDING_REFERENCE_WORKER_ENABLED =
                    'false';

                process.env.PENDING_REFERENCE_INTERVAL_MS =
                    originalWorkerInterval ?? '10000';
            }

            automaticWorker.onModuleInit();

            try {

                let processedTransaction:
                    | WagerTransactionEntity
                    | null = null;

                const deadline = Date.now() + 8000;

                while (Date.now() < deadline) {
                    const checkEm = orm.em.fork();

                    processedTransaction =
                        await checkEm.findOne(
                            WagerTransactionEntity,
                            {
                                id: pendingTransactionId,
                            },
                        );

                    if (
                        processedTransaction?.status ===
                        WagerTransactionStatus.PROCESSED
                    ) {
                        break;
                    }

                    await new Promise<void>((resolve) => {
                        setTimeout(resolve, 100);
                    });
                }

                expect(processedTransaction).not.toBeNull();

                expect(processedTransaction?.status).toBe(
                    WagerTransactionStatus.PROCESSED,
                );

                expect(processedTransaction?.id).toBe(
                    pendingTransactionId,
                );

                expect(
                    processedTransaction?.referenceTransactionId,
                ).toBe(betTransactionId);

                expect(
                    processedTransaction?.processedAt,
                ).toBeInstanceOf(Date);

                const finalEm = orm.em.fork();

                const finalWallet =
                    await finalEm.findOneOrFail(
                        WalletEntity,
                        {
                            id: walletId,
                        },
                    );

                expect(finalWallet.balance).toBe(
                    '100.00',
                );

                expect(finalWallet.version).toBe(3);

                const refundLedgerCount =
                    await finalEm.count(
                        WalletLedgerEntryEntity,
                        {
                            transactionId:
                                pendingTransactionId,
                        },
                    );

                expect(refundLedgerCount).toBe(1);

                const refundOutboxCount =
                    await finalEm.count(
                        OutboxEventEntity,
                        {
                            aggregateId:
                                pendingTransactionId,
                        },
                    );

                expect(refundOutboxCount).toBe(1);
                const duplicateCheckEm = orm.em.fork();

                const duplicateTransactionCount =
                    await duplicateCheckEm.count(
                        WagerTransactionEntity,
                        {
                            providerId,
                            externalTransactionId:
                                refundExternalId,
                        },
                    );

                expect(duplicateTransactionCount).toBe(1);
            } finally {
                await automaticWorker.onModuleDestroy();
            }
        },
        15000,
    );
});
