#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
arch=${1:-amd64}
case "$arch" in
    amd64) platform=linux-x64 ;;
    arm64) platform=linux-arm64 ;;
    *) printf 'Usage: bash %s [amd64|arm64] [output-directory]\n' "$0" >&2; exit 2 ;;
esac

out=${2:-"$root/dist"}
mkdir -p -- "$out"
out=$(cd -- "$out" && pwd)
stage=$(mktemp -d "$out/.linux-sync.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
package="hindsight-sync-server-$platform"
mkdir -- "$stage/$package"

(
    cd -- "$root/hindsight-sync-server"
    CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath -o "$stage/$package/hindsight-sync-server" .
    srp_dir=$(go list -m -f '{{.Dir}}' github.com/posterity/srp)
    text_dir=$(go list -m -f '{{.Dir}}' golang.org/x/text)
    cp -- "$srp_dir/LICENCE" "$stage/$package/SRP-LICENSE"
    cp -- "$text_dir/LICENSE" "$stage/$package/GO-TEXT-LICENSE"
    cp -- "$text_dir/PATENTS" "$stage/$package/GO-TEXT-PATENTS"
)
chmod 755 -- "$stage/$package/hindsight-sync-server"
cp -- "$root/LICENSE" "$stage/$package/LICENSE"
cp -- "$(go env GOROOT)/LICENSE" "$stage/$package/GO-LICENSE"
cp -- "$root/scripts/linux-sync/hindsight-sync.service" "$stage/$package/"
cp -- "$root/hindsight-docs/docs-private/maintenance/linux-sync.md" "$stage/$package/README.md"
go version -m "$stage/$package/hindsight-sync-server" > "$stage/$package/build-info.txt"
# Set archive modes explicitly so a Windows cross-build produces the same
# executable permissions as a build on Linux.
tar -C "$stage" --no-recursion --mode=0755 -cf "$stage/package.tar" \
    "$package" "$package/hindsight-sync-server"
tar -C "$stage/$package" --transform="s,^,$package/," --mode=0644 -rf "$stage/package.tar" \
    LICENSE GO-LICENSE SRP-LICENSE GO-TEXT-LICENSE GO-TEXT-PATENTS hindsight-sync.service README.md build-info.txt
gzip -n -c "$stage/package.tar" > "$stage/$package.tar.gz"
mv -f -- "$stage/$package.tar.gz" "$out/$package.tar.gz"
printf '%s\n' "$out/$package.tar.gz"
