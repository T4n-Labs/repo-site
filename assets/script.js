"use strict";
/* ============================================================
   T4n OS — HOMEPAGE (index.html)
   ============================================================
   Peran  : otak halaman depan — TANPA fitur search.
   Fungsi :
     1. renderCards()     → kartu repository di #repoGrid
     2. Installer interaktif
          pilih repo (#repoTabs) → pilih arch (#archTabs)
          → perintah pasang di .term ikut berubah
     3. buildAllCmds()    → rekap semua perintah di #allCmds
     4. Sinkronisasi pilihan ke URL hash:
          #repo=glibc&arch=x86_64
        sehingga pilihan bisa di-share / di-bookmark.

   Kontrak DOM (elemen wajib ada di index.html):
     #cmd #repoGrid #repoTabs #archTabs
     #repoUrl #confName #copyInstall #allCmds #toast

   Tidak ada dependensi eksternal — vanilla JS saja.
   ============================================================ */

/* ============================================================
   KONFIGURASI — daftar repository
   ------------------------------------------------------------
   key    : id pendek, dipakai untuk link site/<key>.html,
            juga sebagai nilai data-repo di tab & hash URL
   repo   : nama repo GitHub (T4n-Labs/<repo>)
   base   : URL GitHub Pages repo (harus berakhiran "/")
   conf   : nama file konfigurasi xbps di /etc/xbps.d/
   desc   : deskripsi singkat, tampil di kartu
   archs  : daftar arsitektur yang didukung — juga menentukan
            urutan tab arsitektur di installer

   ➕ Menambah repo baru: cukup tambah entri di sini.
      Kartu, tab, dan daftar perintah dibuat otomatis.
   ============================================================ */
const REPOS = {
  glibc: {
    repo: "repo-glibc",
    base: "https://t4n-labs.github.io/repo-glibc/",
    conf: "10-glibc.conf",
    desc: "Base system · glibc",
    archs: ["x86_64", "i686", "aarch64", "armv6l", "armv7l"],
  },
  musl: {
    repo: "repo-musl",
    base: "https://t4n-labs.github.io/repo-musl/",
    conf: "10-musl.conf",
    desc: "Lightweight · musl libc",
    archs: ["x86_64", "i686", "aarch64", "armv6l", "armv7l"],
  },
  server: {
    repo: "repo-server",
    base: "https://t4n-labs.github.io/repo-server/",
    conf: "10-server.conf",
    desc: "Server & daemon packages",
    archs: ["x86_64", "i686", "aarch64", "armv6l", "armv7l"],
  },
  security: {
    repo: "repo-security",
    base: "https://t4n-labs.github.io/repo-security/",
    conf: "10-security.conf",
    desc: "Security & auditing tools",
    archs: ["x86_64", "i686", "aarch64", "armv6l", "armv7l"],
  },
};

/** Arsitektur bawaan saat halaman pertama dibuka / hash tidak valid. */
const DEFAULT_ARCH = "x86_64";

/** State UI saat ini — satu-satunya sumber kebenaran tampilan. */
const state = { repo: "glibc", arch: DEFAULT_ARCH };

/* ============================================================
   UTIL
   ============================================================ */

/** Ambil elemen pertama yang cocok dengan selector CSS. */
const $ = (s, el = document) => el.querySelector(s);

/** Ambil SEMUA elemen yang cocok sebagai array. */
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/**
 * Escape karakter HTML — WAJIB untuk semua string yang
 * disisipkan lewat innerHTML agar bebas XSS.
 * @param {string} s
 * @returns {string} teks yang aman ditampilkan
 */
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** Shortcut: objek repo yang sedang aktif dipilih. */
const R = () => REPOS[state.repo];

/**
 * Susun perintah pasang LENGKAP (3 baris) untuk repo+arch.
 * Dipakai tombol #copyInstall.
 * @param {{base:string,conf:string}} r  objek repo aktif
 * @param {string} arch                  arsitektur terpilih
 * @returns {string} perintah multi-baris siap tempel ke terminal
 */
