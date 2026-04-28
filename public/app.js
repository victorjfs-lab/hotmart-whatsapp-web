const webhookInput = document.querySelector("#webhook-url");
const healthStatus = document.querySelector("#health-status");
const eventsContainer = document.querySelector("#events");
const contactsContainer = document.querySelector("#contacts");
const copyButton = document.querySelector("#copy-webhook");
const refreshButton = document.querySelector("#refresh-events");
const refreshContactsButton = document.querySelector("#refresh-contacts");
const configForm = document.querySelector("#config-form");
const testForm = document.querySelector("#test-form");
const saveConfigButton = document.querySelector("#save-config");
const dryRunButton = document.querySelector("#dry-run");
const sendTestButton = document.querySelector("#send-test");
const startWhatsAppButton = document.querySelector("#start-whatsapp");
const resetWhatsAppButton = document.querySelector("#reset-whatsapp");
const whatsappLabel = document.querySelector("#whatsapp-label");
const whatsappDetail = document.querySelector("#whatsapp-detail");
const whatsappQr = document.querySelector("#whatsapp-qr");
const configResult = document.querySelector("#config-result");
const testResult = document.querySelector("#test-result");
const configChecks = document.querySelector("#config-checks");
const statContacts = document.querySelector("#stat-contacts");
const statSent = document.querySelector("#stat-sent");
const statPending = document.querySelector("#stat-pending");
const statFailed = document.querySelector("#stat-failed");

webhookInput.value = `${window.location.origin}/webhooks/hotmart`;

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(webhookInput.value);
  copyButton.textContent = "Copiado";
  setTimeout(() => { copyButton.textContent = "Copiar"; }, 1400);
});

refreshButton.addEventListener("click", loadEvents);
refreshContactsButton.addEventListener("click", loadContacts);
saveConfigButton.addEventListener("click", saveConfig);
dryRunButton.addEventListener("click", () => runTestSale(true));
sendTestButton.addEventListener("click", () => runTestSale(false));
startWhatsAppButton.addEventListener("click", startWhatsApp);
resetWhatsAppButton.addEventListener("click", resetWhatsApp);
contactsContainer.addEventListener("click", (event) => {
  const button = event.target.closest("[data-retry-sale]");
  if (!button) return;
  retryContact(decodeURIComponent(button.dataset.retrySale || ""), button);
});

checkHealth();
loadConfig();
loadEvents();
loadContacts();
loadWhatsAppStatus();
setInterval(loadWhatsAppStatus, 3000);
setInterval(loadContacts, 5000);

async function checkHealth() {
  try {
    const response = await fetch("/health");
    if (!response.ok) throw new Error("offline");
    healthStatus.textContent = "Online";
    healthStatus.classList.add("ok");
  } catch {
    healthStatus.textContent = "Offline";
    healthStatus.classList.add("fail");
  }
}

async function loadConfig() {
  try {
    const data = await requestJson("/api/config");
    fillForm(configForm, data.config);
    renderConfigChecks(data.config);
  } catch (error) {
    setNotice(configResult, error.message, "error");
    configChecks.textContent = "Nao foi possivel carregar.";
  }
}

