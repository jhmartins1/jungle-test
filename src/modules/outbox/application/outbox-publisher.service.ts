
import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { LockMode } from '@mikro-orm/core';

import {
    OutboxEventEntity,
    OutboxEventStatus,
} from '../infrastructure/persistence/outbox-event.entity.js';
import { SqsPublisherService } from '../infrastructure/sqs-publisher.service.js';

@Injectable()
export class OutboxPublisherService
    implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(OutboxPublisherService.name);

    private timer?: ReturnType<typeof setInterval>;
    private processing = false;

    constructor(
        private readonly orm: MikroORM,
        private readonly sqsPublisher: SqsPublisherService,
    ) { }

    onModuleInit() {
        if (process.env.NODE_ENV === 'test') {
            this.logger.log('Outbox publisher disabled in test environment');
            return;
        }

        this.timer = setInterval(() => {
            void this.publishPending();
        }, 3000);

        this.logger.log('Outbox publisher started');
    }

    onModuleDestroy() {
        if (this.timer) {
            clearInterval(this.timer);
        }
    }

    async publishPending() {
        if (this.processing) return;

        this.processing = true;

        try {
            const em = this.orm.em.fork();

            const events = await em.find(
                OutboxEventEntity,
                { status: OutboxEventStatus.PENDING },
                {
                    orderBy: { createdAt: 'ASC' },
                    limit: 10,
                },
            );

            for (const event of events) {
                try {
                    await this.orm.em.transactional(async (tx) => {
                        const locked = await tx.findOne(
                            OutboxEventEntity,
                            { id: event.id },
                            { lockMode: LockMode.PESSIMISTIC_WRITE },
                        );

                        if (
                            !locked ||
                            locked.status !== OutboxEventStatus.PENDING
                        ) {
                            return;
                        }

                        await this.sqsPublisher.publish({
                            eventId: locked.id,
                            eventType: locked.eventType,
                            aggregateId: locked.aggregateId,
                            payload: locked.payload,
                            occurredAt: locked.createdAt.toISOString(),
                        });

                        locked.status = OutboxEventStatus.PUBLISHED;
                        locked.publishedAt = new Date();
                        locked.attempts += 1;

                        await tx.flush();

                        this.logger.log(`Published outbox event ${locked.id}`);
                    });
                } catch (error) {
                    this.logger.error(
                        `Failed to publish event ${event.id}`,
                        error instanceof Error ? error.stack : String(error),
                    );

                    await this.orm.em.transactional(async (tx) => {
                        const pending = await tx.findOne(
                            OutboxEventEntity,
                            { id: event.id },
                            { lockMode: LockMode.PESSIMISTIC_WRITE },
                        );

                        if (pending?.status === OutboxEventStatus.PENDING) {
                            pending.attempts += 1;
                            await tx.flush();
                        }
                    });
                }
            }
        } finally {
            this.processing = false;
        }
    }
}
