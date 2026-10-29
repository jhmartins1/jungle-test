
import { Migration } from '@mikro-orm/migrations';

export class Migration20261027200653_financial_tables extends Migration {
  override name = 'Migration20261027200653_financial_tables';

  override up(): void {
    this.addSql(`
      create table "wager_transactions" (
        "id" uuid not null,
        "provider_id" varchar(255) not null,
        "external_transaction_id" varchar(255) not null,
        "idempotency_key" varchar(255) not null,
        "payload_hash" varchar(255) not null,
        "wallet_id" uuid not null,
        "player_id" uuid not null,
        "round_id" varchar(255) not null,
        "game_id" varchar(255) not null,
        "kind" varchar(255) not null,
        "status" varchar(255) not null default 'PENDING',
        "amount" numeric(18,2) not null,
        "currency" varchar(3) not null default 'BRL',
        "reference_external_transaction_id" varchar(255) null,
        "reference_transaction_id" uuid null,
        "failure_code" varchar(255) null,
        "processed_at" timestamptz null,
        "created_at" timestamptz not null,
        primary key ("id")
      );
    `);

    this.addSql(`
      create index "wager_transactions_wallet_id_index"
      on "wager_transactions" ("wallet_id");
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_provider_id_idempotency_key_unique"
      unique ("provider_id", "idempotency_key");
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_provider_id_external_transaction_id_unique"
      unique ("provider_id", "external_transaction_id");
    `);

    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "transaction_id" uuid not null,
        "direction" varchar(255) not null,
        "amount" numeric(18,2) not null,
        "currency" varchar(3) not null default 'BRL',
        "balance_before" numeric(18,2) not null,
        "balance_after" numeric(18,2) not null,
        "created_at" timestamptz not null,
        primary key ("id")
      );
    `);

    this.addSql(`
      create index "wallet_ledger_entries_wallet_id_index"
      on "wallet_ledger_entries" ("wallet_id");
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "wallet_ledger_entries_transaction_id_unique"
      unique ("transaction_id");
    `);

    this.addSql(`
      alter table "wallets"
      drop constraint "wallets_player_id_unique";
    `);

    this.addSql(`
      alter table "wallets"
      add "currency" varchar(3) not null default 'BRL',
      add "version" int not null default 1;
    `);

    this.addSql(`
      alter table "wallets"
      add constraint "wallets_player_id_currency_unique"
      unique ("player_id", "currency");
    `);

    this.addSql(`
      alter table "wallets"
      add constraint "wallets_balance_non_negative"
      check ("balance" >= 0);
    `);

    this.addSql(`
      alter table "wallets"
      add constraint "wallets_version_positive"
      check ("version" >= 1);
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_amount_non_negative"
      check ("amount" >= 0);
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "ledger_amount_positive"
      check ("amount" > 0);
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "ledger_balance_before_non_negative"
      check ("balance_before" >= 0);
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "ledger_balance_after_non_negative"
      check ("balance_after" >= 0);
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "ledger_balance_consistency"
      check (
        (
          "direction" = 'CREDIT'
          and "balance_after" = "balance_before" + "amount"
        )
        or
        (
          "direction" = 'DEBIT'
          and "balance_after" = "balance_before" - "amount"
        )
      );
    `);
    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_wallet_fk"
      foreign key ("wallet_id")
      references "wallets" ("id");
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "ledger_wallet_fk"
      foreign key ("wallet_id")
      references "wallets" ("id");
    `);

    this.addSql(`
      alter table "wallet_ledger_entries"
      add constraint "ledger_transaction_fk"
      foreign key ("transaction_id")
      references "wager_transactions" ("id");
    `);

    this.addSql(`
      create index "wager_transactions_player_id_index"
      on "wager_transactions" ("player_id");
    `);

    this.addSql(`
      create index "wallet_ledger_entries_created_at_index"
      on "wallet_ledger_entries" ("created_at");
    `);
  }

  override down(): void {
    this.addSql(`
      drop index if exists "wallet_ledger_entries_created_at_index";
    `);

    this.addSql(`
      drop index if exists "wager_transactions_player_id_index";
    `);
    this.addSql(`
      drop table if exists "wallet_ledger_entries";
    `);

    this.addSql(`
      drop table if exists "wager_transactions";
    `);

    this.addSql(`
      alter table "wallets"
      drop constraint if exists "wallets_balance_non_negative";
    `);

    this.addSql(`
      alter table "wallets"
      drop constraint if exists "wallets_version_positive";
    `);

    this.addSql(`
      alter table "wallets"
      drop constraint if exists "wallets_player_id_currency_unique";
    `);
    this.addSql(`
      alter table "wallets"
      drop column "currency",
      drop column "version";
    `);

    this.addSql(`
      alter table "wallets"
      add constraint "wallets_player_id_unique"
      unique ("player_id");
    `);
  }
}
