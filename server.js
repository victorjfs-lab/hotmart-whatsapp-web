const path = require("node:path");
const { chmodSync, existsSync, readdirSync, statSync } = require("node:fs");

const rootDir = __dirname;
process.env.PUPPETEER_CACHE_DIR ||= path.join(rootDir, ".cache", "puppeteer");

const whatsappWeb = require("whatsapp-web.js");
let puppeteerPackage = null;

try {
  puppeteerPackage = require("puppeteer");
} catch {}

const OriginalClient = whatsappWeb.Client;
const OriginalLocalAuth = whatsappWeb.LocalAuth;

function mergeArgs(existingArgs) {
  return Array.from(new Set([
    ...(Array.isArray(existingArgs) ? existingArgs : []),
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--disable-crashpad",
    "--disable-features=Crashpad",
    "--no-crash-upload"
  ]));
}

function ensureExecutablePermission(filePath) {
  if (!filePath || process.platform === "win32") return;
  try {
    chmodSync(filePath, 0o755);
  } catch {}
}

function ensureChromeDirectoryPermissions(executablePath) {
  if (!executablePath || process.platform === "win32") return;
  chmodExecutableFiles(path.dirname(executablePath));
}

function chmodExecutableFiles(dir) {
  if (!existsSync(dir)) return;

  for (const entry of readdirSync(dir)) {
    const entryPath = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(entryPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      chmodExecutableFiles(entryPath);
      continue;
    }

    if (!entry.includes(".") || entry.endsWith("_handler")) {
      ensureExecutablePermission(entryPath);
    }
  }
}

function resolveExecutablePath(existingPath) {
  if (existingPath) {
    ensureExecutablePermission(existingPath);
    ensureChromeDirectoryPermissions(existingPath);
    return existingPath;
  }
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    ensureExecutablePermission(process.env.PUPPETEER_EXECUTABLE_PATH);
    ensureChromeDirectoryPermissions(process.env.PUPPETEER_EXECUTABLE_PATH);
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  if (process.env.CHROME_BIN) {
    ensureExecutablePermission(process.env.CHROME_BIN);
    ensureChromeDirectoryPermissions(process.env.CHROME_BIN);
    return process.env.CHROME_BIN;
  }

  try {
    const executablePath = puppeteerPackage?.executablePath?.() || undefined;
    ensureExecutablePermission(executablePath);
    ensureChromeDirectoryPermissions(executablePath);
    return executablePath;
  } catch {
    return undefined;
  }
}

class TemporaryLocalAuth extends OriginalLocalAuth {
  async beforeBrowserInitialized() {
    const puppeteerOpts = this.client.options.puppeteer || {};
    this.client.options.puppeteer = { ...puppeteerOpts };
    this.userDataDir = "";
  }

  async logout() {}
}

class PatchedClient extends OriginalClient {
  constructor(options = {}) {
    const puppeteer = options.puppeteer || {};
    super({
      ...options,
      webVersionCache: { type: "none" },
      authTimeoutMs: 120000,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 0,
      puppeteer: {
        ...puppeteer,
        executablePath: resolveExecutablePath(puppeteer.executablePath),
        timeout: puppeteer.timeout || 60000,
        protocolTimeout: puppeteer.protocolTimeout || 120000,
        args: mergeArgs(puppeteer.args)
      }
    });
  }
}

whatsappWeb.Client = PatchedClient;
whatsappWeb.LocalAuth = TemporaryLocalAuth;

require("./legacy-server.js");
