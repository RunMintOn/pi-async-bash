import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// node-pty 1.1.0 ships Unix prebuilt spawn-helper files without executable bits.
const require = createRequire(import.meta.url);
const root = dirname(require.resolve("node-pty/package.json"));
for (const directory of ["build/Release", "build/Debug", `prebuilds/${process.platform}-${process.arch}`]) {
  const helper = join(root, directory, "spawn-helper");
  if (existsSync(helper)) chmodSync(helper, statSync(helper).mode | 0o111);
}