function cmdFull(r, arch) {
  return `mkdir -p /etc/xbps.d\necho 'repository=${r.base}${arch}/' | sudo tee /etc/xbps.d/${r.conf}\nxbps-install -uS`;
}

/**
 * Susun SATU baris perintah echo repository=...
 * Dipakai di daftar #allCmds (per kombinasi repo × arch).
 */
function cmdLine(r, arch) {
  return `echo 'repository=${r.base}${arch}/' | sudo tee /etc/xbps.d/${r.conf}`;
}

/* ============================================================
   RENDER
   ============================================================ */

/**
 * Isi #repoGrid dengan kartu semua repo dari REPOS.
 * Setiap kartu menautkan ke halaman search site/<key>.html.
 */
function renderCards() {
  $("#repoGrid").innerHTML = Object.entries(REPOS)
    .map(
      ([key, r]) => `
    <a class="repo" href="site/${key}.html">
      <span class="repo-name">${esc(r.repo)}</span>
      <span class="repo-desc">${esc(r.desc)}</span>
      <span class="chips">${r.archs.map((a) => `<i>${esc(a)}</i>`).join("")}</span>
      <span class="repo-go">Search Package →</span>
    </a>`,
    )
    .join("");
}

/**
 * Isi #repoTabs: satu tombol per repo.
 * Tombol aktif diberi class .active + aria-selected="true".
 */
function renderRepoTabs() {
  $("#repoTabs").innerHTML = Object.keys(REPOS)
    .map(
      (k) =>
        `<button class="itab ${k === state.repo ? "active" : ""}" role="tab" aria-selected="${k === state.repo}" data-repo="${k}">${esc(REPOS[k].repo)}</button>`,
    )
    .join("");
}

/**
 * Isi #archTabs: tab arsitektur milik repo aktif.
 * Jika state.arch tidak ada di daftar arch repo baru
 * (mis. pindah dari repo dengan arch berbeda), kembali ke arch pertama.
 */
function renderArchTabs() {
  const r = R();
  if (!r.archs.includes(state.arch)) state.arch = r.archs[0] || DEFAULT_ARCH;
  $("#archTabs").innerHTML = r.archs
    .map(
      (a) =>
        `<button class="itab ${a === state.arch ? "active" : ""}" role="tab" aria-selected="${a === state.arch}" data-arch="${esc(a)}">${esc(a)}</button>`,
    )
    .join("");
}

/**
 * Perbarui preview perintah di terminal:
 *   #repoUrl      → URL repo aktif (base + arch + "/")
 *   #confName     → nama file .conf
 *   #copyInstall  → simpan perintah lengkap ke dataset.copy
 * Dataset dipakai delegasi klik di bindUI(), bukan addEventListener
 * per tombol — jadi aman walau elemen di-render ulang.
 */
function renderCmd() {
  const r = R();
  $("#repoUrl").textContent = `${r.base}${state.arch}/`;
  $("#confName").textContent = r.conf;
  $("#copyInstall").dataset.copy = cmdFull(r, state.arch);
}

/** Render ulang seluruh area installer (dipanggil saat ganti repo). */
function renderAll() {
  renderRepoTabs();
  renderArchTabs();
  renderCmd();
}

/**
 * Bangun <details> rekap SEMUA perintah (#allCmds):
   dikelompokkan per repo, satu baris per (repo × arch),
   masing-masing dengan tombol copy [data-copy].
 */
function buildAllCmds() {
  $("#allCmds").innerHTML = Object.values(REPOS)
    .map(
      (r) => `
    <div class="cmd-group">
      <h3>${esc(r.repo)}</h3>
      ${r.archs
        .map((a) => {
          const line = cmdLine(r, a);
          return `<div class="cmd-line">
          <span class="chip">${esc(a)}</span>
          <code>${esc(line)}</code>
          <button class="copy" data-copy="${esc(line)}">⧉</button>
        </div>`;
        })
        .join("")}
    </div>`,
    )
    .join("");
}

