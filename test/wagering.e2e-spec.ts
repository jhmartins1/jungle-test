
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { WalletEntity } from '../src/modules/wallet/infrastructure/persistence/wallet.entity.js';
import { WalletLedgerEntryEntity } from '../src/modules/wallet/infrastructure/persistence/wallet-ledger-entry.entity.js';
import {
    WagerTransactionEntity,
    WagerTransactionStatus,
} from '../src/modules/wagering/infrastructure/persistence/wager-transaction.entity.js';
import { OutboxEventEntity } from '../src/modules/outbox/infrastructure/persistence/outbox-event.entity.js';
import { PendingReferenceProcessorService } from '../src/modules/wagering/application/pending-reference-processor.service.js';

describe('Wagering API (E2E)', () => {
    let app: INestApplication;
    let orm: MikroORM;

    const playerId = randomUUID();
    const providerId = `provider-e2e-${randomUUID()}`;
    const roundId = `round-${randomUUID()}`;
    const gameId = 'game-e2e';

    let walletId: string;

    const makeTransaction = (
        kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK',
        amount: string,
        externalTransactionId: string,
        referenceExternalTransactionId?: string,
    ) => ({
        providerId,
        externalTransactionId,
        walletId,
        playerId,
        roundId,
        gameId,
        kind,
        amount,
        currency: 'BRL',
        ...(referenceExternalTransactionId
            ? { referenceExternalTransactionId }
            : {}),
    });

    beforeAll(async () => {
        if (
            process.env.NODE_ENV !== 'test' ||
            !process.env.DATABASE_URL?.includes('/jungle_test_db')
        ) {
            throw new Error('E2E tests require jungle_test_db');
        }

        const moduleRef = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleRef.createNestApplication();

        app.useGlobalPipes(
            new ValidationPipe({
                whitelist: true,
                forbidNonWhitelisted: true,
                transform: true,
            }),
        );

        await app.init();

        orm = app.get(MikroORM);
    });

    afterAll(async () => {
        if (app) {
            await app.close();
        }
    });

    it('creates a wallet with an initial balance', async () => {
        const response = await request(app.getHttpServer())
            .post('/wallets')
            .send({
                playerId,
                currency: 'BRL',
                initialBalance: '100.00',
            });

        expect(response.status).toBe(201);

        const em = orm.em.fork();

        const wallet = await em.findOneOrFail(WalletEntity, {
            playerId,
            currency: 'BRL',
        });

        walletId = wallet.id;

        expect(wallet.balance).toBe('100.00');
        expect(wallet.version).toBe(1);
    });

    it('processes a BET and debits the wallet', async () => {
        const response = await request(app.getHttpServer())
            .post('/wagering/transactions')
            .set('Idempotency-Key', 'e2e-bet-001')
            .send(makeTransaction('BET', '30.00', 'e2e-bet-001'));

        expect(response.status).toBe(201);
        expect(response.body.status).toBe('PROCESSED');
        expect(response.body.balance).toBe('70.00');

        const wallet = await orm.em.fork().findOneOrFail(
            WalletEntity,
            { id: walletId },
        );

        expect(wallet.balance).toBe('70.00');
        expect(wallet.version).toBe(2);
    });

    it('replays an idempotent BET without debiting twice', async () => {
        const response = await request(app.getHttpServer())
            .post('/wagering/transactions')
            .set('Idempotency-Key', 'e2e-bet-001')
            .send(makeTransaction('BET', '30.00', 'e2e-bet-001'));

        expect(response.status).toBe(201);
        expect(response.body.replayed).toBe(true);
        expect(response.body.balance).toBe('70.00');

        const wallet = await orm.em.fork().findOneOrFail(
            WalletEntity,
            { id: walletId },
        );

        expect(wallet.balance).toBe('70.00');
        expect(wallet.version).toBe(2);
    });

    it('rejects an idempotency key reused with a different amount', async () => {
        const response = await request(app.getHttpServer())
            .post('/wagering/transactions')
            .set('Idempotency-Key', 'e2e-bet-001')
            .send(makeTransaction('BET', '40.00', 'e2e-bet-001'));

        expect(response.status).toBe(409);
    });

    it('processes a WIN and credits the wallet', async () => {
        const response = await request(app.getHttpServer())
            .post('/wagering/transactions')
            .set('Idempotency-Key', 'e2e-win-001')
            .send(makeTransaction('WIN', '50.00', 'e2e-win-001'));

        expect(response.status).toBe(201);
        expect(response.body.status).toBe('PROCESSED');
        expect(response.body.balance).toBe('120.00');

        const wallet = await orm.em.fork().findOneOrFail(
            WalletEntity,
            { id: walletId },
        );

        expect(wallet.balance).toBe('120.00');
        expect(wallet.version).toBe(3);
    });

    it('rejects a BET when funds are insufficient', async () => {
        const response = await request(app.getHttpServer())
            .post('/wagering/transactions')
            .set('Idempotency-Key', 'e2e-insufficient-001')
            .send(
                makeTransaction(
                    'BET',
                    '999.00',
                    'e2e-insufficient-001',
                ),
            );

        expect(response.status).toBe(422);
        expect(response.body.status).toBe('REJECTED');

        const wallet = await orm.em.fork().findOneOrFail(
            WalletEntity,
            { id: walletId },
        );

        expect(wallet.balance).toBe('120.00');
        expect(wallet.version).toBe(3);
    });

    it('processes a REFUND for the original BET', async () => {
        const response = await request(app.getHttpServer())
            .post('/wagering/transactions')
            .set('Idempotency-Key', 'e2e-refund-001')
            .send(
                makeTransaction(
                    'REFUND',
                    '30.00',
                    'e2e-refund-001',
                    'e2e-bet-001',
                ),
            );

        expect(response.status).toBe(201);
        expect(response.body.status).toBe('PROCESSED');
        expect(response.body.balance).toBe('150.00');
    });

    it('prevents refunding the same BET twice', async () => {
        const response = await request(app.getHttpServer())
            .post('/wagering/transactions')
            .set('Idempotency-Key', 'e2e-refund-002')
            .send(
                makeTransaction(
                    'REFUND',
                    '30.00',
                    'e2e-refund-002',
                    'e2e-bet-001',
                ),
            );

        expect(response.status).toBe(409);
    });

    it('processes a ROLLBACK for the original WIN', async () => {
        const response = await request(app.getHttpServer())
            .post('/wagering/transactions')
            .set('Idempotency-Key', 'e2e-rollback-001')
            .send(
                makeTransaction(
                    'ROLLBACK',
                    '50.00',
                    'e2e-rollback-001',
                    'e2e-win-001',
                ),
            );

        expect(response.status).toBe(201);
        expect(response.body.status).toBe('PROCESSED');
        expect(response.body.balance).toBe('100.00');
    });

    it('persists ledger entries and outbox events', async () => {
        const em = orm.em.fork();

        const transactions = await em.find(WagerTransactionEntity, {
            providerId,
        });

        const processed = transactions.filter(
            (transaction) => transaction.status === 'PROCESSED',
        );

        const walletLedger = await em.find(WalletLedgerEntryEntity, {
            walletId,
        });

        const events = await em.find(OutboxEventEntity, {});

        expect(processed.length).toBe(4);
        expect(walletLedger.length).toBe(5);

        const transactionIds = new Set(
            processed.map((transaction) => transaction.id),
        );

        const matchingEvents = events.filter((event) =>
            transactionIds.has(event.aggregateId),
        );

        expect(matchingEvents.length).toBe(4);
        expect(
            matchingEvents.every((event) => event.status === 'PENDING'),
        ).toBe(true);
    });

    it('prevents negative balances under concurrent BET requests', async () => {
        const concurrentPlayerId = randomUUID();

        const walletResponse = await request(app.getHttpServer())
            .post('/wallets')
            .send({
                playerId: concurrentPlayerId,
                currency: 'BRL',
                initialBalance: '100.00',
            });

        expect(walletResponse.status).toBe(201);

        const em = orm.em.fork();

        const concurrentWallet = await em.findOneOrFail(
            WalletEntity,
            {
                playerId: concurrentPlayerId,
                currency: 'BRL',
            },
        );

        const concurrentWalletId = concurrentWallet.id;
        const concurrentProviderId = `provider-${randomUUID()}`;

        const createBet = (externalTransactionId: string) =>
            request(app.getHttpServer())
                .post('/wagering/transactions')
                .set('Idempotency-Key', externalTransactionId)
                .send({
                    providerId: concurrentProviderId,
                    externalTransactionId,
                    walletId: concurrentWalletId,
                    playerId: concurrentPlayerId,
                    roundId: 'concurrent-round',
                    gameId: 'concurrent-game',
                    kind: 'BET',
                    amount: '80.00',
                    currency: 'BRL',
                });

        const [first, second] = await Promise.all([
            createBet(`concurrent-bet-${randomUUID()}`),
            createBet(`concurrent-bet-${randomUUID()}`),
        ]);

        const statuses = [first.status, second.status].sort(
            (a, b) => a - b,
        );

        expect(statuses).toEqual([201, 422]);

        const updatedWallet = await orm.em.fork().findOneOrFail(
            WalletEntity,
            { id: concurrentWalletId },
        );

        expect(updatedWallet.balance).toBe('20.00');
        expect(updatedWallet.version).toBe(2);

        const ledgerEntries = await orm.em.fork().find(
            WalletLedgerEntryEntity,
            { walletId: concurrentWalletId },
        );

        expect(ledgerEntries.length).toBe(2);
    });

    it('processes LOSS without changing the wallet balance', async () => {
        const before = await orm.em.fork().findOneOrFail(
            WalletEntity,
            { id: walletId },
        );

        const balanceBefore = before.balance;
        const versionBefore = before.version;

        const externalTransactionId = `loss-${randomUUID()}`;

        const response = await request(app.getHttpServer())
            .post('/wagering/transactions')
            .set('Idempotency-Key', externalTransactionId)
            .send(
                makeTransaction(
                    'LOSS',
                    '10.00',
                    externalTransactionId,
                ),
            );

        expect(response.status).toBe(201);
        expect(response.body.status).toBe('PROCESSED');

        const after = await orm.em.fork().findOneOrFail(
            WalletEntity,
            { id: walletId },
        );

        expect(after.balance).toBe(balanceBefore);
        expect(after.version).toBe(versionBefore);

        const ledger = await orm.em.fork().findOne(
            WalletLedgerEntryEntity,
            { transactionId: response.body.transactionId },
        );

        expect(ledger).toBeNull();

        const outbox = await orm.em.fork().findOne(
            OutboxEventEntity,
            { aggregateId: response.body.transactionId },
        );

        expect(outbox).not.toBeNull();
        expect(outbox?.status).toBe('PENDING');
    });

    it('reprocesses an out-of-order REFUND exactly once', async () => {
        const originalId = `bet-${randomUUID()}`;
        const refundId = `refund-${randomUUID()}`;

        const before = await orm.em.fork().findOneOrFail(
            WalletEntity,
            { id: walletId },
        );

        const initialBalance = before.balance;
        const initialVersion = before.version;

        const refundPayload = makeTransaction(
            'REFUND',
            '10.00',
            refundId,
            originalId,
        );

        const pending = await request(app.getHttpServer())
            .post('/wagering/transactions')
            .set('Idempotency-Key', refundId)
            .send(refundPayload);

        expect(pending.status).toBe(201);
        expect(pending.body.status).toBe('PENDING_REFERENCE');

        const original = await request(app.getHttpServer())
            .post('/wagering/transactions')
            .set('Idempotency-Key', originalId)
            .send(
                makeTransaction('BET', '10.00', originalId),
            );

        expect(original.status).toBe(201);
        expect(original.body.status).toBe('PROCESSED');

        const processor = app.get(
            PendingReferenceProcessorService,
        );

        await processor.processPending();

        const processed = await orm.em.fork().findOneOrFail(
            WagerTransactionEntity,
            { id: pending.body.transactionId },
        );

        expect(processed.status).toBe('PROCESSED');
        expect(processed.referenceTransactionId).toBe(
            original.body.transactionId,
        );

        const ledger = await orm.em.fork().find(
            WalletLedgerEntryEntity,
            { transactionId: processed.id },
        );

        expect(ledger).toHaveLength(1);

        const outbox = await orm.em.fork().find(
            OutboxEventEntity,
            { aggregateId: processed.id },
        );

        expect(outbox).toHaveLength(1);

        await processor.processPending();

        const replay = await request(app.getHttpServer())
            .post('/wagering/transactions')
            .set('Idempotency-Key', refundId)
            .send(refundPayload);

        expect(replay.status).toBe(201);
        expect(replay.body.status).toBe('PROCESSED');
        expect(replay.body.replayed).toBe(true);
        expect(replay.body.transactionId).toBe(
            pending.body.transactionId,
        );

        const after = await orm.em.fork().findOneOrFail(
            WalletEntity,
            { id: walletId },
        );

        expect(after.balance).toBe(initialBalance);
        expect(after.version).toBe(initialVersion + 2);

        const finalLedger = await orm.em.fork().find(
            WalletLedgerEntryEntity,
            { transactionId: processed.id },
        );

        expect(finalLedger).toHaveLength(1);
    });

    it('reprocesses an out-of-order ROLLBACK for a WIN', async () => {
        const originalId = `win-${randomUUID()}`;
        const rollbackId = `rollback-${randomUUID()}`;

        const before = await orm.em.fork().findOneOrFail(
            WalletEntity,
            { id: walletId },
        );

        const initialBalance = before.balance;
        const initialVersion = before.version;

        const pending = await request(app.getHttpServer())
            .post('/wagering/transactions')
            .set('Idempotency-Key', rollbackId)
            .send(
                makeTransaction(
                    'ROLLBACK',
                    '15.00',
                    rollbackId,
                    originalId,
                ),
            );

        expect(pending.status).toBe(201);
        expect(pending.body.status).toBe('PENDING_REFERENCE');

        const win = await request(app.getHttpServer())
            .post('/wagering/transactions')
            .set('Idempotency-Key', originalId)
            .send(
                makeTransaction('WIN', '15.00', originalId),
            );

        expect(win.status).toBe(201);

        await app
            .get(PendingReferenceProcessorService)
            .processPending();

        const processed = await orm.em.fork().findOneOrFail(
            WagerTransactionEntity,
            { id: pending.body.transactionId },
        );

        expect(processed.status).toBe('PROCESSED');
        expect(processed.referenceTransactionId).toBe(
            win.body.transactionId,
        );

        const after = await orm.em.fork().findOneOrFail(
            WalletEntity,
            { id: walletId },
        );

        expect(after.balance).toBe(initialBalance);
        expect(after.version).toBe(initialVersion + 2);

        const ledger = await orm.em.fork().find(
            WalletLedgerEntryEntity,
            { transactionId: processed.id },
        );

        expect(ledger).toHaveLength(1);
    });


    it('prevents two concurrent REFUNDs for the same BET', async () => {
        const testPlayerId = randomUUID();
        const testProviderId = `provider-${randomUUID()}`;
        const originalId = `bet-${randomUUID()}`;

        const walletResponse = await request(app.getHttpServer())
            .post('/wallets')
            .send({
                playerId: testPlayerId,
                currency: 'BRL',
                initialBalance: '100.00',
            });

        expect(walletResponse.status).toBe(201);

        const wallet = await orm.em.fork().findOneOrFail(
            WalletEntity,
            {
                playerId: testPlayerId,
                currency: 'BRL',
            },
        );

        const payload = (
            kind: 'BET' | 'REFUND',
            externalTransactionId: string,
            referenceExternalTransactionId?: string,
        ) => ({
            providerId: testProviderId,
            externalTransactionId,
            walletId: wallet.id,
            playerId: testPlayerId,
            roundId: 'concurrent-refund-round',
            gameId: 'concurrent-refund-game',
            kind,
            amount: '30.00',
            currency: 'BRL',
            ...(referenceExternalTransactionId
                ? { referenceExternalTransactionId }
                : {}),
        });

        const bet = await request(app.getHttpServer())
            .post('/wagering/transactions')
            .set('Idempotency-Key', originalId)
            .send(payload('BET', originalId));

        expect(bet.status).toBe(201);
        expect(bet.body.status).toBe('PROCESSED');

        const sendRefund = (id: string) =>
            request(app.getHttpServer())
                .post('/wagering/transactions')
                .set('Idempotency-Key', id)
                .send(payload('REFUND', id, originalId));

        const [first, second] = await Promise.all([
            sendRefund(`refund-${randomUUID()}`),
            sendRefund(`refund-${randomUUID()}`),
        ]);

        expect(
            [first.status, second.status].sort((a, b) => a - b),
        ).toEqual([
            201,
            409,
        ]);

        const updatedWallet = await orm.em.fork().findOneOrFail(
            WalletEntity,
            { id: wallet.id },
        );

        expect(updatedWallet.balance).toBe('100.00');
        expect(updatedWallet.version).toBe(3);

        const compensations = await orm.em.fork().find(
            WagerTransactionEntity,
            {
                referenceTransactionId: bet.body.transactionId,
                status: WagerTransactionStatus.PROCESSED,
            },
        );

        expect(compensations).toHaveLength(1);

        const refundLedger = await orm.em.fork().find(
            WalletLedgerEntryEntity,
            { transactionId: compensations[0]!.id },
        );

        expect(refundLedger).toHaveLength(1);

        const refundOutbox = await orm.em.fork().find(
            OutboxEventEntity,
            { aggregateId: compensations[0]!.id },
        );

        expect(refundOutbox).toHaveLength(1);
    });


    it('processes the same pending REFUND only once under concurrent workers', async () => {
        const testPlayerId = randomUUID();
        const testProviderId = `provider-${randomUUID()}`;
        const originalId = `bet-${randomUUID()}`;
        const refundId = `refund-${randomUUID()}`;

        const walletResponse = await request(app.getHttpServer())
            .post('/wallets')
            .send({
                playerId: testPlayerId,
                currency: 'BRL',
                initialBalance: '100.00',
            });

        expect(walletResponse.status).toBe(201);

        const wallet = await orm.em.fork().findOneOrFail(
            WalletEntity,
            {
                playerId: testPlayerId,
                currency: 'BRL',
            },
        );

        const payload = (
            kind: 'BET' | 'REFUND',
            externalTransactionId: string,
            referenceExternalTransactionId?: string,
        ) => ({
            providerId: testProviderId,
            externalTransactionId,
            walletId: wallet.id,
            playerId: testPlayerId,
            roundId: 'concurrent-pending-round',
            gameId: 'concurrent-pending-game',
            kind,
            amount: '25.00',
            currency: 'BRL',
            ...(referenceExternalTransactionId
                ? { referenceExternalTransactionId }
                : {}),
        });

        const pendingResponse = await request(app.getHttpServer())
            .post('/wagering/transactions')
            .set('Idempotency-Key', refundId)
            .send(
                payload('REFUND', refundId, originalId),
            );

        expect(pendingResponse.status).toBe(201);
        expect(pendingResponse.body.status).toBe(
            'PENDING_REFERENCE',
        );

        const pendingId = pendingResponse.body.transactionId;

        const betResponse = await request(app.getHttpServer())
            .post('/wagering/transactions')
            .set('Idempotency-Key', originalId)
            .send(payload('BET', originalId));

        expect(betResponse.status).toBe(201);
        expect(betResponse.body.status).toBe('PROCESSED');

        const processor = app.get(
            PendingReferenceProcessorService,
        );

        await Promise.all([
            processor.processPending(),
            processor.processPending(),
        ]);

        const transaction = await orm.em.fork().findOneOrFail(
            WagerTransactionEntity,
            { id: pendingId },
        );

        expect(transaction.status).toBe('PROCESSED');
        expect(transaction.referenceTransactionId).toBe(
            betResponse.body.transactionId,
        );

        const updatedWallet = await orm.em.fork().findOneOrFail(
            WalletEntity,
            { id: wallet.id },
        );

        expect(updatedWallet.balance).toBe('100.00');
        expect(updatedWallet.version).toBe(3);

        const ledger = await orm.em.fork().find(
            WalletLedgerEntryEntity,
            { transactionId: pendingId },
        );

        expect(ledger).toHaveLength(1);
        expect(ledger[0]!.amount).toBe('25.00');

        const events = await orm.em.fork().find(
            OutboxEventEntity,
            { aggregateId: pendingId },
        );

        expect(events).toHaveLength(1);

        await processor.processPending();

        const finalWallet = await orm.em.fork().findOneOrFail(
            WalletEntity,
            { id: wallet.id },
        );

        expect(finalWallet.balance).toBe('100.00');
        expect(finalWallet.version).toBe(3);
    });


    it.each([
        {
            scenario: 'rejected original BET',
            originalKind: 'BET',
            originalAmount: '999.00',
            refundAmount: '999.00',
            expectedFailureCode: 'REFERENCE_NOT_PROCESSABLE',
        },
        {
            scenario: 'different compensation amount',
            originalKind: 'BET',
            originalAmount: '20.00',
            refundAmount: '30.00',
            expectedFailureCode: 'REFERENCE_AMOUNT_MISMATCH',
        },
        {
            scenario: 'REFUND referencing a WIN',
            originalKind: 'WIN',
            originalAmount: '20.00',
            refundAmount: '20.00',
            expectedFailureCode: 'REFERENCE_KIND_MISMATCH',
        },
    ] as const)(
        'rejects pending REFUND with $scenario',
        async ({
            originalKind,
            originalAmount,
            refundAmount,
            expectedFailureCode,
        }) => {
            const testPlayerId = randomUUID();
            const testProviderId = `provider-${randomUUID()}`;
            const originalId = `original-${randomUUID()}`;
            const refundId = `refund-${randomUUID()}`;

            const walletResponse = await request(app.getHttpServer())
                .post('/wallets')
                .send({
                    playerId: testPlayerId,
                    currency: 'BRL',
                    initialBalance: '100.00',
                });

            expect(walletResponse.status).toBe(201);

            const wallet = await orm.em.fork().findOneOrFail(
                WalletEntity,
                {
                    playerId: testPlayerId,
                    currency: 'BRL',
                },
            );

            const basePayload = {
                providerId: testProviderId,
                walletId: wallet.id,
                playerId: testPlayerId,
                roundId: `round-${randomUUID()}`,
                gameId: 'reference-validation-game',
                currency: 'BRL',
            };

            const pendingResponse = await request(app.getHttpServer())
                .post('/wagering/transactions')
                .set('Idempotency-Key', refundId)
                .send({
                    ...basePayload,
                    externalTransactionId: refundId,
                    kind: 'REFUND',
                    amount: refundAmount,
                    referenceExternalTransactionId: originalId,
                });

            expect(pendingResponse.status).toBe(201);
            expect(pendingResponse.body.status).toBe(
                'PENDING_REFERENCE',
            );

            const pendingId = pendingResponse.body.transactionId;

            const originalResponse = await request(app.getHttpServer())
                .post('/wagering/transactions')
                .set('Idempotency-Key', originalId)
                .send({
                    ...basePayload,
                    externalTransactionId: originalId,
                    kind: originalKind,
                    amount: originalAmount,
                });

            if (originalAmount === '999.00') {
                expect(originalResponse.status).toBe(422);
                expect(originalResponse.body.status).toBe('REJECTED');
            } else {
                expect(originalResponse.status).toBe(201);
                expect(originalResponse.body.status).toBe('PROCESSED');
            }

            const before = await orm.em.fork().findOneOrFail(
                WalletEntity,
                { id: wallet.id },
            );

            const balanceBefore = before.balance;
            const versionBefore = before.version;

            const processor = app.get(
                PendingReferenceProcessorService,
            );

            await processor.processPending();

            const rejected = await orm.em.fork().findOneOrFail(
                WagerTransactionEntity,
                { id: pendingId },
            );

            expect(rejected.status).toBe(
                WagerTransactionStatus.REJECTED,
            );

            expect(rejected.failureCode).toBe(
                expectedFailureCode,
            );

            expect(rejected.referenceTransactionId).toBe(
                originalResponse.body.transactionId,
            );

            expect(rejected.processedAt).toBeInstanceOf(Date);

            const after = await orm.em.fork().findOneOrFail(
                WalletEntity,
                { id: wallet.id },
            );

            expect(after.balance).toBe(balanceBefore);
            expect(after.version).toBe(versionBefore);

            const ledger = await orm.em.fork().find(
                WalletLedgerEntryEntity,
                { transactionId: pendingId },
            );

            expect(ledger).toHaveLength(0);

            const outbox = await orm.em.fork().find(
                OutboxEventEntity,
                { aggregateId: pendingId },
            );

            expect(outbox).toHaveLength(0);

            const replay = await request(app.getHttpServer())
                .post('/wagering/transactions')
                .set('Idempotency-Key', refundId)
                .send({
                    ...basePayload,
                    externalTransactionId: refundId,
                    kind: 'REFUND',
                    amount: refundAmount,
                    referenceExternalTransactionId: originalId,
                });

            expect(replay.status).toBe(422);
            expect(replay.body.transactionId).toBe(pendingId);
            expect(replay.body.status).toBe('REJECTED');
            expect(replay.body.failureCode).toBe(
                expectedFailureCode,
            );
            expect(replay.body.replayed).toBe(true);

            await processor.processPending();

            const finalWallet = await orm.em.fork().findOneOrFail(
                WalletEntity,
                { id: wallet.id },
            );

            expect(finalWallet.balance).toBe(balanceBefore);
            expect(finalWallet.version).toBe(versionBefore);
        },
    );


    describe('ROLLBACK of REFUND (E2E)', () => {
        const createScenario = async (
            initialBalance = '100.00',
            amount = '30.00',
        ) => {
            const scenarioPlayerId = randomUUID();
            const scenarioProviderId = `provider-${randomUUID()}`;
            const scenarioRoundId = `round-${randomUUID()}`;
            const scenarioGameId = 'rollback-refund-game';

            const walletResponse = await request(app.getHttpServer())
                .post('/wallets')
                .send({
                    playerId: scenarioPlayerId,
                    currency: 'BRL',
                    initialBalance,
                });

            expect(walletResponse.status).toBe(201);

            const wallet = await orm.em.fork().findOneOrFail(
                WalletEntity,
                {
                    playerId: scenarioPlayerId,
                    currency: 'BRL',
                },
            );

            const payload = (
                kind: 'BET' | 'WIN' | 'REFUND' | 'ROLLBACK',
                externalTransactionId: string,
                referenceExternalTransactionId?: string,
                transactionAmount = amount,
            ) => ({
                providerId: scenarioProviderId,
                externalTransactionId,
                walletId: wallet.id,
                playerId: scenarioPlayerId,
                roundId: scenarioRoundId,
                gameId: scenarioGameId,
                kind,
                amount: transactionAmount,
                currency: 'BRL',
                ...(referenceExternalTransactionId
                    ? { referenceExternalTransactionId }
                    : {}),
            });

            const send = (
                kind: 'BET' | 'WIN' | 'REFUND' | 'ROLLBACK',
                externalTransactionId: string,
                referenceExternalTransactionId?: string,
                transactionAmount = amount,
            ) =>
                request(app.getHttpServer())
                    .post('/wagering/transactions')
                    .set('Idempotency-Key', externalTransactionId)
                    .send(
                        payload(
                            kind,
                            externalTransactionId,
                            referenceExternalTransactionId,
                            transactionAmount,
                        ),
                    );

            const betId = `bet-${randomUUID()}`;
            const refundId = `refund-${randomUUID()}`;

            const bet = await send('BET', betId);
            expect(bet.status).toBe(201);
            expect(bet.body.status).toBe('PROCESSED');

            const refund = await send('REFUND', refundId, betId);
            expect(refund.status).toBe(201);
            expect(refund.body.status).toBe('PROCESSED');

            return {
                walletId: wallet.id,
                providerId: scenarioProviderId,
                betId,
                refundId,
                bet,
                refund,
                send,
                payload,
            };
        };

        it('reverses a REFUND and persists one debit, ledger entry and outbox event', async () => {
            const scenario = await createScenario();

            const before = await orm.em.fork().findOneOrFail(
                WalletEntity,
                { id: scenario.walletId },
            );

            expect(before.balance).toBe('100.00');
            expect(before.version).toBe(3);

            const rollbackId = `rollback-${randomUUID()}`;

            const response = await scenario.send(
                'ROLLBACK',
                rollbackId,
                scenario.refundId,
            );

            expect(response.status).toBe(201);
            expect(response.body.status).toBe('PROCESSED');
            expect(response.body.balance).toBe('70.00');
            expect(response.body.replayed).toBe(false);

            const after = await orm.em.fork().findOneOrFail(
                WalletEntity,
                { id: scenario.walletId },
            );

            expect(after.balance).toBe('70.00');
            expect(after.version).toBe(4);

            const transaction = await orm.em.fork().findOneOrFail(
                WagerTransactionEntity,
                { id: response.body.transactionId },
            );

            expect(transaction.referenceTransactionId).toBe(
                scenario.refund.body.transactionId,
            );

            const ledger = await orm.em.fork().find(
                WalletLedgerEntryEntity,
                { transactionId: transaction.id },
            );

            expect(ledger).toHaveLength(1);
            expect(ledger[0]!.direction).toBe('DEBIT');
            expect(ledger[0]!.amount).toBe('30.00');
            expect(ledger[0]!.balanceBefore).toBe('100.00');
            expect(ledger[0]!.balanceAfter).toBe('70.00');

            const outbox = await orm.em.fork().find(
                OutboxEventEntity,
                { aggregateId: transaction.id },
            );

            expect(outbox).toHaveLength(1);
            expect(outbox[0]!.eventType).toBe(
                'wager.transaction.processed',
            );
        });

        it('rejects ROLLBACK of REFUND when funds are insufficient', async () => {
            const scenario = await createScenario();

            const extraBetId = `bet-${randomUUID()}`;

            const extraBet = await scenario.send(
                'BET',
                extraBetId,
                undefined,
                '80.00',
            );

            expect(extraBet.status).toBe(201);
            expect(extraBet.body.balance).toBe('20.00');

            const before = await orm.em.fork().findOneOrFail(
                WalletEntity,
                { id: scenario.walletId },
            );

            const rollbackId = `rollback-${randomUUID()}`;

            const response = await scenario.send(
                'ROLLBACK',
                rollbackId,
                scenario.refundId,
            );

            expect(response.status).toBe(422);
            expect(response.body.status).toBe('REJECTED');
            expect(response.body.failureCode).toBe(
                'INSUFFICIENT_FUNDS',
            );

            const after = await orm.em.fork().findOneOrFail(
                WalletEntity,
                { id: scenario.walletId },
            );

            expect(after.balance).toBe('20.00');
            expect(after.version).toBe(before.version);

            const ledger = await orm.em.fork().find(
                WalletLedgerEntryEntity,
                { transactionId: response.body.transactionId },
            );

            expect(ledger).toHaveLength(0);

            const outbox = await orm.em.fork().find(
                OutboxEventEntity,
                { aggregateId: response.body.transactionId },
            );

            expect(outbox).toHaveLength(0);
        });

        it('replays the same ROLLBACK without debiting twice', async () => {
            const scenario = await createScenario();

            const rollbackId = `rollback-${randomUUID()}`;

            const first = await scenario.send(
                'ROLLBACK',
                rollbackId,
                scenario.refundId,
            );

            expect(first.status).toBe(201);
            expect(first.body.status).toBe('PROCESSED');

            const replay = await scenario.send(
                'ROLLBACK',
                rollbackId,
                scenario.refundId,
            );

            expect(replay.status).toBe(201);
            expect(replay.body.replayed).toBe(true);
            expect(replay.body.transactionId).toBe(
                first.body.transactionId,
            );
            expect(replay.body.balance).toBe('70.00');

            const wallet = await orm.em.fork().findOneOrFail(
                WalletEntity,
                { id: scenario.walletId },
            );

            expect(wallet.balance).toBe('70.00');
            expect(wallet.version).toBe(4);

            const ledger = await orm.em.fork().find(
                WalletLedgerEntryEntity,
                { transactionId: first.body.transactionId },
            );

            expect(ledger).toHaveLength(1);

            const outbox = await orm.em.fork().find(
                OutboxEventEntity,
                { aggregateId: first.body.transactionId },
            );

            expect(outbox).toHaveLength(1);
        });

        it('prevents two concurrent ROLLBACKs of the same REFUND', async () => {
            const scenario = await createScenario();

            const firstRollbackId = `rollback-${randomUUID()}`;
            const secondRollbackId = `rollback-${randomUUID()}`;

            const [first, second] = await Promise.all([
                scenario.send(
                    'ROLLBACK',
                    firstRollbackId,
                    scenario.refundId,
                ),
                scenario.send(
                    'ROLLBACK',
                    secondRollbackId,
                    scenario.refundId,
                ),
            ]);

            expect([first.status, second.status].sort((a, b) => a - b)).toEqual([
                201,
                409,
            ]);

            const wallet = await orm.em.fork().findOneOrFail(
                WalletEntity,
                { id: scenario.walletId },
            );

            expect(wallet.balance).toBe('70.00');
            expect(wallet.version).toBe(4);

            const compensations = await orm.em.fork().find(
                WagerTransactionEntity,
                {
                    referenceTransactionId:
                        scenario.refund.body.transactionId,
                    status: WagerTransactionStatus.PROCESSED,
                },
            );

            expect(compensations).toHaveLength(1);

            const rollbackId = compensations[0]!.id;

            const ledger = await orm.em.fork().find(
                WalletLedgerEntryEntity,
                { transactionId: rollbackId },
            );

            expect(ledger).toHaveLength(1);

            const outbox = await orm.em.fork().find(
                OutboxEventEntity,
                { aggregateId: rollbackId },
            );

            expect(outbox).toHaveLength(1);
        });
    });

});
