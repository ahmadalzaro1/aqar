CREATE TYPE "public"."account_code" AS ENUM('tenant_ar', 'trust_cash', 'operating_cash', 'deposit_liability', 'owner_payable', 'expense', 'income', 'late_fee_income', 'service_income', 'cheques_in_transit', 'suspense');--> statement-breakpoint
CREATE TYPE "public"."application_decision" AS ENUM('approve', 'reject', 'waitlist');--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('received', 'screening', 'documents_pending', 'ready_for_decision', 'approved', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."charge_kind" AS ENUM('rent', 'late_fee', 'service', 'deposit', 'other');--> statement-breakpoint
CREATE TYPE "public"."cheque_status" AS ENUM('received', 'deposited', 'cleared', 'bounced');--> statement-breakpoint
CREATE TYPE "public"."decision_actor" AS ENUM('rule', 'model', 'human');--> statement-breakpoint
CREATE TYPE "public"."dispatch_status" AS ENUM('offered', 'accepted', 'declined', 'expired');--> statement-breakpoint
CREATE TYPE "public"."distribution_status" AS ENUM('draft', 'pending_approval', 'approved', 'paid', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('draft', 'active', 'superseded', 'archived');--> statement-breakpoint
CREATE TYPE "public"."identity_channel" AS ENUM('whatsapp', 'telegram', 'sms', 'email', 'in_app');--> statement-breakpoint
CREATE TYPE "public"."inquiry_status" AS ENUM('new', 'contacted', 'qualified', 'dropped');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('received', 'approved', 'scheduled', 'paid', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."lease_status" AS ENUM('upcoming', 'active', 'ended', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('draft', 'live', 'paused', 'closed');--> statement-breakpoint
CREATE TYPE "public"."locale" AS ENUM('ar', 'en');--> statement-breakpoint
CREATE TYPE "public"."match_kind" AS ENUM('auto', 'review', 'ambiguous', 'unknown_payer', 'partial');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."meter_kind" AS ENUM('water', 'electric', 'generator');--> statement-breakpoint
CREATE TYPE "public"."notice_direction" AS ENUM('to_tenant', 'from_tenant');--> statement-breakpoint
CREATE TYPE "public"."notice_kind" AS ENUM('rent_increase', 'eviction', 'maintenance_entry', 'termination', 'general');--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('draft', 'sent', 'accepted', 'declined', 'expired');--> statement-breakpoint
CREATE TYPE "public"."owner_vote" AS ENUM('yes', 'no', 'abstain');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'cliq', 'bank_transfer', 'cheque');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('requested', 'received', 'selected', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."responsibility" AS ENUM('landlord', 'tenant', 'shared', 'warranty');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('emergency', 'high', 'medium', 'low', 'cosmetic');--> statement-breakpoint
CREATE TYPE "public"."showing_outcome" AS ENUM('scheduled', 'attended', 'no_show', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."spend_kind" AS ENUM('capex', 'opex', 'emergency');--> statement-breakpoint
CREATE TYPE "public"."ticket_category" AS ENUM('gas', 'fire', 'electrical', 'plumbing', 'sewage', 'water', 'hvac', 'structural', 'lock', 'elevator', 'appliance', 'pest', 'common_area', 'generator', 'other');--> statement-breakpoint
CREATE TYPE "public"."ticket_channel" AS ENUM('whatsapp', 'telegram', 'email', 'in_app', 'phone');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('new', 'triaged', 'awaiting_tenant', 'approved', 'dispatched', 'in_progress', 'completed', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."unit_status" AS ENUM('vacant', 'occupied', 'turnover', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner_admin', 'property_manager', 'maintenance_coordinator', 'accountant', 'leasing_agent', 'vendor', 'tenant', 'owner', 'agent');--> statement-breakpoint
CREATE TYPE "public"."vendor_job_status" AS ENUM('scheduled', 'in_progress', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."work_order_status" AS ENUM('draft', 'approved', 'dispatched', 'in_progress', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"name_ar" text NOT NULL,
	"slug" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Amman' NOT NULL,
	"currency" text DEFAULT 'JOD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "agent_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ticket_id" uuid,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"total_latency_ms" integer DEFAULT 0 NOT NULL,
	"handed_off_to_human" boolean DEFAULT false NOT NULL,
	"handoff_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_traces_tokens_ck" CHECK ("agent_traces"."total_tokens" >= 0 AND "agent_traces"."total_latency_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor" jsonb NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"model_id" text,
	"prompt_version" text,
	"confidence" numeric(4, 3),
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"reversal_of" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_confidence_ck" CHECK ("audit_events"."confidence" IS NULL OR ("audit_events"."confidence" >= 0 AND "audit_events"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "channel_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel" "identity_channel" NOT NULL,
	"external_id" text NOT NULL,
	"tenant_id" uuid,
	"user_id" uuid,
	"display_name" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"identity_id" uuid,
	"user_id" uuid,
	"code_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otp_codes_attempts_ck" CHECK ("otp_codes"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"totp_secret" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_shape_ck" CHECK ("users"."email" LIKE '%@%')
);
--> statement-breakpoint
CREATE TABLE "amenities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"building_id" uuid,
	"code" text NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"included_in_rent" boolean DEFAULT true NOT NULL,
	"monthly_fils" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amenities_monthly_fils_ck" CHECK ("amenities"."monthly_fils" >= 0)
);
--> statement-breakpoint
CREATE TABLE "buildings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_ar" text NOT NULL,
	"floors" integer DEFAULT 1 NOT NULL,
	"year_built" integer,
	"elevator" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buildings_floors_ck" CHECK ("buildings"."floors" > 0),
	CONSTRAINT "buildings_year_built_ck" CHECK ("buildings"."year_built" IS NULL OR ("buildings"."year_built" >= 1900 AND "buildings"."year_built" <= 2100))
);
--> statement-breakpoint
CREATE TABLE "meters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid,
	"kind" "meter_kind" NOT NULL,
	"serial_number" text NOT NULL,
	"meter_number" text,
	"last_reading" integer,
	"last_reading_at" date,
	"tariff" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meters_reading_ck" CHECK ("meters"."last_reading" IS NULL OR "meters"."last_reading" >= 0)
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_ar" text NOT NULL,
	"district" text NOT NULL,
	"building_name" text,
	"street" text,
	"city" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"shared_services_config" jsonb DEFAULT '{"allocationMode":"per_unit","items":[]}'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "properties_lat_ck" CHECK ("properties"."lat" IS NULL OR ("properties"."lat" >= -90 AND "properties"."lat" <= 90)),
	CONSTRAINT "properties_lng_ck" CHECK ("properties"."lng" IS NULL OR ("properties"."lng" >= -180 AND "properties"."lng" <= 180))
);
--> statement-breakpoint
CREATE TABLE "unit_amenities" (
	"organization_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"amenity_id" uuid NOT NULL,
	CONSTRAINT "unit_amenities_unit_id_amenity_id_pk" PRIMARY KEY("unit_id","amenity_id")
);
--> statement-breakpoint
CREATE TABLE "units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"unit_number" text NOT NULL,
	"floor" text,
	"bedrooms" integer DEFAULT 1 NOT NULL,
	"bathrooms" integer DEFAULT 1 NOT NULL,
	"area_sqm" numeric(8, 2),
	"market_rent_fils" integer NOT NULL,
	"status" "unit_status" DEFAULT 'vacant' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "units_bedrooms_ck" CHECK ("units"."bedrooms" >= 0),
	CONSTRAINT "units_bathrooms_ck" CHECK ("units"."bathrooms" >= 0),
	CONSTRAINT "units_market_rent_ck" CHECK ("units"."market_rent_fils" >= 0),
	CONSTRAINT "units_area_ck" CHECK ("units"."area_sqm" IS NULL OR "units"."area_sqm" > 0)
);
--> statement-breakpoint
CREATE TABLE "applicants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"full_name_en" text NOT NULL,
	"full_name_ar" text,
	"phone" text NOT NULL,
	"email" text,
	"national_id_hash" text,
	"employer" text,
	"monthly_income_fils" integer,
	"household_size" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applicants_income_ck" CHECK ("applicants"."monthly_income_fils" IS NULL OR "applicants"."monthly_income_fils" >= 0),
	CONSTRAINT "applicants_household_ck" CHECK ("applicants"."household_size" > 0)
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"applicant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"listing_id" uuid,
	"status" "application_status" DEFAULT 'received' NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"desired_start_date" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"decision" "application_decision" NOT NULL,
	"reason" text NOT NULL,
	"decided_by_user_id" uuid NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decisions_reason_ck" CHECK (length(btrim("decisions"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "inquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"listing_id" uuid,
	"name_en" text NOT NULL,
	"name_ar" text,
	"phone" text NOT NULL,
	"email" text,
	"channel" "ticket_channel" NOT NULL,
	"message" text,
	"status" "inquiry_status" DEFAULT 'new' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"status" "listing_status" DEFAULT 'draft' NOT NULL,
	"channel" "ticket_channel" DEFAULT 'in_app' NOT NULL,
	"title_en" text NOT NULL,
	"title_ar" text NOT NULL,
	"description_en" text,
	"description_ar" text,
	"rent_ask_fils" integer NOT NULL,
	"deposit_ask_fils" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listings_rent_ck" CHECK ("listings"."rent_ask_fils" >= 0 AND "listings"."deposit_ask_fils" >= 0)
);
--> statement-breakpoint
CREATE TABLE "screening_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"score" integer,
	"passed" boolean NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "screening_results_score_ck" CHECK ("screening_results"."score" IS NULL OR ("screening_results"."score" >= 0 AND "screening_results"."score" <= 100))
);
--> statement-breakpoint
CREATE TABLE "showings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"inquiry_id" uuid,
	"unit_id" uuid NOT NULL,
	"agent_user_id" uuid,
	"scheduled_at" timestamp with time zone NOT NULL,
	"outcome" "showing_outcome" DEFAULT 'scheduled' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lease_addendums" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"effective_date" date NOT NULL,
	"summary_en" text NOT NULL,
	"summary_ar" text NOT NULL,
	"body_md" text,
	"rent_fils" integer,
	"document_key" text,
	"signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lease_addendums_rent_ck" CHECK ("lease_addendums"."rent_fils" IS NULL OR "lease_addendums"."rent_fils" >= 0)
);
--> statement-breakpoint
CREATE TABLE "lease_tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"share_bps" integer DEFAULT 10000 NOT NULL,
	"signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lease_tenants_share_bps_ck" CHECK ("lease_tenants"."share_bps" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"status" "lease_status" DEFAULT 'upcoming' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"rent_fils" integer NOT NULL,
	"deposit_fils" integer NOT NULL,
	"due_day" integer NOT NULL,
	"late_fee_rule" jsonb,
	"escalation_rule" jsonb DEFAULT '{"kind":"none"}'::jsonb NOT NULL,
	"signed_at" timestamp with time zone,
	"terminated_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leases_due_day_ck" CHECK ("leases"."due_day" BETWEEN 1 AND 28),
	CONSTRAINT "leases_rent_ck" CHECK ("leases"."rent_fils" >= 0),
	CONSTRAINT "leases_deposit_ck" CHECK ("leases"."deposit_fils" >= 0),
	CONSTRAINT "leases_dates_ck" CHECK ("leases"."end_date" >= "leases"."start_date")
);
--> statement-breakpoint
CREATE TABLE "notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lease_id" uuid,
	"tenant_id" uuid,
	"kind" "notice_kind" NOT NULL,
	"direction" "notice_direction" DEFAULT 'to_tenant' NOT NULL,
	"served_at" timestamp with time zone NOT NULL,
	"method" text NOT NULL,
	"body_md" text NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notices_target_ck" CHECK ("notices"."lease_id" IS NOT NULL OR "notices"."tenant_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "renewal_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"status" "offer_status" DEFAULT 'draft' NOT NULL,
	"offered_rent_fils" integer NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"sent_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "renewal_offers_rent_ck" CHECK ("renewal_offers"."offered_rent_fils" >= 0),
	CONSTRAINT "renewal_offers_dates_ck" CHECK ("renewal_offers"."end_date" >= "renewal_offers"."start_date")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"full_name_en" text NOT NULL,
	"full_name_ar" text NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"national_id_hash" text,
	"user_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_phone_ck" CHECK (length(btrim("tenants"."phone")) >= 7)
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" "account_code" NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_label" text NOT NULL,
	"bank_name" text,
	"file_name" text NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	"line_count" integer DEFAULT 0 NOT NULL,
	"source_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_imports_line_count_ck" CHECK ("bank_imports"."line_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "bank_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"date" date NOT NULL,
	"amount_fils" integer NOT NULL,
	"payer_name" text NOT NULL,
	"payer_account" text,
	"reference" text,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_lines_amount_ck" CHECK ("bank_lines"."amount_fils" <> 0)
);
--> statement-breakpoint
CREATE TABLE "charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"period" text NOT NULL,
	"kind" charge_kind NOT NULL,
	"amount_fils" integer NOT NULL,
	"due_date" date NOT NULL,
	"prorated_days" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "charges_period_format_ck" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "charges_amount_ck" CHECK ("charges"."amount_fils" >= 0),
	CONSTRAINT "charges_prorated_ck" CHECK ("charges"."prorated_days" IS NULL OR "charges"."prorated_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"amount_fils" integer NOT NULL,
	"period" text NOT NULL,
	"reason" text NOT NULL,
	"applied_to_charge_id" uuid,
	"issued_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_notes_amount_ck" CHECK ("credit_notes"."amount_fils" > 0),
	CONSTRAINT "credit_notes_period_ck" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"period" text NOT NULL,
	"memo" text NOT NULL,
	"posted" boolean DEFAULT false NOT NULL,
	"posted_at" timestamp with time zone,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_period_ck" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"account_code" "account_code" NOT NULL,
	"debit_fils" integer DEFAULT 0 NOT NULL,
	"credit_fils" integer DEFAULT 0 NOT NULL,
	"memo" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"period" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_lines_debit_ck" CHECK ("journal_lines"."debit_fils" >= 0),
	CONSTRAINT "journal_lines_credit_ck" CHECK ("journal_lines"."credit_fils" >= 0),
	CONSTRAINT "journal_lines_one_sided_ck" CHECK (("journal_lines"."debit_fils" > 0 AND "journal_lines"."credit_fils" = 0) OR ("journal_lines"."credit_fils" > 0 AND "journal_lines"."debit_fils" = 0)),
	CONSTRAINT "journal_lines_period_ck" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "late_fees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"rule" jsonb NOT NULL,
	"computed_fils" integer NOT NULL,
	"waived_fils" integer DEFAULT 0 NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "late_fees_computed_ck" CHECK ("late_fees"."computed_fils" >= 0),
	CONSTRAINT "late_fees_waived_ck" CHECK ("late_fees"."waived_fils" >= 0 AND "late_fees"."waived_fils" <= "late_fees"."computed_fils")
);
--> statement-breakpoint
CREATE TABLE "match_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"bank_line_id" uuid NOT NULL,
	"kind" "match_kind" NOT NULL,
	"lease_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payer_id" uuid,
	"amount_fils" integer NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"reason" text NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_suggestions_amount_ck" CHECK ("match_suggestions"."amount_fils" >= 0),
	CONSTRAINT "match_suggestions_confidence_ck" CHECK ("match_suggestions"."confidence" >= 0 AND "match_suggestions"."confidence" <= 1),
	CONSTRAINT "match_suggestions_reason_ck" CHECK (length(btrim("match_suggestions"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"amount_fils" integer NOT NULL,
	"allocated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_allocations_amount_ck" CHECK ("payment_allocations"."amount_fils" > 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"payer_id" uuid NOT NULL,
	"amount_fils" integer NOT NULL,
	"received_date" date NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference_period" text,
	"reference_text" text,
	"cheque_status" "cheque_status",
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_ck" CHECK ("payments"."amount_fils" > 0),
	CONSTRAINT "payments_reference_period_ck" CHECK ("payments"."reference_period" IS NULL OR "payments"."reference_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "payments_cheque_status_ck" CHECK (("payments"."method" = 'cheque' AND "payments"."cheque_status" IS NOT NULL) OR ("payments"."method" <> 'cheque' AND "payments"."cheque_status" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "period_locks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"period" text NOT NULL,
	"reason" text NOT NULL,
	"locked_by_user_id" uuid,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "period_locks_period_ck" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"trades" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"coverage_areas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rates" jsonb DEFAULT '{"calloutFils":0,"hourlyFils":0,"emergencyMultiplierBps":0}'::jsonb NOT NULL,
	"insurance_cert_expiry" date,
	"licence" text,
	"rating" numeric(3, 2),
	"allow_listed" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendors_rating_ck" CHECK ("vendors"."rating" IS NULL OR ("vendors"."rating" >= 0 AND "vendors"."rating" <= 5)),
	CONSTRAINT "vendors_rates_ck" CHECK (("vendors"."rates" ->> 'calloutFils')::int >= 0 AND ("vendors"."rates" ->> 'hourlyFils')::int >= 0)
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ticket_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"s3_key" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_bytes_ck" CHECK ("attachments"."bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "classifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"category" "ticket_category" NOT NULL,
	"severity" "severity" NOT NULL,
	"emergency_flag" boolean NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"deterministic_emergency" boolean NOT NULL,
	"model_severity" "severity" NOT NULL,
	"rationale" text NOT NULL,
	"model_id" text,
	"prompt_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classifications_confidence_ck" CHECK ("classifications"."confidence" >= 0 AND "classifications"."confidence" <= 1),
	CONSTRAINT "classifications_rationale_ck" CHECK (length(btrim("classifications"."rationale")) > 0)
);
--> statement-breakpoint
CREATE TABLE "completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"work_order_id" uuid,
	"completed_at" timestamp with time zone NOT NULL,
	"cost_fils" integer NOT NULL,
	"notes" text,
	"tenant_confirmed" boolean DEFAULT false NOT NULL,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "completions_cost_ck" CHECK ("completions"."cost_fils" >= 0)
);
--> statement-breakpoint
CREATE TABLE "dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"status" "dispatch_status" DEFAULT 'offered' NOT NULL,
	"offered_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "responsibilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"responsibility" "responsibility" NOT NULL,
	"reason_md" text NOT NULL,
	"decided_by" "decision_actor" NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "responsibilities_reason_ck" CHECK (length(btrim("responsibilities"."reason_md")) > 0)
);
--> statement-breakpoint
CREATE TABLE "sla_clocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"severity" "severity" NOT NULL,
	"response_due_at" timestamp with time zone NOT NULL,
	"resolution_due_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sla_clocks_order_ck" CHECK ("sla_clocks"."resolution_due_at" >= "sla_clocks"."response_due_at")
);
--> statement-breakpoint
CREATE TABLE "ticket_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"embedding" vector(384) NOT NULL,
	"model" text DEFAULT 'multilingual-e5-small' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"channel" "ticket_channel" NOT NULL,
	"author_user_id" uuid,
	"tenant_id" uuid,
	"body" text NOT NULL,
	"body_locale" "locale" DEFAULT 'ar' NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid,
	"tenant_id" uuid,
	"channel" "ticket_channel" NOT NULL,
	"status" "ticket_status" DEFAULT 'new' NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"subject" text,
	"body" text NOT NULL,
	"body_locale" "locale" DEFAULT 'ar' NOT NULL,
	"emergency_flag" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_body_ck" CHECK (length(btrim("tickets"."body")) > 0)
);
--> statement-breakpoint
CREATE TABLE "vendor_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"amount_fils" integer NOT NULL,
	"lead_time_days" integer,
	"received_at" timestamp with time zone NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_quotes_amount_ck" CHECK ("vendor_quotes"."amount_fils" >= 0),
	CONSTRAINT "vendor_quotes_lead_ck" CHECK ("vendor_quotes"."lead_time_days" IS NULL OR "vendor_quotes"."lead_time_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "work_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"vendor_id" uuid,
	"status" "work_order_status" DEFAULT 'draft' NOT NULL,
	"scope_md" text NOT NULL,
	"nte_fils" integer,
	"created_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_orders_nte_ck" CHECK ("work_orders"."nte_fils" IS NULL OR "work_orders"."nte_fils" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"vendor_job_id" uuid,
	"status" "invoice_status" DEFAULT 'received' NOT NULL,
	"invoice_number" text NOT NULL,
	"issued_at" date NOT NULL,
	"due_date" date,
	"amount_fils" integer NOT NULL,
	"vat_fils" integer DEFAULT 0 NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_amount_ck" CHECK ("invoices"."amount_fils" >= 0 AND "invoices"."vat_fils" >= 0)
);
--> statement-breakpoint
CREATE TABLE "performance_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"jobs_total" integer DEFAULT 0 NOT NULL,
	"jobs_completed" integer DEFAULT 0 NOT NULL,
	"jobs_on_time" integer DEFAULT 0 NOT NULL,
	"cost_variance_bps_sum" integer DEFAULT 0 NOT NULL,
	"jobs_reworked" integer DEFAULT 0 NOT NULL,
	"score" numeric(5, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "performance_scores_counts_ck" CHECK ("performance_scores"."jobs_total" >= 0 AND "performance_scores"."jobs_completed" >= 0 AND "performance_scores"."jobs_on_time" >= 0 AND "performance_scores"."jobs_reworked" >= 0),
	CONSTRAINT "performance_scores_subset_ck" CHECK ("performance_scores"."jobs_completed" <= "performance_scores"."jobs_total")
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"ticket_id" uuid,
	"vendor_job_id" uuid,
	"status" "quote_status" DEFAULT 'requested' NOT NULL,
	"amount_fils" integer NOT NULL,
	"valid_until" date,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotes_amount_ck" CHECK ("quotes"."amount_fils" >= 0),
	CONSTRAINT "quotes_target_ck" CHECK ("quotes"."ticket_id" IS NOT NULL OR "quotes"."vendor_job_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "vendor_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"ticket_id" uuid,
	"status" "vendor_job_status" DEFAULT 'scheduled' NOT NULL,
	"title" text NOT NULL,
	"scheduled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"quoted_fils" integer DEFAULT 0 NOT NULL,
	"actual_fils" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_jobs_quoted_ck" CHECK ("vendor_jobs"."quoted_fils" >= 0),
	CONSTRAINT "vendor_jobs_actual_ck" CHECK ("vendor_jobs"."actual_fils" IS NULL OR "vendor_jobs"."actual_fils" >= 0)
);
--> statement-breakpoint
CREATE TABLE "distributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"period" text NOT NULL,
	"amount_fils" integer NOT NULL,
	"status" "distribution_status" DEFAULT 'draft' NOT NULL,
	"approved_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "distributions_amount_ck" CHECK ("distributions"."amount_fils" >= 0),
	CONSTRAINT "distributions_period_ck" CHECK ("distributions"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "management_fees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"period" text NOT NULL,
	"basis_bps" integer NOT NULL,
	"base_fils" integer NOT NULL,
	"fee_fils" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "management_fees_bps_ck" CHECK ("management_fees"."basis_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "management_fees_money_ck" CHECK ("management_fees"."base_fils" >= 0 AND "management_fees"."fee_fils" >= 0)
);
--> statement-breakpoint
CREATE TABLE "owner_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"distribution_id" uuid,
	"spend_id" uuid,
	"spend_kind" "spend_kind",
	"owner_id" uuid NOT NULL,
	"vote" "owner_vote" NOT NULL,
	"comment" text,
	"voted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_approvals_target_ck" CHECK (("owner_approvals"."distribution_id" IS NOT NULL AND "owner_approvals"."spend_id" IS NULL) OR ("owner_approvals"."spend_id" IS NOT NULL AND "owner_approvals"."distribution_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "owner_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"period" text NOT NULL,
	"gross_rent_fils" integer NOT NULL,
	"expenses_fils" integer NOT NULL,
	"management_fee_fils" integer DEFAULT 0 NOT NULL,
	"net_fils" integer NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"document_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_statements_period_ck" CHECK ("owner_statements"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "owner_statements_money_ck" CHECK ("owner_statements"."gross_rent_fils" >= 0 AND "owner_statements"."expenses_fils" >= 0 AND "owner_statements"."management_fee_fils" >= 0)
);
--> statement-breakpoint
CREATE TABLE "owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"full_name_en" text NOT NULL,
	"full_name_ar" text NOT NULL,
	"phone" text,
	"email" text,
	"national_id_hash" text,
	"bank_iban" text,
	"user_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ownership_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"share_bps" integer NOT NULL,
	"effective_from" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ownership_shares_bps_ck" CHECK ("ownership_shares"."share_bps" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "trust_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"label" text NOT NULL,
	"bank_name" text NOT NULL,
	"iban" text NOT NULL,
	"currency" text DEFAULT 'JOD' NOT NULL,
	"opened_at" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "certifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"issued_at" date,
	"expires_at" date,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "document_status" DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_latest" boolean DEFAULT true NOT NULL,
	"s3_key" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_version_ck" CHECK ("documents"."version" > 0),
	CONSTRAINT "documents_bytes_ck" CHECK ("documents"."bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "inspections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid,
	"kind" text NOT NULL,
	"conducted_at" timestamp with time zone NOT NULL,
	"inspector_name" text NOT NULL,
	"findings_md" text,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insurance_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid,
	"vendor_id" uuid,
	"provider" text NOT NULL,
	"policy_number" text NOT NULL,
	"coverage" text NOT NULL,
	"premium_fils" integer DEFAULT 0 NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "insurance_policies_premium_ck" CHECK ("insurance_policies"."premium_fils" >= 0),
	CONSTRAINT "insurance_policies_dates_ck" CHECK ("insurance_policies"."end_date" >= "insurance_policies"."start_date")
);
--> statement-breakpoint
CREATE TABLE "legal_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"flag" text NOT NULL,
	"rationale_md" text NOT NULL,
	"human_review_required" boolean DEFAULT true NOT NULL,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_flags_human_review_ck" CHECK ("legal_flags"."human_review_required" = true),
	CONSTRAINT "legal_flags_rationale_ck" CHECK (length(btrim("legal_flags"."rationale_md")) > 0)
);
--> statement-breakpoint
CREATE TABLE "notice_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"locale" "locale" DEFAULT 'ar' NOT NULL,
	"body_md" text NOT NULL,
	"legal_review_required" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_standards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"property_class" text NOT NULL,
	"clocks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_standards_clocks_ck" CHECK (jsonb_typeof("service_standards"."clocks") = 'object' AND "service_standards"."clocks" ? 'emergency')
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"module" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_views_name_ck" CHECK (length(btrim("saved_views"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "scheduled_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"cron" text NOT NULL,
	"recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_reports_cron_ck" CHECK (length(btrim("scheduled_reports"."cron")) >= 5)
);
--> statement-breakpoint
ALTER TABLE "agent_traces" ADD CONSTRAINT "agent_traces_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_reversal_of_audit_events_id_fk" FOREIGN KEY ("reversal_of") REFERENCES "public"."audit_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_codes" ADD CONSTRAINT "otp_codes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_codes" ADD CONSTRAINT "otp_codes_identity_id_channel_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."channel_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_codes" ADD CONSTRAINT "otp_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amenities" ADD CONSTRAINT "amenities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amenities" ADD CONSTRAINT "amenities_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amenities" ADD CONSTRAINT "amenities_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buildings" ADD CONSTRAINT "buildings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buildings" ADD CONSTRAINT "buildings_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meters" ADD CONSTRAINT "meters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meters" ADD CONSTRAINT "meters_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meters" ADD CONSTRAINT "meters_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_amenities" ADD CONSTRAINT "unit_amenities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_amenities" ADD CONSTRAINT "unit_amenities_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_amenities" ADD CONSTRAINT "unit_amenities_amenity_id_amenities_id_fk" FOREIGN KEY ("amenity_id") REFERENCES "public"."amenities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applicants" ADD CONSTRAINT "applicants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_applicant_id_applicants_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."applicants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screening_results" ADD CONSTRAINT "screening_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screening_results" ADD CONSTRAINT "screening_results_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showings" ADD CONSTRAINT "showings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showings" ADD CONSTRAINT "showings_inquiry_id_inquiries_id_fk" FOREIGN KEY ("inquiry_id") REFERENCES "public"."inquiries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showings" ADD CONSTRAINT "showings_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showings" ADD CONSTRAINT "showings_agent_user_id_users_id_fk" FOREIGN KEY ("agent_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_addendums" ADD CONSTRAINT "lease_addendums_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_addendums" ADD CONSTRAINT "lease_addendums_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_tenants" ADD CONSTRAINT "lease_tenants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_tenants" ADD CONSTRAINT "lease_tenants_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_tenants" ADD CONSTRAINT "lease_tenants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewal_offers" ADD CONSTRAINT "renewal_offers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewal_offers" ADD CONSTRAINT "renewal_offers_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_imports" ADD CONSTRAINT "bank_imports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_lines" ADD CONSTRAINT "bank_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_lines" ADD CONSTRAINT "bank_lines_statement_id_bank_imports_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."bank_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_applied_to_charge_id_charges_id_fk" FOREIGN KEY ("applied_to_charge_id") REFERENCES "public"."charges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "late_fees" ADD CONSTRAINT "late_fees_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "late_fees" ADD CONSTRAINT "late_fees_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_suggestions" ADD CONSTRAINT "match_suggestions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_suggestions" ADD CONSTRAINT "match_suggestions_bank_line_id_bank_lines_id_fk" FOREIGN KEY ("bank_line_id") REFERENCES "public"."bank_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_suggestions" ADD CONSTRAINT "match_suggestions_payer_id_tenants_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payer_id_tenants_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_locks" ADD CONSTRAINT "period_locks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completions" ADD CONSTRAINT "completions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completions" ADD CONSTRAINT "completions_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completions" ADD CONSTRAINT "completions_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_clocks" ADD CONSTRAINT "sla_clocks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_clocks" ADD CONSTRAINT "sla_clocks_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_embeddings" ADD CONSTRAINT "ticket_embeddings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_embeddings" ADD CONSTRAINT "ticket_embeddings_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_quotes" ADD CONSTRAINT "vendor_quotes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_quotes" ADD CONSTRAINT "vendor_quotes_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_quotes" ADD CONSTRAINT "vendor_quotes_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_vendor_job_id_vendor_jobs_id_fk" FOREIGN KEY ("vendor_job_id") REFERENCES "public"."vendor_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_scores" ADD CONSTRAINT "performance_scores_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_scores" ADD CONSTRAINT "performance_scores_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_vendor_job_id_vendor_jobs_id_fk" FOREIGN KEY ("vendor_job_id") REFERENCES "public"."vendor_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_jobs" ADD CONSTRAINT "vendor_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_jobs" ADD CONSTRAINT "vendor_jobs_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_jobs" ADD CONSTRAINT "vendor_jobs_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_fees" ADD CONSTRAINT "management_fees_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_fees" ADD CONSTRAINT "management_fees_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_approvals" ADD CONSTRAINT "owner_approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_approvals" ADD CONSTRAINT "owner_approvals_distribution_id_distributions_id_fk" FOREIGN KEY ("distribution_id") REFERENCES "public"."distributions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_approvals" ADD CONSTRAINT "owner_approvals_spend_id_work_orders_id_fk" FOREIGN KEY ("spend_id") REFERENCES "public"."work_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_approvals" ADD CONSTRAINT "owner_approvals_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statements" ADD CONSTRAINT "owner_statements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statements" ADD CONSTRAINT "owner_statements_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owners" ADD CONSTRAINT "owners_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owners" ADD CONSTRAINT "owners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_shares" ADD CONSTRAINT "ownership_shares_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_shares" ADD CONSTRAINT "ownership_shares_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_shares" ADD CONSTRAINT "ownership_shares_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_accounts" ADD CONSTRAINT "trust_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certifications" ADD CONSTRAINT "certifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certifications" ADD CONSTRAINT "certifications_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurance_policies" ADD CONSTRAINT "insurance_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurance_policies" ADD CONSTRAINT "insurance_policies_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurance_policies" ADD CONSTRAINT "insurance_policies_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurance_policies" ADD CONSTRAINT "insurance_policies_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_flags" ADD CONSTRAINT "legal_flags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_flags" ADD CONSTRAINT "legal_flags_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_templates" ADD CONSTRAINT "notice_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_standards" ADD CONSTRAINT "service_standards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_reports" ADD CONSTRAINT "scheduled_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_reports" ADD CONSTRAINT "scheduled_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organizations_slug_idx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "agent_traces_org_idx" ON "agent_traces" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "agent_traces_ticket_idx" ON "agent_traces" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_idempotency_uq" ON "audit_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "audit_events_org_occurred_idx" ON "audit_events" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_identities_channel_external_uq" ON "channel_identities" USING btree ("channel","external_id");--> statement-breakpoint
CREATE INDEX "channel_identities_org_idx" ON "channel_identities" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "channel_identities_tenant_idx" ON "channel_identities" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "otp_codes_org_idx" ON "otp_codes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "otp_codes_expires_idx" ON "otp_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_org_idx" ON "sessions" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_org_idx" ON "users" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "amenities_org_idx" ON "amenities" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "amenities_property_idx" ON "amenities" USING btree ("property_id");--> statement-breakpoint
CREATE UNIQUE INDEX "amenities_property_code_uq" ON "amenities" USING btree ("property_id","code");--> statement-breakpoint
CREATE INDEX "buildings_org_idx" ON "buildings" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "buildings_property_idx" ON "buildings" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "meters_org_idx" ON "meters" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "meters_property_idx" ON "meters" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "meters_unit_idx" ON "meters" USING btree ("unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meters_org_serial_uq" ON "meters" USING btree ("organization_id","serial_number");--> statement-breakpoint
CREATE INDEX "properties_org_idx" ON "properties" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "properties_city_district_idx" ON "properties" USING btree ("city","district");--> statement-breakpoint
CREATE INDEX "unit_amenities_org_idx" ON "unit_amenities" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "units_org_idx" ON "units" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "units_property_idx" ON "units" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "units_status_idx" ON "units" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "units_building_number_uq" ON "units" USING btree ("building_id","unit_number");--> statement-breakpoint
CREATE INDEX "applicants_org_idx" ON "applicants" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "applicants_email_idx" ON "applicants" USING btree ("email");--> statement-breakpoint
CREATE INDEX "applications_org_idx" ON "applications" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "applications_unit_idx" ON "applications" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "applications_status_idx" ON "applications" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "decisions_org_idx" ON "decisions" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_application_uq" ON "decisions" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "inquiries_org_idx" ON "inquiries" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "inquiries_listing_idx" ON "inquiries" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "inquiries_status_idx" ON "inquiries" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "listings_org_idx" ON "listings" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "listings_unit_idx" ON "listings" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "listings_status_idx" ON "listings" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "screening_results_org_idx" ON "screening_results" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "screening_results_application_idx" ON "screening_results" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "screening_results_application_kind_uq" ON "screening_results" USING btree ("application_id","kind");--> statement-breakpoint
CREATE INDEX "showings_org_idx" ON "showings" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "showings_unit_idx" ON "showings" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "showings_scheduled_idx" ON "showings" USING btree ("organization_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "lease_addendums_org_idx" ON "lease_addendums" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "lease_addendums_lease_idx" ON "lease_addendums" USING btree ("lease_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lease_tenants_lease_tenant_uq" ON "lease_tenants" USING btree ("lease_id","tenant_id");--> statement-breakpoint
CREATE INDEX "lease_tenants_org_idx" ON "lease_tenants" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "lease_tenants_tenant_idx" ON "lease_tenants" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "leases_org_idx" ON "leases" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "leases_unit_idx" ON "leases" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "leases_org_status_idx" ON "leases" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "leases_org_end_idx" ON "leases" USING btree ("organization_id","end_date");--> statement-breakpoint
CREATE INDEX "notices_org_idx" ON "notices" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "notices_lease_idx" ON "notices" USING btree ("lease_id");--> statement-breakpoint
CREATE INDEX "notices_served_idx" ON "notices" USING btree ("organization_id","served_at");--> statement-breakpoint
CREATE INDEX "renewal_offers_org_idx" ON "renewal_offers" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "renewal_offers_lease_idx" ON "renewal_offers" USING btree ("lease_id");--> statement-breakpoint
CREATE INDEX "tenants_org_idx" ON "tenants" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "tenants_email_idx" ON "tenants" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_org_phone_uq" ON "tenants" USING btree ("organization_id","phone");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_org_code_uq" ON "accounts" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX "accounts_org_idx" ON "accounts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "bank_imports_org_idx" ON "bank_imports" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_imports_org_source_hash_uq" ON "bank_imports" USING btree ("organization_id","source_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_lines_statement_fingerprint_uq" ON "bank_lines" USING btree ("statement_id","fingerprint");--> statement-breakpoint
CREATE INDEX "bank_lines_org_fingerprint_idx" ON "bank_lines" USING btree ("organization_id","fingerprint");--> statement-breakpoint
CREATE INDEX "bank_lines_statement_idx" ON "bank_lines" USING btree ("statement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "charges_lease_period_kind_uq" ON "charges" USING btree ("lease_id","period","kind");--> statement-breakpoint
CREATE INDEX "charges_org_period_idx" ON "charges" USING btree ("organization_id","period");--> statement-breakpoint
CREATE INDEX "charges_lease_idx" ON "charges" USING btree ("lease_id");--> statement-breakpoint
CREATE INDEX "credit_notes_org_idx" ON "credit_notes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "credit_notes_tenant_idx" ON "credit_notes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "journal_entries_org_period_idx" ON "journal_entries" USING btree ("organization_id","period");--> statement-breakpoint
CREATE INDEX "journal_entries_org_posted_idx" ON "journal_entries" USING btree ("organization_id","posted");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_source_uq" ON "journal_entries" USING btree ("organization_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "journal_lines_entry_idx" ON "journal_lines" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "journal_lines_org_period_idx" ON "journal_lines" USING btree ("organization_id","period");--> statement-breakpoint
CREATE INDEX "late_fees_org_idx" ON "late_fees" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "late_fees_charge_idx" ON "late_fees" USING btree ("charge_id");--> statement-breakpoint
CREATE INDEX "match_suggestions_org_idx" ON "match_suggestions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "match_suggestions_bank_line_idx" ON "match_suggestions" USING btree ("bank_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocations_payment_charge_uq" ON "payment_allocations" USING btree ("payment_id","charge_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_org_idx" ON "payment_allocations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_charge_idx" ON "payment_allocations" USING btree ("charge_id");--> statement-breakpoint
CREATE INDEX "payments_org_received_idx" ON "payments" USING btree ("organization_id","received_date");--> statement-breakpoint
CREATE INDEX "payments_payer_idx" ON "payments" USING btree ("payer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "period_locks_org_period_uq" ON "period_locks" USING btree ("organization_id","period");--> statement-breakpoint
CREATE INDEX "vendors_org_idx" ON "vendors" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_org_name_uq" ON "vendors" USING btree ("organization_id","name_en");--> statement-breakpoint
CREATE INDEX "attachments_org_idx" ON "attachments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "attachments_entity_idx" ON "attachments" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_s3_key_uq" ON "attachments" USING btree ("s3_key");--> statement-breakpoint
CREATE INDEX "classifications_ticket_idx" ON "classifications" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "classifications_org_created_idx" ON "classifications" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "completions_ticket_idx" ON "completions" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "completions_org_idx" ON "completions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "dispatches_ticket_idx" ON "dispatches" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "dispatches_vendor_idx" ON "dispatches" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "dispatches_org_idx" ON "dispatches" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "responsibilities_ticket_idx" ON "responsibilities" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "responsibilities_org_idx" ON "responsibilities" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sla_clocks_ticket_uq" ON "sla_clocks" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "sla_clocks_org_idx" ON "sla_clocks" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_embeddings_ticket_uq" ON "ticket_embeddings" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_embeddings_org_idx" ON "ticket_embeddings" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ticket_embeddings_hnsw_idx" ON "ticket_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "ticket_messages_ticket_idx" ON "ticket_messages" USING btree ("ticket_id","sent_at");--> statement-breakpoint
CREATE INDEX "ticket_messages_org_idx" ON "ticket_messages" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "tickets_org_idx" ON "tickets" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "tickets_property_idx" ON "tickets" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "tickets_unit_idx" ON "tickets" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "tickets_tenant_idx" ON "tickets" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tickets_org_status_idx" ON "tickets" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "tickets_org_opened_idx" ON "tickets" USING btree ("organization_id","opened_at");--> statement-breakpoint
CREATE INDEX "tickets_emergency_idx" ON "tickets" USING btree ("organization_id","opened_at") WHERE "tickets"."emergency_flag" = true;--> statement-breakpoint
CREATE INDEX "vendor_quotes_ticket_idx" ON "vendor_quotes" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "vendor_quotes_vendor_idx" ON "vendor_quotes" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "vendor_quotes_org_idx" ON "vendor_quotes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "work_orders_org_idx" ON "work_orders" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "work_orders_ticket_idx" ON "work_orders" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "work_orders_vendor_idx" ON "work_orders" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_vendor_number_uq" ON "invoices" USING btree ("organization_id","vendor_id","invoice_number");--> statement-breakpoint
CREATE INDEX "invoices_org_status_idx" ON "invoices" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "performance_scores_vendor_asof_uq" ON "performance_scores" USING btree ("vendor_id","as_of");--> statement-breakpoint
CREATE INDEX "performance_scores_org_idx" ON "performance_scores" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "quotes_org_idx" ON "quotes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "quotes_vendor_idx" ON "quotes" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "vendor_jobs_org_idx" ON "vendor_jobs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "vendor_jobs_vendor_idx" ON "vendor_jobs" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "vendor_jobs_ticket_idx" ON "vendor_jobs" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "distributions_org_idx" ON "distributions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "distributions_owner_idx" ON "distributions" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "distributions_org_status_idx" ON "distributions" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "management_fees_property_period_uq" ON "management_fees" USING btree ("property_id","period");--> statement-breakpoint
CREATE INDEX "management_fees_org_idx" ON "management_fees" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "owner_approvals_org_idx" ON "owner_approvals" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "owner_approvals_distribution_idx" ON "owner_approvals" USING btree ("distribution_id");--> statement-breakpoint
CREATE INDEX "owner_approvals_spend_idx" ON "owner_approvals" USING btree ("spend_id");--> statement-breakpoint
CREATE UNIQUE INDEX "owner_statements_property_period_uq" ON "owner_statements" USING btree ("property_id","period");--> statement-breakpoint
CREATE INDEX "owner_statements_org_idx" ON "owner_statements" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "owners_org_idx" ON "owners" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "owners_email_idx" ON "owners" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "ownership_shares_owner_property_uq" ON "ownership_shares" USING btree ("owner_id","property_id");--> statement-breakpoint
CREATE INDEX "ownership_shares_org_idx" ON "ownership_shares" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ownership_shares_property_idx" ON "ownership_shares" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "trust_accounts_org_idx" ON "trust_accounts" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_accounts_org_iban_uq" ON "trust_accounts" USING btree ("organization_id","iban");--> statement-breakpoint
CREATE INDEX "certifications_org_idx" ON "certifications" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "certifications_subject_idx" ON "certifications" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "certifications_expiry_idx" ON "certifications" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_entity_version_uq" ON "documents" USING btree ("entity_type","entity_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_s3_key_uq" ON "documents" USING btree ("s3_key");--> statement-breakpoint
CREATE INDEX "documents_org_idx" ON "documents" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "documents_entity_idx" ON "documents" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "inspections_org_idx" ON "inspections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "inspections_property_idx" ON "inspections" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "inspections_unit_idx" ON "inspections" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "insurance_policies_org_idx" ON "insurance_policies" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "insurance_policies_property_idx" ON "insurance_policies" USING btree ("property_id");--> statement-breakpoint
CREATE UNIQUE INDEX "insurance_policies_org_provider_number_uq" ON "insurance_policies" USING btree ("organization_id","provider","policy_number");--> statement-breakpoint
CREATE INDEX "legal_flags_org_idx" ON "legal_flags" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "legal_flags_entity_idx" ON "legal_flags" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notice_templates_org_code_locale_uq" ON "notice_templates" USING btree ("organization_id","code","locale");--> statement-breakpoint
CREATE INDEX "notice_templates_org_idx" ON "notice_templates" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_standards_org_class_uq" ON "service_standards" USING btree ("organization_id","property_class");--> statement-breakpoint
CREATE INDEX "service_standards_org_idx" ON "service_standards" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "saved_views_org_module_idx" ON "saved_views" USING btree ("organization_id","module");--> statement-breakpoint
CREATE INDEX "saved_views_user_idx" ON "saved_views" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scheduled_reports_org_idx" ON "scheduled_reports" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "scheduled_reports_active_idx" ON "scheduled_reports" USING btree ("organization_id","is_active");