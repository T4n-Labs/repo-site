"use strict";
/* ============================================================
   T4n OS — PACKAGE SEARCH ENGINE (site/*.html)
   ============================================================
   Peran  : otak semua halaman search (glibc/musl/server/security).
            Halaman mana yang aktif ditentukan lewat:
                <body data-repo="glibc|musl|server|security">

   Alur data (dicek berurutan):
     1) <base>/<arch>/packages.json   ← sumber utama (tanpa rate-limit)
        - semua arch di-request PARALEL (Promise.allSettled),
          arch yang gagal diabaikan, cukup satu yang sukses
     2) GitHub Trees API              ← fallback otomatis
        - baca seluruh isi repo, parse nama file *.xbps
        - 404 = repo belum ada → dianggap "kosong", BUKAN error
        - 403 = rate-limit (60 req/jam/IP) → tampil pesan error

   Format packages.json (array ATAU {packages:[...]}):
     [{ "name":"xbps", "version":"0.59.2_1", "arch":"x86_64",
        "filename":"xbps-0.59.2_1.x86_64.xbps", "size":1234,
        "desc":"The X Binary Package System" }]
   → name + version + arch wajib; size & desc opsional.

   Fitur:
     - live search (debounce 110ms) + highlight <mark>
     - tab arsitektur dengan counter per-arch
     - pagination [1][2][3]…[Last] — 10 paket/halaman
     - state tersimpan di URL hash → bisa di-share:
         #q=vim&arch=x86_64&page=2
     - shortcut keyboard: "/" fokus search, "Esc" bersihkan
     - tombol copy: perintah pasang repo & xbps-install <pkg>

   Kontrak DOM (elemen wajib di site/*.html):
     #q #tabs #panelTitle #count #notice #status #results
     #install #toast  ·  #pagination dibuat otomatis oleh JS

   Tidak ada dependensi eksternal — vanilla JS saja.
   ============================================================ */

/* ============================================================
   KONFIGURASI
   ============================================================ */

/** Pemilik organisasi GitHub — dipakai untuk URL API fallback. */
const OWNER = "T4n-Labs";

/**
 * Daftar repository — identik dengan REPOS di assets/script.js (homepage).
 *   repo : nama repo GitHub (T4n-Labs/<repo>)
 *   site : URL GitHub Pages repo, WAJIB berakhiran "/"
 *          → dipakai untuk fetch packages.json & link download .xbps
 *   conf : nama file konfigurasi xbps di /etc/xbps.d/
 *   desc : deskripsi singkat (di-render ke [data-repo-desc])
 *   archs: arsitektur yang didukung = tab yang muncul + folder
 *          yang di-fetch packages.json-nya
 */
const REPOS = {
  glibc: {
    repo: "repo-glibc",
    site: "https://t4n-labs.github.io/repo-glibc/",
    conf: "10-glibc.conf",
    desc: "Base system · glibc",
    archs: ["x86_64", "i686", "aarch64", "armv6l", "armv7l"],
  },
  musl: {
    repo: "repo-musl",
    site: "https://t4n-labs.github.io/repo-musl/",
    conf: "10-musl.conf",
    desc: "Lightweight · musl libc",
    archs: ["x86_64", "i686", "aarch64", "armv6l", "armv7l"],
  },
  server: {
    repo: "repo-server",
    site: "https://t4n-labs.github.io/repo-server/",
    conf: "10-server.conf",
    desc: "Server & daemon packages",
    archs: ["x86_64", "i686", "aarch64", "armv6l", "armv7l"],
  },
  security: {
    repo: "repo-security",
    site: "https://t4n-labs.github.io/repo-security/",
    conf: "10-security.conf",
    desc: "Security & auditing tools",
    archs: ["x86_64", "i686", "aarch64", "armv6l", "armv7l"],
  },
};

/** Opsi perilaku search engine. */
const OPTIONS = {
  perPage: 10, // paket per halaman (pagination)
  branch: "main", // dipakai kalau deteksi default branch gagal
};

/* ----------------- halaman aktif ----------------- */

/** Repo aktif = sesuai data-repo di <body>; fallback ke glibc. */
const R = REPOS[document.body.dataset.repo] || REPOS.glibc;

/** Konfigurasi final halaman ini (repo aktif + OPTIONS). */
const CONFIG = {
  owner: OWNER,
  repo: R.repo,
  site: R.site,
  conf: R.conf,
  archs: R.archs,
  ...OPTIONS,
};

