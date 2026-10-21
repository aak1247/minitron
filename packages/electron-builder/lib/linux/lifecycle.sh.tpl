#!/bin/sh
# Debian passes remove/upgrade as $1. RPM passes the number of remaining
# installed versions: 0 means erase and 1 means upgrade.
# The launcher reads the stable per-user locator at
# $HOME/.local/share/SharedElectron/installations.json. That locator may point
# to a custom ELECTRON_RUNTIME_ROOT without involving the root account's cache.

set -u

MINITRON_PACKAGE_KIND=@@PACKAGE_KIND@@
MINITRON_PHASE=@@PHASE@@
MINITRON_INSTALL_DIR=@@INSTALL_DIR@@
MINITRON_EXECUTABLE_NAME=@@EXECUTABLE_NAME@@
MINITRON_ACTION=${1:-}
MINITRON_LAUNCHER="$MINITRON_INSTALL_DIR/$MINITRON_EXECUTABLE_NAME"

if [ "$MINITRON_PHASE" = install ]; then
  if [ "$MINITRON_PACKAGE_KIND" != rpm ]; then
    echo "Minitron before-install lifecycle is only supported for RPM packages." >&2
    exit 1
  fi
  # RPM runs %pre on both first install and upgrade, before unpacking the
  # new payload. On a first install there is no old launcher to stop.
  if [ ! -x "$MINITRON_LAUNCHER" ]; then
    exit 0
  fi
  MINITRON_UNINSTALL=0
else
  case "$MINITRON_PACKAGE_KIND:$MINITRON_ACTION" in
    deb:upgrade)
      MINITRON_UNINSTALL=0
      ;;
    deb:remove|deb:purge)
      MINITRON_UNINSTALL=1
      ;;
    deb:*)
      exit 0
      ;;
    rpm:0)
      MINITRON_UNINSTALL=1
      ;;
    rpm:*)
      MINITRON_UNINSTALL=0
      ;;
  esac

  if [ ! -x "$MINITRON_LAUNCHER" ]; then
    echo "Minitron launcher is missing before package removal: $MINITRON_LAUNCHER" >&2
    exit 1
  fi
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Minitron package lifecycle must run as root." >&2
  exit 1
fi
if ! command -v runuser >/dev/null 2>&1; then
  echo "Minitron package lifecycle requires runuser from util-linux." >&2
  exit 1
fi

run_as_user() {
  runuser -u "$MINITRON_USER" -- env \
    HOME="$MINITRON_HOME" \
    USER="$MINITRON_USER" \
    LOGNAME="$MINITRON_USER" \
    ELECTRON_RUNTIME_ROOT="$MINITRON_RUNTIME_ROOT" \
    "$@"
}

process_passwd_entries() {
  MINITRON_FAILED=0
  MINITRON_SEEN_UIDS="|"
  while IFS=: read -r MINITRON_USER _ MINITRON_UID _ _ MINITRON_HOME _; do
    case "$MINITRON_UID" in
      ''|*[!0-9]*) continue ;;
    esac
    case "$MINITRON_SEEN_UIDS" in
      *"|$MINITRON_UID|"*) continue ;;
    esac
    MINITRON_SEEN_UIDS="$MINITRON_SEEN_UIDS$MINITRON_UID|"
    case "$MINITRON_HOME" in
      /*) ;;
      *) continue ;;
    esac

    MINITRON_RUNTIME_ROOT=$(runuser -u "$MINITRON_USER" -- env \
      HOME="$MINITRON_HOME" \
      USER="$MINITRON_USER" \
      LOGNAME="$MINITRON_USER" \
      "$MINITRON_LAUNCHER" --app-dir "$MINITRON_INSTALL_DIR" --runtime-root 2>/dev/null) || continue
    case "$MINITRON_RUNTIME_ROOT" in
      /*) ;;
      *) continue ;;
    esac

    if ! run_as_user "$MINITRON_LAUNCHER" --app-dir "$MINITRON_INSTALL_DIR" --stop; then
      echo "Could not stop Minitron for user $MINITRON_USER." >&2
      MINITRON_FAILED=1
      continue
    fi

    if [ "$MINITRON_UNINSTALL" -eq 1 ]; then
      if ! run_as_user "$MINITRON_LAUNCHER" --app-dir "$MINITRON_INSTALL_DIR" --uninstall; then
        echo "Could not unregister Minitron for user $MINITRON_USER." >&2
        MINITRON_FAILED=1
      fi
    fi
  done
  return "$MINITRON_FAILED"
}

if command -v getent >/dev/null 2>&1; then
  if ! getent passwd | process_passwd_entries; then
    exit 1
  fi
elif [ -r /etc/passwd ]; then
  if ! cat /etc/passwd | process_passwd_entries; then
    exit 1
  fi
else
  echo "Minitron package lifecycle cannot enumerate local users." >&2
  exit 1
fi

exit 0
