import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(rootDir, "data");
const eventsFile = path.join(dataDir, "events.jsonl");
const configFile = path.join(dataDir, "config.json");

await loadEnvFile(path.join(rootDir, ".env"));

const env = process.env;
const port = parseListenTarget(env.PORT || 3000);
const host = env.HOST || "0.0.0.0";
let whatsappWebModule = null;
let qrcodeModule = null;
const whatsappState = {
  client: null,
  status: "stopped",
  qr: "",
  qrDataUrl: "",
  lastError: "",
  readyAt: "",
  number: ""
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, service: "hotmart-whatsapp-web" });
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      return handleEventsApi(req, res, url);
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      return handleConfigGet(req, res, url);
    }

    if (req.method === "POST" && url.pathname === "/api/config") {
      return handleConfigPost(req, res, url);
    }

    if (req.method === "POST" && url.pathname === "/api/test-sale") {
      return handleTestSale(req, res, url);
    }

    if (req.method === "GET" && url.pathname === "/api/whatsapp/status") {
      return handleWhatsAppStatus(req, res, url);
    }

    if (req.method === "POST" && url.pathname === "/api/whatsapp/start") {
      return handleWhatsAppStart(req, res, url);
    }

    if (req.method === "GET" && url.pathname === "/webhooks/hotmart") {
      res.writeHead(302, { Location: "/?endpoint=hotmart" });
      return res.end();
    }

    if (req.method === "POST" && url.pathname === "/webhooks/hotmart") {
      return handleHotmartWebhook(req, res);
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname, res);
    }

    json(res, 405, { ok: false, error: "Metodo nao permitido" });
  } catch (error) {
    console.error(error);
    json(res, 500, { ok: false, error: "Erro interno" });
  }
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled Rejection:", error);
});

const listenArgs = typeof port === "number" ? [port, host] : [port];
server.listen(...listenArgs, () => {
  const address = server.address();
  const displayAddress = typeof address === "string"
    ? address
    : `${address?.address || host}:${address?.port || port}`;

  console.log(`Hotmart WhatsApp app rodando em ${displayAddress}`);
  console.log("Webhook path: /webhooks/hotmart");
});

async function handleHotmartWebhook(req, res) {
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

  try {
    const messages = await sendWhatsAppConfirmation(sale, config);
    await recordEvent({ status: "sent", eventType, receivedAt: new Date().toISOString(), sale, messages, payload });
    json(res, 200, { ok: true, eventType, buyer: sale.buyerName, phone: sale.phone, messagesSent: messages.length });
  } catch (error) {
    await recordEvent({
      status: "send_failed",
      eventType,
      receivedAt: new Date().toISOString(),
      sale,
      error: error.message,
      payload
    });
    json(res, 502, { ok: false, eventType, error: error.message });
  }
}

async function handleTestSale(req, res, url) {
  if (!(await isDashboardAuthorized(url))) {
    return json(res, 401, { ok: false, error: "Painel nao autorizado" });
  }

  const body = parseJson(await readBody(req));
  if (!body) return json(res, 400, { ok: false, error: "JSON invalido" });

  const config = await getConfig();
  const sale = {
    buyerName: body.buyerName || "Cliente Teste",
    buyerEmail: body.buyerEmail || "",
    phone: normalizeBrazilPhone(body.phone || ""),
    productName: body.productName || "Produto Teste",
    transaction: body.transaction || `TEST-${Date.now()}`,
    purchaseDate: new Date().toISOString()
  };

  if (!sale.phone) {
    await recordEvent({ status: "test_missing_phone", eventType: "TEST_SALE", receivedAt: new Date().toISOString(), sale });
    return json(res, 422, { ok: false, error: "Informe o telefone do comprador." });
  }

  if (body.dryRun) {
    await recordEvent({ status: "test_ready", eventType: "TEST_SALE", receivedAt: new Date().toISOString(), sale });
    return json(res, 200, { ok: true, dryRun: true, sale, message: "Venda simulada validada. Nada foi enviado no WhatsApp." });
  }

  try {
    const messages = await sendWhatsAppConfirmation(sale, config);
    await recordEvent({ status: "test_sent", eventType: "TEST_SALE", receivedAt: new Date().toISOString(), sale, messages });
    return json(res, 200, { ok: true, sale, messagesSent: messages.length });
  } catch (error) {
    await recordEvent({ status: "test_send_failed", eventType: "TEST_SALE", receivedAt: new Date().toISOString(), sale, error: error.message });
    return json(res, 502, { ok: false, error: error.message, sale });
  }
}

