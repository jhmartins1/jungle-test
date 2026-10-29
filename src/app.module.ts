
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

import { WalletModule } from './modules/wallet/wallet.module.js';

import { WalletEntity } from './modules/wallet/infrastructure/persistence/wallet.entity.js';
import { WalletLedgerEntryEntity } from './modules/wallet/infrastructure/persistence/wallet-ledger-entry.entity.js';
import { WagerTransactionEntity } from './modules/wagering/infrastructure/persistence/wager-transaction.entity.js';
import { WageringModule } from './modules/wagering/wagering.module.js';
import { OutboxEventEntity } from './modules/outbox/infrastructure/persistence/outbox-event.entity.js';
import { OutboxModule } from './modules/outbox/outbox.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    MikroOrmModule.forRoot(
      defineConfig({
        clientUrl: process.env.DATABASE_URL,
        entities: [
          WalletEntity,
          WalletLedgerEntryEntity,
          WagerTransactionEntity,
          OutboxEventEntity,
        ],
        extensions: [Migrator],
      }),
    ),
    WageringModule,
    WalletModule,
    OutboxModule,
  ],
})
export class AppModule { }
