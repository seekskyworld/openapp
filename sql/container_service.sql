-- OpenApp clean PostgreSQL initialization.
-- Docker sets POSTGRES_DB before invoking init scripts. Manual restores fall
-- back to container_service, so schema creation and Portal configuration never
-- silently target different databases.
\getenv target_database POSTGRES_DB
\if :{?target_database}
\else
\set target_database container_service
\endif
SELECT format('CREATE DATABASE %I', :'target_database')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = :'target_database'
)\gexec
\connect :"target_database"

--
-- PostgreSQL database dump
--

\restrict buTx997HahQhk19ScE4Rd0TkIrL26F122EU7SE3XOyGWsVE27s07teXkINsaT27

-- Dumped from database version 17.10
-- Dumped by pg_dump version 17.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: app_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_versions (
    id text NOT NULL,
    app_id text NOT NULL,
    revision bigint NOT NULL,
    version text NOT NULL,
    build_id text NOT NULL,
    packages jsonb DEFAULT '[]'::jsonb NOT NULL,
    image_reference text,
    runtime_contract text,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone,
    image_artifact_id text,
    source_kind text DEFAULT 'packages'::text NOT NULL CHECK (source_kind IN ('packages', 'image')),
    CONSTRAINT app_versions_status_check CHECK ((status = ANY (ARRAY['legacy'::text, 'uploaded'::text, 'image_ready'::text, 'active'::text, 'archived'::text])))
);


--
-- Name: apps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.apps (
    id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    auth_adapter_id text DEFAULT 'none'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT apps_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))
);


--
-- Name: audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_events (
    id text NOT NULL,
    actor_user_id text,
    action text NOT NULL,
    resource_type text NOT NULL,
    resource_id text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_identities (
    provider text NOT NULL,
    subject text NOT NULL,
    user_id text NOT NULL,
    email_snapshot text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_authenticated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: build_packages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.build_packages (
    id text NOT NULL,
    strategy_id text NOT NULL,
    slot_key text NOT NULL,
    artifact jsonb NOT NULL,
    original_name text NOT NULL,
    storage_key text NOT NULL,
    uploaded_by text NOT NULL,
    source_version text,
    source_build_id text,
    inspected_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: build_strategies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.build_strategies (
    id text NOT NULL,
    revision integer DEFAULT 3 NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    runtime_contract text DEFAULT 'none'::text NOT NULL,
    package_requirements jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT build_strategies_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))
);


--
-- Name: config_revision_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.config_revision_history (
    key text NOT NULL,
    revision bigint NOT NULL,
    updated_by text NOT NULL,
    effect text NOT NULL,
    effective_at timestamp with time zone,
    payload jsonb DEFAULT 'null'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT config_revision_history_effect_check CHECK ((effect = ANY (ARRAY['immediate'::text, 'new_instances'::text, 'restart'::text, 'rebuild'::text])))
);


--
-- Name: config_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.config_revisions (
    key text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    updated_by text DEFAULT 'system'::text NOT NULL,
    effect text DEFAULT 'immediate'::text NOT NULL,
    effective_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT config_revisions_effect_check CHECK ((effect = ANY (ARRAY['immediate'::text, 'new_instances'::text, 'restart'::text, 'rebuild'::text])))
);


--
-- Name: containers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.containers (
    id text NOT NULL,
    user_id text NOT NULL,
    app_id text NOT NULL,
    runtime_id text NOT NULL,
    status text NOT NULL,
    endpoint text,
    stop_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL,
    app_version_id text,
    image_artifact_id text,
    image_reference text,
    workspace_status text DEFAULT 'active'::text NOT NULL,
    storage_ref_id text NOT NULL,
    active_execution_id text,
    provider_id text DEFAULT 'docker'::text NOT NULL,
    environment_ref text,
    execution_role text DEFAULT 'active'::text NOT NULL,
    desired_generation bigint DEFAULT 1 NOT NULL,
    deployed_generation bigint NOT NULL,
    healthy_generation bigint,
    transaction_id text,
    transaction_status text NOT NULL,
    desired_state text NOT NULL,
    observed_state text NOT NULL,
    desired_app_revision_id text,
    desired_launch_artifact_id text,
    desired_launch_artifact_reference text,
    execution_revision bigint DEFAULT 1 NOT NULL,
    execution_image_artifact_id text,
    execution_image_reference text,
    execution_endpoint text,
    execution_model_version integer DEFAULT 2 NOT NULL,
    deletion_transaction_id text,
    deletion_phase text,
    deletion_failure text,
    deleted_at timestamp with time zone,
    CONSTRAINT containers_status_check CHECK ((status = ANY (ARRAY['creating'::text, 'running'::text, 'stopped'::text, 'failed'::text]))),
    CONSTRAINT containers_stop_reason_check CHECK ((stop_reason = ANY (ARRAY['idle'::text, 'manual_user'::text, 'manual_admin'::text, 'failure'::text]))),
    CONSTRAINT containers_workspace_deletion_check CHECK ((((workspace_status = 'active'::text) AND (deletion_transaction_id IS NULL) AND (deletion_phase IS NULL) AND (deletion_failure IS NULL) AND (deleted_at IS NULL)) OR ((workspace_status = 'deleting'::text) AND (deletion_transaction_id IS NOT NULL) AND (deletion_phase = ANY (ARRAY['draining'::text, 'removing_environments'::text, 'verifying_references'::text, 'releasing_storage'::text, 'finalizing'::text])) AND (deleted_at IS NULL)) OR ((workspace_status = 'deleted'::text) AND (deletion_transaction_id IS NOT NULL) AND (deletion_phase = 'deleted'::text) AND (deleted_at IS NOT NULL) AND (active_execution_id IS NULL) AND (execution_role = 'retired'::text) AND (environment_ref IS NULL)))),
    CONSTRAINT containers_workspace_execution_check CHECK (((workspace_status = ANY (ARRAY['active'::text, 'deleting'::text, 'deleted'::text])) AND (execution_role = ANY (ARRAY['active'::text, 'candidate'::text, 'previous'::text, 'retired'::text])) AND (transaction_status = ANY (ARRAY['requested'::text, 'progressing'::text, 'applied'::text, 'awaiting_first_start'::text, 'rolled_back'::text, 'failed'::text, 'inconsistent'::text])) AND (desired_state = ANY (ARRAY['running'::text, 'stopped'::text])) AND (observed_state = ANY (ARRAY['absent'::text, 'creating'::text, 'running'::text, 'stopped'::text, 'failed'::text, 'unknown'::text])) AND (desired_generation >= deployed_generation) AND (deployed_generation >= 0) AND ((healthy_generation IS NULL) OR ((healthy_generation >= 0) AND (healthy_generation <= deployed_generation))) AND (execution_revision > 0) AND (execution_model_version >= 2)))
);


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id text NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenants_kind_check CHECK ((kind = ANY (ARRAY['personal'::text, 'organization'::text])))
);


