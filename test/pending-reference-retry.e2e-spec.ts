
import { randomUUID } from 'node:crypto';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
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

import { PendingReferenceProcessorService } from '../src/modules/wagering/application/pending-reference-processor.service.js';

import {
    WagerTransactionEntity,
    WagerTransactionStatus,
} from '../src/modules/wagering/infrastructure/persistence/wager-transaction.entity.js';

import { WalletEntity } from '../src/modules/wallet/infrastructure/persistence/wallet.entity.js';

describe('Pending Reference Retry (E2E)', () => {
    let app: INestApplication;
    let orm: MikroORM;
    let processor: PendingReferenceProcessorService;

    const originalNodeEnv = process.env.NODE_ENV;
    const originalWorkerEnabled =
        process.env.PENDING_REFERENCE_WORKER_ENABLED;

    beforeAll(async () => {
        process.env.NODE_ENV = 'test';
        process.env.PENDING_REFERENCE_WORKER_ENABLED = 'false';

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

        processor = app.get(PendingReferenceProcessorService);
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
    });

    async function createPendingRefund() {
        const walletId = randomUUID();
        const playerId = randomUUID();
        const providerId = `provider-${randomUUID()}`;
        const roundId = `round-${randomUUID()}`;
        const gameId = 'retry-test-game';

        const betExternalId = `bet-${randomUUID()}`;
        const refundExternalId = `refund-${randomUUID()}`;

        const now = new Date();

        const em = orm.em.fork();

        em.persist(
            em.create(WalletEntity, {
                id: walletId,
                playerId,
                currency: 'BRL',
                balance: '100.00',
                version: 1,
                createdAt: now,
                updatedAt: now,
            }),
        );

        await em.flush();

        const response = await request(app.getHttpServer())
            .post('/wagering/transactions')
            .set('Idempotency-Key', randomUUID())
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
                referenceExternalTransactionId: betExternalId,
            });

        expect(response.status).toBe(201);

        expect(response.body.status).toBe(
            WagerTransactionStatus.PENDING_REFERENCE,
        );

        return {
            transactionId: response.body.transactionId as string,
            walletId,
            playerId,
            providerId,
            roundId,
            gameId,
            betExternalId,
            refundExternalId,
        };
    }

    async function getTransaction(id: string) {
        const em = orm.em.fork();

        return em.findOneOrFail(WagerTransactionEntity, {
            id,
        });
    }

    async function updateTransaction(
        id: string,
        sql: string,
        params: unknown[] = [],
    ) {
        const connection = orm.em.getConnection();

        await connection.execute(
            `UPDATE wager_transactions SET ${sql} WHERE id = ?`,
            [...params, id],
        );
    }

    it('applies exponential backoff between retries', async () => {
        const pending = await createPendingRefund();

        const expectedDelays = [
            10_000,
            20_000,
            40_000,
            80_000,
            160_000,
            300_000,
            300_000,
        ];

        for (
            let attempt = 1;
            attempt <= expectedDelays.length;
            attempt++
        ) {
            // Torna a transação elegível sem esperar em tempo real.
            await updateTransaction(
                pending.transactionId,
                'next_retry_at = NULL',
            );

            await processor.processPending();

            const transaction = await getTransaction(
                pending.transactionId,
            );

            expect(transaction.status).toBe(
                WagerTransactionStatus.PENDING_REFERENCE,
            );

            expect(transaction.retryAttempts).toBe(attempt);

            expect(transaction.lastRetryAt).toBeInstanceOf(Date);
            expect(transaction.nextRetryAt).toBeInstanceOf(Date);

            const actualDelay =
                transaction.nextRetryAt!.getTime() -
                transaction.lastRetryAt!.getTime();

            // Margem pequena para diferenças de precisão do banco.
            expect(
                Math.abs(actualDelay - expectedDelays[attempt - 1]),
            ).toBeLessThanOrEqual(100);
        }
    });

    it('does not retry before nextRetryAt', async () => {
        const pending = await createPendingRefund();

        await processor.processPending();

        const first = await getTransaction(
            pending.transactionId,
        );

        expect(first.retryAttempts).toBe(1);

        await processor.processPending();

        const second = await getTransaction(
            pending.transactionId,
        );

        expect(second.retryAttempts).toBe(1);

        expect(second.status).toBe(
            WagerTransactionStatus.PENDING_REFERENCE,
        );
    });

    it('fails after reaching the maximum retry attempts', async () => {
        const pending = await createPendingRefund();

        await updateTransaction(
            pending.transactionId,
            `
                retry_attempts = 10,
                next_retry_at = NOW() - INTERVAL '1 second'
            `,
        );

        await processor.processPending();

        const transaction = await getTransaction(
            pending.transactionId,
        );

        expect(transaction.status).toBe(
            WagerTransactionStatus.FAILED,
        );

        expect(transaction.failureCode).toBe(
            'REFERENCE_RETRY_EXHAUSTED',
        );

        expect(transaction.retryAttempts).toBe(10);
        expect(transaction.nextRetryAt).toBeNull();
        expect(transaction.processedAt).toBeInstanceOf(Date);
    });

    it('expires after 24 hours even when next retry is in the future', async () => {
        const pending = await createPendingRefund();

        await updateTransaction(
            pending.transactionId,
            `
                created_at = NOW() - INTERVAL '25 hours',
                next_retry_at = NOW() + INTERVAL '5 minutes'
            `,
        );

        await processor.processPending();

        const transaction = await getTransaction(
            pending.transactionId,
        );

        expect(transaction.status).toBe(
            WagerTransactionStatus.FAILED,
        );

        expect(transaction.failureCode).toBe(
            'REFERENCE_TTL_EXPIRED',
        );

        expect(transaction.retryAttempts).toBe(0);
        expect(transaction.nextRetryAt).toBeNull();
        expect(transaction.processedAt).toBeInstanceOf(Date);
    });

    it('does not claim the same pending transaction twice concurrently', async () => {
        const pending = await createPendingRefund();

        await Promise.all([
            processor.processPending(),
            processor.processPending(),
        ]);

        const transaction = await getTransaction(
            pending.transactionId,
        );

        expect(transaction.status).toBe(
            WagerTransactionStatus.PENDING_REFERENCE,
        );

        expect(transaction.retryAttempts).toBe(1);

        expect(transaction.nextRetryAt).toBeInstanceOf(Date);
    });

    it('processes a pending REFUND when the BET arrives', async () => {
        const pending = await createPendingRefund();

        // Primeira tentativa: referência ainda não existe.
        await processor.processPending();

        const waiting = await getTransaction(
            pending.transactionId,
        );

        expect(waiting.status).toBe(
            WagerTransactionStatus.PENDING_REFERENCE,
        );

        expect(waiting.retryAttempts).toBe(1);

        // Cria o BET que estava faltando.
        const betResponse = await request(app.getHttpServer())
            .post('/wagering/transactions')
            .set('Idempotency-Key', randomUUID())
            .send({
                providerId: pending.providerId,
                externalTransactionId: pending.betExternalId,
                walletId: pending.walletId,
                playerId: pending.playerId,
                roundId: pending.roundId,
                gameId: pending.gameId,
                kind: 'BET',
                amount: '30.00',
                currency: 'BRL',
            });

        expect(betResponse.status).toBe(201);

        expect(betResponse.body.status).toBe(
            WagerTransactionStatus.PROCESSED,
        );

        // Simula a chegada do próximo horário de retry.
        await updateTransaction(
            pending.transactionId,
            'next_retry_at = NOW() - INTERVAL \'1 second\'',
        );

        await processor.processPending();

        const processed = await getTransaction(
            pending.transactionId,
        );

        expect(processed.status).toBe(
            WagerTransactionStatus.PROCESSED,
        );

        expect(processed.referenceTransactionId).toBe(
            betResponse.body.transactionId,
        );

        const em = orm.em.fork();

        const wallet = await em.findOneOrFail(WalletEntity, {
            id: pending.walletId,
        });

        expect(wallet.balance).toBe('100.00');
    });
});
