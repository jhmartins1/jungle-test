
import { Migration } from '@mikro-orm/migrations';

export class Migration20261028184348 extends Migration {
  override name = 'Migration20261028184348';

  override up(): void {
    this.addSql(`
      CREATE TABLE "outbox_events" (
        "id" uuid NOT NULL,
        "event_type" varchar(100) NOT NULL,
        "aggregate_id" uuid NOT NULL,
        "payload" jsonb NOT NULL,
        "status" text NOT NULL DEFAULT 'PENDING',
        "attempts" int NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL,
        "published_at" timestamptz NULL,
        CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "outbox_events_status_check"
          CHECK ("status" IN ('PENDING', 'PUBLISHED'))
      );
    `);

    this.addSql(`
      CREATE INDEX "outbox_events_status_created_at_index"
      ON "outbox_events" ("status", "created_at");
    `);
  }

  override down(): void {
    this.addSql(`
      DROP TABLE IF EXISTS "outbox_events";
    `);
  }
}
