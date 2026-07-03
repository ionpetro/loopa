import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type CDPSession, type Locator, type Page } from "playwright-core";
import { createKernelBrowser, deleteKernelBrowser } from "./kernel.ts";
import type { ActionResult, BrowserAction, FrameRef, Observation } from "./types.ts";

const MAX_FRAMES = 4000; // ~5-6 min of screencast at ~10fps — runaway-job backstop

// perfect-cursors ships a dependency-free CJS bundle; inline it into the page
// init script so the synthetic cursor can spline-animate between the sparse
// mousemove positions Playwright emits (otherwise it teleports on every click).
// Read by explicit path — require.resolve gets rewritten to a virtual module id
// when Next bundles this file, and this module must also run under plain Node.
const PERFECT_CURSORS_JS = fs.readFileSync(
  path.join(process.cwd(), "node_modules", "perfect-cursors", "dist", "cjs", "index.js"),
  "utf8",
);

/** Injected on every page: a synthetic SVG cursor (the OS pointer isn't part of the page render). */
const CURSOR_SCRIPT = `(() => {
  if (window.__curInit) return; window.__curInit = true;
  const module = { exports: {} }; const exports = module.exports;
  ${PERFECT_CURSORS_JS}
  const PC = module.exports.PerfectCursor;
  const c = document.createElement("div");
  c.id = "__cursor";
  c.style.cssText = "position:fixed;top:-60px;left:-60px;width:28px;height:28px;margin:-3px 0 0 -3px;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.55));";
  c.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="#fff" stroke="#1a1a1a" stroke-width="1.5" stroke-linejoin="round"><path d="M9.80282 4.62973L15.8364 6.99069C19.3164 8.35243 21.0564 9.03329 20.9987 10.1133C20.941 11.1934 19.1251 11.6886 15.4933 12.6791C14.412 12.974 13.8713 13.1215 13.4964 13.4963C13.1215 13.8712 12.9741 14.4119 12.6791 15.4933C11.6887 19.125 11.1934 20.9409 10.1134 20.9986C9.03335 21.0563 8.35249 19.3163 6.99075 15.8363L4.62979 9.80276C3.20411 6.15934 2.49127 4.33764 3.41448 3.41442C4.3377 2.49121 6.15941 3.20405 9.80282 4.62973Z"></path></svg>';
  const add = () => { if (document.body && !document.getElementById("__cursor")) document.body.appendChild(c); };
  add();
  const pc = new PC((pt) => { c.style.left = pt[0] + "px"; c.style.top = pt[1] + "px"; });
  const ripple = (x, y) => {
    if (!document.body) return;
    const r = document.createElement("div");
    r.style.cssText = "position:fixed;width:36px;height:36px;margin:-18px 0 0 -18px;border:2.5px solid rgba(255,255,255,.9);border-radius:50%;z-index:2147483646;pointer-events:none;box-shadow:0 0 6px rgba(0,0,0,.4);left:" + x + "px;top:" + y + "px";
    document.body.appendChild(r);
    r.animate(
      [{ transform: "scale(.35)", opacity: 1 }, { transform: "scale(1.15)", opacity: 0 }],
      { duration: 450, easing: "ease-out" },
    ).onfinish = () => r.remove();
  };
  // The lib's rAF loop ends on the last frame before t=1 without emitting the
  // final point, leaving the cursor slightly short — snap to it once the glide is over.
  let settle = 0;
  document.addEventListener("mousemove", (e) => {
    add();
    pc.addPoint([e.clientX, e.clientY]);
    clearTimeout(settle);
    settle = setTimeout(() => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, 340);
  }, true);
  document.addEventListener("mousedown", (e) => { add(); ripple(e.clientX, e.clientY); }, true);
})()`;