async function saveConfig() {
  saveConfigButton.disabled = true;
  setNotice(configResult, "Salvando...");
  try {
    const payload = formData(configForm);
    const data = await requestJson("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    fillForm(configForm, data.config);
    renderConfigChecks(data.config);
    setNotice(configResult, "Configuracao salva.", "success");
  } catch (error) {
    setNotice(configResult, error.message, "error");
  } finally {
    saveConfigButton.disabled = false;
  }
}

async function runTestSale(dryRun) {
  const button = dryRun ? dryRunButton : sendTestButton;
  button.disabled = true;
  setNotice(testResult, dryRun ? "Validando venda..." : "Criando fila de mensagens...");

  try {
    const payload = { ...formData(testForm), dryRun };
    const data = await requestJson("/api/test-sale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    setNotice(
      testResult,
      dryRun ? "Venda validada. Nada foi enviado." : `Fila criada. Mensagens programadas: ${data.messagesQueued || 0}.`,
      "success"
    );
    await loadEvents();
    await loadContacts();
  } catch (error) {
    setNotice(testResult, error.message, "error");
    await loadEvents();
    await loadContacts();
  } finally {
    button.disabled = false;
  }
}

async function startWhatsApp() {
  startWhatsAppButton.disabled = true;
  whatsappLabel.textContent = "Iniciando...";
  whatsappDetail.textContent = "Abrindo uma sessao do WhatsApp Web no servidor.";
  try {
    const data = await requestJson("/api/whatsapp/start", { method: "POST" });
    renderWhatsAppStatus(data.whatsapp);
  } catch (error) {
    whatsappLabel.textContent = "Erro";
    whatsappDetail.textContent = error.message;
  } finally {
    startWhatsAppButton.disabled = false;
  }
}

async function resetWhatsApp() {
  resetWhatsAppButton.disabled = true;
  whatsappLabel.textContent = "Resetando...";
  whatsappDetail.textContent = "Limpando a sessao local do WhatsApp Web.";
  whatsappQr.removeAttribute("src");
  whatsappQr.hidden = true;
  try {
    const data = await requestJson("/api/whatsapp/reset", { method: "POST" });
    renderWhatsAppStatus(data.whatsapp);
  } catch (error) {
    whatsappLabel.textContent = "Erro";
    whatsappDetail.textContent = error.message;
  } finally {
    resetWhatsAppButton.disabled = false;
  }
}

async function loadWhatsAppStatus() {
  try {
    const data = await requestJson("/api/whatsapp/status");
    renderWhatsAppStatus(data.whatsapp);
  } catch {
    whatsappLabel.textContent = "Indisponivel";
    whatsappDetail.textContent = "Nao foi possivel ler o status do WhatsApp Web.";
  }
}

function renderWhatsAppStatus(whatsapp) {
  const statusText = {
    stopped: "Desconectado",
    starting: "Iniciando",
    qr: "Leia o QR Code",
    authenticated: "Autenticando",
    ready: "Conectado",
    disconnected: "Desconectado",
    auth_failure: "Falha no login",
    error: "Erro"
  };

  whatsappLabel.textContent = statusText[whatsapp.status] || whatsapp.status;
  whatsappDetail.textContent = whatsapp.lastError || detailForStatus(whatsapp);

  if (whatsapp.qrDataUrl) {
    whatsappQr.src = whatsapp.qrDataUrl;
    whatsappQr.hidden = false;
  } else {
    whatsappQr.removeAttribute("src");
    whatsappQr.hidden = true;
  }
}

function detailForStatus(whatsapp) {
  if (whatsapp.status === "ready") {
    const numberText = whatsapp.number ? `Sessao conectada no numero ${whatsapp.number}.` : "Sessao pronta para enviar mensagens.";
    const keepAliveText = whatsapp.lastKeepAliveAt ? ` Keep-alive: ${formatDateTime(whatsapp.lastKeepAliveAt)}.` : "";
    return `${numberText}${keepAliveText}`;
  }
  if (whatsapp.status === "qr") return "Abra o WhatsApp no celular e leia o QR Code.";
  if (whatsapp.status === "starting") {
    return whatsapp.lastReconnectAt
      ? `Reconectando automaticamente. Tentativa ${whatsapp.reconnectAttempts || 1}.`
      : "Aguardando o WhatsApp Web gerar o QR Code.";
  }
  return "Clique em iniciar para gerar o QR Code.";
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("pt-BR");
}

async function loadContacts() {
  try {
    const data = await requestJson("/api/contacts");
    renderStats(data.stats);
    if (!data.contacts.length) {
      contactsContainer.textContent = "Nenhum comprador na fila ainda.";
      return;
    }
    contactsContainer.innerHTML = `
      <div class="contact-row contact-head">
        <span>Comprador</span><span>Produto</span><span>Envios</span><span>Status</span><span>Proxima</span>
      </div>
      ${data.contacts.map(renderContact).join("")}
    `;
  } catch (error) {
    contactsContainer.textContent = error.message;
  }
}

function renderStats(stats = {}) {
  statContacts.textContent = stats.contacts || 0;
  statSent.textContent = stats.sent || 0;
  statPending.textContent = (stats.pending || 0) + (stats.sending || 0) + (stats.unconfirmed || 0);
  statFailed.textContent = stats.failed || 0;
}

function renderContact(contact) {
  const statusLabel = {
    concluido: "Concluido",
    em_andamento: "Em andamento",
    sem_confirmacao: "Sem confirmacao",
    falhou: "Falhou"
  }[contact.status] || contact.status;
  const statusClass = contact.status === "concluido" ? "ok" : contact.status === "falhou" ? "fail" : "warn";
  const details = [contact.phone, contact.buyerEmail].filter(Boolean).join(" - ");
  const sends = `${contact.sentMessages || 0}/${contact.totalMessages || 0}`;
  const next = contact.nextMessageAt ? formatDate(contact.nextMessageAt) : "-";
  const error = contact.lastError ? `<small class="event-error">${escapeHtml(contact.lastError)}</small>` : "";
  const sentInfo = contact.lastMessageId ? `<small>ID: ${escapeHtml(contact.lastMessageId)}</small>` : "";
  const retryButton = contact.saleId
    ? `<button type="button" class="tiny" data-retry-sale="${encodeURIComponent(contact.saleId)}">Reenviar</button>`
    : "";
  return `
    <div class="contact-row">
      <span><strong>${escapeHtml(contact.buyerName || "Comprador")}</strong><small>${escapeHtml(details)}</small></span>
      <span>${escapeHtml(contact.productName || "-")}</span>
      <span>${escapeHtml(sends)}${sentInfo}</span>
      <span><mark class="${statusClass}">${escapeHtml(statusLabel)}</mark>${error}${retryButton}</span>
      <span>${escapeHtml(next)}</span>
    </div>
  `;
}

async function retryContact(saleId, button) {
  if (!saleId) return;
  button.disabled = true;
  button.textContent = "Recriando...";
  try {
    const data = await requestJson("/api/contacts/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ saleId })
    });
    button.textContent = `${data.queued || 0} na fila`;
    await loadEvents();
    await loadContacts();
  } catch (error) {
    button.textContent = "Erro";
    setNotice(testResult, error.message, "error");
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = "Reenviar";
    }, 1800);
  }
}

