const path = require("node:path");
const { readFileSync } = require("node:fs");
const Module = require("node:module");

const rootDir = __dirname;
const legacyPath = path.join(rootDir, "legacy-server.js");

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

const sendMessagesPatch = String.raw`async function sendWhatsAppWebMessages(sale, config) {
  await ensureWhatsAppWebClient();
  if (whatsappState.status !== "ready") {
    throw new Error("WhatsApp Web ainda nao esta conectado. Clique em Iniciar WhatsApp Web e leia o QR Code.");
  }

  const messages = getSaleMessages(sale, config);
  const chatId = await getWhatsAppWebChatId(sale.phone);
  const responses = [];

  for (const message of messages) {
    responses.push(await whatsappState.client.sendMessage(chatId, { text: message }));
  }

  return responses.map((message) => ({
    id: message.key?.id || "",
    timestamp: Date.now()
  }));
}
`;

const chatIdPatch = String.raw`async function getWhatsAppWebChatId(phone) {
  const digits = normalizeBrazilPhone(phone);
  const candidate = digits + "@s.whatsapp.net";
  const matches = await whatsappState.client.onWhatsApp(candidate).catch(() => []);
  const match = Array.isArray(matches) ? matches.find((item) => item?.exists) : null;

  if (match?.jid) return match.jid;

  throw new Error("O numero " + digits + " nao parece estar registrado no WhatsApp.");
}
`;

const initializePatch = String.raw`async function initializeWhatsAppWebClient() {
  await cleanupWhatsAppRuntimeFiles();

  const baileys = await getBaileysModule();
  const makeWASocket = getBaileysExport(baileys, "makeWASocket") || getBaileysExport(baileys, "default");
  const fetchLatestBaileysVersion = getBaileysExport(baileys, "fetchLatestBaileysVersion");
  const useMultiFileAuthState = getBaileysExport(baileys, "useMultiFileAuthState");

  if (typeof makeWASocket !== "function") {
    throw new Error("Motor WhatsApp carregado, mas makeWASocket nao esta disponivel.");
  }
  if (typeof useMultiFileAuthState !== "function") {
    throw new Error("Motor WhatsApp carregado, mas useMultiFileAuthState nao esta disponivel.");
  }

  const { state, saveCreds } = await useMultiFileAuthState(whatsappAuthDir);
  const logger = await getBaileysLogger();
  const versionResult = fetchLatestBaileysVersion
    ? await fetchLatestBaileysVersion().catch(() => ({}))
    : {};

  const client = makeWASocket({
    auth: state,
    browser: ["Hotmart WhatsApp", "Chrome", "1.0.0"],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    logger,
    markOnlineOnConnect: false,
    printQRInTerminal: false,
    syncFullHistory: false,
    version: versionResult.version
  });

  client.ev.on("creds.update", saveCreds);

  client.ev.on("connection.update", async (update) => {
    if (update.qr) {
      clearWhatsAppStartupTimeout();
      whatsappState.status = "qr";
      whatsappState.qr = update.qr;
      whatsappState.qrDataUrl = await generateQrDataUrl(update.qr);
      whatsappState.lastError = "";
    }

    if (update.connection === "open") {
      clearWhatsAppStartupTimeout();
      whatsappState.status = "ready";
      whatsappState.qr = "";
      whatsappState.qrDataUrl = "";
      whatsappState.readyAt = new Date().toISOString();
      whatsappState.number = normalizeWhatsAppUser(client.user?.id || client.user?.jid || "");
      whatsappState.lastError = "";
    }

    if (update.connection === "close") {
      clearWhatsAppStartupTimeout();
      whatsappState.status = "disconnected";
      whatsappState.lastError = explainBaileysDisconnect(update.lastDisconnect);
      whatsappState.client = null;
    }
  });

  whatsappState.client = client;
  return client;
}
`;

const resetPatch = String.raw`async function resetWhatsAppSession() {
  clearWhatsAppStartupTimeout();
  const client = whatsappState.client;
  whatsappState.client = null;
  whatsappStartPromise = null;

  if (client) {
    await client.logout?.().catch(() => {});
    client.ws?.close?.();
  }

  await cleanupWhatsAppSessionFiles();

  whatsappState.status = "stopped";
  whatsappState.qr = "";
  whatsappState.qrDataUrl = "";
  whatsappState.lastError = "";
  whatsappState.readyAt = "";
  whatsappState.number = "";
  whatsappState.startedAt = "";
}
`;

const baileysHelpersPatch = String.raw`async function getBaileysModule() {
  if (baileysModule) return baileysModule;

  baileysModule = await import("@whiskeysockets/baileys");
  return baileysModule;
}

function getBaileysExport(module, name) {
  if (!module) return undefined;
  if (name === "default" && typeof module.default === "function") return module.default;
  if (typeof module[name] === "function") return module[name];
  if (typeof module.default?.[name] === "function") return module.default[name];
  if (name === "makeWASocket" && typeof module.default?.default === "function") return module.default.default;
  return undefined;
}

async function getBaileysLogger() {
  if (!pinoModule) {
    const imported = await import("pino").catch(() => null);
    pinoModule = imported?.default || imported;
  }

  if (pinoModule) return pinoModule({ level: "silent" });

  const silent = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {}
  };
  silent.child = () => silent;
  return silent;
}

function explainBaileysDisconnect(lastDisconnect) {
  const error = lastDisconnect?.error;
  const statusCode = error?.output?.statusCode || error?.statusCode || "";
  const message = error?.message || String(error || "Desconectado");
  return statusCode ? message + " (" + statusCode + ")" : message;
}

function normalizeWhatsAppUser(value) {
  return String(value || "").split(":")[0].split("@")[0];
}
`;

let source = readFileSync(legacyPath, "utf8");
source = source.replace("let whatsappWebModule = null;\nlet qrcodeModule = null;", "let baileysModule = null;\nlet pinoModule = null;\nlet qrcodeModule = null;");
source = source.replace(/async function handleHotmartWebhook\(req, res\) \{[\s\S]*?\nasync function handleTestSale\(req, res, url\) \{/, `${webhookQueuePatch}\nasync function handleTestSale(req, res, url) {`);
source = source.replace(/async function sendWhatsAppWebMessages\(sale, config\) \{[\s\S]*?\nfunction getSaleMessages\(sale, config\) \{/, `${sendMessagesPatch}\nfunction getSaleMessages(sale, config) {`);
source = source.replace(/async function getWhatsAppWebChatId\(phone\) \{[\s\S]*?\nasync function callWhatsAppApi\(body, config = null\) \{/, `${chatIdPatch}\nasync function callWhatsAppApi(body, config = null) {`);
source = source.replace(/async function initializeWhatsAppWebClient\(\) \{[\s\S]*?\nasync function resetWhatsAppSession\(\) \{/, `${initializePatch}\nasync function resetWhatsAppSession() {`);
source = source.replace(/async function resetWhatsAppSession\(\) \{[\s\S]*?\nasync function cleanupWhatsAppSessionFiles\(\) \{/, `${resetPatch}\nasync function cleanupWhatsAppSessionFiles() {`);
source = source.replace(/async function getWhatsAppWebModule\(\) \{[\s\S]*?\nasync function generateQrDataUrl\(qr\) \{/, `${baileysHelpersPatch}\nasync function generateQrDataUrl(qr) {`);

const legacyModule = new Module(legacyPath, module);
legacyModule.filename = legacyPath;
legacyModule.paths = Module._nodeModulePaths(path.dirname(legacyPath));
legacyModule._compile(source, legacyPath);
