# ARU PriceMark

Web ringan untuk membandingkan proposal/barang/jasa dengan harga pasar menggunakan Gemini API + live web search.

## Fitur
- Frontend HTML/CSS/JavaScript biasa (tanpa Next.js/React).
- Login satu password dari `.env`, dengan signed session cookie.
- Input manual atau upload PDF, gambar, DOCX, XLS/XLSX, PPTX, CSV, TXT, Markdown, JSON.
- Market Indonesia, Asia Tenggara, atau International.
- Mode Harga Pasar, Termurah Comparable, atau Paling Sesuai.
- Gemini membaca kebutuhan, Google Search mencari pembanding, Gemini menormalisasi, backend menghitung statistik.
- Penyimpanan lokal `data/history.json`, tanpa database.
- API key Gemini hanya berada di backend.

## Setup lokal
```bash
cp .env.example .env
npm install
npm start
```
Buka `http://127.0.0.1:3300`.

## Environment
```env
PORT=3300
NODE_ENV=production
APP_PASSWORD=...
SESSION_SECRET=...
SESSION_DAYS=7
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.8-flash
SEARCH_PROVIDER=tavily
TAVILY_API_KEY=...
MAX_UPLOAD_MB=20
MAX_COMPARABLES=12
```

Untuk membuat secret random:
```bash
openssl rand -hex 32
```

## Deploy cepat (Ubuntu + PM2 + Hestia)
```bash
cd /opt/apps
git clone https://github.com/RioBithub/ARU_PriceMark.git
cd ARU_PriceMark
npm install --omit=dev
cp .env.example .env
nano .env
pm2 start deploy/ecosystem.config.cjs
pm2 save
curl http://127.0.0.1:3300/health
```

Lalu reverse proxy domain `pricemark.aruraharja.co.id` ke `127.0.0.1:3300`. Contoh location ada di `deploy/nginx-location.conf`.

## Update production
```bash
cd /opt/apps/ARU_PriceMark
git pull
npm install --omit=dev
pm2 restart aru-pricemark --update-env
```

## Catatan keamanan
- Jangan commit `.env`.
- Free tier Gemini dapat memiliki kebijakan penggunaan data yang berbeda dari paid tier; jangan kirim dokumen rahasia sebelum kebijakan internal menyetujuinya.
- `history.json` berisi hasil analisis dan input ringkas; batasi permission folder project sesuai kebutuhan.


## Search provider
Untuk deployment gratis, gunakan `SEARCH_PROVIDER=tavily` dan isi `TAVILY_API_KEY`. Gemini 3.8 Flash dipakai untuk membaca/menormalisasi dokumen, sedangkan Tavily dipakai untuk pencarian web aktual.

Jika project Gemini sudah memiliki billing dan Google Search Grounding aktif, `SEARCH_PROVIDER=gemini` dapat digunakan tanpa Tavily.
