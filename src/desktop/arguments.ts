/** CEF 0.7 on Linux may expose each argv entry with all following arguments appended. */
export function desktopArguments(args: string[]): string[] {
  if (
    args.length > 1 &&
    args.slice(0, -1).every((arg, i) => arg.endsWith(` ${args[i + 1]}`))
  ) {
    return args.map((arg, i) =>
      i + 1 < args.length ? arg.slice(0, -args[i + 1].length - 1) : arg
    );
  }
  if (args.length === 1 && args[0].startsWith("--")) {
    return args[0].split(
      / (?=--(?:workspace|data-dir|port|tools|core-library|pty-library|grant)=)/,
    );
  }
  return args;
}
