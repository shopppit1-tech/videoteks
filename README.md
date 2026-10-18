# VideoTeks

MVP aplikasi untuk membuat subtitle dari suara asli video, menerjemahkannya, memilih gaya/warna, lalu mengekspor video dengan suara asli tetap dipertahankan.

## Fitur

- Upload video dan ekstraksi audio dengan FFmpeg.
- Transkripsi audio bertimestamp memakai Gemini Files API + generateContent.
- Terjemahan subtitle memakai Gemini.
- Editor segmen subtitle dan preview.
- Ekspor MP4 dengan subtitle tertanam dan audio asli tetap ada.
- Template warna subtitle: merah, jingga, kuning, hijau, biru, ungu, pink, hitam, putih, gradient.
- Google Sign-In sebelum membuka fitur, serta riwayat transkripsi per akun yang dapat dihapus.
- Koneksi YouTube tersimpan per akun VideoTeks dan dipulihkan otomatis saat halaman dibuka kembali.

## Menjalankan

Prasyarat: Node.js 18+, FFmpeg, Gemini API key, serta Firebase project dengan Google Authentication dan Firestore.

```bash
npm install
cp .env.example .env
# isi GEMINI_API_KEY di .env untuk Subtitle Video
# isi GEMINI_TTS_API_KEY di .env untuk halaman Suara AI (opsional)
# isi FIREBASE_SERVICE_ACCOUNT_JSON menggunakan kredensial server Firebase (wajib untuk login/riwayat)
# isi kredensial OAuth YouTube dan kunci enkripsi token di bawah ini
npm start
```

Buka `http://localhost:3000`. Firebase Web app di frontend menggunakan project ID `videoteks-a82c1`; tambahkan domain yang dipakai (misalnya `localhost` dan domain Render) pada **Authentication → Settings → Authorized domains**, lalu aktifkan **Authentication → Sign-in method → Google**.

Untuk riwayat, buat Firestore Database. Backend menyimpan dokumen di `users/{uid}/history/{historyId}` sehingga endpoint menggunakan UID sesi yang tokennya diverifikasi server. Di Render, buat service account Firebase dengan akses Firestore yang diperlukan dan isi environment variable `FIREBASE_SERVICE_ACCOUNT_JSON` dengan **seluruh JSON service-account**. Jangan commit service-account atau memasukkan private key ke frontend/chat. Jangan membuat Firestore rules `allow read, write: if true`; akses aplikasi dilakukan melalui server Admin SDK dan tiap operasi membatasi koleksi ke UID token yang diverifikasi. File video tidak disimpan; hanya teks, segmen subtitle, dan pengaturan.

API key hanya dibaca server dari `.env`; jangan commit file `.env`. Untuk halaman Suara AI, gunakan nama terpisah `GEMINI_TTS_API_KEY` agar tidak bentrok dengan `GEMINI_API_KEY`. Model default-nya adalah Gemini 3 TTS `gemini-3.8-flash-tts`; model dapat diganti dengan `GEMINI_TTS_MODEL`.

### Koneksi YouTube otomatis

Buat OAuth 2.0 Client ID bertipe **Web application** di Google Cloud Console untuk proyek yang mengaktifkan **YouTube Data API v3**. Untuk situs GitHub Pages yang dipakai sekarang, tambahkan `https://shopppit1-tech.github.io` ke **Authorized JavaScript origins** (tanpa path). Untuk pengujian lokal, tambahkan `http://localhost:3000` dan `http://127.0.0.1:3000`. Kode memakai GIS popup; saat server menukar kode otorisasi, `redirect_uri` harus sama persis dengan origin frontend (skema, host, dan port saja, tanpa path). **Authorized redirect URIs** boleh dikosongkan. Jangan daftarkan origin API Render kecuali halaman web VideoTeks memang dibuka langsung dari origin itu.

Di **Data Access**, daftarkan scope `https://www.googleapis.com/auth/youtube.upload`. Di **Audience**, pilih **External** bila pengguna memakai akun Google umum; selama status **Testing**, tambahkan email penguji pada **Test users**. Catatan: refresh token untuk aplikasi External yang masih Testing berakhir setelah 7 hari. Agar koneksi dapat bertahan lebih lama, ubah status publikasi ke **Production** dan selesaikan verifikasi Google jika diminta. Di **Branding → Authorized domains**, cukup simpan `shopppit1-tech.github.io` satu kali; domain ini tanpa skema atau path.