function isHotmartRequestAuthorized(req, config) {
  const secret = config.hotmartWebhookSecret;
  if (!secret) return true;

  const receivedToken =
    req.headers["x-hotmart-hottok"] ||
    req.headers.hottok ||
    req.headers["x-hottok"] ||
    req.headers.authorization?.replace(/^Bearer\s+/i, "");

  return receivedToken === secret;
}

function getEventType(payload) {
  return String(
    payload.event ||
      payload.event_type ||
      payload.type ||
      payload.data?.purchase?.status ||
      payload.purchase?.status ||
      "UNKNOWN"
  ).toUpperCase();
}

function extractSale(payload) {
  const buyer = firstObject(payload, [
    "data.buyer",
    "buyer",
    "data.user",
    "user",
    "data.customer",
    "customer"
  ]);

  const product = firstObject(payload, [
    "data.product",
    "product",
    "data.purchase.product",
    "purchase.product"
  ]);

  const purchase = firstObject(payload, [
    "data.purchase",
    "purchase",
    "data.transaction",
    "transaction"
  ]);

  const rawPhone =
    firstValue(payload, [
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
    ]) || "";

  return {
    buyerName: buyer?.name || buyer?.first_name || buyer?.full_name || "cliente",
    buyerEmail: buyer?.email || "",
    phone: normalizeBrazilPhone(rawPhone),
    productName: product?.name || product?.title || "seu produto",
    transaction: purchase?.transaction || purchase?.id || purchase?.order_id || payload.id || "",
    purchaseDate: purchase?.approved_date || purchase?.order_date || payload.creation_date || ""
  };
}

async function sendWhatsAppConfirmation(sale, config) {
  const provider = String(config.whatsappProvider || "web").toLowerCase();
  if (provider === "cloud") {
    const mode = String(config.whatsappMessageMode || "template").toLowerCase();
    if (mode === "text") {
      return sendCloudTextMessages(sale, config);
    }
    return sendTemplateMessages(sale, config);
  }
  return sendWhatsAppWebMessages(sale, config);
}

async function sendTemplateMessages(sale, config) {
  const templates = parseList(config.whatsappTemplateNames);

  if (!templates.length) {
    throw new Error("Configure WHATSAPP_TEMPLATE_NAMES com pelo menos um template aprovado.");
  }

  const responses = [];
  for (const templateName of templates) {
    responses.push(await callWhatsAppApi({
      messaging_product: "whatsapp",
      to: sale.phone,
      type: "template",
      template: {
        name: templateName,
        language: { code: config.whatsappTemplateLanguage || "pt_BR" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: sale.buyerName },
              { type: "text", text: sale.productName },
              { type: "text", text: sale.transaction || "confirmada" }
            ]
          }
        ]
      }
    }));
  }
  return responses;
}

async function sendCloudTextMessages(sale, config) {
  const customMessages = parseLines(config.whatsappTextMessages).map((message) => fillTemplate(message, sale));
  const bodies = customMessages.length
    ? customMessages
    : [
        `Oi, ${sale.buyerName}! Sua compra de ${sale.productName} foi confirmada. Obrigado pela compra!`,
        `Acesso confirmado. Se precisar de ajuda, responda esta mensagem com o e-mail usado na compra: ${sale.buyerEmail || "seu e-mail de compra"}.`
      ];

  const responses = [];
  for (const body of bodies) {
    responses.push(await callWhatsAppApi({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: sale.phone,
      type: "text",
      text: { preview_url: false, body }
    }));
  }
  return responses;
}

