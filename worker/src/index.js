import { DurableObject } from "cloudflare:workers";
import * as puppeteer from "@cloudflare/puppeteer";

const cors = {
  "Access-Control-Allow-Origin": "https://jakec0des.github.io",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors }
  });
}

function marketplaceUrl(value) {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    if (!(host === "facebook.com" || host.endsWith(".facebook.com"))) return null;
    if (u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function safeJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(cleaned); } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

async function extractVehicle(ai, pageText, pageTitle, url) {
  const prompt = `You extract used-car listing facts. Return JSON only.
Never invent a value. Use null when not clearly present.
Schema:
{
  "year": number|null,
  "make": string|null,
  "model": string|null,
  "trim": string|null,
  "price": number|null,
  "km": number|null,
  "location": string|null,
  "safety_status": "certified"|"not_certified"|"unknown",
  "description_summary": string|null,
  "maintenance_signals": string[],
  "warning_flags": string[],
  "seller_notes": string|null,
  "confidence": number
}
Price must be CAD numeric dollars when visible. km must be numeric kilometres.
confidence is 0 to 1 based only on how much listing data is present.

URL: ${url}
Page title: ${pageTitle}
Visible page text:
${pageText.slice(0, 18000)}`;

  const result = await ai.run("@cf/meta/llama-3.2-1b-instruct", {
    messages: [
      { role: "system", content: "Extract factual vehicle metadata. JSON only. Do not guess." },
      { role: "user", content: prompt }
    ],
    max_tokens: 700,
    temperature: 0
  });

  return safeJson(result?.response) || {
    year: null, make: null, model: null, trim: null, price: null, km: null,
    location: null, safety_status: "unknown", description_summary: null,
    maintenance_signals: [], warning_flags: [], seller_notes: null, confidence: 0
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const u = new URL(request.url);
    if (u.pathname === "/health") {
      return json({ ok: true, service: "wheelbeast-marketplace-analyzer" });
    }

    const id = env.FB_SESSION.idFromName("wheelbeast-facebook");
    const stub = env.FB_SESSION.get(id);

    if (u.pathname === "/admin/session" && request.method === "POST") {
      const auth = request.headers.get("authorization") || "";
      if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) {
        return json({ error: "Unauthorized" }, 401);
      }
      const body = await request.json().catch(() => ({}));
      if (!Array.isArray(body.cookies) || body.cookies.length === 0) {
        return json({ error: "cookies[] required" }, 400);
      }
      return stub.fetch(new Request("https://session.local/set", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cookies: body.cookies })
      }));
    }

    if (u.pathname === "/analyze" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const target = marketplaceUrl(body.url);
      if (!target) return json({ error: "A valid Facebook HTTPS URL is required." }, 400);

      const rendered = await stub.fetch(new Request("https://session.local/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: target })
      }));

      const page = await rendered.json();
      if (!rendered.ok) return json(page, rendered.status);

      const metadata = await extractVehicle(env.AI, page.text || "", page.title || "", target);
      return json({
        ok: true,
        url: page.finalUrl || target,
        loginRequired: !!page.loginRequired,
        metadata
      });
    }

    return json({ error: "Not found" }, 404);
  }
};

export class FacebookSession extends DurableObject {
  async fetch(request) {
    const u = new URL(request.url);

    if (u.pathname === "/set" && request.method === "POST") {
      const body = await request.json();
      await this.ctx.storage.put("facebookCookies", body.cookies);
      return json({ ok: true, stored: body.cookies.length });
    }

    if (u.pathname !== "/render" || request.method !== "POST") {
      return json({ error: "Not found" }, 404);
    }

    const { url } = await request.json();
    const cookies = (await this.ctx.storage.get("facebookCookies")) || [];
    if (!cookies.length) {
      return json({ error: "WheelBeast Facebook session has not been initialized.", code: "NO_FB_SESSION" }, 503);
    }

    let browser;
    try {
      browser = await puppeteer.launch(this.env.BROWSER);
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.setCookie(...cookies);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
      await new Promise(r => setTimeout(r, 1800));

      const finalUrl = page.url();
      const title = await page.title();
      const text = await page.evaluate(() => document.body?.innerText || "");
      const lower = text.toLowerCase();
      const loginRequired =
        /log in|login to facebook|create new account/.test(lower.slice(0, 2500)) &&
        !/marketplace/.test(lower.slice(0, 1200));

      const freshCookies = await page.cookies();
      if (freshCookies?.length) await this.ctx.storage.put("facebookCookies", freshCookies);

      if (loginRequired) {
        return json({ error: "WheelBeast Facebook session needs to be refreshed.", code: "FB_LOGIN_REQUIRED", loginRequired: true }, 401);
      }

      return json({ ok: true, finalUrl, title, text: text.slice(0, 25000), loginRequired: false });
    } catch (error) {
      return json({ error: String(error?.message || error), code: "BROWSER_ERROR" }, 502);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }
}