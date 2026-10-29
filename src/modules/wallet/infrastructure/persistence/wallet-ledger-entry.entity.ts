
import {
    Entity,
    PrimaryKey,
    Property,
    Unique,
    Index,
} from '@mikro-orm/decorators/legacy';
import { randomUUID } from 'node:crypto';

export enum LedgerDirection {
    DEBIT = 'DEBIT',
    CREDIT = 'CREDIT',
}

@Entity({ tableName: 'wallet_ledger_entries' })
export class WalletLedgerEntryEntity {
    @PrimaryKey({ type: 'uuid' })
    id: string = randomUUID();

    @Index()
    @Property({ type: 'uuid' })
    walletId!: string;

    @Unique()
    @Property({ type: 'uuid' })
    transactionId!: string;

    @Property({ type: 'string' })
    direction!: LedgerDirection;

    @Property({
        type: 'decimal',
        precision: 18,
        scale: 2,
    })
    amount!: string;

    @Property({ type: 'string', length: 3 })
    currency: string = 'BRL';

    @Property({
        type: 'decimal',
        precision: 18,
        scale: 2,
    })
    balanceBefore!: string;

    @Property({
        type: 'decimal',
        precision: 18,
        scale: 2,
    })
    balanceAfter!: string;

    @Property({
        type: 'datetime',
        onCreate: () => new Date(),
    })
    createdAt: Date = new Date();
}
