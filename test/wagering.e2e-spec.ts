
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
import { WagerTransactionEntity } from '../src/modules/wagering/infrastructure/persistence/wager-transaction.entity.js';
import { OutboxEventEntity } from '../src/modules/outbox/infrastructure/persistence/outbox-event.entity.js';

describe('Wagering API (E2E)', () => {
    let app: INestApplication;
    let orm: MikroORM;

    const playerId = randomUUID();
    const providerId = `provider-e2e-${randomUUID()}`;
    const roundId = `round-${randomUUID()}`;
    const gameId = 'game-e2e';

    let walletId: string;

    const makeTransaction = (
        kind: 'BET' | 'WIN' | 'REFUND' | 'ROLLBACK',
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
                makeTransaction('BET', '999.00', 'e2e-insufficient-001'),
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

        const statuses = [first.status, second.status].sort();

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

});
