import { basename, dirname, join, resolve } from "node:path";
import { sha256 } from "../../src/desktop/package_assets.ts";

async function run(command: string, args: string[], cwd: string) {
  const status = await new Deno.Command(command, {
    args,
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) throw new Error(`${command} failed (${status.code})`);
}
async function reset(directory: string) {
  await Deno.remove(directory, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  await Deno.mkdir(directory, { recursive: true });
}
async function write(path: string, content: string) {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, content, { mode: 0o644 });
}

/** Reject newer native ABI requirements instead of shipping misleading dependency floors. */
export async function checkLinuxAbi(directory: string): Promise<void> {
  for await (const item of Deno.readDir(directory)) {
    const path = join(directory, item.name);
    if (item.isDirectory) {
      await checkLinuxAbi(path);
      continue;
    }
    if (!item.isFile) {
      throw new Error(`Unexpected symlink in native bundle: ${path}`);
    }
    const file = await Deno.open(path);
    const magic = new Uint8Array(20);
    try {
      await file.read(magic);
    } finally {
      file.close();
    }
    if (magic.subarray(0, 4).join(",") !== "127,69,76,70") continue;
    const expectedMachine = Deno.build.arch === "x86_64" ? 62 : 183;
    if (
      magic[4] !== 2 || magic[5] !== 1 ||
      new DataView(magic.buffer).getUint16(18, true) !== expectedMachine
    ) {
      throw new Error(
        `Native binary architecture does not match ${Deno.build.arch}: ${path}`,
      );
    }
    const result = await new Deno.Command("readelf", {
      args: ["--version-info", path],
    }).output();
    if (!result.success) throw new Error(`Cannot inspect ABI: ${path}`);
    const text = new TextDecoder().decode(result.stdout);
    const limits: Record<string, number[]> = {
      GLIBC: [2, 39],
      GLIBCXX: [3, 4, 30],
      CXXABI: [1, 3, 13],
    };
    for (const match of text.matchAll(/\b(GLIBC|GLIBCXX|CXXABI)_([0-9.]+)/g)) {
      const actual = match[2].split(".").map(Number),
        maximum = limits[match[1]];
      const difference = actual.map((n, i) =>
        n - (maximum[i] ?? 0)
      ).find((n) => n !== 0) ?? 0;
      if (difference > 0) {
        throw new Error(
          `${path} needs ${
            match[0]
          }; rebuild native code on the documented Linux baseline`,
        );
      }
    }
  }
}

const debDependencies = [
  "zenity | kdialog",
  "libc6 (>= 2.39)",
  "libstdc++6 (>= 12)",
  "libgcc-s1",
  "libgtk-3-0t64 | libgtk-3-0",
  "libnss3",
  "libnspr4",
  "libasound2t64 | libasound2",
  "libx11-6",
  "libxi6",
  "libxcomposite1",
  "libxdamage1",
  "libxext6",
  "libxfixes3",
  "libxrandr2",
  "libgbm1",
  "libxkbcommon0",
  "libpango-1.0-0",
  "libcairo2",
  "libatk1.0-0t64 | libatk1.0-0",
  "libatk-bridge2.0-0t64 | libatk-bridge2.0-0",
  "libdbus-1-3",
  "libexpat1",
  "libxcb1",
  "libdrm2",
  "libcups2t64 | libcups2",
  "libudev1",
  "coreutils",
];
const rpmDependencies = [
  "zenity",
  "glibc >= 2.39",
  "libstdc++ >= 12",
  "libgcc",
  "coreutils",
  "/bin/sh",
  ...[
    "libgtk-3.so.0",
    "libnss3.so",
    "libnspr4.so",
    "libasound.so.2",
    "libX11.so.6",
    "libXi.so.6",
    "libXcomposite.so.1",
    "libXdamage.so.1",
    "libXext.so.6",
    "libXfixes.so.3",
    "libXrandr.so.2",
    "libgbm.so.1",
    "libxkbcommon.so.0",
    "libpango-1.0.so.0",
    "libcairo.so.2",
    "libatk-1.0.so.0",
    "libatk-bridge-2.0.so.0",
    "libdbus-1.so.3",
    "libexpat.so.1",
    "libxcb.so.1",
    "libdrm.so.2",
    "libcups.so.2",
    "libudev.so.1",
  ].map((name) => `${name}()(64bit)`),
];

export async function packageLinux(
  options: { root: string; bundle: string; formats: string[]; output?: string },
) {
  if (Deno.build.os !== "linux") {
    throw new Error("Linux packaging must run on Linux");
  }
  if (!["x86_64", "aarch64"].includes(Deno.build.arch)) {
    throw new Error("Unsupported Linux architecture");
  }
  const { root, bundle, formats } = options;
  const recipes = join(root, "packaging/linux"),
    work = join(root, "build/linux");
  const metadata = {
    ...JSON.parse(await Deno.readTextFile(join(recipes, "metadata.json"))),
    version:
      JSON.parse(await Deno.readTextFile(join(root, "deno.json"))).version,
  };
  if (
    typeof metadata.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(metadata.version) ||
    !Number.isSafeInteger(metadata.release) || metadata.release < 1 ||
    typeof metadata.maintainer !== "string" ||
    !/^[^\r\n%]+$/.test(metadata.maintainer) ||
    typeof metadata.license !== "string" ||
    !/^[A-Za-z0-9.+-]+$/.test(metadata.license)
  ) {
    throw new Error("Invalid Linux package metadata");
  }
  await checkLinuxAbi(bundle);
  const version: string = metadata.version, release: number = metadata.release;
  const arch = Deno.build.arch, debArch = arch === "x86_64" ? "amd64" : "arm64";
  const stage = join(work, "root"),
    out = join(root, "build/packages"),
    meta = join(work, "metadata");
  await reset(stage);
  await reset(meta);
  await Deno.mkdir(out, { recursive: true });
  const app = join(stage, "usr/lib/maghemite");
  await Deno.mkdir(dirname(app), { recursive: true });
  await run("cp", ["-a", bundle, app], root);
  for (
    const name of [
      ".deno-desktop-app",
      ".downloaded",
      "dev.maghemite.app.desktop",
    ]
  ) {
    await Deno.remove(join(app, name)).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
  await write(
    join(app, "maghemite"),
    '#!/bin/sh\nset -eu\napp_dir=$(dirname -- "$(readlink -f -- "$0")")\nexec "$app_dir/Maghemite" "$@"\n',
  );
  await Deno.chmod(join(app, "maghemite"), 0o755);
  await Deno.mkdir(join(stage, "usr/bin"), { recursive: true });
  await Deno.symlink(
    "../lib/maghemite/maghemite",
    join(stage, "usr/bin/maghemite"),
  );
  await write(
    join(stage, "usr/share/applications/dev.maghemite.app.desktop"),
    await Deno.readTextFile(join(recipes, "dev.maghemite.app.desktop")),
  );
  await write(
    join(stage, "usr/share/icons/hicolor/scalable/apps/dev.maghemite.app.svg"),
    await Deno.readTextFile(join(root, "renderer/public/favicon.svg")),
  );
  await write(
    join(stage, "usr/share/doc/maghemite/README"),
    `Maghemite ${version}\nCode and knowledge workspace\n\nOpen folder: Ctrl+Shift+O or the Open folder button.\nCLI: maghemite --workspace=/absolute/project\nUser data: $XDG_DATA_HOME/maghemite (default ~/.local/share/maghemite)\nPackage removal preserves user data.\nUpdates are managed by your system package manager.\n\nProject licensing has not yet been specified. This development package does not\ngrant a new license; dependency licenses remain their respective authors'.\n`,
  );
  await run("desktop-file-validate", [
    join(stage, "usr/share/applications/dev.maghemite.app.desktop"),
  ], root);
  const sizeResult = await new Deno.Command("du", { args: ["-sk", stage] })
    .output();
  if (!sizeResult.success) throw new Error("Cannot calculate package size");
  const size = Number(
    new TextDecoder().decode(sizeResult.stdout).split(/\s/)[0],
  );
  const debFile = `maghemite_${version}-${release}_${debArch}.deb`;
  await write(
    join(meta, "DEBIAN/control"),
    `Package: maghemite\nVersion: ${version}-${release}\nSection: editors\nPriority: optional\nArchitecture: ${debArch}\nMaintainer: ${metadata.maintainer}\nInstalled-Size: ${size}\nDepends: ${
      debDependencies.join(", ")
    }\nDescription: Code and knowledge workspace\n Solid workspace with Monaco, CodeMirror, a terminal and extensible modules.\n`,
  );
  await write(
    join(meta, "maghemite.spec"),
    `%global debug_package %{nil}\n%global __os_install_post %{nil}\n%global _build_id_links none\n%global _binary_payload w9.zstdio\nName: maghemite\nVersion: ${version}\nRelease: ${release}\nSummary: Code and knowledge workspace\nLicense: ${metadata.license}\nAutoReqProv: no\nRequires: ${
      rpmDependencies.join(", ")
    }\n\n%description\nSolid workspace with Monaco, CodeMirror, a terminal and extensible modules.\n\n%install\nmkdir -p %{buildroot}\ncp -a /payload/usr %{buildroot}/\n\n%files\n%defattr(-,root,root,-)\n/usr/lib/maghemite\n/usr/bin/maghemite\n/usr/share/applications/dev.maghemite.app.desktop\n/usr/share/icons/hicolor/scalable/apps/dev.maghemite.app.svg\n%doc /usr/share/doc/maghemite\n`,
  );
  const artifacts: string[] = [];
  for (const format of formats.filter((f) => f === "deb" || f === "rpm")) {
    const tag = `maghemite-packager-${format}:1`;
    await run("docker", [
      "build",
      "-t",
      tag,
      "-f",
      join(recipes, `Dockerfile.${format}`),
      recipes,
    ], root);
    // Container tools write only the task-owned output directory, as the calling user.
    await run("docker", [
      "run",
      "--rm",
      "--user",
      `${Deno.uid()}:${Deno.gid()}`,
      "--network=none",
      "-v",
      `${stage}:/payload:ro`,
      "-v",
      `${meta}:/metadata:ro`,
      "-v",
      `${recipes}:/recipes:ro`,
      "-v",
      `${out}:/out`,
      "-e",
      `PACKAGE_FILE=${debFile}`,
      "-e",
      `PACKAGE_ARCH=${arch}`,
      tag,
      format === "rpm" ? "bash" : "sh",
      `/recipes/build-${format}.sh`,
    ], root);
    artifacts.push(
      join(
        out,
        format === "deb"
          ? debFile
          : `maghemite-${version}-${release}.${arch}.rpm`,
      ),
    );
  }
  if (formats.includes("arch")) {
    const archWork = join(work, "arch");
    await reset(archWork);
    const archive = `maghemite-${version}-linux-${arch}.tar.zst`;
    await run("tar", [
      "--sort=name",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--mtime=@0",
      "--use-compress-program=zstd -T0 -10",
      "-cf",
      join(archWork, archive),
      "-C",
      stage,
      "usr",
    ], root);
    const digest = await sha256(await Deno.readFile(join(archWork, archive)));
    const pkgbuild =
      `# Generated local binary recipe. Copy the adjacent tar.zst together with this file.\n# Do not strip Deno's executable payload.\npkgname=maghemite\npkgver=${version}\npkgrel=${release}\npkgdesc='Code and knowledge workspace'\narch=('${arch}')\nlicense=('${metadata.license}')\ndepends=('zenity' 'glibc>=2.39' 'gcc-libs' 'gtk3' 'nss' 'nspr' 'alsa-lib' 'libx11' 'libxi' 'libxcomposite' 'libxdamage' 'libxext' 'libxfixes' 'libxrandr' 'libxkbcommon' 'mesa' 'pango' 'cairo' 'at-spi2-core' 'dbus' 'expat' 'libxcb' 'libdrm' 'libcups' 'systemd-libs' 'coreutils')\noptions=('!strip' '!debug')\nsource=('${archive}')\nsha256sums=('${digest}')\npackage() {\n  cp -a --no-preserve=ownership "$srcdir/usr" "$pkgdir/"\n}\n`;
    await write(join(archWork, "PKGBUILD"), pkgbuild);
    await run("docker", [
      "build",
      "-t",
      "maghemite-packager-arch:1",
      "-f",
      join(recipes, "Dockerfile.arch"),
      recipes,
    ], root);
    await run("docker", [
      "run",
      "--rm",
      "--user",
      `${Deno.uid()}:${Deno.gid()}`,
      "--network=none",
      "-v",
      `${archWork}:/input:ro`,
      "-v",
      `${archWork}:/out`,
      "-v",
      `${recipes}:/recipes:ro`,
      "maghemite-packager-arch:1",
      "sh",
      "/recipes/build-arch.sh",
    ], root);
    const packageName = `maghemite-${version}-${release}-${arch}.pkg.tar.zst`;
    await Deno.copyFile(join(archWork, packageName), join(out, packageName));
    artifacts.push(join(out, packageName));
  }
  if (formats.includes("dir")) {
    if (options.output) {
      const destination = resolve(options.output);
      try {
        await Deno.lstat(destination);
        throw new Error(`Output already exists: ${destination}`);
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
      await Deno.mkdir(dirname(destination), { recursive: true });
      await run("cp", ["-a", stage, destination], root);
      console.log(`Install tree: ${destination}`);
    } else console.log(`Install tree: ${stage}`);
  } else if (options.output && artifacts.length === 1) {
    const destination = resolve(options.output);
    if (destination !== artifacts[0]) {
      await Deno.mkdir(dirname(destination), { recursive: true });
      await Deno.copyFile(artifacts[0], destination);
      artifacts[0] = destination;
    }
  }
  for (const path of artifacts) {
    await write(
      `${path}.sha256`,
      `${await sha256(await Deno.readFile(path))}  ${basename(path)}\n`,
    );
    console.log(`Linux package: ${path}`);
  }
}
