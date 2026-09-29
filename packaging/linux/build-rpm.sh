#!/bin/bash
set -eu
mkdir -p /tmp/rpmbuild/{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS}
rpmbuild -bb --define '_topdir /tmp/rpmbuild' --target "$PACKAGE_ARCH" /metadata/maghemite.spec
find /tmp/rpmbuild/RPMS -name '*.rpm' -exec cp '{}' /out/ ';'