/** Judul asli halaman — dipakai ulang saat query dibersihkan. */
const BASE_TITLE = document.title;

/**
 * State UI — satu-satunya sumber kebenaran tampilan.
 * render() membaca state ini; interaksi hanya mengubah state + render().
 */
const state = {
  arch: "all", // "all" | salah satu CONFIG.archs
  q: "", // kata kunci pencarian
  page: 1, // halaman pagination aktif
  data: [], // seluruh paket hasil loadAll()
  loading: true, // true saat fetch berjalan → skeleton
  error: null, // pesan error (HTML) bila fetch gagal total
  repoMissing : false, // placeholder — lihat baris berikutnya
};

/* ============================================================
   UTIL
   ============================================================ */

/** Ambil elemen pertama yang cocok dengan selector CSS. */
const $ = (s, el = document) => el.querySelector(s);

/** Ambil SEMUA elemen yang cocok sebagai array. */
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/**
 * Escape karakter HTML — WAJIB untuk semua string yang masuk
 * ke template innerHTML (nama paket, query user, dsb) agar bebas XSS.
 */
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/**
 * Format ukuran byte → "1.2 MB" (kosong jika data tidak ada).
 * @param {number|string|null} b  ukuran dalam byte
 */
function fmtSize(b) {
  if (b == null || b === "") return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0,
    n = Number(b);
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return (i === 0 ? n : n.toFixed(1)) + " " + u[i];
}

/**
 * Parse nama file .xbps → {name, version, arch}.
 * Pola: "nama-versi.ARCH.xbps"  (contoh: "vim-9.1.0496_1.x86_64.xbps")
 * Catatan: nama paket boleh mengandung "-", jadi pemecahan dilakukan
 * dari BELAKANG (lastIndexOf), bukan split("-") pertama.
 * @returns {object|null} null jika pola tidak cocok
 */
function parseXbpsFile(file) {
  if (!file.endsWith(".xbps")) return null;
  const base = file.slice(0, -5);
  const dot = base.lastIndexOf(".");
  if (dot < 1) return null;
  const arch = base.slice(dot + 1);
  const rest = base.slice(0, dot);
  const dash = rest.lastIndexOf("-");
  if (dash < 1) return null;
  return { name: rest.slice(0, dash), version: rest.slice(dash + 1), arch };
}

/**
 * Normalisasi entri paket dari sumber mana pun (JSON / API)
 * menjadi bentuk baku yang dipakai renderer.
 * @param {object} p          entri mentah
 * @param {string} defArch    arch default (dari nama folder JSON)
 */
function norm(p, defArch = "") {
  const arch = p.arch || defArch,
    version = p.version || "";
  return {
    name: String(p.name || ""),
    version,
    arch,
    filename: p.filename || `${p.name}-${version}.${arch}.xbps`,
    size: p.size ?? null,
    desc: p.desc || p.short_desc || "",
  };
}

/* ============================================================
   LOADER DATA
   ============================================================ */

/**
 * fetch() JSON dengan timeout (default 12 detik).
 * Melempar Error(status) bila respons tidak ok — pesannya berupa
 * kode HTTP ("404", "403", ...) yang dipakai friendlyError().
 */