async function loadEvents() {
  eventsContainer.textContent = "Carregando...";
  try {
    const data = await requestJson("/api/events");
    if (!data.events.length) {
      eventsContainer.textContent = "Nenhum evento recebido ainda.";
      return;
    }
    eventsContainer.innerHTML = data.events.map(renderEvent).join("");
  } catch (error) {
    eventsContainer.textContent = error.message;
  }
}

function renderConfigChecks(config) {
  const hasSchedule = Boolean(config.whatsappMessageSchedule || config.whatsappTextMessages);
  const checks = [
    ["Webhook pronto", true],
    ["Token Hotmart opcional", true],
    ["Envio por WhatsApp Web", config.whatsappProvider === "web"],
    ["Sequencia configurada", hasSchedule]
  ];
  configChecks.innerHTML = checks
    .map(([label, ok]) => `<span class="${ok ? "check-ok" : "check-warn"}">${ok ? "OK" : "Pendente"} - ${escapeHtml(label)}</span>`)
    .join("");
}

function renderEvent(event) {
  const sale = event.sale || {};
  const title = [event.status, event.eventType].filter(Boolean).join(" / ");
  const details = [
    sale.buyerName,
    sale.productName,
    sale.phone,
    event.sequence ? `msg ${event.sequence}` : "",
    event.messageId ? `id ${event.messageId}` : "",
    event.receivedAt ? formatDate(event.receivedAt) : ""
  ].filter(Boolean).join(" - ");
  const error = event.error ? `<span class="event-error">${escapeHtml(event.error)}</span>` : "";
  return `
    <article class="event">
      <strong>${escapeHtml(title || "evento")}</strong>
      <span>${escapeHtml(details || event.reason || "Sem detalhes")}</span>
      ${error}
    </article>
  `;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Erro ${response.status}`);
  return data;
}

function fillForm(form, values) {
  for (const [key, value] of Object.entries(values || {})) {
    const field = form.elements[key];
    if (field) field.value = value || "";
  }
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function setNotice(element, message, type = "") {
  element.textContent = message;
  element.className = `notice ${type}`.trim();
}

function formatDate(value) {
  return new Date(value).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