--
-- Name: tenant_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_memberships (
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_memberships_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))
);


--
-- Name: workspace_tenant_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_tenant_bindings (
    workspace_id text NOT NULL,
    tenant_id text NOT NULL,
    owner_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: forwarding_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forwarding_policies (
    id text NOT NULL,
    name text NOT NULL,
    target_base_url text NOT NULL,
    allowed_hosts text[] DEFAULT '{}'::text[] NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    updated_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: health_checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.health_checks (
    id text NOT NULL,
    target text NOT NULL,
    checked_at timestamp with time zone NOT NULL,
    healthy boolean NOT NULL,
    latency_ms double precision,
    error text
);


--
-- Name: image_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_artifacts (
    id text NOT NULL,
    build_id text NOT NULL,
    image_reference text NOT NULL,
    image_id text NOT NULL,
    runtime_contract text DEFAULT 'none'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: image_builds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_builds (
    id text NOT NULL,
    strategy_id text NOT NULL,
    strategy_snapshot jsonb NOT NULL,
    operation_id text,
    source_app_version_id text,
    requested_by text NOT NULL,
    packages jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    CONSTRAINT image_builds_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'building'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: local_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_credentials (
    user_id text NOT NULL,
    password_hash text NOT NULL,
    password_changed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: operation_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operation_runs (
    id text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    type text NOT NULL,
    status text NOT NULL,
    progress integer DEFAULT 0 NOT NULL,
    stage text NOT NULL,
    actor_user_id text NOT NULL,
    resource_type text NOT NULL,
    resource_id text,
    request_id text NOT NULL,
    idempotency_key text,
    request_fingerprint text,
    retry_of text,
    cancellable boolean DEFAULT false NOT NULL,
    retryable boolean DEFAULT false NOT NULL,
    result jsonb,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    finished_at timestamp with time zone,
    CONSTRAINT operation_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: upgrade_rollouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upgrade_rollouts (
    id text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    actor_user_id text NOT NULL,
    status text NOT NULL,
    task_kind text DEFAULT 'image_upgrade'::text NOT NULL,
    use_latest_version boolean NOT NULL,
    requested integer NOT NULL,
    completed integer DEFAULT 0 NOT NULL,
    succeeded integer DEFAULT 0 NOT NULL,
    superseded integer DEFAULT 0 NOT NULL,
    failed integer DEFAULT 0 NOT NULL,
    waiting integer DEFAULT 0 NOT NULL,
    upgrading integer DEFAULT 0 NOT NULL,
    needs_attention integer DEFAULT 0 NOT NULL,
    idempotency_key text,
    request_fingerprint text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT upgrade_rollouts_status_check CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'partial_failed'::text, 'cancelled'::text, 'needs_attention'::text]))),
    CONSTRAINT upgrade_rollouts_task_kind_check CHECK ((task_kind = ANY (ARRAY['image_upgrade'::text, 'rebuild_same_image'::text, 'apply_resource_policy'::text, 'instance_recovery'::text])))
);


--
-- Name: upgrade_rollout_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upgrade_rollout_items (
    rollout_id text NOT NULL,
    instance_id text NOT NULL,
    position integer NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    user_id text NOT NULL,
    app_id text NOT NULL,
    source_status text NOT NULL,
    desired_state text NOT NULL,
    source_app_version_id text,
    source_image_artifact_id text,
    source_image_reference text,
    target_app_version_id text,
    target_image_artifact_id text,
    target_image_reference text NOT NULL,
    target_runtime_contract text,
    launch_profile jsonb NOT NULL,
    status text NOT NULL,
    blocker text,
    error text,
    diagnostics jsonb,
    force_requested boolean DEFAULT false NOT NULL,
    attempt_id text,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    last_checked_at timestamp with time zone,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT upgrade_rollout_items_source_status_check CHECK ((source_status = ANY (ARRAY['creating'::text, 'running'::text, 'stopped'::text, 'failed'::text]))),
    CONSTRAINT upgrade_rollout_items_desired_state_check CHECK ((desired_state = ANY (ARRAY['running'::text, 'stopped'::text]))),
    CONSTRAINT upgrade_rollout_items_status_check_v3 CHECK ((status = ANY (ARRAY['queued'::text, 'assessing'::text, 'waiting_for_idle'::text, 'draining'::text, 'rebuilding'::text, 'verifying'::text, 'awaiting_first_start'::text, 'succeeded'::text, 'superseded'::text, 'failed'::text, 'cancelled'::text, 'needs_attention'::text])))
);


--
-- Name: instance_activity_leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instance_activity_leases (
    id text NOT NULL,
    instance_id text NOT NULL,
    kind text NOT NULL,
    opened_at timestamp with time zone NOT NULL,
    heartbeat_at timestamp with time zone NOT NULL,
    last_activity_at timestamp with time zone NOT NULL,
    CONSTRAINT instance_activity_leases_kind_check CHECK ((kind = ANY (ARRAY['http'::text, 'websocket'::text])))
);


--
-- Name: instance_upgrade_drains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instance_upgrade_drains (
    instance_id text NOT NULL,
    rollout_id text NOT NULL,
    attempt_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: provisioning_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provisioning_policy (
    id text NOT NULL,
    policy jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: runtime_samples; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runtime_samples (
    id text NOT NULL,
    instance_id text NOT NULL,
    sampled_at timestamp with time zone NOT NULL,
    state text NOT NULL,
    network_rx_bytes double precision,
    network_tx_bytes double precision,
    cpu_percent double precision,
    memory_working_set_bytes double precision,
    pids integer,
    gpu_utilization_percent double precision,
    error text,
    CONSTRAINT runtime_samples_state_check CHECK ((state = ANY (ARRAY['creating'::text, 'running'::text, 'stopped'::text, 'failed'::text])))
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    token_hash text NOT NULL,
    user_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    auth_method text DEFAULT 'external'::text NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id text NOT NULL,
    email text NOT NULL,
    role text DEFAULT 'user'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    app_initialized_at timestamp with time zone,
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['user'::text, 'admin'::text, 'super_admin'::text])))
);


--
-- Data for Name: app_versions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.app_versions (id, app_id, revision, version, build_id, packages, image_reference, runtime_contract, status, created_at, activated_at, image_artifact_id, source_kind) FROM stdin;
\.


--
-- Data for Name: apps; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.apps (id, name, description, auth_adapter_id, status, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: audit_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.audit_events (id, actor_user_id, action, resource_type, resource_id, metadata, created_at) FROM stdin;
\.


--
-- Data for Name: auth_identities; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.auth_identities (provider, subject, user_id, email_snapshot, created_at, last_authenticated_at) FROM stdin;
\.


--
-- Data for Name: build_packages; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.build_packages (id, strategy_id, slot_key, artifact, original_name, storage_key, uploaded_by, source_version, source_build_id, inspected_at, created_at) FROM stdin;
\.


--
-- Data for Name: build_strategies; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.build_strategies (id, revision, name, description, runtime_contract, package_requirements, status, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: config_revision_history; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.config_revision_history (key, revision, updated_by, effect, effective_at, payload, created_at) FROM stdin;
\.


--
-- Data for Name: config_revisions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.config_revisions (key, revision, updated_by, effect, effective_at, updated_at) FROM stdin;
\.


--
-- Data for Name: containers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.containers (id, user_id, app_id, runtime_id, status, endpoint, stop_reason, created_at, updated_at, last_activity_at, app_version_id, image_artifact_id, image_reference, workspace_status, storage_ref_id, active_execution_id, provider_id, environment_ref, execution_role, desired_generation, deployed_generation, healthy_generation, transaction_id, transaction_status, desired_state, observed_state, desired_app_revision_id, desired_launch_artifact_id, desired_launch_artifact_reference, execution_revision, execution_image_artifact_id, execution_image_reference, execution_endpoint, execution_model_version, deletion_transaction_id, deletion_phase, deletion_failure, deleted_at) FROM stdin;
\.


--
-- Data for Name: tenant_memberships; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tenant_memberships (tenant_id, user_id, role, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: tenants; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.tenants (id, kind, name, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: workspace_tenant_bindings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.workspace_tenant_bindings (workspace_id, tenant_id, owner_id, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: forwarding_policies; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.forwarding_policies (id, name, target_base_url, allowed_hosts, enabled, updated_by, updated_at) FROM stdin;
\.


--
-- Data for Name: health_checks; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.health_checks (id, target, checked_at, healthy, latency_ms, error) FROM stdin;
\.


--
-- Data for Name: image_artifacts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.image_artifacts (id, build_id, image_reference, image_id, runtime_contract, created_at) FROM stdin;
\.


--
-- Data for Name: image_builds; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.image_builds (id, strategy_id, strategy_snapshot, operation_id, source_app_version_id, requested_by, packages, status, error, created_at, started_at, finished_at) FROM stdin;
\.


--
-- Data for Name: local_credentials; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.local_credentials (user_id, password_hash, password_changed_at) FROM stdin;
\.


--
-- Data for Name: operation_runs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.operation_runs (id, revision, type, status, progress, stage, actor_user_id, resource_type, resource_id, request_id, idempotency_key, request_fingerprint, retry_of, cancellable, retryable, result, error, created_at, started_at, heartbeat_at, finished_at) FROM stdin;
\.


--
-- Data for Name: upgrade_rollouts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.upgrade_rollouts (id, revision, actor_user_id, status, task_kind, use_latest_version, requested, completed, succeeded, superseded, failed, waiting, upgrading, needs_attention, idempotency_key, request_fingerprint, created_at, updated_at, finished_at) FROM stdin;
\.


--
-- Data for Name: upgrade_rollout_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.upgrade_rollout_items (rollout_id, instance_id, position, revision, user_id, app_id, source_status, desired_state, source_app_version_id, source_image_artifact_id, source_image_reference, target_app_version_id, target_image_artifact_id, target_image_reference, target_runtime_contract, launch_profile, status, blocker, error, force_requested, attempt_id, attempt_count, next_attempt_at, last_checked_at, started_at, finished_at, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: instance_activity_leases; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.instance_activity_leases (id, instance_id, kind, opened_at, heartbeat_at, last_activity_at) FROM stdin;
\.


--
-- Data for Name: instance_upgrade_drains; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.instance_upgrade_drains (instance_id, rollout_id, attempt_id, expires_at) FROM stdin;
\.


--
-- Data for Name: provisioning_policy; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.provisioning_policy (id, policy, updated_at) FROM stdin;
\.


--
-- Data for Name: runtime_samples; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.runtime_samples (id, instance_id, sampled_at, state, network_rx_bytes, network_tx_bytes, cpu_percent, memory_working_set_bytes, pids, gpu_utilization_percent, error) FROM stdin;
\.


--
-- Data for Name: sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sessions (token_hash, user_id, expires_at, auth_method) FROM stdin;
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.users (id, email, role, created_at, app_initialized_at) FROM stdin;
\.


--
-- Name: app_versions app_versions_app_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_versions
    ADD CONSTRAINT app_versions_app_id_version_key UNIQUE (app_id, version);


--
-- Name: app_versions app_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_versions
    ADD CONSTRAINT app_versions_pkey PRIMARY KEY (id);


--
-- Name: apps apps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apps
    ADD CONSTRAINT apps_pkey PRIMARY KEY (id);


--
-- Name: audit_events audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);


--
-- Name: auth_identities auth_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_identities
    ADD CONSTRAINT auth_identities_pkey PRIMARY KEY (provider, subject);


--
-- Name: build_packages build_packages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_packages
    ADD CONSTRAINT build_packages_pkey PRIMARY KEY (id);


--
-- Name: build_packages build_packages_storage_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_packages
    ADD CONSTRAINT build_packages_storage_key_key UNIQUE (storage_key);


--
-- Name: build_strategies build_strategies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_strategies
    ADD CONSTRAINT build_strategies_pkey PRIMARY KEY (id);


--
-- Name: config_revision_history config_revision_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_revision_history
    ADD CONSTRAINT config_revision_history_pkey PRIMARY KEY (key, revision);


--
-- Name: config_revisions config_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_revisions
    ADD CONSTRAINT config_revisions_pkey PRIMARY KEY (key);


--
-- Name: containers containers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.containers
    ADD CONSTRAINT containers_pkey PRIMARY KEY (id);


--
-- Name: tenant_memberships tenant_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_memberships
    ADD CONSTRAINT tenant_memberships_pkey PRIMARY KEY (tenant_id, user_id);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: workspace_tenant_bindings workspace_tenant_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tenant_bindings
    ADD CONSTRAINT workspace_tenant_bindings_pkey PRIMARY KEY (workspace_id);


--
-- Name: forwarding_policies forwarding_policies_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forwarding_policies
    ADD CONSTRAINT forwarding_policies_name_key UNIQUE (name);


--
-- Name: forwarding_policies forwarding_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forwarding_policies
    ADD CONSTRAINT forwarding_policies_pkey PRIMARY KEY (id);


--
-- Name: health_checks health_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.health_checks
    ADD CONSTRAINT health_checks_pkey PRIMARY KEY (id);


--
-- Name: image_artifacts image_artifacts_build_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_artifacts
    ADD CONSTRAINT image_artifacts_build_id_key UNIQUE (build_id);


--
-- Name: image_artifacts image_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_artifacts
    ADD CONSTRAINT image_artifacts_pkey PRIMARY KEY (id);


--
-- Name: image_builds image_builds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_builds
    ADD CONSTRAINT image_builds_pkey PRIMARY KEY (id);


--
-- Name: local_credentials local_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_credentials
    ADD CONSTRAINT local_credentials_pkey PRIMARY KEY (user_id);


--
-- Name: operation_runs operation_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operation_runs
    ADD CONSTRAINT operation_runs_pkey PRIMARY KEY (id);


--
-- Name: upgrade_rollouts upgrade_rollouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upgrade_rollouts
    ADD CONSTRAINT upgrade_rollouts_pkey PRIMARY KEY (id);


--
-- Name: upgrade_rollout_items upgrade_rollout_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upgrade_rollout_items
    ADD CONSTRAINT upgrade_rollout_items_pkey PRIMARY KEY (rollout_id, instance_id);


--
-- Name: instance_activity_leases instance_activity_leases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_activity_leases
    ADD CONSTRAINT instance_activity_leases_pkey PRIMARY KEY (id);


--
-- Name: instance_upgrade_drains instance_upgrade_drains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_upgrade_drains
    ADD CONSTRAINT instance_upgrade_drains_pkey PRIMARY KEY (instance_id);


--
-- Name: provisioning_policy provisioning_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provisioning_policy
    ADD CONSTRAINT provisioning_policy_pkey PRIMARY KEY (id);


--
-- Name: runtime_samples runtime_samples_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runtime_samples
    ADD CONSTRAINT runtime_samples_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (token_hash);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: app_versions_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX app_versions_active_idx ON public.app_versions USING btree (app_id) WHERE (status = 'active'::text);


--
-- Name: app_versions_app_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_versions_app_idx ON public.app_versions USING btree (app_id, created_at DESC);


--
-- Name: app_versions_revision_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX app_versions_revision_idx ON public.app_versions USING btree (app_id, revision);


--
-- Name: app_versions_image_artifact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_versions_image_artifact_idx ON public.app_versions USING btree (image_artifact_id) WHERE (image_artifact_id IS NOT NULL);


--
-- Name: audit_events_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_created_idx ON public.audit_events USING btree (created_at DESC);


--
-- Name: audit_events_resource_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_resource_idx ON public.audit_events USING btree (resource_type, resource_id, created_at DESC);


--
-- Name: auth_identities_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_identities_user_idx ON public.auth_identities USING btree (user_id);


--
-- Name: build_packages_strategy_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX build_packages_strategy_idx ON public.build_packages USING btree (strategy_id, slot_key, created_at DESC);


--
-- Name: config_revision_history_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX config_revision_history_idx ON public.config_revision_history USING btree (key, revision DESC);


--
-- Name: containers_app_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX containers_app_version_idx ON public.containers USING btree (app_id, app_version_id);


--
-- Name: containers_image_artifact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX containers_image_artifact_idx ON public.containers USING btree (image_artifact_id) WHERE (image_artifact_id IS NOT NULL);


--
-- Name: containers_live_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX containers_live_user_idx ON public.containers USING btree (user_id) WHERE (workspace_status <> 'deleted'::text);


--
-- Name: containers_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX containers_status_idx ON public.containers USING btree (status);


--
-- Name: tenant_memberships_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tenant_memberships_user_idx ON public.tenant_memberships USING btree (user_id);


--
-- Name: workspace_tenant_bindings_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_tenant_bindings_tenant_idx ON public.workspace_tenant_bindings USING btree (tenant_id);


--
-- Name: health_checks_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX health_checks_target_idx ON public.health_checks USING btree (target, checked_at DESC);


--
-- Name: image_builds_operation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX image_builds_operation_idx ON public.image_builds USING btree (operation_id) WHERE (operation_id IS NOT NULL);


--
-- Name: image_builds_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX image_builds_status_idx ON public.image_builds USING btree (status, created_at DESC);


--
-- Name: image_builds_strategy_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX image_builds_strategy_idx ON public.image_builds USING btree (strategy_id, created_at DESC);


--
-- Name: operation_runs_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operation_runs_created_idx ON public.operation_runs USING btree (created_at DESC);


--
-- Name: operation_runs_idempotency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operation_runs_idempotency_idx ON public.operation_runs USING btree (actor_user_id, idempotency_key);


--
-- Name: operation_runs_idempotency_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX operation_runs_idempotency_unique_idx ON public.operation_runs USING btree (actor_user_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: operation_runs_stale_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operation_runs_stale_idx ON public.operation_runs USING btree (COALESCE(heartbeat_at, started_at, created_at)) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));


--
-- Name: operation_runs_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operation_runs_status_idx ON public.operation_runs USING btree (status, created_at DESC);


--
-- Name: upgrade_rollouts_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX upgrade_rollouts_created_idx ON public.upgrade_rollouts USING btree (created_at DESC);


--
-- Name: upgrade_rollouts_idempotency_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX upgrade_rollouts_idempotency_unique_idx ON public.upgrade_rollouts USING btree (actor_user_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: upgrade_rollout_items_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX upgrade_rollout_items_due_v3_idx ON public.upgrade_rollout_items USING btree (next_attempt_at, position) WHERE (status = ANY (ARRAY['queued'::text, 'waiting_for_idle'::text, 'awaiting_first_start'::text]));


--
-- Name: upgrade_rollout_items_interrupted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX upgrade_rollout_items_interrupted_idx ON public.upgrade_rollout_items USING btree (updated_at) WHERE (status = ANY (ARRAY['assessing'::text, 'draining'::text, 'rebuilding'::text, 'verifying'::text]));


--
-- Name: instance_activity_leases_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX instance_activity_leases_active_idx ON public.instance_activity_leases USING btree (instance_id, heartbeat_at DESC);


--
-- Name: instance_upgrade_drains_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX instance_upgrade_drains_expiry_idx ON public.instance_upgrade_drains USING btree (expires_at);


--
-- Name: runtime_samples_instance_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runtime_samples_instance_idx ON public.runtime_samples USING btree (instance_id, sampled_at DESC);


--
-- Name: sessions_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_expiry_idx ON public.sessions USING btree (expires_at);


--
-- Name: app_versions app_versions_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_versions
    ADD CONSTRAINT app_versions_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_versions app_versions_image_artifact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_versions
    ADD CONSTRAINT app_versions_image_artifact_id_fkey FOREIGN KEY (image_artifact_id) REFERENCES public.image_artifacts(id);


--
-- Name: auth_identities auth_identities_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_identities
    ADD CONSTRAINT auth_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: build_packages build_packages_strategy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_packages
    ADD CONSTRAINT build_packages_strategy_id_fkey FOREIGN KEY (strategy_id) REFERENCES public.build_strategies(id);


--
-- Name: containers containers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.containers
    ADD CONSTRAINT containers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: containers containers_image_artifact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.containers
    ADD CONSTRAINT containers_image_artifact_id_fkey FOREIGN KEY (image_artifact_id) REFERENCES public.image_artifacts(id);


--
-- Name: tenant_memberships tenant_memberships_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_memberships
    ADD CONSTRAINT tenant_memberships_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tenant_memberships tenant_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_memberships
    ADD CONSTRAINT tenant_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: workspace_tenant_bindings workspace_tenant_bindings_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tenant_bindings
    ADD CONSTRAINT workspace_tenant_bindings_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: workspace_tenant_bindings workspace_tenant_bindings_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tenant_bindings
    ADD CONSTRAINT workspace_tenant_bindings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: workspace_tenant_bindings workspace_tenant_bindings_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tenant_bindings
    ADD CONSTRAINT workspace_tenant_bindings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.containers(id) ON DELETE CASCADE;


--
-- Name: image_artifacts image_artifacts_build_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_artifacts
    ADD CONSTRAINT image_artifacts_build_id_fkey FOREIGN KEY (build_id) REFERENCES public.image_builds(id);


--
-- Name: image_builds image_builds_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_builds
    ADD CONSTRAINT image_builds_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.operation_runs(id) ON DELETE SET NULL;


--
-- Name: image_builds image_builds_source_app_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_builds
    ADD CONSTRAINT image_builds_source_app_version_id_fkey FOREIGN KEY (source_app_version_id) REFERENCES public.app_versions(id) ON DELETE SET NULL;


--
-- Name: image_builds image_builds_strategy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_builds
    ADD CONSTRAINT image_builds_strategy_id_fkey FOREIGN KEY (strategy_id) REFERENCES public.build_strategies(id);


--
-- Name: local_credentials local_credentials_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_credentials
    ADD CONSTRAINT local_credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: upgrade_rollout_items upgrade_rollout_items_rollout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upgrade_rollout_items
    ADD CONSTRAINT upgrade_rollout_items_rollout_id_fkey FOREIGN KEY (rollout_id) REFERENCES public.upgrade_rollouts(id) ON DELETE CASCADE;


--
-- Name: instance_activity_leases instance_activity_leases_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_activity_leases
    ADD CONSTRAINT instance_activity_leases_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.containers(id) ON DELETE CASCADE;


--
-- Name: instance_upgrade_drains instance_upgrade_drains_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_upgrade_drains
    ADD CONSTRAINT instance_upgrade_drains_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.containers(id) ON DELETE CASCADE;


--
-- Name: instance_upgrade_drains instance_upgrade_drains_rollout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_upgrade_drains
    ADD CONSTRAINT instance_upgrade_drains_rollout_id_fkey FOREIGN KEY (rollout_id) REFERENCES public.upgrade_rollouts(id) ON DELETE CASCADE;


--
-- Name: runtime_samples runtime_samples_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runtime_samples
    ADD CONSTRAINT runtime_samples_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.containers(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict buTx997HahQhk19ScE4Rd0TkIrL26F122EU7SE3XOyGWsVE27s07teXkINsaT27
