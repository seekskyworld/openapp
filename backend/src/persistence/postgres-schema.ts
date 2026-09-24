/** 平台 schema 初始化独立维护；这里只执行通用的幂等 DDL，不注入产品数据。 */
import type pg from "pg";
export async function initializeCoreSchema(pool: Pick<pg.Pool, "query">): Promise<void> {
  await pool.query(`
      create table if not exists users (
        id text primary key,
        email text unique not null,
        role text not null default 'user' constraint users_role_check check (role in ('user', 'admin', 'super_admin')),
        created_at timestamptz not null default now(),
        app_initialized_at timestamptz
      );
      do $$ begin
        if not exists (
          select 1 from pg_constraint
          where conname = 'users_role_check' and conrelid = 'users'::regclass
        ) then
          alter table users add constraint users_role_check
            check (role in ('user', 'admin', 'super_admin'));
        elsif not exists (
          select 1 from pg_constraint
          where conname = 'users_role_check' and conrelid = 'users'::regclass
            and pg_get_constraintdef(oid) like '%super_admin%'
        ) then
          alter table users drop constraint users_role_check;
          alter table users add constraint users_role_check
            check (role in ('user', 'admin', 'super_admin'));
        end if;
      end $$;
      create table if not exists auth_identities (
        provider text not null,
        subject text not null,
        user_id text not null references users(id) on delete cascade,
        email_snapshot text not null,
        created_at timestamptz not null default now(),
        last_authenticated_at timestamptz not null default now(),
        primary key (provider, subject)
      );
      create index if not exists auth_identities_user_idx on auth_identities(user_id);
      create table if not exists local_credentials (
        user_id text primary key references users(id) on delete cascade,
        password_hash text not null,
        password_changed_at timestamptz not null default now()
      );
      create table if not exists sessions (
        token_hash text primary key,
        user_id text not null references users(id) on delete cascade,
        expires_at timestamptz not null,
        auth_method text not null default 'external'
      );
      create index if not exists sessions_expiry_idx on sessions(expires_at);
      create table if not exists containers (
        id text primary key,
        user_id text not null references users(id) on delete cascade,
        app_id text not null,
        runtime_id text not null,
        status text not null check (status in ('creating', 'running', 'stopped', 'failed')),
        endpoint text,
        stop_reason text check (stop_reason in ('idle', 'manual_user', 'manual_admin', 'failure')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        last_activity_at timestamptz not null default now(),
        app_version_id text,
        image_reference text,
        image_artifact_id text,
        workspace_status text not null default 'active',
        storage_ref_id text,
        active_execution_id text,
        provider_id text not null default 'docker',
        environment_ref text,
        execution_role text not null default 'active',
        desired_generation bigint not null default 1,
        deployed_generation bigint,
        healthy_generation bigint,
        transaction_id text,
        transaction_status text,
        desired_state text,
        observed_state text,
        desired_app_revision_id text,
        desired_launch_artifact_id text,
        desired_launch_artifact_reference text,
        execution_revision bigint not null default 1,
        execution_image_artifact_id text,
        execution_image_reference text,
        execution_endpoint text,
        execution_model_version integer not null default 2,
        deletion_transaction_id text,
        deletion_phase text,
        deletion_failure text,
        deleted_at timestamptz
      );
      alter table containers add column if not exists stop_reason text;
      alter table containers add column if not exists workspace_status text default 'active';
      alter table containers add column if not exists storage_ref_id text;
      alter table containers add column if not exists active_execution_id text;
      alter table containers add column if not exists provider_id text default 'docker';
      alter table containers add column if not exists environment_ref text;
      alter table containers add column if not exists execution_role text default 'active';
      alter table containers add column if not exists desired_generation bigint default 1;
      alter table containers add column if not exists deployed_generation bigint;
      alter table containers add column if not exists healthy_generation bigint;
      alter table containers add column if not exists transaction_id text;
      alter table containers add column if not exists transaction_status text;
      alter table containers add column if not exists desired_state text;
      alter table containers add column if not exists observed_state text;
      alter table containers add column if not exists desired_app_revision_id text;
      alter table containers add column if not exists desired_launch_artifact_id text;
      alter table containers add column if not exists desired_launch_artifact_reference text;
      alter table containers add column if not exists execution_revision bigint default 1;
      alter table containers add column if not exists execution_image_artifact_id text;
      alter table containers add column if not exists execution_image_reference text;
      alter table containers add column if not exists execution_endpoint text;
      alter table containers add column if not exists execution_model_version integer;
      alter table containers add column if not exists deletion_transaction_id text;
      alter table containers add column if not exists deletion_phase text;
      alter table containers add column if not exists deletion_failure text;
      alter table containers add column if not exists deleted_at timestamptz;
      update containers set
        workspace_status=coalesce(workspace_status,'active'),
        storage_ref_id=coalesce(storage_ref_id,'workspace-storage:' || id),
        active_execution_id=coalesce(active_execution_id,id || ':docker'),
        provider_id=coalesce(provider_id,'docker'),
        environment_ref=case when runtime_id='pending' then null else runtime_id end,
        execution_role=coalesce(execution_role,'active'),
        desired_generation=coalesce(desired_generation,1),
        deployed_generation=coalesce(deployed_generation,case when status='creating' then 0 else 1 end),
        healthy_generation=case when status='running' then coalesce(healthy_generation,1) else healthy_generation end,
        transaction_id=coalesce(transaction_id,'legacy-import:' || id),
        transaction_status=coalesce(transaction_status,case when status='creating' then 'progressing' when status='failed' then 'failed' else 'applied' end),
        desired_state=coalesce(desired_state,case when status='stopped' then 'stopped' else 'running' end),
        observed_state=status,
        execution_revision=coalesce(execution_revision,1),
        execution_image_artifact_id=image_artifact_id,
        execution_image_reference=image_reference,
        execution_endpoint=endpoint
      where storage_ref_id is null
         or active_execution_id is null
         or deployed_generation is null
         or transaction_status is null
         or desired_state is null
         or observed_state is null
         or execution_revision is null;
      update containers set
        desired_app_revision_id=app_version_id,
        desired_launch_artifact_id=image_artifact_id,
        desired_launch_artifact_reference=image_reference,
        execution_model_version=2
      where execution_model_version is null;
      alter table containers alter column workspace_status set not null;
      alter table containers alter column storage_ref_id set not null;
      alter table containers alter column active_execution_id drop not null;
      alter table containers alter column provider_id set not null;
      alter table containers alter column execution_role set not null;
      alter table containers alter column desired_generation set not null;
      alter table containers alter column deployed_generation set not null;
      alter table containers alter column transaction_status set not null;
      alter table containers alter column desired_state set not null;
      alter table containers alter column observed_state set not null;
      alter table containers alter column execution_revision set not null;
      alter table containers alter column execution_model_version set default 2;
      alter table containers alter column execution_model_version set not null;
      alter table containers drop constraint if exists containers_user_id_key;
      create unique index if not exists containers_live_user_idx
        on containers(user_id) where workspace_status <> 'deleted';
      do $$ begin
        if not exists (
          select 1 from pg_constraint
          where conname = 'containers_stop_reason_check' and conrelid = 'containers'::regclass
        ) then
          alter table containers add constraint containers_stop_reason_check
            check (stop_reason in ('idle', 'manual_user', 'manual_admin', 'failure'));
        end if;
        if not exists (
          select 1 from pg_constraint
          where conname = 'containers_workspace_execution_check' and conrelid = 'containers'::regclass
        ) then
          alter table containers add constraint containers_workspace_execution_check check (
            workspace_status in ('active','deleting','deleted')
            and execution_role in ('active','candidate','previous','retired')
            and transaction_status in ('requested','progressing','applied','awaiting_first_start','rolled_back','failed','inconsistent')
            and desired_state in ('running','stopped')
            and observed_state in ('absent','creating','running','stopped','failed','unknown')
            and desired_generation >= deployed_generation
            and deployed_generation >= 0
            and (healthy_generation is null or (healthy_generation >= 0 and healthy_generation <= deployed_generation))
            and execution_revision > 0
            and execution_model_version >= 2
          );
        end if;
        if not exists (
          select 1 from pg_constraint
          where conname = 'containers_workspace_deletion_check' and conrelid = 'containers'::regclass
        ) then
          alter table containers add constraint containers_workspace_deletion_check check (
            (workspace_status='active'
              and deletion_transaction_id is null and deletion_phase is null
              and deletion_failure is null and deleted_at is null)
            or (workspace_status='deleting'
              and deletion_transaction_id is not null
              and deletion_phase in ('draining','removing_environments','verifying_references','releasing_storage','finalizing')
              and deleted_at is null)
            or (workspace_status='deleted'
              and deletion_transaction_id is not null and deletion_phase='deleted'
              and deleted_at is not null and active_execution_id is null
              and execution_role='retired' and environment_ref is null)
          );
        end if;
      end $$;
      create index if not exists containers_status_idx on containers(status);
      -- M5 先建立独立 Tenant 投影，旧 users/containers 表继续保留为兼容读写来源。
      create table if not exists tenants (
        id text primary key,
        kind text not null check (kind in ('personal','organization')),
        name text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table if not exists tenant_memberships (
        tenant_id text not null references tenants(id) on delete cascade,
        user_id text not null references users(id) on delete cascade,
        role text not null check (role in ('owner','admin','member')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        primary key (tenant_id, user_id)
      );
      create index if not exists tenant_memberships_user_idx on tenant_memberships(user_id);
      create table if not exists workspace_tenant_bindings (
        workspace_id text primary key references containers(id) on delete cascade,
        tenant_id text not null references tenants(id) on delete restrict,
        owner_id text not null references users(id) on delete cascade,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists workspace_tenant_bindings_tenant_idx on workspace_tenant_bindings(tenant_id);
      -- 历史用户和 Workspace 只投影到自己的 Personal Tenant，重复执行安全。
      insert into tenants(id, kind, name)
      select 'personal:' || u.id, 'personal', u.email from users u
      on conflict(id) do update
        set name=excluded.name, updated_at=now()
        where tenants.name is distinct from excluded.name;
      insert into tenant_memberships(tenant_id, user_id, role)
      select 'personal:' || u.id, u.id, 'owner' from users u
      on conflict(tenant_id, user_id) do nothing;
      insert into workspace_tenant_bindings(workspace_id, tenant_id, owner_id)
      select c.id, 'personal:' || c.user_id, c.user_id from containers c
      where c.workspace_status <> 'deleted'
      on conflict(workspace_id) do nothing;
      create table if not exists apps (
        id text primary key,
        name text not null,
        description text not null default '',
        auth_adapter_id text not null default 'none',
        status text not null default 'active' check (status in ('active','archived')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table if not exists app_versions (
        id text primary key,
        app_id text not null references apps(id) on delete cascade,
        version text not null,
        build_id text not null,
        packages jsonb not null default '[]'::jsonb,
        image_reference text,
        runtime_contract text,
        status text not null check (status in ('legacy','uploaded','image_ready','active','archived')),
        created_at timestamptz not null default now(),
        activated_at timestamptz,
        revision bigint not null,
        image_artifact_id text,
        unique(app_id, version)
      );
      create index if not exists app_versions_app_idx on app_versions(app_id, created_at desc);
      alter table app_versions add column if not exists source_kind text not null default 'packages' check (source_kind in ('packages','image'));
      create unique index if not exists app_versions_revision_idx on app_versions(app_id, revision);
      create unique index if not exists app_versions_active_idx on app_versions(app_id) where status='active';
      create index if not exists containers_app_version_idx on containers(app_id, app_version_id);
      create table if not exists forwarding_policies (id text primary key, name text unique not null, target_base_url text not null, allowed_hosts text[] not null default '{}', enabled boolean not null default true, updated_by text not null, updated_at timestamptz not null default now());
      create table if not exists audit_events (id text primary key, actor_user_id text, action text not null, resource_type text not null, resource_id text, metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());
      create index if not exists audit_events_created_idx on audit_events(created_at desc);
      create index if not exists audit_events_resource_idx on audit_events(resource_type, resource_id, created_at desc);
      create table if not exists runtime_samples (
        id text primary key,
        instance_id text not null references containers(id) on delete cascade,
        sampled_at timestamptz not null,
        state text not null check (state in ('creating', 'running', 'stopped', 'failed')),
        network_rx_bytes double precision,
        network_tx_bytes double precision,
        cpu_percent double precision,
        memory_working_set_bytes double precision,
        pids integer,
        gpu_utilization_percent double precision,
        error text
      );
      create index if not exists runtime_samples_instance_idx on runtime_samples(instance_id, sampled_at desc);
      create table if not exists health_checks (
        id text primary key,
        target text not null,
        checked_at timestamptz not null,
        healthy boolean not null,
        latency_ms double precision,
        error text
      );
      create index if not exists health_checks_target_idx on health_checks(target, checked_at desc);
      create table if not exists operation_runs (
        id text primary key,
        revision bigint not null default 1,
        type text not null,
        status text not null check (status in ('queued','running','succeeded','failed','cancelled')),
        progress integer not null default 0,
        stage text not null,
        actor_user_id text not null,
        resource_type text not null,
        resource_id text,
        request_id text not null,
        idempotency_key text,
        request_fingerprint text,
        retry_of text,
        cancellable boolean not null default false,
        retryable boolean not null default false,
        result jsonb,
        error text,
        created_at timestamptz not null default now(),
        started_at timestamptz,
        heartbeat_at timestamptz,
        finished_at timestamptz
      );
      create index if not exists operation_runs_created_idx on operation_runs(created_at desc);
      create index if not exists operation_runs_status_idx on operation_runs(status, created_at desc);
      create index if not exists operation_runs_stale_idx
        on operation_runs ((coalesce(heartbeat_at, started_at, created_at)))
        where status in ('queued', 'running');
      create index if not exists operation_runs_idempotency_idx on operation_runs(actor_user_id, idempotency_key);
      create unique index if not exists operation_runs_idempotency_unique_idx
        on operation_runs(actor_user_id, idempotency_key) where idempotency_key is not null;
      create table if not exists upgrade_rollouts (
        id text primary key,
        revision bigint not null default 1,
        actor_user_id text not null,
        status text not null check (status in ('running','succeeded','partial_failed','cancelled','needs_attention')),
        task_kind text not null default 'image_upgrade' constraint upgrade_rollouts_task_kind_check
          check (task_kind in ('image_upgrade','rebuild_same_image','apply_resource_policy','instance_recovery')),
        use_latest_version boolean not null,
        requested integer not null,
        completed integer not null default 0,
        succeeded integer not null default 0,
        failed integer not null default 0,
        superseded integer not null default 0,
        waiting integer not null default 0,
        upgrading integer not null default 0,
        needs_attention integer not null default 0,
        idempotency_key text,
        request_fingerprint text not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        finished_at timestamptz
      );
      alter table upgrade_rollouts add column if not exists upgrading integer not null default 0;
      alter table upgrade_rollouts add column if not exists needs_attention integer not null default 0;
      alter table upgrade_rollouts add column if not exists superseded integer not null default 0;
      alter table upgrade_rollouts add column if not exists task_kind text not null default 'image_upgrade';
      update upgrade_rollouts set task_kind='image_upgrade' where task_kind is null;
      alter table upgrade_rollouts alter column task_kind set not null;
      alter table upgrade_rollouts drop constraint if exists upgrade_rollouts_task_kind_check;
      do $$ begin
        alter table upgrade_rollouts add constraint upgrade_rollouts_task_kind_check
          check (task_kind in ('image_upgrade','rebuild_same_image','apply_resource_policy','instance_recovery'));
      end $$;
      create index if not exists upgrade_rollouts_created_idx on upgrade_rollouts(created_at desc);
      create unique index if not exists upgrade_rollouts_idempotency_unique_idx
        on upgrade_rollouts(actor_user_id,idempotency_key) where idempotency_key is not null;
      create table if not exists upgrade_rollout_items (
        rollout_id text not null references upgrade_rollouts(id) on delete cascade,
        instance_id text not null,
        position integer not null,
        revision bigint not null default 1,
        user_id text not null,
        app_id text not null,
        source_status text not null check (source_status in ('creating','running','stopped','failed')),
        desired_state text not null check (desired_state in ('running','stopped')),
        source_app_version_id text,
        source_image_artifact_id text,
        source_image_reference text,
        target_app_version_id text,
        target_image_artifact_id text,
        target_image_reference text not null,
        target_runtime_contract text,
        launch_profile jsonb not null,
        recovery boolean not null default false,
        status text not null constraint upgrade_rollout_items_status_check_v3
          check (status in ('queued','assessing','waiting_for_idle','draining','rebuilding','verifying','awaiting_first_start','succeeded','superseded','failed','cancelled','needs_attention')),
        blocker text,
        error text,
        diagnostics jsonb,
        force_requested boolean not null default false,
        attempt_id text,
        attempt_count integer not null default 0,
        next_attempt_at timestamptz,
        last_checked_at timestamptz,
        started_at timestamptz,
        finished_at timestamptz,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        primary key (rollout_id,instance_id)
      );
      alter table upgrade_rollout_items add column if not exists attempt_id text;
      alter table upgrade_rollout_items add column if not exists source_image_artifact_id text;
      alter table upgrade_rollout_items add column if not exists recovery boolean not null default false;
      alter table upgrade_rollout_items add column if not exists diagnostics jsonb;
      alter table upgrade_rollout_items drop constraint if exists upgrade_rollout_items_status_check;
      alter table upgrade_rollout_items drop constraint if exists upgrade_rollout_items_status_check_v2;
      alter table upgrade_rollout_items drop constraint if exists upgrade_rollout_items_status_check_v3;
      do $$ begin
        if not exists (
          select 1 from pg_constraint
          where conrelid='upgrade_rollout_items'::regclass
            and conname='upgrade_rollout_items_status_check_v3'
        ) then
          alter table upgrade_rollout_items add constraint upgrade_rollout_items_status_check_v3
            check (status in ('queued','assessing','waiting_for_idle','draining','rebuilding','verifying','awaiting_first_start','succeeded','superseded','failed','cancelled','needs_attention'));
        end if;
      end $$;
      drop index if exists upgrade_rollout_items_due_idx;
      drop index if exists upgrade_rollout_items_due_v2_idx;
      create index if not exists upgrade_rollout_items_due_v3_idx
        on upgrade_rollout_items(next_attempt_at,position)
        where status in ('queued','waiting_for_idle','awaiting_first_start');
      create index if not exists upgrade_rollout_items_interrupted_idx
        on upgrade_rollout_items(updated_at)
        where status in ('assessing','draining','rebuilding','verifying');
      drop index if exists upgrade_rollout_items_resumable_instance_unique_idx;
      create table if not exists instance_activity_leases (
        id text primary key,
        instance_id text not null references containers(id) on delete cascade,
        kind text not null check (kind in ('http','websocket')),
        opened_at timestamptz not null,
        heartbeat_at timestamptz not null,
        last_activity_at timestamptz not null
      );
      create index if not exists instance_activity_leases_active_idx
        on instance_activity_leases(instance_id,heartbeat_at desc);
      create table if not exists instance_upgrade_drains (
        instance_id text primary key references containers(id) on delete cascade,
        rollout_id text not null references upgrade_rollouts(id) on delete cascade,
        attempt_id text not null,
        expires_at timestamptz not null
      );
      alter table instance_upgrade_drains add column if not exists attempt_id text;
      update instance_upgrade_drains set attempt_id=rollout_id where attempt_id is null;
      alter table instance_upgrade_drains alter column attempt_id set not null;
      create index if not exists instance_upgrade_drains_expiry_idx
        on instance_upgrade_drains(expires_at);
      create table if not exists build_strategies (
        id text primary key,
        revision integer not null default 3,
        name text not null,
        description text not null default '',
        runtime_contract text not null default 'none',
        package_requirements jsonb not null default '[]'::jsonb,
        status text not null default 'active' check (status in ('active','archived')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table if not exists build_packages (
        id text primary key,
        strategy_id text not null references build_strategies(id),
        slot_key text not null,
        artifact jsonb not null,
        original_name text not null,
        storage_key text unique not null,
        uploaded_by text not null,
        created_at timestamptz not null default now(),
        source_version text,
        source_build_id text,
        inspected_at timestamptz
      );
      create index if not exists build_packages_strategy_idx
        on build_packages(strategy_id, slot_key, created_at desc);
      create table if not exists image_builds (
        id text primary key,
        strategy_id text not null references build_strategies(id),
        strategy_snapshot jsonb not null,
        operation_id text references operation_runs(id) on delete set null,
        source_app_version_id text references app_versions(id) on delete set null,
        requested_by text not null,
        packages jsonb not null default '[]'::jsonb,
        status text not null check (status in ('queued','building','succeeded','failed','cancelled')),
        error text,
        created_at timestamptz not null default now(),
        started_at timestamptz,
        finished_at timestamptz
      );
      create index if not exists image_builds_strategy_idx on image_builds(strategy_id, created_at desc);
      create index if not exists image_builds_status_idx on image_builds(status, created_at desc);
      create index if not exists image_builds_operation_idx on image_builds(operation_id) where operation_id is not null;
      create table if not exists image_artifacts (
        id text primary key,
        build_id text unique not null references image_builds(id),
        image_reference text not null,
        image_id text not null,
        runtime_contract text not null default 'none',
        created_at timestamptz not null default now()
      );
      do $$ begin
        if not exists (
          select 1 from pg_constraint
          where conrelid = 'containers'::regclass
            and conname = 'containers_image_artifact_id_fkey'
        ) then
          alter table containers
            add constraint containers_image_artifact_id_fkey
            foreign key (image_artifact_id) references image_artifacts(id) not valid;
        end if;
        -- 历史快照可能早于制品目录；保留原引用，不伪造构建来源。
        -- NOT VALID 仍约束新增及变更的引用；历史缺口消除后再完成全表校验。
        if exists (
          select 1 from pg_constraint
          where conrelid = 'containers'::regclass
            and conname = 'containers_image_artifact_id_fkey' and not convalidated
        ) and not exists (
          select 1 from containers c
          where c.image_artifact_id is not null
            and not exists (select 1 from image_artifacts a where a.id = c.image_artifact_id)
        ) then
          alter table containers validate constraint containers_image_artifact_id_fkey;
        end if;
      end $$;
      create index if not exists app_versions_image_artifact_idx on app_versions(image_artifact_id) where image_artifact_id is not null;
      create index if not exists containers_image_artifact_idx on containers(image_artifact_id) where image_artifact_id is not null;
      create table if not exists provisioning_policy (id text primary key, policy jsonb not null, updated_at timestamptz not null default now());
      create table if not exists config_revisions (
        key text primary key,
        revision bigint not null default 0,
        updated_by text not null default 'system',
        effect text not null default 'immediate' check (effect in ('immediate','new_instances','restart','rebuild')),
        effective_at timestamptz,
        updated_at timestamptz not null default now()
      );
      create table if not exists config_revision_history (
        key text not null,
        revision bigint not null,
        updated_by text not null,
        effect text not null check (effect in ('immediate','new_instances','restart','rebuild')),
        effective_at timestamptz,
        payload jsonb not null default 'null'::jsonb,
        created_at timestamptz not null default now(),
        primary key (key, revision)
      );
      create index if not exists config_revision_history_idx on config_revision_history(key, revision desc);
      insert into config_revisions(key, revision, updated_by, effect, effective_at)
        values ('instance-policy', 0, 'system', 'immediate', now()), ('forwarding:default', 0, 'system', 'immediate', now())
        on conflict(key) do nothing;
    `);
}
