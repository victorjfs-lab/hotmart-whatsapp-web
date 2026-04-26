const fs = require("node:fs/promises");
const path = require("node:path");
const nodeCrypto = require("node:crypto");
const express = require("express");
const pino = require("pino");
const qrcode = require("qrcode");

if (!globalThis.crypto) {
  globalThis.crypto = nodeCrypto.webcrypto;
}

const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(rootDir, "data");
const configFile = path.join(dataDir, "config.json");
const eventsFile = path.join(dataDir, "events.json");
const jobsFile = path.join(dataDir, "message-jobs.json");
const authDir = path.join(dataDir, "whatsapp-session");

const defaultConfig = {
  hotmartWebhookSecret: "",
  hotmartAllowedEvents: "PURCHASE_APPROVED,PURCHASE_COMPLETE,APPROVED,COMPLETE",
  whatsappProvider: "web",
  whatsappMessageSchedule:
    "0 | Oi, {{nome}}! Sua compra de {{produto}} foi confirmada.\n10m | Passando para confirmar: seu acesso ja esta liberado no email {{email}}.\n1h | Qualquer duvida, responda esta mensagem que eu te ajudo.",
  whatsappTextMessages: ""
};

const whatsappState = {
  status: "stopped",
  qrDataUrl: "",
  lastError: "",
  readyAt: "",
  number: "",
  webVersion: ""
};

let baileysModule = null;
let whatsappClient = null;
let startPromise = null;
let processorTimer = null;
let processorRunning = false;

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(publicDir));

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "hotmart-whatsapp-web" });
});

app.get("/api/config", async (req, res) => {
  res.json({ ok: true, config: await getConfig() });
});

app.post("/api/config", async (req, res) => {
  const current = await getConfig();
  const next = { ...current };
  for (const key of Object.keys(defaultConfig)) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) {
      next[key] = String(req.body[key] || "");
    }
  }
  next.whatsappProvider = "web";
  await writeJson(configFile, next);
  res.json({ ok: true, config: next });
});

app.get("/api/events", async (req, res) => {
  const events = await readJson(eventsFile, []);
  res.json({ ok: true, events: events.slice(-80).reverse() });
});

app.get("/api/contacts", async (req, res) => {
  const jobs = await readJson(jobsFile, []);
  res.json(buildContactSummary(jobs));
});

app.get("/api/whatsapp/status", (req, res) => {
  res.json({ ok: true, whatsapp: publicWhatsAppState() });
});

app.post("/api/whatsapp/start", async (req, res) => {
  try {
    await startWhatsApp();
    res.json({ ok: true, whatsapp: publicWhatsAppState() });
  } catch (error) {
    setWhatsAppError(error);
    res.status(500).json({ ok: false, error: friendlyWhatsAppError(error), whatsapp: publicWhatsAppState() });
  }
});

app.post("/api/whatsapp/reset", async (req, res) => {
  await resetWhatsApp();
  res.json({ ok: true, whatsapp: publicWhatsAppState() });
});

app.post("/api/test-sale", async (req, res) => {
  const sale = {
    buyerName: req.body.buyerName || "Cliente Teste",
    buyerEmail: req.body.buyerEmail || "cliente@email.com",
    phone: normalizeBrazilPhone(req.body.phone || ""),
    productName: req.body.productName || "Produto Teste",
    transaction: req.body.transaction || `TEST-${Date.now()}`,
    purchaseDate: new Date().toISOString()
  };

  if (!sale.phone) {
    return res.status(422).json({ ok: false, error: "Informe o telefone do comprador." });
  }

  if (req.body.dryRun) {
    await recordEvent({ status: "test_ready", eventType: "TEST_SALE", sale, receivedAt: new Date().toISOString() });
    return res.json({ ok: true, dryRun: true, sale });
  }

  const queued = await queueSaleMessages(sale, await getConfig(), "TEST_SALE");
  await recordEvent({
    status: queued.duplicate ? "test_sequence_already_queued" : "test_sequence_queued",
    eventType: "TEST_SALE",
    sale,
    queued,
    receivedAt: new Date().toISOString()
  });
  scheduleProcessor(500);
  res.json({ ok: true, sale, messagesQueued: queued.totalMessages, duplicate: queued.duplicate });
});

app.get("/webhooks/hotmart", (req, res) => {
  res.redirect("/?endpoint=hotmart");
});

