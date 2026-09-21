// WheelBeast deployment trigger: Cloudflare Worker backend
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

async function extractVehicle(ai, pageText, pageTitle, url, extra = {}) {
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
Final URL: ${extra.finalUrl || url}
Page title: ${pageTitle}
OpenGraph title: ${extra.ogTitle || ""}
OpenGraph description: ${extra.ogDescription || ""}
Canonical URL: ${extra.canonical || ""}
Structured/script text:
${(extra.structuredText || "").slice(0, 12000)}

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

    if (u.pathname === "/status") {
      let session = { hasSession: false };
      try {
        const r = await stub.fetch(new Request("https://session.local/status"));
        session = await r.json();
      } catch {}
      return json({
        ok: true,
        browserConfigured: !!env.BROWSER,
        aiConfigured: !!env.AI,
        facebookCredentialsConfigured: !!env.FB_EMAIL && !!env.FB_PASSWORD,
        facebookCookieBootstrapConfigured: !!env.FB_COOKIES_JSON || !!env.FB_COOKIE_HEADER,
        facebookSessionReady: !!session.hasSession,
        service: "wheelbeast-marketplace-analyzer"
      });
    }

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

      let rendered;
      try {
        rendered = await stub.fetch(new Request("https://session.local/render", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: target })
        }));
      } catch (error) {
        return json({ error: String(error?.message || error), code: "SESSION_WORKER_ERROR", stage: "browser-session" }, 502);
      }

      const page = await rendered.json().catch(() => ({}));
      if (!rendered.ok) return json({ ...page, stage: page.stage || "facebook-render" }, rendered.status);

      let metadata;
      try {
        metadata = await extractVehicle(env.AI, page.text || "", page.title || "", target, {
          finalUrl: page.finalUrl,
          ogTitle: page.ogTitle,
          ogDescription: page.ogDescription,
          canonical: page.canonical,
          structuredText: page.structuredText
        });
      } catch (error) {
        return json({ error: String(error?.message || error), code: "AI_EXTRACTION_ERROR", stage: "ai-extraction" }, 502);
      }
      return json({
        ok: true,
        url: page.finalUrl || target,
        loginRequired: !!page.loginRequired,
        metadata,
        diagnostics: {
          finalUrl: page.finalUrl || target,
          textLength: (page.text || "").length,
          structuredLength: (page.structuredText || "").length,
          ogTitle: page.ogTitle || null,
          ogDescriptionPresent: !!page.ogDescription
        }
      });
    }

    return json({ error: "Not found" }, 404);
  }
};

export class FacebookSession extends DurableObject {
  async seedCookiesFromSecret() {
    if (this.env.FB_COOKIES_JSON) {
      try {
        const parsed = JSON.parse(this.env.FB_COOKIES_JSON);
        if (Array.isArray(parsed) && parsed.length) {
          await this.ctx.storage.put("facebookCookies", parsed);
          return parsed;
        }
      } catch {}
    }

    if (this.env.FB_COOKIE_HEADER) {
      const parsed = String(this.env.FB_COOKIE_HEADER)
        .split(";")
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => {
          const i = part.indexOf("=");
          if (i <= 0) return null;
          return {
            name: part.slice(0, i).trim(),
            value: part.slice(i + 1),
            domain: ".facebook.com",
            path: "/",
            secure: true,
            sameSite: "Lax"
          };
        })
        .filter(Boolean);

      if (parsed.length) {
        await this.ctx.storage.put("facebookCookies", parsed);
        return parsed;
      }
    }

