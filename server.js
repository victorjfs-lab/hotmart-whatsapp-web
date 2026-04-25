const whatsappWeb = require("whatsapp-web.js");

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
        timeout: 60000,
        protocolTimeout: 120000,
        args: mergeArgs(puppeteer.args)
      }
    });
  }
}

whatsappWeb.Client = PatchedClient;
whatsappWeb.LocalAuth = TemporaryLocalAuth;

require("./legacy-server.js");
