#!/bin/sh
# Only run inside an expendable container; installs and removes the test package.
set -eu
case "$1" in
  deb)
    package=$(printf '%s\n' /packages/maghemite_*.deb | sort -V | tail -n 1)
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$package" python3 xvfb xauth xdotool
    ;;
  rpm)
    package=$(printf '%s\n' /packages/maghemite-*.rpm | sort -V | tail -n 1)
    dnf install -y "$package" python3 xorg-x11-server-Xvfb xdotool
    ;;
  arch)
    package=$(printf '%s\n' /packages/maghemite-*.pkg.tar.zst | sort -V | tail -n 1)
    pacman -Syu --noconfirm python xorg-server-xvfb xdotool gtk3 nss nspr alsa-lib libx11 libxi libxcomposite libxdamage libxext libxfixes libxrandr libxkbcommon mesa pango cairo at-spi2-core dbus expat libxcb libdrm libcups systemd-libs
    pacman -U --noconfirm "$package"
    ;;
  *) exit 2 ;;
esac
python3 /recipes/verify-installed.py
case "$1" in
  deb) dpkg -i "$package"; dpkg --purge maghemite ;;
  rpm) rpm -U --replacepkgs "$package"; rpm -e maghemite ;;
  arch) pacman -U --noconfirm "$package"; pacman -R --noconfirm maghemite ;;
esac
test ! -e /usr/bin/maghemite
test ! -e /usr/lib/maghemite
test ! -e /usr/share/applications/dev.maghemite.app.desktop
test ! -e /usr/share/icons/hicolor/scalable/apps/dev.maghemite.app.svg
test -f '/tmp/maghemite-package-test/QA profile/keep-after-uninstall'
printf '%s\n' 'INSTALL_REINSTALL_REMOVE_OK; USER_DATA_PRESERVED'
