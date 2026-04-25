const { spawnSync } = require("node:child_process");
const path = require("node:path");

if (process.env.SKIP_PUPPETEER_BROWSER_INSTALL === "1") {
  console.log("Skipping Puppeteer Chrome install.");
  process.exit(0);
}

process.env.PUPPETEER_CACHE_DIR ||= path.join(process.cwd(), ".cache", "puppeteer");

const command = process.platform === "win32" ? "cmd" : "npx";
const args =
  process.platform === "win32"
    ? ["/c", "npx", "puppeteer", "browsers", "install", "chrome"]
    : ["puppeteer", "browsers", "install", "chrome"];

console.log(`Installing Puppeteer Chrome into ${process.env.PUPPETEER_CACHE_DIR}`);

const result = spawnSync(command, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit"
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status || 0);
