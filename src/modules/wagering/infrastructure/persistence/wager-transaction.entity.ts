
import {
    Entity,
    PrimaryKey,
    Property,
    Unique,
    Index,
} from '@mikro-orm/decorators/legacy';
import { randomUUID } from 'node:crypto';

export enum WagerTransactionKind {
    OPENING = 'OPENING',
    BET = 'BET',
    WIN = 'WIN',
    LOSS = 'LOSS',
    REFUND = 'REFUND',
    ROLLBACK = 'ROLLBACK',
}

export enum WagerTransactionStatus {
    PENDING = 'PENDING',
    PENDING_REFERENCE = 'PENDING_REFERENCE',
    PROCESSED = 'PROCESSED',
    REJECTED = 'REJECTED',
    FAILED = 'FAILED',
}

@Entity({ tableName: 'wager_transactions' })
@Unique({
    properties: ['providerId', 'externalTransactionId'],
})
@Unique({
    properties: ['providerId', 'idempotencyKey'],
})
export class WagerTransactionEntity {
    @PrimaryKey({ type: 'uuid' })
    id: string = randomUUID();

    @Property({ type: 'string' })
    providerId!: string;

    @Property({ type: 'string' })
    externalTransactionId!: string;

    @Property({ type: 'string' })
    idempotencyKey!: string;

    @Property({ type: 'string' })
    payloadHash!: string;

    @Index()
    @Property({ type: 'uuid' })
    walletId!: string;

    @Property({ type: 'uuid' })
    playerId!: string;

    @Property({ type: 'string' })
    roundId!: string;

    @Property({ type: 'string' })
    gameId!: string;

    @Property({ type: 'string' })
    kind!: WagerTransactionKind;

    @Property({ type: 'string' })
    status: WagerTransactionStatus =
        WagerTransactionStatus.PENDING;

    @Property({
        type: 'decimal',
        precision: 18,
        scale: 2,
    })
    amount!: string;

    @Property({ type: 'string', length: 3 })
    currency: string = 'BRL';

    @Property({ type: 'string', nullable: true })
    referenceExternalTransactionId?: string;

    @Property({ type: 'uuid', nullable: true })
    referenceTransactionId?: string;

    @Property({ type: 'string', nullable: true })
    failureCode?: string;

    @Property({ type: 'datetime', nullable: true })
    processedAt?: Date;

    @Property({ type: 'datetime', onCreate: () => new Date() })
    createdAt: Date = new Date();
}
