import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type CDPSession, type Locator, type Page } from "playwright-core";
import { createKernelBrowser, deleteKernelBrowser } from "./kernel.ts";
import type { ActionResult, BrowserAction, FrameRef, Observation } from "./types.ts";

const MAX_FRAMES = 4000; // ~5-6 min of screencast at ~10fps — runaway-job backstop

/** Injected on every page: a synthetic cursor dot (the OS pointer isn't part of the page render). */
const CURSOR_SCRIPT = `(() => {
  if (window.__curInit) return; window.__curInit = true;
  const c = document.createElement("div");
  c.id = "__cursor";
  c.style.cssText = "position:fixed;top:-60px;left:-60px;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;background:rgba(255,40,80,.62);border:2px solid #fff;box-shadow:0 0 10px rgba(0,0,0,.7);z-index:2147483647;pointer-events:none;";
  const add = () => { if (document.body && !document.getElementById("__cursor")) document.body.appendChild(c); };
  add();
  document.addEventListener("mousemove", (e) => { add(); c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
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
  title: string;
  subtitle: string;
  outro: string;
}

export interface Overlays {
  caps: string[]; // base64 PNGs
  brand: string | null;
  intro: string;
  outro: string;
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
        else if (a.action === "type") {
          await loc.click({ timeout: 6_000 });
          await loc.fill("");
          await loc.pressSequentially(String(a.text ?? ""), { delay: 80 });
        } else {
          await loc.click({ timeout: 6_000 });
        }
        await this.page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
      }
      await sleep(400);
      return { ok: true, url: this.page.url() };
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 160), url: this.page.url() };
    }
  }

  /** Render caption/brand/intro/outro cards as transparent PNGs using the (now idle) page. */
  async renderOverlays(spec: OverlaySpec): Promise<Overlays> {
    const hesc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    await this.page.setViewportSize({ width: spec.W, height: spec.H }).catch(() => {});
    await this.page.setContent(
      "<html><head><meta charset='utf8'><link rel='preconnect' href='https://fonts.gstatic.com' crossorigin><link rel='stylesheet' href='https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;800&display=swap'><style>*{margin:0;box-sizing:border-box;font-family:'Poppins',Arial,Helvetica,sans-serif}body{background:transparent}</style></head><body><div id='stage'></div></body></html>",
    );
    await this.page
      .evaluate(() =>
        Promise.all(["400", "600", "800"].map((w) => document.fonts.load(`${w} 30px Poppins`))),
      )
      .catch(() => {});
    const shot = async (html: string): Promise<string> => {
      await this.page.evaluate((h) => { document.getElementById("stage")!.innerHTML = h; }, html);
      const el = await this.page.$("#x");
      const b = await el!.screenshot({ omitBackground: true, type: "png" });
      return b.toString("base64");
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
    const cardCss = `width:${spec.W}px;height:${spec.H}px;background:linear-gradient(135deg,#0b0b12,#16161f);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px`;
    const intro = await shot(
      `<div id='x' style="${cardCss}"><div style='font-size:58px;font-weight:800;color:#fff;text-align:center;padding:0 60px'>${hesc(spec.title)}</div><div style='font-size:26px;font-weight:600;letter-spacing:1.5px;color:#ff2850'>${hesc(spec.subtitle)}</div></div>`,
    );
    const outro = await shot(
      `<div id='x' style="${cardCss}"><div style='font-size:50px;font-weight:800;color:#fff'>${hesc(spec.outro)}</div></div>`,
    );
    return { caps, brand, intro, outro };
  }

  async close(): Promise<void> {
    this.recording = false;
    try {
      await this.browser.close();
    } catch {}
    await deleteKernelBrowser(this.sessionId);
  }
}
