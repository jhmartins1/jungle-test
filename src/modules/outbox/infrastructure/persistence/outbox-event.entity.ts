
import { randomUUID } from 'node:crypto';
import {
    Entity,
    Enum,
    Index,
    PrimaryKey,
    Property,
} from '@mikro-orm/decorators/legacy';

export enum OutboxEventStatus {
    PENDING = 'PENDING',
    PUBLISHED = 'PUBLISHED',
}

@Entity({ tableName: 'outbox_events' })
@Index({ properties: ['status', 'createdAt'] })
export class OutboxEventEntity {
    @PrimaryKey({ type: 'uuid' })
    id: string = randomUUID();

    @Property({ type: 'string', length: 100 })
    eventType!: string;

    @Property({ type: 'uuid' })
    aggregateId!: string;

    @Property({ type: 'json' })
    payload!: Record<string, unknown>;

    @Enum({
        items: () => OutboxEventStatus,
        nativeEnumName: undefined,
    })
    status: OutboxEventStatus = OutboxEventStatus.PENDING;

    @Property({ type: 'int', default: 0 })
    attempts = 0;

    @Property({ type: 'datetime' })
    createdAt: Date = new Date();

    @Property({ type: 'datetime', nullable: true })
    publishedAt?: Date;
}
