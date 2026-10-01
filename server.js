import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import AdmZip from 'adm-zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3300);
const PASSWORD = process.env.APP_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || '';
const SESSION_DAYS = Math.max(1, Number(process.env.SESSION_DAYS || 7));
const API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_MB = Math.min(50, Math.max(1, Number(process.env.MAX_UPLOAD_MB || 20)));
const MAX_RESULTS = Math.min(25, Math.max(3, Number(process.env.MAX_COMPARABLES || 12)));
const HISTORY = path.join(__dirname, 'data', 'history.json');
const COOKIE = 'pricemark_session';

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({limit:'1mb'}));
app.use(express.urlencoded({extended:false}));
const upload = multer({storage:multer.memoryStorage(), limits:{fileSize:MAX_MB*1024*1024,files:1}});

const clean = (v='') => String(v).replace(/\u0000/g,'').replace(/\r/g,'').trim();
const safeEq = (a,b) => {
  const x=Buffer.from(String(a)), y=Buffer.from(String(b));
  return x.length===y.length && crypto.timingSafeEqual(x,y);
};
const sign = v => crypto.createHmac('sha256',SECRET).update(v).digest('base64url');
function makeToken(){
  const p=Buffer.from(JSON.stringify({v:1,exp:Date.now()+SESSION_DAYS*86400000,n:crypto.randomBytes(8).toString('hex')})).toString('base64url');
  return p+'.'+sign(p);
}
function cookies(req){
  return Object.fromEntries((req.headers.cookie||'').split(';').map(v=>v.trim()).filter(Boolean).map(v=>{
    const i=v.indexOf('='); return [decodeURIComponent(v.slice(0,i)),decodeURIComponent(v.slice(i+1))];
  }));
}
function authed(req){
  if(!SECRET) return false;
  const token=cookies(req)[COOKIE];
  if(!token?.includes('.')) return false;
  const [p,s]=token.split('.');
  if(!safeEq(s,sign(p))) return false;
  try{return JSON.parse(Buffer.from(p,'base64url').toString()).exp>Date.now();}catch{return false;}
}
const requireAuth=(req,res,next)=>authed(req)?next():res.status(401).json({error:'Sesi tidak valid atau sudah berakhir.'});
function setCookie(res){
  const secure=process.env.NODE_ENV==='production'?'; Secure':'';
  res.setHeader('Set-Cookie',`${COOKIE}=${encodeURIComponent(makeToken())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS*86400}${secure}`);
}
function clearCookie(res){
  const secure=process.env.NODE_ENV==='production'?'; Secure':'';
  res.setHeader('Set-Cookie',`${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

async function ensureHistory(){
  await fs.mkdir(path.dirname(HISTORY),{recursive:true});
  try{await fs.access(HISTORY);}catch{await fs.writeFile(HISTORY,'[]\n');}
}
async function readHistory(){
  await ensureHistory();
  try{const x=JSON.parse(await fs.readFile(HISTORY,'utf8')); return Array.isArray(x)?x:[];}catch{return [];}
}
let writeQueue=Promise.resolve();
function writeHistory(rows){
  writeQueue=writeQueue.then(async()=>{
    const tmp=HISTORY+'.tmp';
    await fs.writeFile(tmp,JSON.stringify(rows,null,2)+'\n');
    await fs.rename(tmp,HISTORY);
  });
  return writeQueue;
}

function pptxText(buffer){
  const z=new AdmZip(buffer);
  return z.getEntries().filter(e=>/^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
    .sort((a,b)=>a.entryName.localeCompare(b.entryName,undefined,{numeric:true}))
    .map(e=>[...e.getData().toString('utf8').matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m=>m[1]
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'")).join(' '))
    .join('\n');
}
async function parseFile(file){
  if(!file) return {parts:[],text:'',name:''};
  const ext=path.extname(file.originalname||'').toLowerCase();
  const mime=file.mimetype||'application/octet-stream';
  if(ext==='.pdf'||mime==='application/pdf') return {parts:[{type:'document',data:file.buffer.toString('base64'),mime_type:'application/pdf'}],text:'',name:file.originalname};
  if(/^image\//.test(mime)||['.png','.jpg','.jpeg','.webp','.gif','.bmp','.tif','.tiff'].includes(ext))
    return {parts:[{type:'image',data:file.buffer.toString('base64'),mime_type:mime==='image/jpg'?'image/jpeg':mime}],text:'',name:file.originalname};
  if(ext==='.docx'){
    const r=await mammoth.extractRawText({buffer:file.buffer});
    return {parts:[],text:clean(r.value).slice(0,150000),name:file.originalname};
  }
  if(['.xlsx','.xls'].includes(ext)){
    const wb=XLSX.read(file.buffer,{type:'buffer'});
    const text=wb.SheetNames.slice(0,8).map(n=>`### SHEET: ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join('\n');
    return {parts:[],text:clean(text).slice(0,180000),name:file.originalname};
  }
  if(ext==='.pptx') return {parts:[],text:clean(pptxText(file.buffer)).slice(0,150000),name:file.originalname};
  if(['.txt','.csv','.md','.json'].includes(ext)||/^text\//.test(mime))
    return {parts:[],text:clean(file.buffer.toString('utf8')).slice(0,180000),name:file.originalname};
  throw new Error('Format file belum didukung.');
}

async function gemini(body){
  if(!API_KEY) throw new Error('GEMINI_API_KEY belum dikonfigurasi.');
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/interactions?key=${encodeURIComponent(API_KEY)}`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({store:false,...body})
  });
  const raw=await r.text(); let data;
  try{data=JSON.parse(raw);}catch{throw new Error(`Respons Gemini tidak valid (HTTP ${r.status}).`);}
  if(!r.ok) throw new Error(data?.error?.message||data?.message||`Gemini HTTP ${r.status}`);
  return data;
}
function getText(obj){
  if(typeof obj?.output_text==='string') return obj.output_text;
  const out=[];
  const walk=n=>{if(!n)return;if(Array.isArray(n))return n.forEach(walk);if(typeof n!=='object')return;if(typeof n.text==='string')out.push(n.text);Object.values(n).forEach(walk);};
  walk(obj?.outputs||obj?.output||obj?.steps||obj);
  return out.join('\n').trim();
}
function sources(obj){
  const m=new Map();
  const walk=n=>{if(!n)return;if(Array.isArray(n))return n.forEach(walk);if(typeof n!=='object')return;
    const u=typeof n.url==='string'?n.url:typeof n.uri==='string'?n.uri:null;
    if(u&&/^https?:\/\//i.test(u)&&!/google\.com\/search/i.test(u))m.set(u,{title:clean(n.title||n.name||'Sumber'),url:u});
    Object.values(n).forEach(walk);
  };
  walk(obj); return [...m.values()].slice(0,40);
}
function parseJson(text){
  const t=text.replace(/^\s*```(?:json)?/i,'').replace(/```\s*$/,'').trim();
  return JSON.parse(t);
}

async function extractNeed({text,file,category,proposalPrice,currency}){
  const prompt=`Ekstrak kebutuhan procurement dari input berikut menjadi JSON valid saja.
Field wajib: title, summary, kind(product/service/unknown), query, must_match(array), nice_to_match(array), proposal_price(number|null), proposal_currency(string).
Kategori pilihan user: ${category}. Harga proposal eksplisit: ${proposalPrice||'tidak diisi'} ${currency}.
Teks user: ${text||'(kosong)'}
Teks hasil ekstraksi file: ${file.text||'(tidak ada)'}
Jangan mengarang spesifikasi yang tidak tersedia. Buat query pencarian yang spesifik.`;
  const input=file.parts.length?[{type:'text',text:prompt},...file.parts]:prompt;
  const r=await gemini({model:MODEL,input,generation_config:{temperature:0.05,max_output_tokens:3000}});
  const data=parseJson(getText(r));
  data.title=clean(data.title||'Analisis harga');
  data.summary=clean(data.summary);
  data.query=clean(data.query||data.title);
  data.kind=['product','service','unknown'].includes(data.kind)?data.kind:'unknown';
  data.must_match=Array.isArray(data.must_match)?data.must_match.map(clean).filter(Boolean):[];
  data.nice_to_match=Array.isArray(data.nice_to_match)?data.nice_to_match.map(clean).filter(Boolean):[];
  if(proposalPrice){data.proposal_price=proposalPrice;data.proposal_currency=currency;}
  return data;
}
function marketInstruction(m){
  if(m==='international') return 'Cari pasar internasional. Pertahankan mata uang asli sumber.';
  if(m==='sea') return 'Prioritaskan Indonesia, Singapura, Malaysia, Thailand, Vietnam, dan Filipina. Pertahankan mata uang asli.';
  return 'Fokus pasar Indonesia dan harga dalam IDR. Prioritaskan vendor/toko yang melayani Indonesia.';
}
async function searchMarket(extracted,market,mode){
  const modeText=mode==='cheapest'
    ?'Prioritaskan harga TERENDAH yang benar-benar comparable; jangan pilih murah karena speknya berbeda.'
    :mode==='best_match'?'Prioritaskan kecocokan spesifikasi/scope.':'Cari rentang pasar representatif dari murah sampai premium.';
  const prompt=`Lakukan riset harga pasar aktual menggunakan Google Search.
Target: ${extracted.title}
Ringkasan: ${extracted.summary}
Query awal: ${extracted.query}
Must match: ${JSON.stringify(extracted.must_match)}
Nice to match: ${JSON.stringify(extracted.nice_to_match)}
Jenis: ${extracted.kind}
${marketInstruction(market)}
${modeText}
Cari 5-${MAX_RESULTS} pembanding bila tersedia. Catat nama, vendor, harga numerik, mata uang, unit/periode, URL, kecocokan, serta pajak/ongkir/instalasi/subscription jika diketahui. Jangan membuat harga atau URL.`;
  const r=await gemini({model:MODEL,input:prompt,tools:[{type:'google_search'}],generation_config:{temperature:0.15,max_output_tokens:12000}});
  return {text:getText(r),sources:sources(r)};
}
async function normalize(extracted,search){
  const refs=search.sources.map((s,i)=>`[S${i+1}] ${s.title}: ${s.url}`).join('\n');
  const prompt=`Ubah hasil riset menjadi JSON valid saja:
{"comparables":[{"name":"","vendor":"","price":0,"currency":"","unit":"","source_url":"","source_title":"","match_score":0,"match_notes":"","price_notes":""}],"analysis":"","caveats":[]}
TARGET:
${JSON.stringify(extracted)}
URL valid:
${refs||'(tidak ada)'}
HASIL:
${search.text}
Aturan: source_url hanya boleh URL dari daftar; price angka aktual satu unit/periode; jangan konversi mata uang; match_score 0-100; buang item tanpa harga numerik; maksimal ${MAX_RESULTS} item.`;
  const r=await gemini({model:MODEL,input:prompt,generation_config:{temperature:0.05,max_output_tokens:8000}});
  return parseJson(getText(r));
}
function percentile(a,p){
  if(!a.length)return null;if(a.length===1)return a[0];
  const x=(a.length-1)*p,l=Math.floor(x),h=Math.ceil(x);
  return l===h?a[l]:a[l]+(a[h]-a[l])*(x-l);
}
function sanitize(rows,refs,mode){
  const allowed=new Set(refs.map(x=>x.url));
  let out=(Array.isArray(rows)?rows:[]).map(r=>({
    name:clean(r.name),vendor:clean(r.vendor),price:Number(r.price),
    currency:clean(r.currency).toUpperCase(),unit:clean(r.unit),
    source_url:allowed.has(r.source_url)?r.source_url:'',source_title:clean(r.source_title),
    match_score:Math.max(0,Math.min(100,Number(r.match_score)||0)),
    match_notes:clean(r.match_notes),price_notes:clean(r.price_notes)
  })).filter(r=>r.name&&Number.isFinite(r.price)&&r.price>0);
  const d=new Map(); for(const r of out)d.set(`${r.source_url}|${r.name}|${r.price}|${r.currency}`.toLowerCase(),r);
  out=[...d.values()];
  if(mode==='best_match')out.sort((a,b)=>b.match_score-a.match_score||a.price-b.price);
  else if(mode==='cheapest')out.sort((a,b)=>(b.match_score>=80)-(a.match_score>=80)||a.price-b.price||b.match_score-a.match_score);
  else out.sort((a,b)=>a.price-b.price);
  return out.slice(0,MAX_RESULTS);
}
function stats(rows,preferred){
  const good=rows.filter(r=>r.match_score>=70&&Number.isFinite(r.price)&&r.price>0);
  let pool=good.filter(r=>r.currency===preferred);
  if(pool.length<2)pool=good;
  const cur=[...new Set(pool.map(r=>r.currency).filter(Boolean))];
  if(!pool.length||cur.length!==1)return {currency:cur.length===1?cur[0]:null,count:pool.length,lowest:null,p25:null,median:null,p75:null,highest:null};
  const a=pool.map(r=>r.price).sort((x,y)=>x-y);
  return {currency:cur[0],count:a.length,lowest:a[0],p25:percentile(a,.25),median:percentile(a,.5),p75:percentile(a,.75),highest:a.at(-1)};
}

const attempts=new Map();
app.get('/health',(req,res)=>res.json({ok:true,app:'ARU PriceMark',model:MODEL,time:new Date().toISOString()}));
app.get('/api/session',(req,res)=>res.json({authenticated:authed(req)}));
app.post('/api/login',(req,res)=>{
  const ip=req.ip||'unknown',now=Date.now(),a=attempts.get(ip)||{n:0,until:now+900000};
  if(now>a.until){a.n=0;a.until=now+900000;}
  if(a.n>=10)return res.status(429).json({error:'Terlalu banyak percobaan login. Coba lagi nanti.'});
  if(!PASSWORD||!SECRET)return res.status(503).json({error:'Login server belum dikonfigurasi.'});
  if(!safeEq(req.body?.password||'',PASSWORD)){a.n++;attempts.set(ip,a);return res.status(401).json({error:'Password salah.'});}
  attempts.delete(ip);setCookie(res);res.json({ok:true});
});
app.post('/api/logout',(req,res)=>{clearCookie(res);res.json({ok:true});});
app.get('/api/history',requireAuth,async(req,res)=>res.json((await readHistory()).slice().reverse()));
app.delete('/api/history/:id',requireAuth,async(req,res)=>{
  const h=await readHistory(),n=h.filter(x=>x.id!==req.params.id);
  if(n.length===h.length)return res.status(404).json({error:'Riwayat tidak ditemukan.'});
  await writeHistory(n);res.json({ok:true});
});
app.post('/api/analyze',requireAuth,upload.single('file'),async(req,res,next)=>{
  try{
    const text=clean(req.body?.text||'');
    if(!text&&!req.file)return res.status(400).json({error:'Masukkan teks atau upload file.'});
    const market=['indonesia','sea','international'].includes(req.body?.market)?req.body.market:'indonesia';
    const mode=['market','cheapest','best_match'].includes(req.body?.mode)?req.body.mode:'market';
    const category=['auto','product','service'].includes(req.body?.category)?req.body.category:'auto';
    const currency=clean(req.body?.currency||(market==='indonesia'?'IDR':'USD')).toUpperCase();
    const proposalPrice=Number(req.body?.proposalPrice||0)||null;
    const file=await parseFile(req.file);
    const extracted=await extractNeed({text,file,category,proposalPrice,currency});
    const search=await searchMarket(extracted,market,mode);
    const norm=await normalize(extracted,search);
    const comparables=sanitize(norm.comparables,search.sources,mode);
    const record={
      id:`PM-${new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`,
      createdAt:new Date().toISOString(),inputType:req.file?(text?'text+file':'file'):'text',
      fileName:req.file?.originalname||null,userText:text.slice(0,3000),market,mode,category,
      extracted,comparables,stats:stats(comparables,extracted.proposal_currency||currency),
      analysis:clean(norm.analysis),caveats:Array.isArray(norm.caveats)?norm.caveats.map(clean).filter(Boolean):[],
      sources:search.sources,searchSummary:search.text.slice(0,16000)
    };
    const h=await readHistory();h.push(record);await writeHistory(h.slice(-500));res.json(record);
  }catch(e){next(e);}
});

app.get('/',(req,res)=>res.redirect(authed(req)?'/app':'/login'));
app.get('/login',(req,res)=>res.sendFile(path.join(__dirname,'public','login.html')));
app.get('/app',(req,res)=>authed(req)?res.sendFile(path.join(__dirname,'public','index.html')):res.redirect('/login'));
app.use('/assets',express.static(path.join(__dirname,'public'),{maxAge:process.env.NODE_ENV==='production'?'1h':0}));

app.use((err,req,res,next)=>{
  console.error(err);
  if(err instanceof multer.MulterError&&err.code==='LIMIT_FILE_SIZE')return res.status(413).json({error:`File terlalu besar. Maksimal ${MAX_MB} MB.`});
  res.status(500).json({error:err?.message||'Terjadi kesalahan server.'});
});

await ensureHistory();
app.listen(PORT,'127.0.0.1',()=>console.log(`ARU PriceMark running on http://127.0.0.1:${PORT}`));