Gunakan pasangan Client ID dan Client Secret dari OAuth Web Client yang sama.

Atur `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_TOKEN_ENCRYPTION_KEY`, serta `YOUTUBE_REDIRECT_URI=https://shopppit1-tech.github.io` pada server. Nilainya harus sama persis dengan origin frontend yang membuka halaman (bukan URL halaman dengan path). Untuk pengujian lokal, set nilainya ke origin lokal yang sedang dipakai, misalnya `http://localhost:3000`. Buat kunci enkripsi 32-byte dengan `openssl rand -hex 32`; jangan commit atau membagikannya. Server menyimpan refresh token terenkripsi di Firestore per UID VideoTeks, sementara token akses hanya dipakai sementara. Pengguna menyetujui izin unggah YouTube satu kali; koneksi bisa dilepas dari halaman YouTube.

Di halaman **Subtitle Video**, pilih bahasa tujuan dan tekan **Terjemahkan** untuk memakai endpoint penerjemahan yang sudah ada. Setelah ekspor MP4 berhasil, tekan **Lanjutkan video ke YouTube**; MP4 dan teks subtitle disimpan sementara di IndexedDB pada browser yang sama, lalu dimuat otomatis pada halaman upload. Video tetap dapat diunduh seperti biasa.

Metadata SEO YouTube hanya memakai Gemini khusus melalui `GEMINI_YOUTUBE_API_KEY` pada Render (`GEMINI_YOUTUBE_KEY` diterima sebagai alias khusus YouTube); tidak ada fallback ke `GEMINI_API_KEY` transkripsi/terjemahan atau `GEMINI_TTS_API_KEY`. Model SEO menggunakan `GEMINI_YOUTUBE_MODEL`. API key hanya dibaca server. Untuk unggah langsung, setelah pengguna menyetujui analisis, backend mengekstrak audio dan sampai 12 frame sampel; Gemini membuat judul, deskripsi, dan tag berdasarkan isi tersebut, sementara nama file dan topik opsional hanya petunjuk tambahan. Video utuh tidak dikirim ke Gemini. Jika video diteruskan dari Subtitle Video, subtitle/terjemahan digunakan sebagai konteks. Hasil dapat diedit sebelum unggah.

## Deploy ke Render

1. Upload ZIP ini ke GitHub atau gunakan repository `nana99-alt/videoteks`.
2. Di Render pilih **New > Web Service** lalu hubungkan repository.
3. Gunakan pengaturan berikut:
   - Build Command: `npm ci`
   - Start Command: `npm start`
   - Health Check Path: `/api/health`
4. Tambahkan environment variable di Render:
   - `GEMINI_API_KEY`: API key Gemini akun/project pertama
   - `GEMINI_API_KEY_2`: API key Gemini akun/project kedua
   - `GEMINI_API_KEY_3`: API key Gemini akun/project ketiga, ikut rotasi otomatis
   - `GEMINI_MODEL`: `gemini-3.8-flash`
   - `GEMINI_TTS_API_KEY`: API key Gemini khusus halaman Suara AI
   - `GEMINI_TTS_MODEL`: `gemini-3.8-flash-tts`
   - `FIREBASE_SERVICE_ACCOUNT_JSON`: seluruh JSON service-account Firebase sebagai nilai environment (jangan commit file/key tersebut)
   - `YOUTUBE_CLIENT_ID`: OAuth Web Client ID Google
   - `YOUTUBE_CLIENT_SECRET`: Client Secret untuk OAuth Web Client yang sama
   - `YOUTUBE_TOKEN_ENCRYPTION_KEY`: kunci acak 64 karakter heksadesimal dari `openssl rand -hex 32`
   - `YOUTUBE_REDIRECT_URI`: `https://shopppit1-tech.github.io` (origin saja, tanpa path atau slash di akhir)
   - `GEMINI_YOUTUBE_API_KEY`: API key Gemini khusus judul dan deskripsi YouTube
   - `GEMINI_YOUTUBE_MODEL`: `gemini-3.8-flash`
5. Di Firebase Authentication, aktifkan Google Sign-In dan tambahkan domain Render pada Authorized domains. Buat Firestore Database.
6. Jangan menaruh API key Gemini atau service-account private key di file frontend atau GitHub. Tanpa `FIREBASE_SERVICE_ACCOUNT_JSON`, endpoint aplikasi mengembalikan status konfigurasi belum siap.

File `render.yaml` sudah disertakan agar Render dapat membaca konfigurasi dasar secara otomatis.