async function loadJSON(url, ms = 12000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const res = await fetch(url, { signal: c.signal });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Ambil packages.json satu arsitektur.
 * Menerima format array langsung ATAU objek {packages:[...]}.
 * Error dibiarkan naik → ditangani Promise.allSettled di loadAll().
 */
async function archJSON(arch) {
  const data = await loadJSON(`${CONFIG.site}${arch}/packages.json`);
  const list = Array.isArray(data) ? data : (data && data.packages) || [];
  return list.map((p) => norm(p, arch)).filter((p) => p.name);
}

/**
 * Fallback GitHub Trees API (dipakai jika TIDAK ADA packages.json).
 * Cache promise di ghPromise agar hanya dijalankan SEKALI per load
 * meski dipanggil berkali-kali; reset ke null bila gagal agar
 * bisa dicoba ulang.
 */
let ghPromise = null;
function githubAll() {
  if (ghPromise) return ghPromise;
  ghPromise = (async () => {
    const base = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}`;
    let branch = OPTIONS.branch;
    const meta = await loadJSON(base); // 404 di sini = repo belum ada
    if (meta && meta.default_branch) branch = meta.default_branch;
    const tree = await loadJSON(`${base}/git/trees/${branch}?recursive=1`);
    return (tree.tree || [])
      .filter((n) => n.type === "blob" && n.path.endsWith(".xbps"))
      .map((n) => {
        /* path: "<arch>/<nama>-<versi>.<arch>.xbps" */
        const seg = n.path.split("/");
        const arch = seg.length > 1 ? seg[0] : "";
        const p = parseXbpsFile(seg[seg.length - 1]);
        return p ? norm({ ...p, arch, size: n.size }) : null;
      })
      .filter((p) => p && p.name && CONFIG.archs.includes(p.arch));
  })();
  ghPromise.catch(() => {
    ghPromise = null;
  });
  return ghPromise;
}

/**
 * Muat seluruh paket untuk repo aktif.
 * Strategi:
 *   1. fetch semua arch paralel; gagal sebagian tidak masalah
 *   2. jika TIDAK ADA yang sukses → fallback GitHub API
 *   3. 404 dari API = repo belum ada/belum public → set
 *      state.repoMissing (ditampilkan sebagai ∅, bukan error merah)
 */
async function loadAll() {
  const res = await Promise.allSettled(CONFIG.archs.map(archJSON));
  const ok = res
    .filter((r) => r.status === "fulfilled")
    .flatMap((r) => r.value);
  if (ok.length) return ok;
  try {
    return await githubAll();
  } catch (err) {
    /* 404 = repo belum ada / belum public di GitHub
       → perlakukan sama seperti repo kosong, BUKAN error */
    if (String((err && err.message) || err).includes("404")) {
      state.repoMissing = true;
      return [];
    }
    throw err;
  }
}

/* ============================================================
   PAGINATION
   ============================================================ */

/**
 * Susun daftar nomor halaman ala terminal:
 *   [1][2][3][4][5] … [Last]
 * Selalu memuat halaman 1 & terakhir; celah ≥2 nomor → "…",
 * celah 1 nomor → ditampilkan langsung (tidak jadi "…").
 * @param {number} cur    halaman aktif
 * @param {number} total  total halaman
 * @param {number} span   jangkauan kiri-kanan (default 2 → jendela 5)
 * @returns {Array<number|"…">}
 */
function pageList(cur, total, span = 2) {
  let start = Math.max(1, cur - span);
  let end = Math.min(total, cur + span);
  if (end - start < span * 2) {
    if (cur <= span) end = Math.min(total, span * 2 + 1);
    else start = Math.max(1, total - span * 2);
  }
  const set = new Set([1, total]);
  for (let i = start; i <= end; i++) set.add(i);
  const nums = [...set].sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const n of nums) {
    if (n - prev === 2)
      out.push(prev + 1); // celah 1 nomor → tampilkan, jangan "…"
    else if (n - prev > 2) out.push("…");
    out.push(n);
    prev = n;
  }
  return out;
}

/**
 * Render baris pagination ke #pagination (dibuat injectPagination()).
 * Tidak dirender bila hasil ≤ perPage (tidak perlu navigasi).
 * Tombol ‹ › disabled di halaman pertama/terakhir.
 */
function renderPagination(total) {
  const pg = $("#pagination");
  if (!pg) return;
  const totalPages = Math.max(1, Math.ceil(total / CONFIG.perPage));
  if (total <= CONFIG.perPage) {
    pg.innerHTML = "";
    return;
  }
  const from = (state.page - 1) * CONFIG.perPage + 1;
  const to = Math.min(total, state.page * CONFIG.perPage);
  const btn = (p, label, cls = "", extra = "") =>
    `<button class="pg ${cls}" data-page="${p}" ${extra}>${label}</button>`;
  const pages = pageList(state.page, totalPages, 2)
    .map((n) =>
      n === "…"
        ? `<span class="pg-dots">…</span>`
        : btn(
            n,
            String(n),
            n === state.page ? "active" : "",
            n === state.page ? 'aria-current="page"' : "",
          ),
    )
    .join("");
  pg.innerHTML = `
    <span class="pg-info">menampilkan <b>${from}–${to}</b> dari <b>${total}</b> paket</span>
    <span class="pg-pages">
      ${btn(state.page - 1, "‹", "nav", state.page === 1 ? "disabled" : "")}
      ${pages}
      ${btn(state.page + 1, "›", "nav", state.page === totalPages ? "disabled" : "")}
    </span>`;
}

/**
 * Gulir layar ke atas panel hasil (dipakai setelah pindah halaman).
 * "smooth" dihormati kecuali user memilih reduce motion.
 */
function scrollToResults() {
  const panel = $(".panel");
  if (!panel) return;
  panel.scrollIntoView({
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
    block: "start",
  });
}

/* ============================================================
   RENDER
   ============================================================ */

/** Template skeleton loading — tampil selagi fetch berjalan. */
const SKEL = Array.from(
  { length: 6 },
  () => `<li class="sk"><div class="sk-line"></div></li>`,
).join("");

/**
 * Bungkus kemunculan PERTAMA dari query q dalam <mark>…</mark>
 * (case-insensitive). Semua bagian tetap di-escape.
 */
function hl(text, q) {
  const t = String(text);
  if (!q) return esc(t);
  const i = t.toLowerCase().indexOf(q);
  if (i < 0) return esc(t);
  return (
    esc(t.slice(0, i)) +
    "<mark>" +
    esc(t.slice(i, i + q.length)) +
    "</mark>" +
    esc(t.slice(i + q.length))
  );
}

/**
 * Satu baris hasil pencarian:
 *   link → download .xbps langsung dari repo (tab baru)
 *   tombol [data-install] → salin "xbps-install <nama>"
 */
function rowHTML(p, q) {
  const href = `${CONFIG.site}${p.arch}/${p.filename}`;
  return `<li class="row">
    <a class="row-link" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(p.filename)}">
      <span class="name">${hl(p.name, q)}</span>
      <span class="ver">${esc(p.version)}</span>
      <span class="desc">${esc(p.desc)}</span>
      <span class="chip arch">${esc(p.arch)}</span>
      <span class="size">${esc(fmtSize(p.size))}</span>
    </a>
    <button class="copy" data-install="${esc(p.name)}" title="Salin perintah install">xbps-install ⧉</button>
  </li>`;
}

/**
 * RENDER UTAMA — menggambar seluruh area hasil dari `state`.
 * Dipanggil saat: boot, ketik query, ganti tab arch, pindah halaman,
 * dan setelah selesai loading. Urutan:
 *   tab+counter → judul terminal & document.title
 *   → loading / error → filter → sort → pagination → daftar/empty-state
 */
function render() {
  /* tab + counter */
  const counts = { all: state.data.length };
  for (const p of state.data) counts[p.arch] = (counts[p.arch] || 0) + 1;
  $$("#tabs .tab").forEach((b) => {
    const on = b.dataset.arch === state.arch;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
    const n = $(".n", b);
    if (n)
      n.textContent = state.loading ? "" : String(counts[b.dataset.arch] || 0);
  });

  /* meta — judul terminal meniru xbps-query + judul tab browser */
  const q = state.q.trim();
  let cmd = `xbps-query -Rs ${q ? `'${q}'` : "''"}`;
  if (state.arch !== "all") cmd += ` -a ${state.arch}`;
  $("#panelTitle").textContent = `${CONFIG.repo} $ ${cmd}`;
  document.title = q ? `${q} · ${BASE_TITLE}` : BASE_TITLE;

  const status = $("#status"),
    ul = $("#results"),
    pg = $("#pagination");

  /* state: loading → skeleton */
  if (state.loading) {
    status.innerHTML = "";
    if (pg) pg.innerHTML = "";
    ul.innerHTML = SKEL;
    return;
  }

  /* state: error (rate-limit / koneksi) */
  if (state.error) {
    ul.innerHTML = "";
    if (pg) pg.innerHTML = "";
    $("#count").textContent = "";
    status.innerHTML = `<div class="status err"><div class="big">!</div><p>${state.error}</p></div>`;
    return;
  }

  /* filter: arch terpilih + kata kunci (name/version/desc/arch) */
  let list = state.data;
  if (state.arch !== "all") list = list.filter((p) => p.arch === state.arch);
  if (q) {
    const nq = q.toLowerCase();
    list = list.filter((p) =>
      `${p.name} ${p.version} ${p.desc} ${p.arch}`.toLowerCase().includes(nq),
    );
  }
  /* urut abjad → versi; agar hasil stabil antar render */
  list = list
    .slice()
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
    );

  /* pagination — jaga state.page tetap valid saat hasil menyusut */
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / CONFIG.perPage));
  if (state.page > totalPages) {
    state.page = totalPages;
    syncHash();
  }
  const start = (state.page - 1) * CONFIG.perPage;

  $("#count").textContent =
    `${total} pkg${totalPages > 1 ? ` · hal ${state.page}/${totalPages}` : ""}`;

  /* empty-state: tidak ada hasil / repo belum diisi / query tidak ketemu */
  if (!total) {
    ul.innerHTML = "";
    if (pg) pg.innerHTML = "";
    const head = state.repoMissing
      ? `Repository <code>${esc(CONFIG.repo)}</code> belum tersedia / masih dibangun.`
      : `Belum ada paket.`;
    status.innerHTML = q
      ? `<div class="status"><div class="big">⌕</div><p>Tidak ada hasil untuk <b>"${esc(q)}"</b></p></div>`
      : `<div class="status"><div class="big">∅</div><p><b>${head}</b></p></div>`;
    return;
  }
  status.innerHTML = "";
  ul.innerHTML = list
    .slice(start, start + CONFIG.perPage)
    .map((p) => rowHTML(p, q.toLowerCase()))
    .join("");
  ul.scrollTop = 0; /* reset scroll internal list */
  renderPagination(total);
}

/* ============================================================
   UI — membangun elemen interaktif & memasang listener
   ============================================================ */

/**
 * Tab arsitektur: "All" + semua arch CONFIG, dengan counter (.n)
 * yang diisi render(). Ganti tab → reset ke halaman 1.
 */
function buildTabs() {
  const tabs = [
    { id: "all", label: "All" },
    ...CONFIG.archs.map((a) => ({ id: a, label: a })),
  ];
  $("#tabs").innerHTML = tabs
    .map(
      (t) =>
        `<button class="tab" role="tab" aria-selected="false" data-arch="${esc(t.id)}">${esc(t.label)}<span class="n"></span></button>`,
    )
    .join("");
  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (!b) return;
    state.arch = b.dataset.arch;
    state.page = 1;
    syncHash();
    render();
  });
}

/**
 * Bagian "Cara pasang repository" untuk repo halaman INI:
 * satu baris perintah per arsitektur, masing-masing dengan
 * tombol copy [data-copy] (ditangani delegasi global di bindUI()).
 */
function buildInstall() {
  const host = $("#install");
  if (!host) return;
  host.innerHTML = `<div class="inst">
    ${CONFIG.archs
      .map((a) => {
        const line = `echo 'repository=${CONFIG.site}${a}/' | sudo tee /etc/xbps.d/${CONFIG.conf}`;
        return `<div class="inst-line">
        <span class="chip arch">${esc(a)}</span>
        <code>${esc(line)}</code>
        <button class="copy" data-copy="${esc(line)}">copy ⧉</button>
      </div>`;
      })
      .join("")}
    <p class="inst-note">Jalankan <code>mkdir -p /etc/xbps.d</code> dulu jika belum ada, lalu <code>xbps-install -S</code> untuk sinkronisasi indeks.</p>
  </div>`;
}

/**
 * Suntik <nav id="pagination"> tepat SETELAH #results.
 * HTML tidak perlu memuatnya — dibuat sekali di boot().
 */
function injectPagination() {
  const ul = $("#results");
  if (!ul || $("#pagination")) return;
  const nav = document.createElement("nav");
  nav.id = "pagination";
  nav.className = "pagination";
  nav.setAttribute("aria-label", "Navigasi halaman hasil");
  ul.after(nav);
}

/**
 * Tulis state ke URL hash (tanpa menambah entry history):
 *   #q=… &arch=… &page=…   — komponen default diabaikan.
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

/**
 * Baca state awal dari URL hash saat boot.
 * Nilai tidak valid (arch tak dikenal, page < 1) → fallback aman.
 */
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return {
    q: p.get("q") || "",
    arch: p.get("arch") || "all",
    page: Math.max(1, parseInt(p.get("page") || "1", 10) || 1),
  };
}

/** Timer id toast aktif — toast baru me-reset timeout toast lama. */
let toastTimer;

/** Notifikasi singkat (~2 detik) di #toast. */
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

/**
 * Pasang semua event listener:
 *   - input search  : debounce 110ms → render (ketikan terasa instan
 *                     tapi tidak me-render tiap huruf)
 *   - keyboard      : "/" fokus ke search, "Esc" bersihkan
 *   - pagination    : delegasi klik di #pagination
 *   - copy          : delegasi global document untuk
 *                     [data-copy] (perintah pasang) dan
 *                     [data-install] (perintah install paket)
 * Delegasi dipakai agar tetap berfungsi walau DOM dirender ulang.
 */
function bindUI() {
  const input = $("#q");
  let deb;
  input.addEventListener("input", () => {
    clearTimeout(deb);
    deb = setTimeout(() => {
      state.q = input.value;
      state.page = 1; // query baru → kembali ke halaman 1
      syncHash();
      render();
    }, 110);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== input) {
      e.preventDefault();
      input.focus();
    }
    if (e.key === "Escape" && document.activeElement === input) {
      input.value = "";
      state.q = "";
      state.page = 1;
      syncHash();
      render();
    }
  });
  /* klik pagination */
  $("#pagination").addEventListener("click", (e) => {
    const b = e.target.closest("button.pg:not([disabled])");
    if (!b) return;
    const p = parseInt(b.dataset.page, 10);
    if (!p || p === state.page) return;
    state.page = p;
    syncHash();
    render();
    scrollToResults();
  });
  /* delegasi copy: data-copy (install list) & data-install (hasil pencarian) */
  document.addEventListener("click", async (e) => {
    const cp = e.target.closest("[data-copy]");
    if (cp) {
      try {
        await navigator.clipboard.writeText(cp.dataset.copy);
        toast("✓ perintah disalin");
      } catch {
        toast("Gagal menyalin — salin manual ya");
      }
      return;
    }
    const ins = e.target.closest("[data-install]");
    if (ins) {
      const cmd = `xbps-install ${ins.dataset.install}`;
      try {
        await navigator.clipboard.writeText(cmd);
        toast(`✓ ${cmd}`);
      } catch {
        toast(cmd);
      }
    }
  });
}

/**
 * Isi teks identitas repo ke placeholder HTML:
 *   [data-repo-name]  → "repo-glibc"     (breadcrumb)
 *   [data-repo-label] → "glibc"          (h1: repo-<label>)
 *   [data-repo-desc]  → deskripsi        (subjudul)
 * plus tandai link nav aktif via data-key di #switch.
 */
function paintChrome() {
  $$("[data-repo-name]").forEach((el) => (el.textContent = R.repo));
  $$("[data-repo-label]").forEach(
    (el) => (el.textContent = R.repo.replace(/^repo-/, "")),
  );
  $$("[data-repo-desc]").forEach((el) => (el.textContent = R.desc));
  $$("#switch a").forEach((a) =>
    a.classList.toggle("active", a.dataset.key === document.body.dataset.repo),
  );
}

/**
 * Efek mengetik di #cmd (crumb hero).
 * Langsung tampil penuh bila user memilih reduce motion.
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

/**
 * Terjemahkan error teknis menjadi pesan ramah + saran solusi.
 * (HTML — kode <code> ikut ditampilkan di panel error.)
 */
function friendlyError(err) {
  const m = String((err && err.message) || err);
  if (m.includes("403") || /rate/i.test(m))
    return `GitHub API rate-limit (60 req/jam per IP). Tunggu sebentar, atau sediakan <code>packages.json</code> agar tidak bergantung API.`;
  if (m.includes("404"))
    return `Repository <code>${esc(CONFIG.repo)}</code> / indeks paket belum tersedia. Buat <code>packages.json</code> di folder arsitektur.`;
  if (m.includes("abort"))
    return `Koneksi timeout saat memuat data paket. Coba muat ulang.`;
  return `Gagal memuat data paket. Periksa koneksi lalu muat ulang.`;
}

/* ============================================================
   BOOT — titik masuk
   Urutan:
     1. chrome (identitas repo + nav aktif)
     2. bangun UI statis (tabs, install list, pagination nav)
     3. pasang listener
     4. terapkan state awal dari URL hash
     5. render skeleton → fetch → render final
   ============================================================ */
async function boot() {
  paintChrome();
  buildTabs();
  buildInstall();
  injectPagination();
  bindUI();
  const h = readHash();
  state.q = h.q;
  state.page = h.page;
  state.arch =
    h.arch === "all" || CONFIG.archs.includes(h.arch) ? h.arch : "all";
  $("#q").value = state.q;
  typeCmd($("#cmd"), "xbps-query -Rs");

  state.loading = true;
  render(); // tampil skeleton
  try {
    state.data = await loadAll();
  } catch (err) {
    state.error = friendlyError(err);
  }
  state.loading = false;
  render(); // hasil final
}
if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", boot);
else boot();