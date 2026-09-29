#!/bin/sh
set -eu
mkdir -p /tmp/maghemite-arch
cp /input/PKGBUILD /input/*.tar.zst /tmp/maghemite-arch/
cd /tmp/maghemite-arch
HOME=/tmp makepkg --nodeps --force
cp ./*.pkg.tar.zst /out/
makepkg --printsrcinfo > /out/.SRCINFO
