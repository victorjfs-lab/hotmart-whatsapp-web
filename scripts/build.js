import { spawn } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("src", "dist/src", { recursive: true });
await cp("public", "dist/public", { recursive: true });
await cp("package.json", "dist/package.json");

const installCommand = process.platform === "win32" ? "cmd" : "npm";
const installArgs =
  process.platform === "win32"
    ? ["/c", "npm", "install", "--omit=dev"]
    : ["install", "--omit=dev"];

await run(installCommand, installArgs, "dist");

console.log("Build ready in dist/");

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