function observeInPage() {
  const vis = (el: any) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 && el.offsetParent !== null; };
  function cssPath(el: any) {
    const parts: string[] = [];
    while (el && el.nodeType === 1 && el.tagName !== "BODY") {
      let s = el.tagName.toLowerCase();
      const p = el.parentElement;
      if (p) { const sib = [...p.children].filter((c: any) => c.tagName === el.tagName); if (sib.length > 1) s += ":nth-of-type(" + (sib.indexOf(el) + 1) + ")"; }
      parts.unshift(s); el = p;
    }
    return parts.join(">");
  }
  function durable(el: any) {
    const tag = el.tagName.toLowerCase();
    if (el.id) { try { if (document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) return { selector: "#" + CSS.escape(el.id) }; } catch (e) {} }
    const tid = el.getAttribute("data-testid"); if (tid) return { selector: '[data-testid="' + tid + '"]' };
    const href = el.getAttribute("href"); if (href) return { selector: tag + '[href="' + href + '"]' };
    const txt = (el.innerText || el.value || "").trim().replace(/\s+/g, " ");
    if (txt && txt.length <= 40) return { text: txt };
    return { selector: cssPath(el) };
  }
  const sel = "a,button,[role=button],input,textarea,select,[role=tab],[role=menuitem],[role=link],[role=option]";
  const nodes = [...document.querySelectorAll(sel)].filter(vis).slice(0, 55);
  const els: any[] = [];
  nodes.forEach((el: any, i: number) => {
    el.setAttribute("data-fva", String(i));
    const d = durable(el);
    els.push({
      i, tag: el.tagName.toLowerCase(), role: el.getAttribute("role") || "",
      name: ((el.innerText || el.getAttribute("aria-label") || el.value || "").trim().replace(/\s+/g, " ")).slice(0, 60),
      ph: el.getAttribute("placeholder") || "", href: el.getAttribute("href") || "",
      dialog: !!el.closest("[role=dialog]"), sel: d.selector || null, selText: (d as any).text || null,
    });
  });
  return { url: location.href, title: document.title, dialogOpen: !!document.querySelector("[role=dialog]"), elements: els };
}

export function observationText(o: Observation): string {
  const lines = o.elements.map((e) => {
    const bits = [`#${e.i}`, e.role || e.tag];
    if (e.name) bits.push(`"${e.name}"`);
    if (e.ph) bits.push(`placeholder="${e.ph}"`);
    if (e.href) bits.push(`href=${e.href}`);
    if (e.dialog) bits.push("[in-dialog]");
    return bits.join(" ");
  });
  return `URL: ${o.url}\nTITLE: ${o.title}\nDIALOG_OPEN: ${o.dialogOpen}\nELEMENTS:\n${lines.join("\n")}`;
}

export interface RecordingConfig {
  width: number;
  height: number;
  quality: number;
}

export interface OverlaySpec {
  W: number;
  H: number;
  captions: string[];
  brand: string;
}

export interface Overlays {
  caps: string[]; // base64 PNGs
  brand: string | null;
}

/**
 * One Kernel cloud browser, driven directly over CDP from this process.
 * Records continuously via Page.startScreencast while the agent acts — what
 * the user watches in the live view is exactly what lands in the MP4.
 */
export class BrowserSession {
  readonly sessionId: string;
  readonly liveViewUrl?: string;

  private browser: Browser;
  private page: Page;
  private cdp: CDPSession | null = null;
  private framesDir: string;
  private frames: FrameRef[] = [];
  private recStart = 0;
  private recording = false;

  private constructor(sessionId: string, liveViewUrl: string | undefined, browser: Browser, page: Page, framesDir: string) {
    this.sessionId = sessionId;
    this.liveViewUrl = liveViewUrl;
    this.browser = browser;
    this.page = page;
    this.framesDir = framesDir;
  }

  static async create(framesDir: string, viewport = { width: 1280, height: 800 }): Promise<BrowserSession> {
    const kb = await createKernelBrowser(viewport);
    let browser: Browser;
    try {
      browser = await chromium.connectOverCDP(kb.cdpWsUrl, { timeout: 30_000 });
    } catch (err) {
      await deleteKernelBrowser(kb.sessionId);
      throw err;
    }
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    await page.addInitScript(CURSOR_SCRIPT);
    fs.mkdirSync(framesDir, { recursive: true });
    return new BrowserSession(kb.sessionId, kb.liveViewUrl, browser, page, framesDir);
  }

  /** ms since recording started (0 if not yet recording). */
  now(): number {
    return this.recording ? Date.now() - this.recStart : 0;
  }

