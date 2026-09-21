# WheelBeast Marketplace Analyzer

This Worker is the backend for link-only Facebook Marketplace analysis.

## What it does

1. Accepts one exact Facebook Marketplace/share URL from WheelBeast.
2. Opens that URL using a dedicated WheelBeast Facebook session.
3. Reads only the rendered page text for that submitted listing.
4. Sends the visible text to Cloudflare Workers AI for structured vehicle metadata.
5. Returns year, make, model, price, km, safety status, summary and warning flags.

It does **not** crawl Marketplace or search Facebook broadly.

## Zero-cost prototype limits

Use a Cloudflare Workers **Free** account. Browser Run Free currently has a daily browser-time limit and Workers AI has a daily free allocation. When the free limits are exhausted, requests fail rather than silently switching the Worker to paid usage unless the account is explicitly upgraded.

## Deploy

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

After deploy, configure the frontend analyzer URL in `config.js`.

## Initialize the dedicated Facebook session

The Worker deliberately does not store a Facebook password. Sign into the dedicated WheelBeast Facebook account once in a trusted browser, export the Facebook cookies as JSON, and POST them to:

`POST /admin/session`

Header:

`Authorization: Bearer <ADMIN_TOKEN>`

Body:

```json
{ "cookies": [ ... ] }
```

The cookie/session state is kept server-side in the Durable Object. End users never log into Facebook through WheelBeast.

If Facebook expires or challenges the session, the API returns `FB_LOGIN_REQUIRED`; refresh the dedicated account's cookies and POST them again.

## Production notes

- Keep `ADMIN_TOKEN` secret.
- Do not put Facebook cookies in GitHub or frontend JavaScript.
- Restrict CORS to the WheelBeast site.
- Only exact user-submitted Facebook URLs are accepted.