app.post("/webhooks/hotmart", async (req, res) => {
  const payload = req.body || {};
  const config = await getConfig();

  if (!isHotmartAuthorized(req, config)) {
    await recordEvent({ status: "unauthorized", receivedAt: new Date().toISOString(), payload });
    return res.status(401).json({ ok: false, error: "Webhook nao autorizado" });
  }

  const eventType = getEventType(payload);
  const allowedEvents = parseList(config.hotmartAllowedEvents).map((event) => event.toUpperCase());
  if (allowedEvents.length && !allowedEvents.includes(eventType)) {
    await recordEvent({ status: "ignored", reason: "event_not_allowed", eventType, receivedAt: new Date().toISOString(), payload });
    return res.status(202).json({ ok: true, ignored: true, eventType });
  }

  const sale = extractSale(payload);
  if (!sale.phone) {
    await recordEvent({ status: "missing_phone", eventType, sale, receivedAt: new Date().toISOString(), payload });
    return res.status(422).json({ ok: false, error: "Telefone do comprador nao encontrado no payload" });
  }

  await recordEvent({ status: "queued", eventType, sale, receivedAt: new Date().toISOString(), payload });
  const queued = await queueSaleMessages(sale, config, eventType);
  await recordEvent({
    status: queued.duplicate ? "sequence_already_queued" : "sequence_queued",
    eventType,
    sale,
    queued,
    receivedAt: new Date().toISOString()
  });
  scheduleProcessor(500);
  res.json({ ok: true, queued: true, eventType, buyer: sale.buyerName, phone: sale.phone, messagesQueued: queued.totalMessages });
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Nao encontrado" });
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
app.listen(port, host, () => {
  console.log(`Hotmart WhatsApp app rodando em ${host}:${port}`);
  scheduleProcessor(1500);
});

async function startWhatsApp() {
  if (whatsappClient && whatsappState.status === "ready") return whatsappClient;
  if (startPromise) return startPromise;

  whatsappState.status = "starting";
  whatsappState.qrDataUrl = "";
  whatsappState.lastError = "Buscando versao atual do WhatsApp Web...";

  startPromise = createWhatsAppClient()
    .catch((error) => {
      setWhatsAppError(error);
      throw error;
    })
    .finally(() => {
      startPromise = null;
    });

  return startPromise;
}

async function createWhatsAppClient() {
  const baileys = await loadBaileys();
  const { state, saveCreds } = await baileys.useMultiFileAuthState(authDir);
  const version = await getLatestWhatsAppVersion(baileys);

  whatsappState.webVersion = version.join(".");
  whatsappState.lastError = `Abrindo WhatsApp Web ${whatsappState.webVersion}...`;

  whatsappClient = baileys.makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: getBrowserTuple(baileys),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 20000
  });

  whatsappClient.ev.on("creds.update", saveCreds);
  whatsappClient.ev.on("connection.update", async (update) => {
    if (update.qr) {
      whatsappState.status = "qr";
      whatsappState.qrDataUrl = await qrcode.toDataURL(update.qr);
      whatsappState.lastError = "Leia o QR Code pelo WhatsApp do celular.";
    }

    if (update.connection === "open") {
      whatsappState.status = "ready";
      whatsappState.qrDataUrl = "";
      whatsappState.lastError = "";
      whatsappState.readyAt = new Date().toISOString();
      whatsappState.number = normalizeWhatsAppUser(whatsappClient.user?.id || "");
      scheduleProcessor(500);
    }

    if (update.connection === "close") {
      const code = getDisconnectCode(update.lastDisconnect);
      const message = explainDisconnect(update.lastDisconnect);
      whatsappClient = null;
      whatsappState.qrDataUrl = "";

      if (code === baileys.DisconnectReason?.loggedOut) {
        whatsappState.status = "disconnected";
        whatsappState.lastError = "Sessao encerrada. Clique em resetar sessao e conecte de novo.";
        return;
      }

      if (code === 405) {
        whatsappState.status = "disconnected";
        whatsappState.lastError = `WhatsApp recusou a conexao Web ${whatsappState.webVersion}. Clique em Resetar sessao e Iniciar WhatsApp Web de novo.`;
        return;
      }

      if (code === 515 || String(message).toLowerCase().includes("restart required")) {
        whatsappState.status = "starting";
        whatsappState.lastError = "Reiniciando conexao do WhatsApp Web...";
        setTimeout(() => startWhatsApp().catch(setWhatsAppError), 1500);
        return;
      }

      whatsappState.status = "disconnected";
      whatsappState.lastError = message;
    }
  });

  return whatsappClient;
}

