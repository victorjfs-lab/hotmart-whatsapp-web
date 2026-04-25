# Deploy na Hostinger pelo GitHub

Este projeto precisa rodar como aplicação Node.js, não como site estático.

## Requisitos

- Node.js 18 ou superior
- Suporte a processo Node persistente
- Permissão para rodar Chromium/Puppeteer em modo headless
- Pasta persistente para `data/`, onde ficam configuração, eventos e sessão do WhatsApp Web

Se a sua Hostinger for apenas hospedagem estática/PHP, o WhatsApp Web não vai funcionar. Nesse caso, use VPS ou hospedagem Node compatível.

## Configuração sugerida

No painel da Hostinger, conecte o repositório GitHub e configure:

```text
Build command: npm install
Start command: npm start
Port: usar a variável PORT fornecida pela Hostinger
```

Variáveis de ambiente:

```text
PORT=3000
BASE_URL=https://seu-dominio.com
HOTMART_WEBHOOK_SECRET=uma-chave-secreta
HOTMART_ALLOWED_EVENTS=PURCHASE_APPROVED,PURCHASE_COMPLETE
WHATSAPP_PROVIDER=web
```

Depois de publicar, abra:

```text
https://seu-dominio.com
```

Clique em `Iniciar WhatsApp Web` e leia o QR Code.

## Webhook na Hotmart

Use:

```text
https://seu-dominio.com/webhooks/hotmart
```

A Hotmart não aceita `localhost`, então o domínio precisa estar publicado com HTTPS.

## Observações

- Não envie a pasta `data/` para o GitHub. Ela contém sessão e logs locais.
- Se a Hostinger recriar o app a cada deploy sem persistir `data/`, será necessário ler o QR Code novamente.
- `whatsapp-web.js` usa WhatsApp Web. Não é a API oficial da Meta e pode sofrer limitações.
