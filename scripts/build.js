import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("src", "dist/src", { recursive: true });
await cp("public", "dist/public", { recursive: true });
await cp("package.json", "dist/package.json");

console.log("Build ready in dist/");