async function loadBaileys() {
  if (baileysModule) return baileysModule;
  const imported = require("@whiskeysockets/baileys");
  baileysModule = {
    makeWASocket: pickBaileysFunction(imported, "makeWASocket", true),
    useMultiFileAuthState: pickBaileysFunction(imported, "useMultiFileAuthState"),
    fetchLatestBaileysVersion: pickBaileysFunction(imported, "fetchLatestBaileysVersion"),
    DisconnectReason: imported.DisconnectReason || imported.default?.DisconnectReason || {},
    Browsers: imported.Browsers || imported.default?.Browsers || {}
  };
  if (!baileysModule.makeWASocket || !baileysModule.useMultiFileAuthState) {
    const keys = Object.keys(imported || {}).slice(0, 12).join(", ");
    throw new Error(`Nao foi possivel carregar o cliente do WhatsApp Web. Exportacoes: ${keys}`);
  }
  return baileysModule;
}

function pickBaileysFunction(imported, name, allowDefault = false) {
  const candidates = [
    imported?.[name],
    imported?.default?.[name],
    imported?.default?.default?.[name],
    allowDefault ? imported?.default : null,
    allowDefault ? imported?.default?.default : null
  ];
  return candidates.find((candidate) => typeof candidate === "function") || null;
}

async function getLatestWhatsAppVersion(baileys) {
  if (baileys.fetchLatestBaileysVersion) {
    const result = await baileys.fetchLatestBaileysVersion().catch(() => null);
    if (Array.isArray(result?.version)) return result.version;
  }
  return [2, 3000, 1015901307];
}

function getBrowserTuple(baileys) {
  if (typeof baileys.Browsers?.ubuntu === "function") return baileys.Browsers.ubuntu("Chrome");
  if (typeof baileys.Browsers?.appropriate === "function") return baileys.Browsers.appropriate("Chrome");
  return ["Ubuntu", "Chrome", "22.04.4"];
}

async function resetWhatsApp() {
  try {
    if (whatsappClient?.end) whatsappClient.end();
    if (whatsappClient?.ws?.close) whatsappClient.ws.close();
  } catch {}
  whatsappClient = null;
  startPromise = null;
  await fs.rm(authDir, { recursive: true, force: true });
  whatsappState.status = "stopped";
  whatsappState.qrDataUrl = "";
  whatsappState.lastError = "Sessao limpa. Clique em iniciar para gerar outro QR Code.";
  whatsappState.readyAt = "";
  whatsappState.number = "";
}

function publicWhatsAppState() {
  return { ...whatsappState, connected: whatsappState.status === "ready" };
}

function setWhatsAppError(error) {
  whatsappState.status = "error";
  whatsappState.lastError = friendlyWhatsAppError(error);
  whatsappState.qrDataUrl = "";
}

function friendlyWhatsAppError(error) {
  const message = error?.message || String(error || "Erro desconhecido");
  return `Nao foi possivel iniciar o WhatsApp Web. Detalhe: ${message}`;
}

function getDisconnectCode(lastDisconnect) {
  const error = lastDisconnect?.error;
  return Number(error?.output?.statusCode || error?.statusCode || 0);
}

function explainDisconnect(lastDisconnect) {
  const code = getDisconnectCode(lastDisconnect);
  const error = lastDisconnect?.error;
  const message = error?.message || String(error || "Desconectado");
  return code ? `${message} (${code})` : message;
}

async function queueSaleMessages(sale, config, eventType) {
  const messages = getScheduledMessages(sale, config);
  const jobs = await readJson(jobsFile, []);
  const saleId = getSaleId(sale);
  const existing = jobs.filter((job) => job.saleId === saleId);
  if (existing.length) return { duplicate: true, saleId, totalMessages: existing.length };

  const now = Date.now();
  const newJobs = messages.map((item, index) => ({
    id: `${saleId}-${index + 1}-${now}`,
    saleId,
    eventType,
    buyerName: sale.buyerName,
    buyerEmail: sale.buyerEmail,
    phone: sale.phone,
    productName: sale.productName,
    transaction: sale.transaction,
    message: item.message,
    sequence: index + 1,
    totalMessages: messages.length,
    status: "pending",
    attempts: 0,
    scheduledAt: new Date(now + item.delayMs).toISOString(),
    createdAt: new Date(now).toISOString(),
    sentAt: "",
    lastError: ""
  }));

  await writeJson(jobsFile, jobs.concat(newJobs));
  return { duplicate: false, saleId, totalMessages: newJobs.length };
}

