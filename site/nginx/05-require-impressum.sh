#!/bin/sh
# A legal notice with blanks must never go online, so the container stops instead
set -eu

for name in IMPRESSUM_NAME IMPRESSUM_STREET IMPRESSUM_CITY IMPRESSUM_EMAIL PRIVACY_LOG_DAYS; do
    value=$(printenv "$name" || true)
    if [ -z "$value" ]; then
        echo "usestraw-site: set $name" >&2
        exit 1
    fi
    case "$value" in
        *'"'* | *'\'* | *'$'* | *'{'* | *'}'*)
            echo "usestraw-site: $name must not contain \", \\, \$, { or }" >&2
            exit 1
            ;;
    esac
done

case "$PRIVACY_LOG_DAYS" in
    *[!0-9]*)
        echo "usestraw-site: PRIVACY_LOG_DAYS must be a number of days" >&2
        exit 1
        ;;
esac
