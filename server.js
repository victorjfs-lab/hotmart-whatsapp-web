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
let pendingAcks = new Map();

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

app.post("/api/contacts/retry", async (req, res) => {
  const body = await ensureBody(req);
  const jobs = await readJson(jobsFile, []);
  const source = jobs.find((job) => job.saleId === body.saleId) || jobs.find((job) => job.id === body.jobId);
  if (!source) {
    return res.status(404).json({ ok: false, error: "Comprador nao encontrado na fila." });
  }

  const sale = {
    buyerName: source.buyerName,
    buyerEmail: source.buyerEmail,
    phone: source.phone,
    productName: source.productName,
    transaction: `${source.transaction || "retry"}-RETRY-${Date.now()}`,
    purchaseDate: new Date().toISOString()
  };

  const queued = await queueSaleMessages(sale, await getConfig(), "MANUAL_RETRY", { force: true });
  await recordEvent({ status: "manual_retry_queued", eventType: "MANUAL_RETRY", sale, queued, receivedAt: new Date().toISOString() });
  scheduleProcessor(500);
  res.json({ ok: true, queued });
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
  whatsappClient.ev.on("messages.update", (updates) => {
    for (const update of updates || []) resolveAck(update);
  });
  whatsappClient.ev.on("message-receipt.update", (updates) => {
    for (const update of updates || []) resolveAck(update);
  });
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

async function ensureBody(req) {
  return req.body && typeof req.body === "object" ? req.body : {};
}

async function queueSaleMessages(sale, config, eventType, options = {}) {
  const messages = getScheduledMessages(sale, config);
  const jobs = await readJson(jobsFile, []);
  const saleId = options.force ? `${getSaleId(sale)}|retry-${Date.now()}` : getSaleId(sale);
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
        const sent = await sendWhatsAppMessage(current.phone, current.message);
        current.status = "sent";
        current.sentAt = new Date().toISOString();
        current.lastError = "";
        current.messageId = sent.messageId;
        current.remoteJid = sent.remoteJid;
        current.verifiedRecipient = sent.verified;
        current.ackStatus = sent.ackStatus;

        if (sent.ackConfirmed) {
          current.status = "sent";
          await recordEvent({
            status: "message_sent",
            eventType: current.eventType,
            sale: jobToSale(current),
            sequence: current.sequence,
            messageId: sent.messageId,
            remoteJid: sent.remoteJid,
            ackStatus: sent.ackStatus,
            verifiedRecipient: sent.verified,
            receivedAt: new Date().toISOString()
          });
        } else {
          current.status = "unconfirmed";
          current.lastError = `WhatsApp retornou ID ${sent.messageId || "-"}, mas nao confirmou a saida no socket.`;
          await recordEvent({
            status: "message_unconfirmed",
            eventType: current.eventType,
            sale: jobToSale(current),
            sequence: current.sequence,
            messageId: sent.messageId,
            remoteJid: sent.remoteJid,
            verifiedRecipient: sent.verified,
            error: current.lastError,
            receivedAt: new Date().toISOString()
          });
        }
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
  const recipient = await resolveWhatsAppRecipient(phone);
  const sent = await whatsappClient.sendMessage(recipient.jid, { text: message });
  const remoteJid = sent?.key?.remoteJid || recipient.jid;
  const messageId = sent?.key?.id || "";
  const ack = await waitForMessageAck(messageId, remoteJid, 12000);
  return {
    verified: recipient.verified,
    remoteJid,
    messageId,
    ackConfirmed: ack.confirmed,
    ackStatus: ack.status
  };
}

async function resolveWhatsAppRecipient(phone) {
  const normalized = normalizeBrazilPhone(phone);
  if (!normalized) throw new Error( ‰Q•±•™½¹”‘¼½µÁÉ…‘½ÈÙ…é¥¼¸ˆ¤ì((€½¹ÍÐ™…±±‰…­)¥€ô€‘í¹½Éµ…±¥é•‘õÌ¹Ý¡…ÑÍ…ÁÀ¹¹•Ñ€ì(€¥˜€¡ÑåÁ•½˜Ý¡…ÑÍ…ÁÁ±¥•¹Ð¹½¹]¡…ÑÍÁÀ€„ôô€‰™Õ¹Ñ¥½¸ˆ¤ì(€€€É•ÑÕÉ¸ì©¥è™…±±‰…­)¥°Ù•É¥™¥•è™…±Í”ôì(€ô((€™½È€¡½¹ÍÐÅÕ•Éä½˜m¹½Éµ…±¥é•°™…±±‰…­)¥‘t¤ì(€€€½¹ÍÐµ…Ñ¡•Ì€ô…Ý…¥ÐÝ¡…ÑÍ…ÁÁ±¥•¹Ð¹½¹]¡…ÑÍÁÀ¡ÅÕ•Éä¤¹…Ñ   ¤€ôømt¤ì(€€€½¹ÍÐµ…Ñ €ôÉÉ…ä¹¥ÍÉÉ…ä¡µ…Ñ¡•Ì¤€üµ…Ñ¡•Ì¹™¥¹ ¡¥Ñ•´¤€ôø¥Ñ•´ü¹•á¥ÍÑÌ¤€è¹Õ±°ì(€€€¥˜€¡µ…Ñ ¤ì(€€€€€É•ÑÕÉ¸ì©¥èµ…Ñ ¹©¥ñð™…±±‰…­)¥°Ù•É¥™¥•èÑÉÕ”ôì(€€€ô(€ô((€Ñ¡É½Ü¹•ÜÉÉ½È¡9Õµ•É¼€‘í¹½Éµ…±¥é•‘ô¹…¼•¹½¹ÑÉ…‘¼¹¼]¡…ÑÍÁÀ¹€¤ì)ô()™Õ¹Ñ¥½¸Ý…¥Ñ½É5•ÍÍ…•¬¡µ•ÍÍ…•%°É•µ½Ñ•)¥°Ñ¥µ•½ÕÑ5Ì¤ì(€¥˜€ …µ•ÍÍ…•%¤É•ÑÕÉ¸AÉ½µ¥Í”¹É•Í½±Ù”¡ì½¹™¥Éµ•è™…±Í”°ÍÑ…ÑÕÌè€‰Í•µ}¥ˆô¤ì((€É•ÑÕÉ¸¹•ÜAÉ½µ¥Í” ¡É•Í½±Ù”¤€ôøì(€€€½¹ÍÐ­•åÌ€ôm…­-•ä¡µ•ÍÍ…•%°É•µ½Ñ•)¥¤°…­-•ä¡µ•ÍÍ…•%°€ˆˆ¥tì(€€€½¹ÍÐ‘½¹”€ô€¡É•ÍÕ±Ð¤€ôøì(€€€€€±•…ÉQ¥µ•½ÕÐ¡Ñ¥µ•È¤ì(€€€€€­•åÌ¹™½É…  ¡­•ä¤€ôøÁ•¹‘¥¹­Ì¹‘•±•Ñ”¡­•ä¤¤ì(€€€€€É•Í½±Ù”¡É•ÍÕ±Ð¤ì(€€€ôì(€€€½¹ÍÐÑ¥µ•È€ôÍ•ÑQ¥µ•½ÕÐ  ¤€ôø‘½¹”¡ì½¹™¥Éµ•è™…±Í”°ÍÑ…ÑÕÌè€‰Ñ¥µ•½ÕÐˆô¤°Ñ¥µ•½ÕÑ5Ì¤ì(€€€½¹ÍÐ•¹ÑÉä€ôì‘½¹”ôì(€€€­•åÌ¹™½É…  ¡­•ä¤€ôøÁ•¹‘¥¹­Ì¹Í•Ð¡­•ä°•¹ÑÉä¤¤ì(€ô¤ì)ô()™Õ¹Ñ¥½¸…­-•ä¡µ•ÍÍ…•%°É•µ½Ñ•)¥¤ì(€É•ÑÕÉ¸€‘íÉ•µ½Ñ•)¥ñð€ˆ‰õð‘íµ•ÍÍ…•%ñð€ˆ‰õ€ì)ô()™Õ¹Ñ¥½¸É•Í½±Ù•¬¡ÕÁ‘…Ñ”¤ì(€½¹ÍÐµ•ÍÍ…•%€ôÕÁ‘…Ñ”ü¹­•äü¹¥ñðÕÁ‘…Ñ”ü¹µ•ÍÍ…•%ñðÕÁ‘…Ñ”ü¹¥ñð€ˆˆì(€¥˜€ …µ•ÍÍ…•%¤É•ÑÕÉ¸ì(€½¹ÍÐÉ•µ½Ñ•)¥€ôÕÁ‘…Ñ”ü¹­•äü¹É•µ½Ñ•)¥ñðÕÁ‘…Ñ”ü¹É•µ½Ñ•)¥ñð€ˆˆì(€½¹ÍÐÍÑ…ÑÕÌ€ôÕÁ‘…Ñ”ü¹ÕÁ‘…Ñ”ü¹ÍÑ…ÑÕÌñðÕÁ‘…Ñ”ü¹ÍÑ…ÑÕÌñðÕÁ‘…Ñ”ü¹É••¥ÁÐü¹ÑåÁ”ñð€‰…¬ˆì(€¥˜€ …¥Í½¹™¥Éµ•‘­MÑ…ÑÕÌ¡ÍÑ…ÑÕÌ¤¤É•ÑÕÉ¸ì(€½¹ÍÐ•¹ÑÉä€ôÁ•¹‘¥¹­Ì¹•Ð¡…­-•ä¡µ•ÍÍ…•%°É•µ½Ñ•)¥¤¤ñðÁ•¹‘¥¹­Ì¹•Ð¡…­-•ä¡µ•ÍÍ…•%°€ˆˆ¤¤ì(€¥˜€¡•¹ÑÉä¤•¹ÑÉä¹‘½¹”¡ì½¹™¥Éµ•èÑÉÕ”°ÍÑ…ÑÕÌèMÑÉ¥¹œ¡ÍÑ…ÑÕÌñð€‰…¬ˆ¤ô¤ì)ô()™Õ¹Ñ¥½¸¥Í½¹™¥Éµ•‘­MÑ…ÑÕÌ¡ÍÑ…ÑÕÌ¤ì(€¥˜€¡ÑåÁ•½˜ÍÑ…ÑÕÌ€ôôô€‰¹Õµ‰•Èˆ¤É•ÑÕÉ¸ÍÑ…ÑÕÌ€øô€Èì(€½¹ÍÐÑ•áÐ€ôMÑÉ¥¹œ¡ÍÑ…ÑÕÌñð€ˆˆ¤¹Ñ½1½Ý•É…Í” ¤ì(€É•ÑÕÉ¸l‰Í•ÉÙ•Èˆ°€‰‘•±¥Ù•Éäˆ°€‰É•…ˆ°€‰Á±…å•ˆ°€‰…¬ˆ°€‰Í•¹Ð‰t¹Í½µ” ¡Ù…±Õ”¤€ôøÑ•áÐ¹¥¹±Õ‘•Ì¡Ù…±Õ”¤¤ì)ô()™Õ¹Ñ¥½¸‰Õ¥±‘½¹Ñ…ÑMÕµµ…Éä¡©½‰Ì¤ì(€½¹ÍÐÍÑ…ÑÌ€ôì½¹Ñ…ÑÌè€À°Ñ½Ñ…±5•ÍÍ…•Ìè©½‰Ì¹±•¹Ñ °Á•¹‘¥¹œè€À°Í•¹‘¥¹œè€À°Í•¹Ðè€À°™…¥±•è€À°Õ¹½¹™¥Éµ•è€Àôì(€™½È€¡½¹ÍÐ©½ˆ½˜©½‰Ì¤ì(€€€¥˜€¡ÍÑ…ÑÍm©½ˆ¹ÍÑ…ÑÕÍt€„ôôÕ¹‘•™¥¹•¤ÍÑ…ÑÍm©½ˆ¹ÍÑ…ÑÕÍt€¬ô€Äì(€ô((€½¹ÍÐÉ½ÕÁ•€ô¹•Ü5…À ¤ì(€™½È€¡½¹ÍÐ©½ˆ½˜©½‰Ì¤ì(€€€¥˜€ …É½ÕÁ•¹¡…Ì¡©½ˆ¹Í…±•%¤¤ì(€€€€€É½ÕÁ•¹Í•Ð¡©½ˆ¹Í…±•%°ì(€€€€€€€Í…±•%è©½ˆ¹Í…±•%°(€€€€€€€‰Õå•É9…µ”è©½ˆ¹‰Õå•É9…µ”°(€€€€€€€‰Õå•Éµ…¥°è©½ˆ¹‰Õå•Éµ…¥°°(€€€€€€€Á¡½¹”è©½ˆ¹Á¡½¹”°(€€€€€€€ÁÉ½‘ÕÑ9…µ”è©½ˆ¹ÁÉ½‘ÕÑ9…µ”°(€€€€€€€ÑÉ…¹Í…Ñ¥½¸è©½ˆ¹ÑÉ…¹Í…Ñ¥½¸°(€€€€€€€Ñ½Ñ…±5•ÍÍ…•Ìè€À°(€€€€€€€Í•¹Ñ5•ÍÍ…•Ìè€À°(€€€€€€€Á•¹‘¥¹5•ÍÍ…•Ìè€À°(€€€€€€€™…¥±•‘5•ÍÍ…•Ìè€À°(€€€€€€€Õ¹½¹™¥Éµ•‘5•ÍÍ…•Ìè€À°(€€€€€€€¹•áÑ5•ÍÍ…•Ðè€ˆˆ°(€€€€€€€±…ÍÑÉÉ½Èè€ˆˆ°(€€€€€€€±…ÍÑ5•ÍÍ…•%è€ˆˆ°(€€€€€€€±…ÍÑM•¹ÑÐè€ˆˆ°(€€€€€€€É•µ½Ñ•)¥è€ˆˆ°(€€€€€€€É•…Ñ•‘Ðè©½ˆ¹É•…Ñ•‘Ð(€€€€€ô¤ì(€€€ô(€€€½¹Ñ…Ð€ôÉ½ÕÁ•¹•Ð¡©½ˆ¹Í…±•%¤ì(€€€½¹Ñ…Ð¹Ñ½Ñ…±5•ÍÍ…•Ì€¬ô€Äì(€€€¥˜€¡©½ˆ¹ÍÑ…ÑÕÌ€ôôô€‰Í•¹Ðˆ¤½¹Ñ…Ð¹Í•¹Ñ5•ÍÍ…•Ì€¬ô€Äì(€€€¥˜€¡©½ˆ¹ÍÑ…ÑÕÌ€ôôô€‰Á•¹‘¥¹œˆñð©½ˆ¹ÍÑ…ÑÕÌ€ôôô€‰Í•¹‘¥¹œˆ¤½¹Ñ…Ð¹Á•¹‘¥¹5•ÍÍ…•Ì€¬ô€Äì(€€€¥˜€¡©½ˆ¹ÍÑ…ÑÕÌ€ôôô€‰™…¥±•ˆ¤½¹Ñ…Ð¹™…¥±•‘5•ÍÍ…•Ì€¬ô€Äì(€€€¥˜€¡©½ˆ¹ÍÑ…ÑÕÌ€ôôô€‰Õ¹½¹™¥Éµ•ˆ¤½¹Ñ…Ð¹Õ¹½¹™¥Éµ•‘5•ÍÍ…•Ì€¬ô€Äì(€€€¥˜€¡©½ˆ¹±…ÍÑÉÉ½È¤½¹Ñ…Ð¹±…ÍÑÉÉ½È€ô©½ˆ¹±…ÍÑÉÉ½Èì(€€€¥˜€¡©½ˆ¹µ•ÍÍ…•%¤½¹Ñ…Ð¹±…ÍÑ5•ÍÍ…•%€ô©½ˆ¹µ•ÍÍ…•%ì(€€€¥˜€¡©½ˆ¹É•µ½Ñ•)¥¤½¹Ñ…Ð¹É•µ½Ñ•)¥€ô©½ˆ¹É•µ½Ñ•)¥ì(€€€¥˜€¡©½ˆ¹Í•¹ÑÐ¤½¹Ñ…Ð¹±…ÍÑM•¹ÑÐ€ô©½ˆ¹Í•¹ÑÐì(€€€¥˜€ ¡©½ˆ¹ÍÑ…ÑÕÌ€ôôô€‰Á•¹‘¥¹œˆñð©½ˆ¹ÍÑ…ÑÕÌ€ôôô€‰Í•¹‘¥¹œˆ¤€˜˜€ …½¹Ñ…Ð¹¹•áÑ5•ÍÍ…•Ðñð…Ñ”¹Á…ÉÍ”¡©½ˆ¹Í¡•‘Õ±•‘Ð¤€ð…Ñ”¹Á…ÉÍ”¡½¹Ñ…Ð¹¹•áÑ5•ÍÍ…•Ð¤¤¤ì(€€€€€½¹Ñ…Ð¹¹•áÑ5•ÍÍ…•Ð€ô©½ˆ¹Í¡•‘Õ±•‘Ðì(€€€ô(€ô((€½¹ÍÐ½¹Ñ…ÑÌ€ôÉÉ…ä¹™É½´¡É½ÕÁ•¹Ù…±Õ•Ì ¤¤¹µ…À ¡½¹Ñ…Ð¤€ôø€¡ì(€€€€¸¸¹½¹Ñ…Ð°(€€€ÍÑ…ÑÕÌè½¹Ñ…Ð¹Í•¹Ñ5•ÍÍ…•Ì€ôôô½¹Ñ…Ð¹Ñ½Ñ…±5•ÍÍ…•Ì(€€€€€€ü€‰½¹±Õ¥‘¼ˆ(€€€€€€è½¹Ñ…Ð¹Õ¹½¹™¥Éµ•‘5•ÍÍ…•Ì(€€€€€€€€ü€‰Í•µ}½¹™¥Éµ……¼ˆ(€€€€€€€€è½¹Ñ…Ð¹™…¥±•‘5•ÍÍ…•Ì€˜˜€…½¹Ñ…Ð¹Á•¹‘¥¹5•ÍÍ…•Ì(€€€€€€€€€€ü€‰™…±¡½Ôˆ(€€€€€€€€€€è€‰•µ}…¹‘…µ•¹Ñ¼ˆ(€ô¤¤¹Í½ÉÐ ¡„°ˆ¤€ôø…Ñ”¹Á…ÉÍ”¡ˆ¹É•…Ñ•‘Ðñð€À¤€´…Ñ”¹Á…ÉÍ”¡„¹É•…Ñ•‘Ðñð€À¤¤ì((€ÍÑ…ÑÌ¹½¹Ñ…ÑÌ€ô½¹Ñ…ÑÌ¹±•¹Ñ ì(€É•ÑÕÉ¸ì½¬èÑÉÕ”°ÍÑ…ÑÌ°½¹Ñ…ÑÌôì)ô()™Õ¹Ñ¥½¸•áÑÉ…ÑM…±”¡Á…å±½…¤ì(€½¹ÍÐ‰Õå•È€ô™¥ÉÍÑ=‰©•Ð¡Á…å±½…°l‰‘…Ñ„¹‰Õå•Èˆ°€‰‰Õå•Èˆ°€‰‘…Ñ„¹ÕÍ•Èˆ°€‰ÕÍ•Èˆ°€‰‘…Ñ„¹ÕÍÑ½µ•Èˆ°€‰ÕÍÑ½µ•È‰t¤ì(€½¹ÍÐÁÉ½‘ÕÐ€ô™¥ÉÍÑ=‰©•Ð¡Á…å±½…°l‰‘…Ñ„¹ÁÉ½‘ÕÐˆ°€‰ÁÉ½‘ÕÐˆ°€‰‘…Ñ„¹ÁÕÉ¡…Í”¹ÁÉ½‘ÕÐˆ°€‰ÁÕÉ¡…Í”¹ÁÉ½‘ÕÐ‰t¤ì(€½¹ÍÐÁÕÉ¡…Í”€ô™¥ÉÍÑ=‰©•Ð¡Á…å±½…°l‰‘…Ñ„¹ÁÕÉ¡…Í”ˆ°€‰ÁÕÉ¡…Í”ˆ°€‰‘…Ñ„¹ÑÉ…¹Í…Ñ¥½¸ˆ°€‰ÑÉ…¹Í…Ñ¥½¸‰t¤ì(€½¹ÍÐÉ…ÝA¡½¹”€ô™¥ÉÍÑY…±Õ”¡Á…å±½…°l(€€€€‰‘…Ñ„¹‰Õå•È¹¡•­½ÕÑ}Á¡½¹”ˆ°(€€€€‰‘…Ñ„¹‰Õå•È¹Á¡½¹”ˆ°(€€€€‰‘…Ñ„¹‰Õå•È¹Á¡½¹•}¹Õµ‰•Èˆ°(€€€€‰‘…Ñ„¹‰Õå•È¹µ½‰¥±”ˆ°(€€€€‰‰Õå•È¹¡•­½ÕÑ}Á¡½¹”ˆ°(€€€€‰‰Õå•È¹Á¡½¹”ˆ°(€€€€‰‰Õå•È¹Á¡½¹•}¹Õµ‰•Èˆ°(€€€€‰‘…Ñ„¹ÕÍÑ½µ•È¹Á¡½¹”ˆ°(€€€€‰ÕÍÑ½µ•È¹Á¡½¹”ˆ°(€€€€‰‘…Ñ„¹ÕÍ•È¹Á¡½¹”ˆ°(€€€€‰ÕÍ•È¹Á¡½¹”ˆ(€t¤ì((€É•ÑÕÉ¸ì(€€€‰Õå•É9…µ”è‰Õå•Èü¹¹…µ”ñð‰Õå•Èü¹™¥ÉÍÑ}¹…µ”ñð‰Õå•Èü¹™Õ±±}¹…µ”ñð™¥ÉÍÑY…±Õ”¡Á…å±½…°l‰‰Õå•É}¹…µ”ˆ°€‰¹…µ”‰t¤ñð€‰±¥•¹Ñ”ˆ°(€€€‰Õå•Éµ…¥°è‰Õå•Èü¹•µ…¥°ñð™¥ÉÍÑY…±Õ”¡Á…å±½…°l‰‘…Ñ„¹‰Õå•È¹•µ…¥°ˆ°€‰‰Õå•È¹•µ…¥°ˆ°€‰•µ…¥°‰t¤ñð€ˆˆ°(€€€Á¡½¹”è¹½Éµ…±¥é•	É…é¥±A¡½¹”¡É…ÝA¡½¹”¤°(€€€ÁÉ½‘ÕÑ9…µ”èÁÉ½‘ÕÐü¹¹…µ”ñðÁÉ½‘ÕÐü¹Ñ¥Ñ±”ñð™¥ÉÍÑY…±Õ”¡Á…å±½…°l‰‘…Ñ„¹ÁÉ½‘ÕÐ¹¹…µ”ˆ°€‰ÁÉ½‘ÕÐ¹¹…µ”‰t¤ñð€‰Í•ÔÁÉ½‘ÕÑ¼ˆ°(€€€ÑÉ…¹Í…Ñ¥½¸èÁÕÉ¡…Í”ü¹ÑÉ…¹Í…Ñ¥½¸ñðÁÕÉ¡…Í”ü¹¥ñðÁÕÉ¡…Í”ü¹½É‘•É}¥ñð™¥ÉÍÑY…±Õ”¡Á…å±½…°l‰‘…Ñ„¹ÁÕÉ¡…Í”¹ÑÉ…¹Í…Ñ¥½¸ˆ°€‰ÑÉ…¹Í…Ñ¥½¸ˆ°€‰¥‰t¤ñð€ˆˆ°(€€€ÁÕÉ¡…Í•…Ñ”èÁÕÉ¡…Í”ü¹…ÁÁÉ½Ù•‘}‘…Ñ”ñðÁÕÉ¡…Í”ü¹½É‘•É}‘…Ñ”ñðÁ…å±½…¹É•…Ñ¥½¹}‘…Ñ”ñð€ˆˆ(€ôì)ô()™Õ¹Ñ¥½¸•ÑÙ•¹ÑQåÁ”¡Á…å±½…¤ì(€É•ÑÕÉ¸MÑÉ¥¹œ¡Á…å±½…¹•Ù•¹ÐñðÁ…å±½…¹•Ù•¹Ñ}ÑåÁ”ñðÁ…å±½…¹ÑåÁ”ñðÁ…å±½…¹‘…Ñ„ü¹ÁÕÉ¡…Í”ü¹ÍÑ…ÑÕÌñðÁ…å±½…¹ÁÕÉ¡…Í”ü¹ÍÑ…ÑÕÌñð€‰U9-9=]8ˆ¤¹Ñ½UÁÁ•É…Í” ¤ì)ô()™Õ¹Ñ¥½¸¥Í!½Ñµ…ÉÑÕÑ¡½É¥é•¡É•Ä°½¹™¥œ¤ì(€½¹ÍÐÍ•É•Ð€ôMÑÉ¥¹œ¡½¹™¥œ¹¡½Ñµ…ÉÑ]•‰¡½½­M•É•Ðñð€ˆˆ¤¹ÑÉ¥´ ¤ì(€¥˜€ …Í•É•Ð¤É•ÑÕÉ¸ÑÉÕ”ì(€½¹ÍÐÉ••¥Ù•€ôÉ•Ä¹¡•…‘•ÉÍl‰àµ¡½Ñµ…ÉÐµ¡½ÑÑ½¬‰tñðÉ•Ä¹¡•…‘•ÉÌ¹¡½ÑÑ½¬ñðÉ•Ä¹¡•…‘•ÉÍl‰àµ¡½ÑÑ½¬‰tñðMÑÉ¥¹œ¡É•Ä¹¡•…‘•ÉÌ¹…ÕÑ¡½É¥é…Ñ¥½¸ñð€ˆˆ¤¹É•Á±…” ½y	•…É•ÉqÌ¬½¤°€ˆˆ¤ì(€É•ÑÕÉ¸MÑÉ¥¹œ¡É••¥Ù•ñð€ˆˆ¤€ôôôÍ•É•Ðì)ô()™Õ¹Ñ¥½¸•ÑM…±•%¡Í…±”¤ì(€É•ÑÕÉ¸mÍ…±”¹ÑÉ…¹Í…Ñ¥½¸°Í…±”¹Á¡½¹”°Í…±”¹ÁÉ½‘ÕÑ9…µ”°Í…±”¹ÁÕÉ¡…Í•…Ñ•t¹™¥±Ñ•È¡	½½±•…¸¤¹©½¥¸ ‰ðˆ¤ñð€‘íÍ…±”¹Á¡½¹•õð‘íÍ…±”¹ÁÉ½‘ÕÑ9…µ•õ€ì)ô()™Õ¹Ñ¥½¸©½‰Q½M…±”¡©½ˆ¤ì(€É•ÑÕÉ¸ì(€€€‰Õå•É9…µ”è©½ˆ¹‰Õå•É9…µ”°(€€€‰Õå•Éµ…¥°è©½ˆ¹‰Õå•Éµ…¥°°(€€€Á¡½¹”è©½ˆ¹Á¡½¹”°(€€€ÁÉ½‘ÕÑ9…µ”è©½ˆ¹ÁÉ½‘ÕÑ9…µ”°(€€€ÑÉ…¹Í…Ñ¥½¸è©½ˆ¹ÑÉ…¹Í…Ñ¥½¸(€ôì)ô()™Õ¹Ñ¥½¸™¥±±Q•µÁ±…Ñ”¡µ•ÍÍ…”°Í…±”¤ì(€É•ÑÕÉ¸MÑÉ¥¹œ¡µ•ÍÍ…”ñð€ˆˆ¤(€€€€¹É•Á±…•±° ‰íí¹½µ•õôˆ°Í…±”¹‰Õå•É9…µ”ñð€‰±¥•¹Ñ”ˆ¤(€€€€¹É•Á±…•±° ‰ííÁÉ½‘ÕÑ½õôˆ°Í…±”¹ÁÉ½‘ÕÑ9…µ”ñð€‰Í•ÔÁÉ½‘ÕÑ¼ˆ¤(€€€€¹É•Á±…•±° ‰íí•µ…¥±õôˆ°Í…±”¹‰Õå•Éµ…¥°ñð€‰Í•Ô•µ…¥°ˆ¤(€€€€¹É•Á±…•±° ‰ííÑ•±•™½¹•õôˆ°Í…±”¹Á¡½¹”ñð€ˆˆ¤(€€€€¹É•Á±…•±° ‰ííÑÉ…¹Í……½õôˆ°Í…±”¹ÑÉ…¹Í…Ñ¥½¸ñð€ˆˆ¤ì)ô()™Õ¹Ñ¥½¸‘•™…Õ±ÑM…±•5•ÍÍ…”¡Í…±”¤ì(€É•ÑÕÉ¸=¤°€‘íÍ…±”¹‰Õå•É9…µ”ñð€‰±¥•¹Ñ”‰ô„MÕ„½µÁÉ„‘”€‘íÍ…±”¹ÁÉ½‘ÕÑ9…µ”ñð€‰Í•ÔÁÉ½‘ÕÑ¼‰ô™½¤½¹™¥Éµ…‘„¸=‰É¥…‘¼Á•±„½µÁÉ„…€ì)ô()™Õ¹Ñ¥½¸¹½Éµ…±¥é•	É…é¥±A¡½¹”¡Ù…±Õ”¤ì(€±•Ð‘¥¥ÑÌ€ôMÑÉ¥¹œ¡Ù…±Õ”ñð€ˆˆ¤¹É•Á±…” ½q½œ°€ˆˆ¤ì(€¥˜€ …‘¥¥ÑÌ¤É•ÑÕÉ¸€ˆˆì(€¥˜€¡‘¥¥ÑÌ¹ÍÑ…ÉÑÍ]¥Ñ  ˆÀÀˆ¤¤‘¥¥ÑÌ€ô‘¥¥ÑÌ¹Í±¥” È¤ì(€¥˜€ …‘¥¥ÑÌ¹ÍÑ…ÉÑÍ]¥Ñ  ˆÔÔˆ¤€˜˜‘¥¥ÑÌ¹±•¹Ñ €øô€ÄÀ€˜˜‘¥¥ÑÌ¹±•¹Ñ €ðô€ÄÄ¤‘¥¥ÑÌ€ô€ÔÔ‘í‘¥¥ÑÍõ€ì(€É•ÑÕÉ¸‘¥¥ÑÌì)ô()™Õ¹Ñ¥½¸¹½Éµ…±¥é•]¡…ÑÍÁÁUÍ•È¡Ù…±Õ”¤ì(€É•ÑÕÉ¸MÑÉ¥¹œ¡Ù…±Õ”ñð€ˆˆ¤¹ÍÁ±¥Ð ˆèˆ¥lÁt¹ÍÁ±¥Ð ‰ ˆ¥lÁtì)ô()™Õ¹Ñ¥½¸™¥ÉÍÑ=‰©•Ð¡Í½ÕÉ”°Á…Ñ¡Ì¤ì(€™½È€¡½¹ÍÐ¥Ñ•µA…Ñ ½˜Á…Ñ¡Ì¤ì(€€€½¹ÍÐÙ…±Õ”€ô•ÑA…Ñ ¡Í½ÕÉ”°¥Ñ•µA…Ñ ¤ì(€€€¥˜€¡Ù…±Õ”€˜˜ÑåÁ•½˜Ù…±Õ”€ôôô€‰½‰©•Ðˆ€˜˜€…ÉÉ…ä¹¥ÍÉÉ…ä¡Ù…±Õ”¤¤É•ÑÕÉ¸Ù…±Õ”ì(€ô(€É•ÑÕÉ¸íôì)ô()™Õ¹Ñ¥½¸™¥ÉÍÑY…±Õ”¡Í½ÕÉ”°Á…Ñ¡Ì¤ì(€™½È€¡½¹ÍÐ¥Ñ•µA…Ñ ½˜Á…Ñ¡Ì¤ì(€€€½¹ÍÐÙ…±Õ”€ô•ÑA…Ñ ¡Í½ÕÉ”°¥Ñ•µA…Ñ ¤ì(€€€¥˜€¡Ù…±Õ”€„ôôÕ¹‘•™¥¹•€˜˜Ù…±Õ”€„ôô¹Õ±°€˜˜Ù…±Õ”€„ôô€ˆˆ¤É•ÑÕÉ¸Ù…±Õ”ì(€ô(€É•ÑÕÉ¸€ˆˆì)ô()™Õ¹Ñ¥½¸•ÑA…Ñ ¡Í½ÕÉ”°¥Ñ•µA…Ñ ¤ì(€É•ÑÕÉ¸MÑÉ¥¹œ¡¥Ñ•µA…Ñ ¤¹ÍÁ±¥Ð ˆ¸ˆ¤¹É•‘Õ” ¡ÕÉÉ•¹Ð°Á…ÉÐ¤€ôøÕÉÉ•¹Ðü¹mÁ…ÉÑt°Í½ÕÉ”¤ì)ô()™Õ¹Ñ¥½¸Á…ÉÍ•1¥ÍÐ¡Ù…±Õ”¤ì(€É•ÑÕÉ¸MÑÉ¥¹œ¡Ù…±Õ”ñð€ˆˆ¤¹ÍÁ±¥Ð ½mq¸°ít¼¤¹µ…À ¡¥Ñ•´¤€ôø¥Ñ•´¹ÑÉ¥´ ¤¤¹™¥±Ñ•È¡	½½±•…¸¤ì)ô()™Õ¹Ñ¥½¸Á…ÉÍ•1¥¹•Ì¡Ù…±Õ”¤ì(€É•ÑÕÉ¸MÑÉ¥¹œ¡Ù…±Õ”ñð€ˆˆ¤¹ÍÁ±¥Ð ½qÈýq¸¼¤¹µ…À ¡¥Ñ•´¤€ôø¥Ñ•´¹ÑÉ¥´ ¤¤¹™¥±Ñ•È¡	½½±•…¸¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸•Ñ½¹™¥œ ¤ì(€É•ÑÕÉ¸ì€¸¸¹‘•™…Õ±Ñ½¹™¥œ°€¸¸¸¡…Ý…¥ÐÉ•…‘)Í½¸¡½¹™¥¥±”°íô¤¤ôì)ô()…Íå¹Œ™Õ¹Ñ¥½¸É•½É‘Ù•¹Ð¡•Ù•¹Ð¤ì(€½¹ÍÐ•Ù•¹ÑÌ€ô…Ý…¥ÐÉ•…‘)Í½¸¡•Ù•¹ÑÍ¥±”°mt¤ì(€•Ù•¹ÑÌ¹ÁÕÍ ¡•Ù•¹Ð¤ì(€…Ý…¥ÐÝÉ¥Ñ•)Í½¸¡•Ù•¹ÑÍ¥±”°•Ù•¹ÑÌ¹Í±¥” ´ÈÔÀ¤¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸É•…‘)Í½¸¡™¥±”°™…±±‰…¬¤ì(€ÑÉäì(€€€É•ÑÕÉ¸)M=8¹Á…ÉÍ”¡…Ý…¥Ð™Ì¹É•…‘¥±”¡™¥±”°€‰ÕÑ˜àˆ¤¤ì(€ô…Ñ ì(€€€É•ÑÕÉ¸™…±±‰…¬ì(€ô)ô()…Íå¹Œ™Õ¹Ñ¥½¸ÝÉ¥Ñ•)Í½¸¡™¥±”°‘…Ñ„¤ì(€…Ý…¥Ð™Ì¹µ­‘¥È¡Á…Ñ ¹‘¥É¹…µ”¡™¥±”¤°ìÉ•ÕÉÍ¥Ù”èÑÉÕ”ô¤ì(€½¹ÍÐÑ•µÁ¥±”€ô€‘í™¥±•ô¸‘íÁÉ½•ÍÌ¹Á¥‘ô¹ÑµÁ€ì(€…Ý…¥Ð™Ì¹ÝÉ¥Ñ•¥±”¡Ñ•µÁ¥±”°€‘í)M=8¹ÍÑÉ¥¹¥™ä¡‘…Ñ„°¹Õ±°°€È¥õq¹€°€‰ÕÑ˜àˆ¤ì(€…Ý…¥Ð™Ì¹É•¹…µ”¡Ñ•µÁ¥±”°™¥±”¤ì)ô(