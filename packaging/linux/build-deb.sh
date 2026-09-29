#!/bin/sh
set -eu
mkdir -p /tmp/maghemite-deb
cp -a /payload/. /tmp/maghemite-deb/
cp -a /metadata/DEBIAN /tmp/maghemite-deb/
dpkg-deb --build --root-owner-group -Zxz -z6 /tmp/maghemite-deb "/out/$PACKAGE_FILE"
