# VideoTeks Google Flow Worker

Worker ini menjalankan Chromium Playwright untuk membuka Google Flow, memakai sesi Google yang login secara manual, membuat klip video, lalu mengembalikan MP4 ke backend VideoTeks.

## Jalankan di komputer yang bisa membuka browser

```bash
cd flow-worker
npm install
npx playwright install chromium
FLOW_WORKER_SECRET='buat-secret-panjang-yang-sama' FLOW_HEADLESS=false npm start
```

Browser Chromium akan terbuka. Login ke Google Flow secara manual pada jendela tersebut. Jangan mengirim password, cookie, atau folder `FLOW_PROFILE_DIR` ke server.

## Hubungkan ke Render

Buat HTTPS tunnel privat ke port `3010`, lalu isi environment service `terjemah-video` di Render:

```env
FLOW_WORKER_URL=https://url-tunnel-privat-anda
FLOW_WORKER_SECRET=secret-yang-sama-dengan-worker
FLOW_WORKER_TIMEOUT_MS=300000
```

Worker harus tetap hidup dan komputer harus tetap terhubung internet. Endpoint worker dilindungi header `x-flow-worker-secret` dan menolak request tanpa secret yang benar.

## Login persisten dan auto-restart

Render Free dan sandbox sementara tidak menyimpan profil browser setelah container atau sandbox dibuat ulang. Untuk mempertahankan login Flow, jalankan worker pada komputer/VPS yang selalu menyala dengan disk persisten. Profil browser disimpan di `FLOW_PROFILE_DIR`; jangan menghapus folder tersebut dan jangan membagikannya.

```bash
cd flow-worker
npm install
npx playwright install chromium
chmod +x run-persistent.sh
FLOW_WORKER_SECRET='secret-panjang-yang-sama-dengan-Render' \
CLOUDFLARED_TUNNEL_TOKEN='token-named-tunnel-dari-Cloudflare' \
FLOW_HEADLESS=false ./run-persistent.sh
```

Saat Chromium terbuka, login Google Flow satu kali secara manual. Setelah login berhasil, hentikan worker dengan `Ctrl+C`, lalu jalankan kembali dengan `FLOW_HEADLESS=true`; profil pada `FLOW_PROFILE_DIR` akan dipakai kembali. Skrip menjalankan worker dan Cloudflare Named Tunnel bersama-sama dan menghentikan pasangan proses bila salah satunya berhenti. Named Tunnel harus memiliki public hostname yang diarahkan ke `http://localhost:3010`.

Jangan gunakan `FLOW_GOOGLE_PASSWORD` atau menyimpan password Google di environment. Sesi login disimpan sebagai cookie/profile browser dan dapat kedaluwarsa bila Google meminta autentikasi ulang.

Jika tampilan Google Flow berubah, gunakan selector override:

```env
FLOW_PROMPT_SELECTOR=textarea
FLOW_GENERATE_SELECTOR=button[aria-label="Generate"]
FLOW_DOWNLOAD_SELECTOR=button[aria-label="Download"]
```