function getScheduledMessages(sale, config) {
  const scheduled = parseSchedule(config.whatsappMessageSchedule, sale);
  const legacy = parseLines(config.whatsappTextMessages).map((message) => ({ delayMs: 0, message: fillTemplate(message, sale) }));
  const messages = scheduled.length ? scheduled : legacy;
  const effective = messages.length ? messages : [{ delayMs: 0, message: defaultSaleMessage(sale) }];
  if (!effective.some((item) => item.delayMs === 0)) {
    effective.unshift({ delayMs: 0, message: defaultSaleMessage(sale) });
  }
  return effective.filter((item) => item.message).sort((a, b) => a.delayMs - b.delayMs);
}

function parseSchedule(value, sale) {
  return parseLines(value).map((line) => {
    const separator = line.indexOf("|");
    const rawDelay = separator >= 0 ? line.slice(0, separator).trim() : "0";
    const rawMessage = separator >= 0 ? line.slice(separator + 1).trim() : line.trim();
    return { delayMs: parseDelayMs(rawDelay), message: fillTemplate(rawMessage, sale) };
  });
}

function parseDelayMs(value) {
  const text = String(value || "0").trim().toLowerCase().replace(",", ".");
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(s|seg|segundos?|m|min|minutos?|h|hr|horas?|d|dias?)?$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2] || "m";
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (unit.startsWith("s")) return Math.round(amount * 1000);
  if (unit.startsWith("h")) return Math.round(amount * 60 * 60 * 1000);
  if (unit.startsWith("d")) return Math.round(amount * 24 * 60 * 60 * 1000);
  return Math.round(amount * 60 * 1000);
}

async function processQueue() {
  if (processorRunning) return;
  processorRunning = true;
  try {
    let jobs = await readJson(jobsFile, []);
    const now = Date.now();
    const due = jobs.filter((job) => job.status === "pending" && Date.parse(job.scheduledAt) <= now);
    if (!due.length) return;

    for (const job of due) {
      jobs = await readJson(jobsFile, []);
      const current = jobs.find((item) => item.id === job.id);
      if (!current || current.status !== "pending") continue;

      if (whatsappState.status !== "ready" || !whatsappClient) {
        current.lastError = "WhatsApp Web nao conectado.";
        await writeJson(jobsFile, jobs);
        continue;
      }

      current.status = "sending";
      current.attempts += 1;
      current.lastError = "";
      await writeJson(jobsFile, jobs);

      try {
        await sendWhatsAppMessage(current.phone, current.message);
        current.status = "sent";
        current.sentAt = new Date().toISOString();
        current.lastError = "";
        await recordEvent({ status: "message_sent", eventType: current.eventType, sale: jobToSale(current), sequence: current.sequence, receivedAt: new Date().toISOString() });
      } catch (error) {
        current.status = current.attempts >= 3 ? "failed" : "pending";
        current.scheduledAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
        current.lastError = error.message || String(error);
        await recordEvent({ status: "message_failed", eventType: current.eventType, sale: jobToSale(current), sequence: current.sequence, error: current.lastError, receivedAt: new Date().toISOString() });
      }

      await writeJson(jobsFile, jobs);
    }
  } finally {
    processorRunning = false;
    scheduleProcessor(5000);
  }
}

function scheduleProcessor(delayMs) {
  clearTimeout(processorTimer);
  processorTimer = setTimeout(processQueue, delayMs);
}

async function sendWhatsAppMessage(phone, message) {
  const jid = `${normalizeBrazilPhone(phone)}@s.whatsapp.net`;
  await whatsappClient.sendMessage(jid, { text: message });
}

function buildContactSummary(jobs) {
  const stats = { contacts: 0, totalMessages: jobs.length, pending: 0, sending: 0, sent: 0, failed: 0 };
  for (const job of jobs) {
    if (stats[job.status] !== undefined) stats[job.status] += 1;
  }

  const grouped = new Map();
  for (const job of jobs) {
    if (!grouped.has(job.saleId)) {
      grouped.set(job.saleId, {
        saleId: job.saleId,
        buyerName: job.buyerName,
        buyerEmail: job.buyerEmail,
        phone: job.phone,
        productName: job.productName,
        transaction: job.transaction,
        totalMessages: 0,
        sentMessages: 0,
        pendingMessages: 0,
        failedMessages: 0,
        nextMessageAt: "",
        lastError: "",
        createdAt: job.createdAt
      });
    }
    const contact = grouped.get(job.saleId);
    contact.totalMessages += 1;
    if (job.status === "sent") contact.sentMessages += 1;
    if (job.status === "pending" || job.status === "sending") contact.pendingMessages += 1;
    if (job.status === "failed") contact.failedMessages += 1;
    if (job.lastError) contact.lastError = job.lastError;
    if ((job.status === "pending" || job.status === "sending") && (!contact.nextMessageAt || Date.parse(job.scheduledAt) < Date.parse(contact.nextMessageAt))) {
      contact.nextMessageAt = job.scheduledAt;
    }
  }

  const contacts = Array.from(grouped.values()).map((contact) => ({
    ...contact,
    status: contact.sentMessages === contact.totalMessages ? "concluido" : contact.failedMessages && !contact.pendingMessages ? "falhou" : "em_andamento"
  })).sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));

  stats.contacts = contacts.length;
  return { ok: true, stats, contacts };
}

