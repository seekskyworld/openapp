#!/bin/sh
set -eu

target="${PORTAL_PUBLIC_BASE_URL:-}"
case "${target}" in
  http://*|https://*) ;;
  *) echo "PORTAL_PUBLIC_BASE_URL is required for forwarding policy initialization" >&2; exit 1 ;;
esac

# Only replace the bootstrap loopback value. A deliberate administrator setting
# on an existing production database must survive subsequent deployments.
psql -v ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" \
  -v target_base_url="${target%/}" <<'SQL'
with migrated as (
  insert into forwarding_policies(
    id, name, target_base_url, allowed_hosts, enabled, updated_by
  ) values (
    'default', 'default', :'target_base_url', array[:'target_base_url'], true, 'deployment'
  )
  on conflict (id) do update set
    target_base_url = excluded.target_base_url,
    allowed_hosts = excluded.allowed_hosts,
    enabled = excluded.enabled,
    updated_by = excluded.updated_by,
    updated_at = now()
  where forwarding_policies.target_base_url ~ '^https?://(127\.0\.0\.1|localhost)(:|/|$)'
  returning id
)
insert into config_revisions(key, revision, updated_by, effect, effective_at, updated_at)
select 'forwarding:default', 1, 'deployment', 'immediate', now(), now()
from migrated
on conflict (key) do update set
  revision = config_revisions.revision + 1,
  updated_by = excluded.updated_by,
  effect = excluded.effect,
  effective_at = excluded.effective_at,
  updated_at = excluded.updated_at;
SQL
