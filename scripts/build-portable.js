const { spawn } = require("node:child_process");

// High 7-Zip compression exhausted memory during the Windows portable build.
const compressionLevel = process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL || "1";
const child = spawn(process.execPath, [
  require.resolve("electron-builder/cli.js"),
  "--win",
  "portable",
  ...process.argv.slice(2)
], {
  stdio: "inherit",
  windowsHide: true,
  env: { ...process.env, ELECTRON_BUILDER_COMPRESSION_LEVEL: compressionLevel }
});

child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
