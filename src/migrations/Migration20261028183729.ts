
import { Migration } from '@mikro-orm/migrations';

export class Migration20261028183729 extends Migration {
  override name = 'Migration20261028183729';

  override up(): void {
    this.addSql(`
      CREATE UNIQUE INDEX "uq_wager_processed_compensation"
      ON "wager_transactions" ("reference_transaction_id")
      WHERE "reference_transaction_id" IS NOT NULL
        AND "status" = 'PROCESSED'
        AND "kind" IN ('REFUND', 'ROLLBACK');
    `);
  }

  override down(): void {
    this.addSql(`
      DROP INDEX IF EXISTS "uq_wager_processed_compensation";
    `);
  }
}
