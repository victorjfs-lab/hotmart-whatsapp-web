const nodeCrypto = require("node:crypto");

if (!globalThis.crypto) {
  globalThis.crypto = nodeCrypto.webcrypto;
}

require("./baileys-server.js");
