
import { config } from 'dotenv';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

import { WalletEntity } from './src/modules/wallet/infrastructure/persistence/wallet.entity.js';
import { WalletLedgerEntryEntity } from './src/modules/wallet/infrastructure/persistence/wallet-ledger-entry.entity.js';
import { WagerTransactionEntity } from './src/modules/wagering/infrastructure/persistence/wager-transaction.entity.js';
import { OutboxEventEntity } from './src/modules/outbox/infrastructure/persistence/outbox-event.entity.js';

const envFile =
    process.env.NODE_ENV === 'test'
        ? '.env.test'
        : '.env';

config({
    path: envFile,
    override: false,
});

if (!process.env.DATABASE_URL) {
    throw new Error(
        `DATABASE_URL is required. Check ${envFile}`,
    );
}

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