    return [];
  }

  async login(page) {
    if (!this.env.FB_EMAIL || !this.env.FB_PASSWORD) {
      return { ok: false, code: "FB_CREDENTIALS_MISSING", error: "Facebook secrets are not configured.", stage: "facebook-login" };
    }

    await page.goto("https://www.facebook.com/login", { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForSelector('input[name="email"]', { timeout: 10000 });
    await page.type('input[name="email"]', this.env.FB_EMAIL, { delay: 20 });
    await page.type('input[name="pass"]', this.env.FB_PASSWORD, { delay: 20 });

    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }),
      page.click('button[name="login"]')
    ]);
    await new Promise(r => setTimeout(r, 2500));

    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    const lower = bodyText.toLowerCase();

    const challenged =
      /two-factor|two factor|authentication code|security check|confirm your identity|check your notifications|enter code/.test(lower) ||
      /checkpoint|two_step_verification/.test(finalUrl);

    const stillLogin =
      /\/login/.test(new URL(finalUrl).pathname) &&
      /log in|forgot password|create new account/.test(lower.slice(0, 2500));

    if (challenged) {
      return { ok: false, code: "FB_LOGIN_CHALLENGE", error: "Facebook requires a one-time verification for the WheelBeast account.", stage: "facebook-login" };
    }
    if (stillLogin) {
      return { ok: false, code: "FB_LOGIN_FAILED", error: "Facebook rejected the WheelBeast login.", stage: "facebook-login" };
    }

    const cookies = await page.cookies();
    if (!cookies?.length) {
      return { ok: false, code: "FB_LOGIN_FAILED", error: "Facebook login did not create a session.", stage: "facebook-login" };
    }

    await this.ctx.storage.put("facebookCookies", cookies);
    return { ok: true, stored: cookies.length };
  }

  async fetch(request) {
    const u = new URL(request.url);

    if (u.pathname === "/status") {
      const cookies = (await this.ctx.storage.get("facebookCookies")) || [];
      return json({ ok: true, hasSession: cookies.length > 0, cookieCount: cookies.length });
    }

    if (u.pathname === "/set" && request.method === "POST") {
      const body = await request.json();
      await this.ctx.storage.put("facebookCookies", body.cookies);
      return json({ ok: true, stored: body.cookies.length });
    }

    if (u.pathname !== "/render" || request.method !== "POST") {
      return json({ error: "Not found" }, 404);
    }

    const { url } = await request.json();

    let browser;
    try {
      browser = await puppeteer.launch(this.env.BROWSER);
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });

      let cookies = (await this.ctx.storage.get("facebookCookies")) || [];
      if (!cookies.length) cookies = await this.seedCookiesFromSecret();
      if (!cookies.length) {
        const login = await this.login(page);
        if (!login.ok) {
          return json({
            ...login,
            fallback: "Copy the normal browser's Facebook Cookie request header into the Cloudflare secret FB_COOKIE_HEADER, or provide FB_COOKIES_JSON."
          }, login.code === "FB_LOGIN_CHALLENGE" ? 409 : 401);
        }
        cookies = (await this.ctx.storage.get("facebookCookies")) || [];
      }

      if (cookies.length) await page.setCookie(...cookies);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
      await new Promise(r => setTimeout(r, 2000));

      await new Promise(r => setTimeout(r, 2500));
      let finalUrl = page.url();
      let title = await page.title();
      let extracted = await page.evaluate(() => {
        const text = document.body?.innerText || "";
        const meta = sel => document.querySelector(sel)?.getAttribute("content") || "";
        const canonical = document.querySelector('link[rel="canonical"]')?.href || "";
        const structuredText = Array.from(document.scripts)
          .map(s => s.textContent || "")
          .filter(t => /marketplace|listing|vehicle|price|kilomet|mileage|description|seller/i.test(t))
          .join("\n")
          .slice(0, 50000);
        return {
          text,
          ogTitle: meta('meta[property="og:title"]'),
          ogDescription: meta('meta[property="og:description"]'),
          canonical,
          structuredText
        };
      });
      let text = extracted.text || "";
      let ogTitle = extracted.ogTitle || "";
      let ogDescription = extracted.ogDescription || "";
      let canonical = extracted.canonical || "";
      let structuredText = extracted.structuredText || "";
      let lower = text.toLowerCase();

      let loginRequired =
        /log in|login to facebook|create new account/.test(lower.slice(0, 2500)) &&
        !/marketplace/.test(lower.slice(0, 1200));

      if (loginRequired) {
        const login = await this.login(page);
        if (!login.ok) return json(login, login.code === "FB_LOGIN_CHALLENGE" ? 409 : 401);

        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
        await new Promise(r => setTimeout(r, 2000));
        await new Promise(r => setTimeout(r, 2500));
        finalUrl = page.url();
        title = await page.title();
        extracted = await page.evaluate(() => {
          const text = document.body?.innerText || "";
          const meta = sel => document.querySelector(sel)?.getAttribute("content") || "";
          const canonical = document.querySelector('link[rel="canonical"]')?.href || "";
          const structuredText = Array.from(document.scripts)
            .map(s => s.textContent || "")
            .filter(t => /marketplace|listing|vehicle|price|kilomet|mileage|description|seller/i.test(t))
            .join("\n")
            .slice(0, 50000);
          return {
            text,
            ogTitle: meta('meta[property="og:title"]'),
            ogDescription: meta('meta[property="og:description"]'),
            canonical,
            structuredText
          };
        });
        text = extracted.text || "";
        ogTitle = extracted.ogTitle || "";
        ogDescription = extracted.ogDescription || "";
        canonical = extracted.canonical || "";
        structuredText = extracted.structuredText || "";
        lower = text.toLowerCase();
        loginRequired =
          /log in|login to facebook|create new account/.test(lower.slice(0, 2500)) &&
          !/marketplace/.test(lower.slice(0, 1200));
      }

      const freshCookies = await page.cookies();
      if (freshCookies?.length) await this.ctx.storage.put("facebookCookies", freshCookies);

      if (loginRequired) {
        return json({ error: "WheelBeast Facebook session needs verification.", code: "FB_LOGIN_REQUIRED", loginRequired: true }, 401);
      }

      return json({
        ok: true,
        finalUrl,
        title,
        text: text.slice(0, 25000),
        ogTitle,
        ogDescription,
        canonical,
        structuredText: structuredText.slice(0, 30000),
        loginRequired: false
      });
    } catch (error) {
      return json({ error: String(error?.message || error), code: "BROWSER_ERROR", stage: "browser-render" }, 502);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }
}