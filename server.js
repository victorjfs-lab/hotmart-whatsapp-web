const path = require("node:path");
const { chmodSync, existsSync, readdirSync, statSync, readFileSync } = require("node:fs");
const Module = require("node:module");

const rootDir = __dirname;
process.env.PUPPETEER_CACHE_DIR ||= path.join(rootDir, ".cache", "puppeteer");

const webhookQueuePatch = String.raw`async function handleHotmartWebhook(req, res) {
  const rawBody = await readBody(req);
  const payload = parseJson(rawBody);
  const config = await getConfig();

  if (!payload) {
    await recordEvent({ status: "invalid_json", receivedAt: new Date().toISOString(), rawBody });
    return json(res, 400, { ok: false, error: "JSON invalido" });
  }

  if (!isHotmartRequestAuthorized(req, config)) {
    await recordEvent({ status: "unauthorized", receivedAt: new Date().toISOString(), payload });
    return json(res, 401, { ok: false, error: "Webhook nao autorizado" });
  }

  const eventType = getEventType(payload);
  const allowedEvents = parseList(config.hotmartAllowedEvents).map((event) => event.toUpperCase());
  if (allowedEvents.length && !allowedEvents.includes(eventType)) {
    await recordEvent({ status: "ignored", reason: "event_not_allowed", eventType, receivedAt: new Date().toISOString(), payload });
    return json(res, 202, { ok: true, ignored: true, eventType });
  }

  const sale = extractSale(payload);
  if (!sale.phone) {
    await recordEvent({ status: "missing_phone", eventType, receivedAt: new Date().toISOString(), sale, payload });
    return json(res, 422, { ok: false, error: "Telefone do comprador nao encontrado no payload" });
  }

  const receivedAt = new Date().toISOString();
  await recordEvent({ status: "queued", eventType, receivedAt, sale, payload });
  json(res, 200, { ok: true, queued: true, eventType, buyer: sale.buyerName, phone: sale.phone });
  processHotmartSaleInBackground({ sale, config, eventType, payload });
}

async function processHotmartSaleInBackground({ sale, config, eventType, payload }) {
  try {
    const messages = await sendWhatsAppConfirmation(sale, config);
    await recordEvent({ status: "sent", eventType, receivedAt: new Date().toISOString(), sale, messages, payload });
  } catch (error) {
    await recordEvent({
      status: "send_failed",
      eventType,
      receivedAt: new Date().toISOString(),
      sale,
      error: error.message,
      payload
    });
  }
}
`;

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

runLegacyServerWithWebhookQueue();

function runLegacyServerWithWebhookQueue() {
  const legacyPath = path.join(rootDir, "legacy-server.js");
  const originalSource = readFileSync(legacyPath, "utf8");
  const patchedSource = originalSource.replace(
    /async function handleHotmartWebhook\(req, res\) \{[\s\S]*?\nasync function handleTestSale\(req, res, url\) \{/,
    `${webhookQueuePatch}\nasync function handleTestSale(req, res, url) {`
  );

  if (patchedSource === originalSource) {
    throw new Error("Nao foi possivel aplicar o patch de resposta rapida no webhook da Hotmart.");
  }

  const legacyModule = new Module(legacyPath, module);
  legacyModule.filename = legacyPath;
  legacyModule.paths = Module._nodeModulePaths(path.dirname(legacyPath));
  legacyModule._compile(patchedSource, legacyPath);
}