/* ============================================================
   HASH & INTERAKSI
   ============================================================ */

/**
 * Tulis state pencarian ke URL hash (tanpa menambah entry history):
 *   #q=<kata>&arch=<arch>&page=<n>
 * Komponen yang masih default (q kosong / arch "all" / page 1)
 * tidak ditulis → hash hanya muncul setelah user benar-benar
 * mencari / memfilter / berpindah halaman.
 * Tujuan: URL hasil pencarian bisa di-share / di-bookmark.
 */
function syncHash() {
  const p = new URLSearchParams();
  if (state.q.trim()) p.set("q", state.q.trim());
  if (state.arch !== "all") p.set("arch", state.arch);
  if (state.page > 1) p.set("page", String(state.page));
  const s = p.toString();
  history.replaceState(null, "", s ? `#${s}` : location.pathname);
}

/** Baca hash URL saat load & terapkan ke state (jika valid). */
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const repo = p.get("repo"),
    arch = p.get("arch");
  if (repo && REPOS[repo]) state.repo = repo;
  if (arch) state.arch = arch;
}

/**
 * Pasang semua event listener.
 * Catatan: tab & tombol copy TIDAK dipasangi listener per elemen —
 * memakai event delegation di container/ document, sehingga
 * tetap berfungsi meski innerHTML di-render ulang.
 */
function bindUI() {
  /* Tab repo: ganti state.repo → render ulang seluruh installer */
  $("#repoTabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-repo]");
    if (!b) return;
    state.repo = b.dataset.repo;
    syncHash();
    renderAll();
  });

  /* Tab arch: ganti state.arch → render tab + perintah saja */
  $("#archTabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-arch]");
    if (!b) return;
    state.arch = b.dataset.arch;
    syncHash();
    renderArchTabs();
    renderCmd();
  });

  /* Delegasi global tombol copy [data-copy] — mencakup juga
     tombol di dalam <details> (#allCmds) */
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-copy]");
    if (!b) return;
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      toast("✓ perintah disalin");
    } catch {
      toast("Gagal menyalin — salin manual ya");
    }
  });
}

/** Timer id toast aktif — agar toast baru me-reset timeout toast lama. */
let toastTimer;

/**
 * Tampilkan notifikasi singkat di #toast selama ~2 detik.
 * @param {string} msg teks yang ditampilkan
 */
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

/**
 * Efek mengetik teks per karakter di #cmd (baris terminal hero).
 * Otomatis dilewati (teks langsung penuh) jika user mengaktifkan
 * preferensi OS "reduce motion".
 * @param {HTMLElement|null} el   elemen target
 * @param {string} text           teks yang diketik
 */
function typeCmd(el, text) {
  if (!el) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.textContent = text;
    return;
  }
  let i = 0;
  el.textContent = "";
  const t = setInterval(() => {
    el.textContent = text.slice(0, ++i);
    if (i >= text.length) clearInterval(t);
  }, 42);
}

/* ============================================================
   BOOT — titik masuk aplikasi
   Urutan penting: hash dulu (state awal), lalu render statis
   (kartu + rekap), pasang listener, baru render sesuai state.
   ============================================================ */
function boot() {
  readHash(); // 1. terapkan #repo=&arch= dari URL (jika ada)
  renderCards(); // 2. kartu repository
  buildAllCmds(); // 3. rekap semua perintah (dalam <details>)
  bindUI(); // 4. event listener
  renderAll(); // 5. tab + perintah sesuai state
  syncHash(); // 6. normalisasi hash (jaga URL selalu valid)
  typeCmd($("#cmd"), "xbps-query -L"); // 7. animasi hero
}

/* Jalankan boot() begitu DOM siap
   (script dimuat di akhir <body>, tapi tetap dijaga defensif) */
if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", boot);
else boot();
