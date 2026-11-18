ALTER TABLE "executions" ADD COLUMN "seed" bigint;
--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "config_snapshot" jsonb;