async function sendWhatsAppWebMessages(sale, config) {
  await ensureWhatsAppWebClient();
  if (whatsappState.status !== "ready") {
    throw new Error("WhatsApp Web ainda nao esta conectado. Clique em Iniciar WhatsApp Web e leia o QR Code.");
  }

  const messages = getSaleMessages(sale, config);
  const chatId = await getWhatsAppWebChatId(sale.phone);
  const responses = [];

  for (const message of messages) {
    responses.push(await whatsappState.client.sendMessage(chatId, message));
  }

  return responses.map((message) => ({
    id: message.id?._serialized || "",
    timestamp: message.timestamp || Date.now()
  }));
}

function getSaleMessages(sale, config) {
  const customMessages = parseLines(config.whatsappTextMessages).map((message) => fillTemplate(message, sale));
  return customMessages.length
    ? customMessages
    : [
        `Oi, ${sale.buyerName}! Sua compra de ${sale.productName} foi confirmada. Obrigado pela compra!`,
        `Acesso confirmado. Se precisar de ajuda, responda esta mensagem com o e-mail usado na compra: ${sale.buyerEmail || "seu e-mail de compra"}.`
      ];
}

async function getWhatsAppWebChatId(phone) {
  const digits = normalizeBrazilPhone(phone);
  const candidate = `${digits}@c.us`;
  const numberId = await whatsappState.client.getNumberId(digits).catch(() => null);
  if (numberId?._serialized) return numberId._serialized;

  const isRegistered = await whatsappState.client.isRegisteredUser(candidate).catch(() => false);
  if (isRegistered) return candidate;

  throw new Error(`O numero ${digits} nao parece estar registrado no WhatsApp.`);
}

async function callWhatsAppApi(body, config = null) {
  const effectiveConfig = config || await getConfig();
  const accessToken = effectiveConfig.whatsappAccessToken;
  const phoneNumberId = effectiveConfig.whatsappPhoneNumberId;
  const apiVersion = effectiveConfig.whatsappApiVersion || "v21.0";

  if (!accessToken || !phoneNumberId) {
    throw new Error("Configure WHATSAPP_ACCESS_TOKEN e WHATSAPP_PHONE_NUMBER_ID.");
  }

  const response = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`WhatsApp API ${response.status}: ${JSON.stringify(responseBody)}`);
  }
  return responseBody;
}

async function handleConfigGet(req, res, url) {
  if (!(await isDashboardAuthorized(url))) {
    return json(res, 401, { ok: false, error: "Painel nao autorizado" });
  }

  const config = await getConfig();
  json(res, 200, { ok: true, config: redactConfig(config) });
}

