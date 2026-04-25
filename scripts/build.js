const { spawn } = require("node:child_process");
const { cp, mkdir, rm } = require("node:fs/promises");

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  await rm("dist", { recursive: true, force: true });
  await mkdir("dist", { recursive: true });
  await cp("src", "dist/src", { recursive: true });
  await cp("public", "dist/public", { recursive: true });
  await cp("scripts", "dist/scripts", { recursive: true });
  await cp(".puppeteerrc.cjs", "dist/.puppeteerrc.cjs");
  await cp("server.js", "dist/server.js");
  await cp("legacy-server.js", "dist/legacy-server.js").catch(() => {});
  await cp("package.json", "dist/package.json");
  await cp("package-lock.json", "dist/package-lock.json").catch(() => {});

  const installCommand = process.platform === "win32" ? "cmd" : "npm";
  const installArgs =
    process.platform === "win32"
      ? ["/c", "npm", "install", "--omit=dev", "--ignore-scripts"]
      : ["install", "--omit=dev", "--ignore-scripts"];

  await run(installCommand, installArgs, "dist");
  await run(process.execPath, ["scripts/install-chrome.js"], "dist");

  console.log("Build ready in dist/");
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
    child.on("error", reject);
  });
}
