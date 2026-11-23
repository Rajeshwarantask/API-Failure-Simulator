CREATE TABLE "execution_request_contexts" (
  "execution_id" integer PRIMARY KEY NOT NULL,
  "encrypted_context" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_request_contexts" ADD CONSTRAINT "execution_request_contexts_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "execution_request_contexts" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "execution_request_contexts" FROM PUBLIC, anon, authenticated;
