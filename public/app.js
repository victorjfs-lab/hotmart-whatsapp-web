const webhookInput = document.querySelector("#webhook-url");
const healthStatus = document.querySelector("#health-status");
const eventsContainer = document.querySelector("#events");
const copyButton = document.querySelector("#copy-webhook");
const refreshButton = document.querySelector("#refresh-events");
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

webhookInput.value = `${window.location.origin}/webhooks/hotmart`;

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(webhookInput.value);
  copyButton.textContent = "Copiado";
  setTimeout(() => {
    copyButton.textContent = "Copiar";
  }, 1400);
});

refreshButton.addEventListener("click", loadEvents);
saveConfigButton.addEventListener("click", saveConfig);
dryRunButton.addEventListener("click", () => runTestSale(true));
sendTestButton.addEventListener("click", () => runTestSale(false));
startWhatsAppButton.addEventListener("click", startWhatsApp);
resetWhatsAppButton.addEventListener("click", resetWhatsApp);

checkHealth();
loadConfig();
loadEvents();
loadWhatsAppStatus();
setInterval(loadWhatsAppStatus, 3000);

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
  setNotice(configResult, "");
  try {
    const data = await requestJson("/api/config");
    fillForm(configForm, data.config);
    renderConfigChecks(data.config);
  } catch (error) {
    setNotice(configResult, error.message, "error");
    configChecks.textContent = "NÃ£o foi possÃ­vel carregar.";
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
    setNotice(configResult, "ConfiguraÃ§Ã£o salva.", "success");
  } catch (error) {
    setNotice(configResult, error.message, "error");
  } finally {
    saveConfigButton.disabled = false;
  }
}

async function runTestSale(dryRun) {
  const button = dryRun ? dryRunButton : sendTestButton;
  button.disabled = true;
  setNotice(testResult, dryRun ? "Validando venda..." : "Enviando teste...");

  try {
    const payload = { ...formData(testForm), dryRun };
    const data = await requestJson("/api/test-sale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    setNotice(
      testResult,
      dryRun
        ? "Venda validada. O app conseguiu montar os dados do comprador."
        : `Teste enviado. Mensagens: ${data.messagesSent || 0}.`,
      "success"
    );
    await loadEvents();
  } catch (error) {
    setNotice(testResult, error.message, "error");
    await loadEvents();
  } finally {
    button.disabled = false;
  }
}

async function startWhatsApp() {
  startWhatsAppButton.disabled = true;
  whatsappLabel.textContent = "Iniciando...";
  whatsappDetail.textContent = "Abrindo uma sessÃ£o do WhatsApp Web no servidor.";

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
    whatsappLabel.textContent = "IndisponÃ­vel";
    whatsappDetail.textContent = "NÃ£o foi possÃ­vel ler o status do WhatsApp Web.";
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
    return whatsapp.number ? `SessÃ£o conectada no nÃºmero ${whatsapp.number}.` : "SessÃ£o pronta para enviar mensagens.";
  }
  if (whatsapp.status === "qr") return "Abra o WhatsApp no celular e leia o QR Code.";
  if (whatsapp.status === "starting") return "Aguardando o WhatsApp Web gerar o QR Code.";
  return "Clique em iniciar para gerar o QR Code.";
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
  const checks = [
    ["Hotmart protegida", Boolean(config.hotmartWebhookSecret)],
    ["Envio por WhatsApp Web", config.whatsappProvider === "web"],
    ["Mensagens configuradas", Boolean(config.whatsappTextMessages)]
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
    event.receivedAt ? new Date(event.receivedAt).toLocaleString("pt-BR") : ""
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
  if (!response.ok) {
    throw new Error(data.error || `Erro ${response.status}`);
  }
  return data;
}

function fillForm(form, values) {
  for (const [key, value] of Object.entries(values || {})) {
    const field = form.elements[key];
    if (!field) continue;
    field.value = value || "";
  }

  const tokenField = form.elements.whatsappAccessToken;
  if (tokenField && values?.hasWhatsappAccessToken) {
    tokenField.placeholder = "Token jÃ¡ salvo. Cole outro para substituir.";
    tokenField.value = "";
  }
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function setNotice(element, message, type = "") {
  element.textContent = message;
  element.className = `notice ${type}`.trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
