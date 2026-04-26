const { spawn } = require("node:child_process");
const { cp, mkdir, rm } = require("node:fs/promises");

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  await rm("dist", { recursive: true, force: true });
  await mkdir("dist", { recursive: true });
  await cp("src", "dist/src", { recursive: true }).catch(() => {});
  await cp("public", "dist/public", { recursive: true });
  await cp("scripts", "dist/scripts", { recursive: true });
  await cp("server.js", "dist/server.js");
  await cp("package.json", "dist/package.json");

  const installCommand = process.platform === "win32" ? "cmd" : "npm";
  const installArgs = process.platform === "win32"
    ? ["/c", "npm", "install", "--omit=dev", "--ignore-scripts"]
    : ["install", "--omit=dev", "--ignore-scripts"];

  await run(installCommand, installArgs, "dist");
  console.log("Build ready in dist/");
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
    child.on("error", reject);
  });
}
