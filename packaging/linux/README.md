# Linux distribution

The Linux default is **DEB + RPM + Arch**. AppImage is an optional portable build.
Builds stay local: these tasks do not install Maghemite on the host or publish it.

## Build

Requirements on the target Linux architecture:

- Deno with `deno desktop` (currently exercised with 2.9.7 / CEF 0.7.0), Rust/Cargo.
- Docker daemon access; Ubuntu/Fedora/Arch packaging tools run in containers.
- GNU coreutils, GNU tar, zstd, binutils (`readelf`), and desktop-file-utils.
- deno-pty-ffi **0.42.0** native library, prepared by `deno task desktop:prepare-pty`.

From the project root:

```sh
deno task desktop:package --pty-library=/absolute/path/to/pty-library
deno task desktop:package --pty-library=/absolute/path/to/pty-library --formats=deb,rpm,arch,appimage
deno task desktop:package --pty-library=/absolute/path/to/pty-library --output=build/Maghemite.deb
deno task desktop:package --pty-library=/absolute/path/to/pty-library --formats=dir
```

`--output` is for one format and must have its matching extension. `--formats=dir`
creates a relocatable installation tree at `build/linux/root`; an explicit output
directory must not already exist. Do not run two packaging tasks concurrently.

Version comes from the root `deno.json`. Package release, maintainer and the current
license marker live in `metadata.json`. This repository has no declared project
license yet; the marker does not grant one. Fill in the actual release licensing
and maintainer contact before public publication.

Outputs for x86_64, version 0.1.0, package release 5:

| Artifact | Location |
| --- | --- |
| DEB | `build/packages/maghemite_0.1.0-5_amd64.deb` |
| RPM | `build/packages/maghemite-0.1.0-5.x86_64.rpm` |
| Arch | `build/packages/maghemite-0.1.0-5-x86_64.pkg.tar.zst` |
| Portable AppImage | `build/Maghemite.AppImage` (when requested) |
| Local PKGBUILD + `.SRCINFO` + checksummed source archive | `build/linux/arch/` |

Native packages have adjacent `.sha256` files. The generated PKGBUILD consumes the
adjacent archive; it is ready for local `makepkg`, not an AUR submission with a
published download URL. Neither Arch nor RPM is allowed to strip the executable
or its `.so`: stripping can destroy Deno's embedded application payload.

## Installed layout

```text
/usr/bin/maghemite -> ../lib/maghemite/maghemite
/usr/lib/maghemite/
  Maghemite, Maghemite.so, CEF resources
  assets/
    libmaghemite_core.so, maghemite-wasm-host, deno, libpty.so
    renderer/, modules-sdk/js/, src/modules/, assets.json
/usr/share/applications/dev.maghemite.app.desktop
/usr/share/icons/hicolor/scalable/apps/dev.maghemite.app.svg
/usr/share/doc/maghemite/
```

Installed resources are read directly. Launching through the symlink or from a
different working directory still finds the same resources. The application does
not require a separately installed Deno, Node.js, Rust or Wasmtime runtime.

Writable data remains at `$XDG_DATA_HOME/maghemite` (default
`~/.local/share/maghemite`), or `--data-dir`. Native packages do not populate its
`runtime/` subdirectory. An old AppImage's extracted cache is left untouched;
packaging does not delete existing profiles. The package manager owns updates and
uninstallation; removal preserves user settings, modules, indexes and drafts.

Current binary floor: **glibc 2.39** and **GCC 12 libstdc++**. This supports the
Ubuntu 24.04 baseline; Ubuntu 22.04 / Debian 12 are below it. The PTY release needs
glibc 2.39 and the CEF launcher needs `GLIBCXX_3.4.30`. `checkLinuxAbi` validates
every ELF before packaging so a newer compiler cannot silently raise the floor.
To lower the floor, rebuild those upstream binaries on an older baseline first.
Only x86_64 has been exercised; aarch64 needs its own build and verification.

The Deno executable running `desktop:package` is also copied into the package.
Use an ABI-compatible Deno binary to invoke the entire task: two binaries with
the same Deno version can require different glibc versions. The ABI check applies
to that bundled runtime too; changing the package dependency floor is not a
substitute for selecting a compatible build.

## Install and run

```sh
# Choose the command for your distribution, from the project root.
sudo apt install ./build/packages/maghemite_0.1.0-5_amd64.deb
sudo dnf install ./build/packages/maghemite-0.1.0-5.x86_64.rpm
sudo pacman -U ./build/packages/maghemite-0.1.0-5-x86_64.pkg.tar.zst

maghemite --workspace=/absolute/path/to/project
```

The app menu reopens the last folder. Use **Open folder** / **Ctrl+Shift+O** to
choose another project, browse using the system folder picker, or enter a path.
Recent folders and per-folder tabs/drafts survive restarts. `--workspace` overrides
the remembered folder. Missing recent folders fall back to the sample workspace.
Linux packages depend on a system picker (Zenity; DEB also accepts KDialog).
AppImage users can install either, or use the path field without a picker.
File associations are deferred until OS file-open arguments are supported; no MIME
defaults are changed.

## Verification

```sh
deno task desktop:package:test
docker run --rm --shm-size=512m \
  -v "$PWD/build/packages:/packages:ro" \
  -v "$PWD/packaging/linux:/recipes:ro" \
  ubuntu:24.04 sh /recipes/verify-container.sh deb
# Substitute fedora:44 / rpm or archlinux:base / arch for the other packages.
```

**Run `verify-container.sh` only inside an expendable container.** It installs the
package with dependencies, verifies sidecar hashes, loads the native libraries,
starts the actual CEF window as UID 1000 under Xvfb, checks the renderer and host,
checks that no runtime was extracted and installed files stayed unchanged,
reinstalls and removes the package, and checks that user data survived removal.
This does not cover a full desktop session, hardware GPU drivers, or every distro.

Signed APT/RPM repositories, AUR publication, signing keys, release license notices
and automatic update delivery remain release tasks. No repository is registered
or update agent installed by these packages.
