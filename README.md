# Hotmart para WhatsApp Web

Site simples com webhook para receber uma venda da Hotmart e enviar mensagens pelo seu WhatsApp Web.

## Como rodar

```powershell
Copy-Item .env.example .env
npm install
npm start
```

Abra `http://localhost:3000`.

## Como usar

1. Clique em `Iniciar WhatsApp Web`.
2. Leia o QR Code com o WhatsApp do celular.
3. Preencha o token secreto da Hotmart.
4. Escreva as mensagens que deseja enviar, uma por linha.
5. Use `Validar sem enviar` para testar os dados.
6. Use `Enviar teste` para disparar uma mensagem real pelo WhatsApp conectado.
7. Configure na Hotmart o webhook:

```text
https://seu-dominio.com/webhooks/hotmart
```

Localmente, a URL aparece no painel como:

```text
http://localhost:3000/webhooks/hotmart
```

Para a Hotmart conseguir chamar o webhook de verdade, publique em uma hospedagem com HTTPS.

## Variáveis das mensagens

```text
{{nome}}       Nome do comprador
{{produto}}    Nome do produto
{{email}}      E-mail do comprador
{{transacao}}  Código da transação
```

Exemplo:

```text
Oi, {{nome}}! Sua compra de {{produto}} foi confirmada.
Seu acesso foi liberado para o e-mail {{email}}.
```

## Observação

Este projeto usa `whatsapp-web.js`, que automatiza o WhatsApp Web. Não é a API oficial da Meta. Funciona para fluxos simples, mas pode quebrar se o WhatsApp mudar a interface ou limitar automações.
