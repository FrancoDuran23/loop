-- Hand-added: drizzle-kit has no concept of Postgres extensions and never
-- generates this statement on its own. Required before the `vector(384)`
-- column below and the `ivfflat`/`vector_cosine_ops` index can be created.
-- Kept as a single idempotent statement so re-running this migration (or a
-- future `db:migrate` against a DB that already has the extension) is safe.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_name" text NOT NULL,
	"domain" text,
	"description" text,
	"sector" text,
	"estimated_stage" text,
	"embedding" vector(384),
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"flags" text[] DEFAULT '{}' NOT NULL,
	"merged_into" uuid,
	"one_liner" text,
	"people" text[],
	"blocking_keys" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_members" (
	"company_id" uuid NOT NULL,
	"source_record_id" uuid NOT NULL,
	CONSTRAINT "company_members_company_id_source_record_id_pk" PRIMARY KEY("company_id","source_record_id")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"thesis_hash" text NOT NULL,
	"status" text,
	"stats" jsonb
);
--> statement-breakpoint
CREATE TABLE "scored_deals" (
	"run_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"score" double precision NOT NULL,
	"breakdown" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"flags" text[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "scored_deals_run_id_company_id_pk" PRIMARY KEY("run_id","company_id")
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" double precision NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"evidence_url" text
);
--> statement-breakpoint
CREATE TABLE "source_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"raw" jsonb NOT NULL,
	"extracted" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_watermarks" (
	"source" text PRIMARY KEY NOT NULL,
	"watermark" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_merged_into_companies_id_fk" FOREIGN KEY ("merged_into") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scored_deals" ADD CONSTRAINT "scored_deals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scored_deals" ADD CONSTRAINT "scored_deals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_domain_key" ON "companies" USING btree ("domain") WHERE "companies"."domain" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "companies_embedding_ivfflat_idx" ON "companies" USING ivfflat ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "companies_blocking_keys_gin_idx" ON "companies" USING gin ("blocking_keys");--> statement-breakpoint
CREATE UNIQUE INDEX "source_records_source_source_id_key" ON "source_records" USING btree ("source","source_id");