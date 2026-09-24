#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "${ROOT_DIR}"
ENV_FILE="${DEPLOYMENT_ENV_FILE:-.env}"
PORTAL_SERVICE="${OPENAPP_PORTAL_SERVICE:-portal-backend}"
[[ -f "${ENV_FILE}" ]] || { echo "deployment env file not found: ${ENV_FILE}" >&2; exit 1; }
set -a
. "${ENV_FILE}"
set +a
source "${ROOT_DIR}/compose-files.sh"

super_admin_email="${OPENAPP_BOOTSTRAP_SUPER_ADMIN_EMAIL:-${OPENAPP_BOOTSTRAP_ADMIN_EMAIL:-}}"
if [[ -z "${super_admin_email}" ]]; then
  [[ -t 0 ]] || {
    echo "set OPENAPP_BOOTSTRAP_SUPER_ADMIN_EMAIL when running non-interactively" >&2
    exit 2
  }
  read -rp 'Initial super administrator email: ' super_admin_email
fi
super_admin_email="$(printf '%s' "${super_admin_email}" | tr '[:upper:]' '[:lower:]')"
super_admin_email="${super_admin_email#"${super_admin_email%%[![:space:]]*}"}"
super_admin_email="${super_admin_email%"${super_admin_email##*[![:space:]]}"}"
[[ "${super_admin_email}" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || {
  echo "super administrator email is invalid" >&2
  exit 2
}

if [[ -n "${OPENAPP_BOOTSTRAP_SUPER_ADMIN_PASSWORD+x}" ]]; then
  super_admin_password="${OPENAPP_BOOTSTRAP_SUPER_ADMIN_PASSWORD}"
elif [[ -n "${OPENAPP_BOOTSTRAP_ADMIN_PASSWORD+x}" ]]; then
  super_admin_password="${OPENAPP_BOOTSTRAP_ADMIN_PASSWORD}"
else
  [[ -t 0 ]] || {
    echo "set OPENAPP_BOOTSTRAP_SUPER_ADMIN_PASSWORD when running non-interactively" >&2
    exit 2
  }
  read -rsp 'Initial super administrator password: ' super_admin_password
  echo
  read -rsp 'Confirm super administrator password: ' password_confirmation
  echo
  [[ "${super_admin_password}" == "${password_confirmation}" ]] || {
    unset super_admin_password password_confirmation
    echo "password confirmation does not match" >&2
    exit 2
  }
  unset password_confirmation
fi

password_hash="$(
  printf '%s' "${super_admin_password}" |
    openapp_compose exec -T "${PORTAL_SERVICE}" \
      sh -c 'cd /app/backend && exec node --input-type=module -e '\''
import { hashLocalPassword } from "./dist/auth/local-password.js";
let password = "";
for await (const chunk of process.stdin) password += chunk;
try {
  process.stdout.write(await hashLocalPassword(password));
} catch (error) {
  console.error(error instanceof Error ? error.message : "invalid_password");
  process.exit(2);
}
'\'''
)"
unset super_admin_password
[[ "${password_hash}" == scrypt-v1\$* ]] || {
  echo "failed to generate super administrator password hash" >&2
  exit 1
}

openapp_compose exec -T \
  -e "OPENAPP_BOOTSTRAP_SUPER_ADMIN_EMAIL=${super_admin_email}" \
  -e "OPENAPP_BOOTSTRAP_PASSWORD_HASH=${password_hash}" \
  postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -v super_admin_email="$OPENAPP_BOOTSTRAP_SUPER_ADMIN_EMAIL" \
    -v password_hash="$OPENAPP_BOOTSTRAP_PASSWORD_HASH"' <<'SQL'
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('openapp:role-governance'));
SELECT EXISTS (
  SELECT 1 FROM users
  WHERE role='super_admin'
) AS bootstrap_conflict
\gset
\if :bootstrap_conflict
  \echo 'A super administrator already exists; bootstrap never resets an existing administrator.'
  DO $bootstrap$
  BEGIN
    RAISE EXCEPTION 'a super administrator already exists';
  END
  $bootstrap$;
\endif
SELECT COALESCE(
  (SELECT role FROM users WHERE email=lower(:'super_admin_email')),
  'absent'
) AS previous_role
\gset
INSERT INTO users(id,email,role)
VALUES (concat('super-admin-', md5(lower(:'super_admin_email'))), lower(:'super_admin_email'), 'super_admin')
ON CONFLICT(email) DO UPDATE SET role='super_admin'
RETURNING id AS super_admin_id
\gset
INSERT INTO auth_identities(provider,subject,user_id,email_snapshot)
VALUES ('local',lower(:'super_admin_email'),:'super_admin_id',lower(:'super_admin_email'))
ON CONFLICT(provider,subject) DO UPDATE
SET email_snapshot=excluded.email_snapshot,last_authenticated_at=now()
WHERE auth_identities.user_id=excluded.user_id
RETURNING user_id AS local_identity_user_id
\gset
INSERT INTO local_credentials(user_id,password_hash)
VALUES (:'super_admin_id',:'password_hash')
ON CONFLICT(user_id) DO UPDATE
SET password_hash=excluded.password_hash,password_changed_at=now();
DELETE FROM sessions WHERE user_id=:'super_admin_id';
INSERT INTO audit_events(id,actor_user_id,action,resource_type,resource_id,metadata)
VALUES (
  concat('bootstrap-', md5(:'super_admin_id' || clock_timestamp()::text || random()::text)),
  NULL,
  'user.bootstrap_super_admin',
  'user',
  :'super_admin_id',
  jsonb_build_object(
    'afterRole', 'super_admin',
    'beforeRole', :'previous_role',
    'email', lower(:'super_admin_email')
  )
);
COMMIT;
SQL
unset password_hash

echo "Super administrator bootstrap completed for ${super_admin_email}"