async function handleConfigPost(req, res, url) {
  if (!(await isDashboardAuthorized(url))) {
    return json(res, 401, { ok: false, error: "Painel nao autorizado" });
  }

  const body = parseJson(await readBody(req));
  if (!body) return json(res, 400, { ok: false, error: "JSON invalido" });

  const current = await getConfig();
  const next = {
    ...current,
    hotmartWebhookSecret: clean(body.hotmartWebhookSecret),
    hotmartAllowedEvents: clean(body.hotmartAllowedEvents) || "PURCHASE_APPROVED,PURCHASE_COMPLETE",
    whatsappProvider: clean(body.whatsappProvider) || "web",
    whatsappAccessToken: clean(body.whatsappAccessToken) || current.whatsappAccessToken,
    whatsappPhoneNumberId: clean(body.whatsappPhoneNumberId),
    whatsappApiVersion: clean(body.whatsappApiVersion) || "v21.0",
    whatsappMessageMode: clean(body.whatsappMessageMode) || "template",
    whatsappTemplateNames: clean(body.whatsappTemplateNames),
    whatsappTemplateLanguage: clean(body.whatsappTemplateLanguage) || "pt_BR",
    whatsappTextMessages: clean(body.whatsappTextMessages)
  };

  if (body.clearWhatsappAccessToken) {
    next.whatsappAccessToken = "";
  }

  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(configFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  json(res, 200, { ok: true, config: redactConfig(next) });
}

async function getConfig() {
  const stored = parseJson(await fs.readFile(configFile, "utf8").catch(() => "")) || {};
  return {
    hotmartWebhookSecret: stored.hotmartWebhookSecret ?? env.HOTMART_WEBHOOK_SECRET ?? "",
    hotmartAllowedEvents: stored.hotmartAllowedEvents ?? env.HOTMART_ALLOWED_EVENTS ?? "PURCHASE_APPROVED,PURCHASE_COMPLETE",
    whatsappProvider: stored.whatsappProvider ?? env.WHATSAPP_PROVIDER ?? "web",
    whatsappAccessToken: stored.whatsappAccessToken ?? env.WHATSAPP_ACCESS_TOKEN ?? "",
    whatsappPhoneNumberId: stored.whatsappPhoneNumberId ?? env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    whatsappApiVersion: stored.whatsappApiVersion ?? env.WHATSAPP_API_VERSION ?? "v21.0",
    whatsappMessageMode: stored.whatsappMessageMode ?? env.WHATSAPP_MESSAGE_MODE ?? "template",
    whatsappTemplateNames: stored.whatsappTemplateNames ?? env.WHATSAPP_TEMPLATE_NAMES ?? "",
    whatsappTemplateLanguage: stored.whatsappTemplateLanguage ?? env.WHATSAPP_TEMPLATE_LANGUAGE ?? "pt_BR",
    whatsappTextMessages: stored.whatsappTextMessages ?? env.WHATSAPP_TEXT_MESSAGES ?? ""
  };
}

function redactConfig(config) {
  return {
    ...config,
    whatsappAccessToken: config.whatsappAccessToken ? "************" : "",
    hasWhatsappAccessToken: Boolean(config.whatsappAccessToken)
  };
}

async function handleWhatsAppStatus(req, res, url) {
  if (!(await isDashboardAuthorized(url))) {
    return json(res, 401, { ok: false, error: "Painel nao autorizado" });
  }

  json(res, 200, { ok: true, whatsapp: publicWhatsAppState() });
}

async function handleWhatsAppStart(req, res, url) {
  if (!(await isDashboardAuthorized(url))) {
    return json(res, 401, { ok: false, error: "Painel nao autorizado" });
  }

  await ensureWhatsAppWebClient();
  json(res, 200, { ok: true, whatsapp: publicWhatsAppState() });
}

async function ensureWhatsAppWebClient() {
  if (whatsappState.client) return whatsappState.client;

  whatsappState.status = "starting";
  whatsappState.lastError = "";

  const { Client, LocalAuth } = await getWhatsAppWebModule();
  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: "hotmart-whatsapp",
      dataPath: path.join(dataDir, "whatsapp-session")
    }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    }
  });

  client.on("qr", async (qr) => {
    whatsappState.status = "qr";
    whatsappState.qr = qr;
    whatsappState.qrDataUrl = await generateQrDataUrl(qr);
    whatsappState.lastError = "";
  });

  client.on("ready", () => {
    whatsappState.status = "ready";
    whatsappState.qr = "";
    whatsappState.qrDataUrl = "";
    whatsappState.readyAt = new Date().toISOString();
    whatsappState.number = client.info?.wid?.user || "";
  });

  client.on("authenticated", () => {
    whatsappState.status = "authenticated";
    whatsappState.lastError = "";
  });

  client.on("auth_failure", (message) => {
    whatsappState.status = "auth_failure";
    whatsappState.lastError = String(message || "Falha de autenticacao");
  });

  client.on("disconnected", (reason) => {
    whatsappState.status = "disconnected";
    whatsappState.lastError = String(reason || "Desconectado");
    whatsappState.client = null;
  });

  whatsappState.client = client;
  client.initialize().catch((error) => {
    whatsappState.status = "error";
    whatsappState.lastError = error.message;
    whatsappState.client = null;
  });

  return client;
}

