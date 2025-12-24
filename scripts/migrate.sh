#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
MIGRATIONS_DIR="$ROOT_DIR/migrations"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found on PATH" >&2
  exit 1
fi

: "${DATABASE_URL:?DATABASE_URL must be set}"

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  echo "Migrations directory not found: $MIGRATIONS_DIR" >&2
  exit 1
fi

MIGRATION_FILES=()
while IFS= read -r file; do
  MIGRATION_FILES+=("$file")
done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name "*.sql" | sort)

if [[ ${#MIGRATION_FILES[@]} -eq 0 ]]; then
  echo "No migration files found in $MIGRATIONS_DIR" >&2
  exit 1
fi

for file in "${MIGRATION_FILES[@]}"; do
  echo "Applying $(basename "$file")" >&2
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$file"
done
