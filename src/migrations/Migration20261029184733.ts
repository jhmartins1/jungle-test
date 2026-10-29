
import { Migration } from '@mikro-orm/migrations';

export class Migration20261029184733 extends Migration {
  override name = 'Migration20261029184733';

  override up(): void {
    this.addSql(`
      ALTER TABLE "wager_transactions"
      ADD COLUMN "retry_attempts" integer NOT NULL DEFAULT 0;
    `);

    this.addSql(`
      ALTER TABLE "wager_transactions"
      ADD COLUMN "next_retry_at" timestamptz NULL;
    `);

    this.addSql(`
      ALTER TABLE "wager_transactions"
      ADD COLUMN "last_retry_at" timestamptz NULL;
    `);

    this.addSql(`
      CREATE INDEX "wager_transactions_next_retry_at_index"
      ON "wager_transactions" ("next_retry_at");
    `);
  }

  override down(): void {
    this.addSql(`
      DROP INDEX "wager_transactions_next_retry_at_index";
    `);

    this.addSql(`
      ALTER TABLE "wager_transactions"
      DROP COLUMN "retry_attempts",
      DROP COLUMN "next_retry_at",
      DROP COLUMN "last_retry_at";
    `);
  }
}