function extractSale(payload) {
  const buyer = firstObject(payload, ["data.buyer", "buyer", "data.user", "user", "data.customer", "customer"]);
  const product = firstObject(payload, ["data.product", "product", "data.purchase.product", "purchase.product"]);
  const purchase = firstObject(payload, ["data.purchase", "purchase", "data.transaction", "transaction"]);
  const rawPhone = firstValue(payload, [
    "data.buyer.checkout_phone",
    "data.buyer.phone",
    "data.buyer.phone_number",
    "data.buyer.mobile",
    "buyer.checkout_phone",
    "buyer.phone",
    "buyer.phone_number",
    "data.customer.phone",
    "customer.phone",
    "data.user.phone",
    "user.phone"
  ]);

  return {
    buyerName: buyer?.name || buyer?.first_name || buyer?.full_name || firstValue(payload, ["buyer_name", "name"]) || "cliente",
    buyerEmail: buyer?.email || firstValue(payload, ["data.buyer.email", "buyer.email", "email"]) || "",
    phone: normalizeBrazilPhone(rawPhone),
    productName: product?.name || product?.title || firstValue(payload, ["data.product.name", "product.name"]) || "seu produto",
    transaction: purchase?.transaction || purchase?.id || purchase?.order_id || firstValue(payload, ["data.purchase.transaction", "transaction", "id"]) || "",
    purchaseDate: purchase?.approved_date || purchase?.order_date || payload.creation_date || ""
  };
}

function getEventType(payload) {
  return String(payload.event || payload.event_type || payload.type || payload.data?.purchase?.status || payload.purchase?.status || "UNKNOWN").toUpperCase();
}

function isHotmartAuthorized(req, config) {
  const secret = String(config.hotmartWebhookSecret || "").trim();
  if (!secret) return true;
  const received = req.headers["x-hotmart-hottok"] || req.headers.hottok || req.headers["x-hottok"] || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return String(received || "") === secret;
}

function getSaleId(sale) {
  return [sale.transaction, sale.phone, sale.productName, sale.purchaseDate].filter(Boolean).join("|") || `${sale.phone}|${sale.productName}`;
}

function jobToSale(job) {
  return {
    buyerName: job.buyerName,
    buyerEmail: job.buyerEmail,
    phone: job.phone,
    productName: job.productName,
    transaction: job.transaction
  };
}

function fillTemplate(message, sale) {
  return String(message || "")
    .replaceAll("{{nome}}", sale.buyerName || "cliente")
    .replaceAll("{{produto}}", sale.productName || "seu produto")
    .replaceAll("{{email}}", sale.buyerEmail || "seu email")
    .replaceAll("{{telefone}}", sale.phone || "")
    .replaceAll("{{transacao}}", sale.transaction || "");
}

function defaultSaleMessage(sale) {
  return `Oi, ${sale.buyerName || "cliente"}! Sua compra de ${sale.productName || "seu produto"} foi confirmada. Obrigado pela compra!`;
}

function normalizeBrazilPhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (!digits.startsWith("55") && digits.length >= 10 && digits.length <= 11) digits = `55${digits}`;
  return digits;
}

function normalizeWhatsAppUser(value) {
  return String(value || "").split(":")[0].split("@")[0];
}

function firstObject(source, paths) {
  for (const itemPath of paths) {
    const value = getPath(source, itemPath);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  }
  return {};
}

function firstValue(source, paths) {
  for (const itemPath of paths) {
    const value = getPath(source, itemPath);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function getPath(source, itemPath) {
  return String(itemPath).split(".").reduce((current, part) => current?.[part], source);
}

function parseList(value) {
  return String(value || "").split(/[\n,;]/).map((item) => item.trim()).filter(Boolean);
}

function parseLines(value) {
  return String(value || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

async function getConfig() {
  return { ...defaultConfig, ...(await readJson(configFile, {})) };
}

async function recordEvent(event) {
  const events = await readJson(eventsFile, []);
  events.push(event);
  await writeJson(eventsFile, events.slice(-250));
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tempFile, file);
}
