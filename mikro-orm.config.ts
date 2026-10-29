
import 'dotenv/config';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

import { WalletEntity } from './src/modules/wallet/infrastructure/persistence/wallet.entity.js';
import { WalletLedgerEntryEntity } from './src/modules/wallet/infrastructure/persistence/wallet-ledger-entry.entity.js';
import { WagerTransactionEntity } from './src/modules/wagering/infrastructure/persistence/wager-transaction.entity.js';
import { OutboxEventEntity } from './src/modules/outbox/infrastructure/persistence/outbox-event.entity.js';

export default defineConfig({
    clientUrl: process.env.DATABASE_URL,
    entities: [
        WalletEntity,
        WalletLedgerEntryEntity,
        WagerTransactionEntity,
        OutboxEventEntity,
    ],
    extensions: [Migrator],
    migrations: {
        path: './dist/migrations',
        pathTs: './src/migrations',
    },
});