async function getWhatsAppWebModule() {
  if (whatsappWebModule) return whatsappWebModule;

  const imported = await import("whatsapp-web.js");
  const module = imported.default || imported;
  if (!module.Client || !module.LocalAuth) {
    throw new Error("Nao foi possivel carregar whatsapp-web.js.");
  }

  whatsappWebModule = {
    Client: module.Client,
    LocalAuth: module.LocalAuth
  };
  return whatsappWebModule;
}

async function generateQrDataUrl(qr) {
  if (!qrcodeModule) {
    const imported = await import("qrcode");
    qrcodeModule = imported.default || imported;
  }

  return qrcodeModule.toDataURL(qr);
}

function publicWhatsAppState() {
  return {
    status: whatsappState.status,
    qrDataUrl: whatsappState.qrDataUrl,
    lastError: whatsappState.lastError,
    readyAt: whatsappState.readyAt,
    number: whatsappState.number
  };
}

function normalizeBrazilPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("55")) return digits;
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

function parseListenTarget(value) {
  if (typeof value === "number") return value;
  const text = String(value || "").trim();
  if (/^\d+$/.test(text)) return Number(text);
  return text || 3000;
}

function firstObject(source, paths) {
  for (const pathExpression of paths) {
    const value = getPath(source, pathExpression);
    if (value && typeof value === "object") return value;
  }
  return {};
}

function firstValue(source, paths) {
  for (const pathExpression of paths) {
    const value = getPath(source, pathExpression);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function getPath(source, pathExpression) {
  return pathExpression.split(".").reduce((current, key) => current?.[key], source);
}

async function handleEventsApi(req, res, url) {
  if (!(await isDashboardAuthorized(url))) {
    return json(res, 401, { ok: false, error: "Nao autorizado" });
  }

  const lines = await fs.readFile(eventsFile, "utf8").catch(() => "");
  const events = lines
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-50)
    .reverse()
    .map((line) => parseJson(line))
    .filter(Boolean);

  json(res, 200, { ok: true, events });
}

async function isDashboardAuthorized(url) {
  const dashboardToken = env.DASHBOARD_TOKEN;
  if (!dashboardToken) return true;
  return url.searchParams.get("token") === dashboardToken;
}

async function serveStatic(urlPath, res) {
  const normalizedPath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(publicDir, normalizedPath));

  if (!filePath.startsWith(publicDir)) {
    return json(res, 403, { ok: false, error: "Acesso negado" });
  }

  const content = await fs.readFile(filePath).catch(() => null);
  if (!content) {
    return json(res, 404, { ok: false, error: "Nao encontrado" });
  }

  res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
  res.end(content);
}

async function recordEvent(event) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.appendFile(eventsFile, `${JSON.stringify(event)}\n`, "utf8");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function clean(value) {
  return String(value ?? "").trim();
}

function fillTemplate(message, sale) {
  return message
    .replaceAll("{{nome}}", sale.buyerName)
    .replaceAll("{{produto}}", sale.productName)
    .replaceAll("{{email}}", sale.buyerEmail || "")
    .replaceAll("{{transacao}}", sale.transaction || "");
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function loadEnvFile(filePath) {
  const content = await fs.readFile(filePath, "utf8").catch(() => "");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;

    const [key, ...valueParts] = trimmed.split("=");
    if (process.env[key]) continue;

    const value = valueParts.join("=").trim().replace(/^["']|["']$/g, "");
    process.env[key] = value;
  }
}
