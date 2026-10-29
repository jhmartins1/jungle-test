
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { OutboxPublisherService } from '../src/modules/outbox/application/outbox-publisher.service.js';
import { SqsPublisherService } from '../src/modules/outbox/infrastructure/sqs-publisher.service.js';
import {
    OutboxEventEntity,
    OutboxEventStatus,
} from '../src/modules/outbox/infrastructure/persistence/outbox-event.entity.js';

describe('Transactional Outbox (E2E)', () => {
    let moduleRef: TestingModule;
    let orm: MikroORM;
    let publisher: OutboxPublisherService;

    const sendMock = vi.fn<(...args: unknown[]) => Promise<void>>();
    const createdEventIds: string[] = [];

    async function createPendingEvent() {
        const em = orm.em.fork();

        const event = em.create(OutboxEventEntity, {
            eventType: 'wager.transaction.processed',
            aggregateId: randomUUID(),
            payload: {
                transactionId: randomUUID(),
                kind: 'BET',
                amount: '10.00',
                currency: 'BRL',
            },
            status: OutboxEventStatus.PENDING,
            attempts: 0,
            createdAt: new Date(),
        });

        em.persist(event);
        await em.flush();

        createdEventIds.push(event.id);

        return event.id;
    }

    async function findEvent(id: string) {
        return orm.em.fork().findOneOrFail(OutboxEventEntity, { id });
    }

    beforeAll(async () => {
        if (
            process.env.NODE_ENV !== 'test' ||
            !process.env.DATABASE_URL?.includes('/jungle_test_db')
        ) {
            throw new Error('Outbox tests require jungle_test_db');
        }

        moduleRef = await Test.createTestingModule({
            imports: [AppModule],
        })
            .overrideProvider(SqsPublisherService)
            .useValue({ publish: sendMock })
            .compile();

        await moduleRef.init();

        orm = moduleRef.get(MikroORM);
        publisher = moduleRef.get(OutboxPublisherService);

        // Process previously pending test events with the mocked SQS.
        // This prevents old records from filling the publisher's batch.
        sendMock.mockResolvedValue(undefined);

        for (let i = 0; i < 100; i++) {
            const pendingCount = await orm.em.fork().count(
                OutboxEventEntity,
                { status: OutboxEventStatus.PENDING },
            );

            if (pendingCount === 0) break;

            await publisher.publishPending();
        }

        sendMock.mockClear();
    });

    afterAll(async () => {
        // Remove only events created by this test suite.
        if (orm && createdEventIds.length > 0) {
            await orm.em.fork().nativeDelete(
                OutboxEventEntity,
                { id: { $in: createdEventIds } },
            );
        }

        await moduleRef?.close();
    });

    it('stores an event as PENDING', async () => {
        const id = await createPendingEvent();
        const saved = await findEvent(id);

        expect(saved.status).toBe(OutboxEventStatus.PENDING);
        expect(saved.attempts).toBe(0);
        expect(saved.publishedAt).toBeNull();
    });

    it('publishes a pending event successfully', async () => {
        sendMock.mockResolvedValue(undefined);

        await publisher.publishPending();

        const id = await createPendingEvent();

        await publisher.publishPending();

        const saved = await findEvent(id);

        expect(saved.status).toBe(OutboxEventStatus.PUBLISHED);
        expect(saved.attempts).toBe(1);
        expect(saved.publishedAt).not.toBeNull();

        expect(sendMock).toHaveBeenCalled();
    });

    it('keeps an event PENDING when SQS fails', async () => {
        sendMock.mockRejectedValue(new Error('SQS unavailable'));

        const id = await createPendingEvent();

        await publisher.publishPending();

        const saved = await findEvent(id);

        expect(saved.status).toBe(OutboxEventStatus.PENDING);
        expect(saved.attempts).toBe(1);
        expect(saved.publishedAt).toBeNull();
    });

    it('recovers and publishes an event after SQS returns', async () => {
        sendMock.mockResolvedValue(undefined);

        const pendingEventId = createdEventIds.at(-1);

        expect(pendingEventId).toBeDefined();

        await publisher.publishPending();

        const saved = await findEvent(pendingEventId!);

        expect(saved.status).toBe(OutboxEventStatus.PUBLISHED);
        expect(saved.attempts).toBe(2);
        expect(saved.publishedAt).not.toBeNull();
    });
});
