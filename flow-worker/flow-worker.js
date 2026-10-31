import 'dotenv/config';
import express from 'express';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const app = express();
app.use(express.json({ limit: '2mb' }));
const PORT = Number(process.env.FLOW_WORKER_PORT || 3010);
const SECRET = process.env.FLOW_WORKER_SECRET || '';
const FLOW_URL = process.env.FLOW_URL || 'https://labs.google/fx/tools/flow';
const GOOGLE_EMAIL = process.env.FLOW_GOOGLE_EMAIL || '';
const GOOGLE_PASSWORD = process.env.FLOW_GOOGLE_PASSWORD || '';
const PROFILE_DIR = process.env.FLOW_PROFILE_DIR || path.join(os.homedir(), '.animasi-ai-studio-flow-profile');
const HEADLESS = String(process.env.FLOW_HEADLESS || 'false').toLowerCase() === 'true';
const MAX_WAIT = Number(process.env.FLOW_MAX_WAIT_MS || 240000);
const DOWNLOAD_DIR = process.env.FLOW_DOWNLOAD_DIR || path.join(os.homedir(), 'AnimasiAIStudioDownloads');
let context, page, lastError = null, busy = false;

function auth(req,res,next) {
  if (!SECRET) return res.status(503).json({error:'FLOW_WORKER_SECRET belum diatur.'});
  const got = req.get('x-flow-worker-secret') || '';
  const a=Buffer.from(got), b=Buffer.from(SECRET);
  if (a.length!==b.length || !crypto.timingSafeEqual(a,b)) return res.status(401).json({error:'Unauthorized'});
  next();
}
async function launch() {
  await fs.mkdir(PROFILE_DIR,{recursive:true});
  await fs.mkdir(DOWNLOAD_DIR,{recursive:true});
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
    args: ['--disable-blink-features=AutomationControlled']
  });
  page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(25000);
  await page.goto(FLOW_URL,{waitUntil:'domcontentloaded',timeout:90000}).catch(e=>{lastError=e.message;});
  await ensureGoogleSession();
  console.log('Flow browser ready.');
}
async function ensureGoogleSession() {
  const needsLogin = /accounts\.google\.com|ServiceLogin/i.test(page.url()) || !(await page.locator('textarea:visible, [contenteditable="true"]:visible, [role="textbox"]:visible').count().catch(()=>0));
  if (!needsLogin || !GOOGLE_EMAIL || !GOOGLE_PASSWORD) return;
  await page.goto('https://accounts.google.com/ServiceLogin?service=wise',{waitUntil:'domcontentloaded',timeout:90000});
  const email=page.locator('input[type="email"]:visible').first();
  await email.waitFor({state:'visible',timeout:30000});
  await email.fill(GOOGLE_EMAIL); await email.press('Enter');
  await page.waitForTimeout(3500);
  let password=page.locator('input[type="password"]:visible').first();
  if (!(await password.count())) {
    const alternate=page.getByRole('button',{name:/try another way|coba cara lain/i}).last();
    if (await alternate.count() && await alternate.isVisible().catch(()=>false)) {
      await alternate.click(); await page.waitForTimeout(1800);
      const passwordChoice=page.getByText(/password|sandi/i).last();
      if (await passwordChoice.count() && await passwordChoice.isVisible().catch(()=>false)) { await passwordChoice.click(); await page.waitForTimeout(1800); }
    }
    password=page.locator('input[type="password"]:visible').first();
  }
  await password.waitFor({state:'visible',timeout:30000});
  await password.fill(GOOGLE_PASSWORD); await password.press('Enter');
  await page.waitForTimeout(7000);
  await page.goto(FLOW_URL,{waitUntil:'domcontentloaded',timeout:90000});
}
async function openFlowComposer() {
  const prompt=page.locator('textarea:visible, [contenteditable="true"]:visible, [role="textbox"]:visible');
  if (await prompt.count().catch(()=>0)) return;
  const next=page.getByRole('button',{name:/berikutnya|next/i}).last();
  if (await next.count() && await next.isVisible().catch(()=>false)) { await next.click().catch(()=>{}); await page.waitForTimeout(1200); }
  const project=page.getByRole('button',{name:/project baru|new project/i}).last();
  if (await project.count() && await project.isVisible().catch(()=>false)) { await project.click(); await page.waitForTimeout(2500); }
  const projectText=page.getByText(/^(project baru|new project)$/i).last();
  if (!(await prompt.count().catch(()=>0)) && await projectText.count() && await projectText.isVisible().catch(()=>false)) { await projectText.click(); await page.waitForTimeout(2500); }
}
function findPromptLocator() {
  if (process.env.FLOW_PROMPT_SELECTOR) return page.locator(process.env.FLOW_PROMPT_SELECTOR).last();
  return page.locator('textarea:visible, [contenteditable="true"]:visible, [role="textbox"]:visible').last();
}
async function fillPrompt(prompt) {
  const loc=findPromptLocator();
  await loc.waitFor({state:'visible',timeout:45000});
  await loc.fill(prompt);
}
async function clickGenerate() {
  if (process.env.FLOW_GENERATE_SELECTOR) {
    await page.locator(process.env.FLOW_GENERATE_SELECTOR).last().click();
    return;
  }
  const candidates = [
    page.getByRole('button',{name:/generate/i}),
    page.getByRole('button',{name:/create/i}),
    page.locator('button[aria-label*="Generate" i]')
  ];
  for (const loc of candidates) {
    if (await loc.count()) {
      const b=loc.last();
      if (await b.isVisible().catch(()=>false)) { await b.click(); return; }
    }
  }
  throw new Error('Tombol Generate tidak ditemukan. Atur FLOW_GENERATE_SELECTOR sesuai UI Flow yang tampil.');
}
async function downloadGeneratedVideo(previousVideoCount, previousDownloadCount) {
  const deadline=Date.now()+MAX_WAIT;
  // First allow the new generation to finish. Flow UI changes over time; selector overrides are provided.
  while(Date.now()<deadline) {
    const videoCount=await page.locator('video').count().catch(()=>0);
    const downloadCount=process.env.FLOW_DOWNLOAD_SELECTOR
      ? await page.locator(process.env.FLOW_DOWNLOAD_SELECTOR).count().catch(()=>0)
      : await page.getByRole('button',{name:/download/i}).count().catch(()=>0);
    if(videoCount>previousVideoCount || downloadCount>previousDownloadCount) break;
    await page.waitForTimeout(2500);
  }
  const downloadLoc = process.env.FLOW_DOWNLOAD_SELECTOR
    ? page.locator(process.env.FLOW_DOWNLOAD_SELECTOR).last()
    : page.getByRole('button',{name:/download/i}).last();
  if (!(await downloadLoc.count())) {
    throw new Error('Hasil video belum terdeteksi. Periksa Flow, tunggu generasi selesai, lalu sesuaikan FLOW_DOWNLOAD_SELECTOR jika tombol unduh berbeda.');
  }
  const [download] = await Promise.all([
    page.waitForEvent('download',{timeout:60000}),
    downloadLoc.click()
  ]);
  const suggested=download.suggestedFilename() || `flow-${Date.now()}.mp4`;
  const target=path.join(DOWNLOAD_DIR,`${Date.now()}-${suggested.replace(/[^a-zA-Z0-9._-]/g,'_')}`);
  await download.saveAs(target);
  const stat=await fs.stat(target);
  if(stat.size<10000) throw new Error('File unduhan terlalu kecil; hasil Flow mungkin belum selesai.');
  return target;
}
app.get('/health',auth,(_req,res)=>res.json({
  ok:true, browserReady:Boolean(context&&page), headless:HEADLESS, busy,
  flowUrl:FLOW_URL, currentUrl:page?.url()||null, lastError
}));
app.post('/login',auth,async(_req,res)=>{
  try {
    if(!context) await launch();
    await page.goto(FLOW_URL,{waitUntil:'domcontentloaded'});
    res.json({ok:true,message:'Browser Flow dibuka. Login Google secara manual di jendela browser, lalu coba produksi.'});
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/generate',auth,async(req,res)=>{
  if(busy) return res.status(409).json({error:'Flow worker sedang mengerjakan klip lain.'});
  const prompt=String(req.body?.prompt||'').trim();
  if(!prompt) return res.status(400).json({error:'Prompt wajib diisi.'});
  busy=true; let screenshotPath=null;
  try {
    if(!context) await launch();
    if(!page || page.isClosed()) page=await context.newPage();
    await page.goto(FLOW_URL,{waitUntil:'domcontentloaded',timeout:90000}).catch(()=>{});
    await ensureGoogleSession();
    if(/accounts\.google\.com|ServiceLogin/i.test(page.url())) throw new Error('Flow belum login.');
    await openFlowComposer();
    await fillPrompt(`${prompt}\nGenerate a silent visual-only animation. No dialogue, narration, music, sound effects, captions, subtitles, text or logos. Aspect ratio ${req.body?.aspectRatio==='16:9'?'16:9':'9:16'}.`);
    const previousVideoCount=await page.locator('video').count().catch(()=>0);
    const previousDownloadCount=process.env.FLOW_DOWNLOAD_SELECTOR
      ? await page.locator(process.env.FLOW_DOWNLOAD_SELECTOR).count().catch(()=>0)
      : await page.getByRole('button',{name:/download/i}).count().catch(()=>0);
    await clickGenerate();
    const file=await downloadGeneratedVideo(previousVideoCount,previousDownloadCount);
    const bytes=await fs.readFile(file);
    res.setHeader('Content-Type','video/mp4');
    res.setHeader('Content-Disposition','attachment; filename="flow-generated.mp4"');
    res.setHeader('X-Flow-File-Bytes',String(bytes.length));
    res.send(bytes);
    await fs.rm(file,{force:true}).catch(()=>{});
  } catch(e) {
    lastError=e.message;
    screenshotPath=path.join(DOWNLOAD_DIR,`flow-error-${Date.now()}.png`);
    await page?.screenshot({path:screenshotPath,fullPage:true}).catch(()=>{});
    console.error('Flow generation failed:',e.message,'Screenshot:',screenshotPath);
    if(!res.headersSent) res.status(502).json({error:e.message,screenshot:screenshotPath});
  } finally { busy=false; }
});
app.listen(PORT,async()=>{
  try { await launch(); } catch(e) { lastError=e.message; console.error('Browser launch failed:',e); }
  console.log(`Flow worker listening on ${PORT}`);
});
