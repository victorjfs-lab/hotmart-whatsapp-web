const path = require("node:path");
const { chmodSync } = require("node:fs");

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
    "--disable-sync"
  ]));
}

function ensureExecutablePermission(filePath) {
  if (!filePath || process.platform === "win32") return;
  try {
    chmodSync(filePath, 0o755);
  } catch {}
}

function resolveExecutablePath(existingPath) {
  if (existingPath) {
    ensureExecutablePermission(existingPath);
    return existingPath;
  }
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    ensureExecutablePermission(process.env.PUPPETEER_EXECUTABLE_PATH);
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  if (process.env.CHROME_BIN) {
    ensureExecutablePermission(process.env.CHROME_BIN);
    return process.env.CHROME_BIN;
  }

  try {
    const executablePath = puppeteerPackage?.executablePath?.() || undefined;
    ensureExecutablePermission(executablePath);
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
