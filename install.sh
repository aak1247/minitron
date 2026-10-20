#!/bin/sh
set -eu

version=latest
install_dir=.
base_url=https://github.com/aak1247/minitron/releases

usage() {
    cat <<'EOF'
Usage: install.sh [--version TAG] [--dir DIRECTORY] [--base-url URL]

Install the latest minitron release by default. The install directory defaults
to the current directory. --base-url is intended for release mirrors and tests.
EOF
}

fail() {
    printf '%s\n' "Installation failed: $*" >&2
    exit 1
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --version)
            [ "$#" -ge 2 ] || fail "--version requires a release tag."
            version=$2
            shift 2
            ;;
        --dir)
            [ "$#" -ge 2 ] || fail "--dir requires a directory."
            install_dir=$2
            shift 2
            ;;
        --base-url)
            [ "$#" -ge 2 ] || fail "--base-url requires a URL."
            base_url=$2
            shift 2
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            fail "Unknown argument '$1'. Use --help for usage."
            ;;
    esac
done

case "$version" in
    ''|*[!A-Za-z0-9._-]*) fail "Invalid version '$version'. Use a release tag such as v0.1.0." ;;
esac
case "$version" in
    [A-Za-z0-9]*) ;;
    *) fail "Invalid version '$version'. Use a release tag such as v0.1.0." ;;
esac
case "$base_url" in
    http://*|https://*) ;;
    *) fail "--base-url must be an absolute HTTP or HTTPS URL." ;;
esac
case "$base_url" in
    *\?*|*\#*) fail "--base-url must not include a query or fragment." ;;
esac
while [ "${base_url%/}" != "$base_url" ]; do
    base_url=${base_url%/}
done

command -v curl >/dev/null 2>&1 || fail 'curl is required to download a release.'
command -v tar >/dev/null 2>&1 || fail 'tar is required to unpack a release.'

system=$(uname -s 2>/dev/null || printf unknown)
machine=$(uname -m 2>/dev/null || printf unknown)
case "$system" in
    Linux) platform=linux ;;
    Darwin) platform=macos ;;
    *) fail "Operating system '$system' is not supported. Supported targets: Linux x64 and macOS x64/arm64." ;;
esac
case "$machine" in
    x86_64|amd64|AMD64) architecture=x64 ;;
    arm64|aarch64) architecture=arm64 ;;
    *) fail "Architecture '$machine' is not published. Supported targets: Linux x64 and macOS x64/arm64." ;;
esac
if [ "$platform" = linux ] && [ "$architecture" != x64 ]; then
    fail "Linux $architecture is not published. Supported Linux target: x64."
fi

command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || \
    fail 'A SHA-256 utility (sha256sum or shasum) is required to verify the release.'

if [ "$version" = latest ]; then
    latest_url=$(curl --fail --location --silent --show-error --output /dev/null --write-out '%{url_effective}' "$base_url/latest") || \
        fail "Could not resolve the latest release from '$base_url'."
    case "$latest_url" in
        "$base_url/tag/"*) tag=${latest_url#"$base_url/tag/"} ;;
        *) fail "Could not resolve a release tag from '$latest_url'." ;;
    esac
    case "$tag" in
        ''|*/*|*[!A-Za-z0-9._-]*) fail "The latest release returned an invalid tag '$tag'." ;;
    esac
else
    tag=$version
fi

asset_name="minitron-$tag-$platform-$architecture.tar.gz"
binary_name=minitron

temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/minitron-install.XXXXXX") || fail 'Could not create a temporary download directory.'
staged_binary=
cleanup() {
    if [ -n "$staged_binary" ] && [ -e "$staged_binary" ]; then
        rm -f "$staged_binary"
    fi
    rm -rf "$temporary_dir"
}
trap cleanup 0
trap 'exit 1' HUP INT TERM

archive_path=$temporary_dir/$asset_name
manifest_path=$temporary_dir/SHA256SUMS
download_base="$base_url/download/$tag"
curl --fail --location --silent --show-error --output "$manifest_path" "$download_base/SHA256SUMS" || \
    fail "Could not download SHA256SUMS for release '$tag'."
curl --fail --location --silent --show-error --output "$archive_path" "$download_base/$asset_name" || \
    fail "Could not download release asset '$asset_name'."

expected_hash=$(awk -v name="$asset_name" '
    $2 == name || $2 == ("*" name) {
        if (length($1) != 64 || $1 !~ /^[[:xdigit:]]+$/) {
            malformed = 1
        } else {
            count++
            hash = tolower($1)
        }
    }
    END {
        if (malformed || count != 1) exit 1
        print hash
    }
' "$manifest_path") || fail "SHA256SUMS must contain exactly one valid checksum for '$asset_name'."

if command -v sha256sum >/dev/null 2>&1; then
    actual_hash=$(sha256sum "$archive_path" | awk '{print tolower($1)}')
else
    actual_hash=$(shasum -a 256 "$archive_path" | awk '{print tolower($1)}')
fi
[ "$actual_hash" = "$expected_hash" ] || fail "SHA-256 verification failed for '$asset_name'; refusing to install."

archive_entries=$(tar -tzf "$archive_path") || fail "Could not read release archive '$asset_name'."
[ "$archive_entries" = "$binary_name" ] || \
    fail "The release archive must contain only the root-level $binary_name binary."
extracted_binary=$temporary_dir/$binary_name
tar -xzf "$archive_path" -O "$binary_name" > "$extracted_binary" || \
    fail "Could not extract $binary_name from '$asset_name'."
[ -s "$extracted_binary" ] || fail "The $binary_name binary in the release archive is empty."

mkdir -p "$install_dir" || fail "Could not create install directory '$install_dir'."
install_dir=$(cd "$install_dir" && pwd -P) || fail "Could not access install directory '$install_dir'."
target_binary=$install_dir/$binary_name
[ ! -d "$target_binary" ] || fail "Cannot install because '$target_binary' is a directory."
staged_binary=$(mktemp "$install_dir/.minitron.install.XXXXXX") || fail "Could not stage minitron in '$install_dir'."
cp "$extracted_binary" "$staged_binary" || fail "Could not stage the minitron binary in '$install_dir'."
chmod 755 "$staged_binary" || fail "Could not make the minitron binary executable."
mv -f "$staged_binary" "$target_binary" || fail "Could not install minitron to '$target_binary'."
staged_binary=

printf 'Installed minitron to: %s\n' "$target_binary"
printf 'Keep minitron.toml and application resources in: %s\n' "$install_dir"
if [ "$platform" = linux ]; then
    printf '%s\n' 'On Linux, install any system dynamic libraries required by minitron.'
fi