  async startRecording(cfg: RecordingConfig): Promise<void> {
    if (this.recording) return;
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.recStart = Date.now();
    this.recording = true;
    this.cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number }) => {
      if (!this.recording || this.frames.length >= MAX_FRAMES) return;
      const file = path.join(this.framesDir, `f_${String(this.frames.length).padStart(5, "0")}.jpg`);
      fs.writeFile(file, Buffer.from(f.data, "base64"), () => {});
      this.frames.push({ t: Date.now() - this.recStart, file });
      this.cdp?.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: cfg.quality,
      maxWidth: cfg.width,
      maxHeight: cfg.height,
      everyNthFrame: 2,
    });
  }

  async stopRecording(): Promise<FrameRef[]> {
    if (!this.recording) return this.frames;
    this.recording = false;
    try {
      await this.cdp?.send("Page.stopScreencast");
    } catch {}
    try {
      await this.cdp?.detach();
    } catch {}
    this.cdp = null;
    return this.frames;
  }

  async observe(withScreenshot = true): Promise<Observation> {
    const data = (await this.page.evaluate(observeInPage)) as Observation;
    if (withScreenshot) {
      const shot = await this.page.screenshot({ type: "jpeg", quality: 55, fullPage: false });
      data.shot = shot.toString("base64");
    }
    return data;
  }

  private target(a: BrowserAction): Locator {
    return this.page.locator(`[data-fva="${a.targetIndex}"]`).first();
  }

  async act(a: BrowserAction): Promise<ActionResult> {
    const sleep = (ms: number) => this.page.waitForTimeout(ms);
    try {
      if (a.action === "goto") {
        await this.page.goto(a.url!, { waitUntil: "domcontentloaded", timeout: 25_000 });
        await this.page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
      } else if (a.action === "scroll") {
        await this.page.mouse.wheel(0, a.dy ?? 400);
        await sleep(400);
      } else if (a.action === "wait") {
        await sleep(Math.min(a.ms ?? 800, 3_000));
      } else {
        const loc = this.target(a);
        await loc.scrollIntoViewIfNeeded({ timeout: 4_000 }).catch(() => {});
        if (a.action === "hover") await loc.hover({ timeout: 6_000 });
        else {
          // Move first and let the perfect-cursors glide (≤300ms) land on the
          // target before the click fires, so the pointer visibly travels there.
          await loc.hover({ timeout: 6_000 }).catch(() => {});
          await sleep(380);
          if (a.action === "type") {
            await loc.click({ timeout: 6_000 });
            await loc.fill("");
            await loc.pressSequentially(String(a.text ?? ""), { delay: 80 });
          } else {
            await loc.click({ timeout: 6_000 });
          }
        }
        await this.page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
      }
      await sleep(400);
      return { ok: true, url: this.page.url() };
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 160), url: this.page.url() };
    }
  }

  /**
   * Render caption/brand cards as transparent PNGs on a FRESH page — never the
   * recorded one, which can be left unstable by wherever the demo ended
   * (pending navigations, dialogs, SPA re-renders; seen in prod as a 30s
   * "waiting for element to be stable" screenshot timeout).
   */
  async renderOverlays(spec: OverlaySpec): Promise<Overlays> {
    const hesc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // 1x1 transparent PNG — stands in for a card that failed to render so
    // caption indexes stay aligned and one bad card can't kill the video.
    const BLANK =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const page = await this.page.context().newPage();
    try {
      await page.setViewportSize({ width: spec.W, height: spec.H }).catch(() => {});
      await page.setContent(
        "<html><head><meta charset='utf8'><link rel='preconnect' href='https://fonts.gstatic.com' crossorigin><link rel='stylesheet' href='https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;800&display=swap'><style>*{margin:0;box-sizing:border-box;font-family:'Poppins',Arial,Helvetica,sans-serif}body{background:transparent}</style></head><body><div id='stage'></div></body></html>",
      );
      await page
        .evaluate(() =>
          Promise.all(["400", "600", "800"].map((w) => document.fonts.load(`${w} 30px Poppins`))),
        )
        .catch(() => {});
      const shot = async (html: string): Promise<string> => {
        try {
          await page.evaluate((h) => { document.getElementById("stage")!.innerHTML = h; }, html);
          const el = await page.$("#x");
          const b = await el!.screenshot({ omitBackground: true, type: "png", timeout: 10_000 });
          return b.toString("base64");
        } catch (err) {
          console.error("[overlays] card render failed, using blank:", err instanceof Error ? err.message.split("\n")[0] : err);
          return BLANK;
        }
      };
      const caps: string[] = [];
      for (const t of spec.captions) {
        caps.push(await shot(
          `<div id='x' style="display:inline-block;background:rgba(10,10,18,.74);color:#fff;font-size:30px;font-weight:600;padding:14px 26px;border-radius:14px;max-width:1080px;line-height:1.3">${hesc(t)}</div>`,
        ));
      }
      const brand = spec.brand
        ? await shot(`<div id='x' style="color:rgba(255,255,255,.85);font-size:24px;font-weight:800;letter-spacing:1.5px">${hesc(spec.brand)}</div>`)
        : null;
      return { caps, brand: brand === BLANK ? null : brand };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    this.recording = false;
    try {
      await this.browser.close();
    } catch {}
    await deleteKernelBrowser(this.sessionId);
  }
}
