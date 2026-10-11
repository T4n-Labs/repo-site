# repo-site

Website Repository **T4n OS** - Distro Linux sederhana berbasis [Void Linux](https://voidlinux.org), dikelola dengan `xbps`.

🌐 **https://repo.t4nlabs.web.id**

## Repositories

| Repo | Keterangan | Arsitektur |
|---|---|---|
| [repo-glibc](https://github.com/T4n-Labs/repo-glibc) | Base system · glibc | x86_64 · i686 · aarch64 · armv6l · armv7l |
| [repo-musl](https://github.com/T4n-Labs/repo-musl) | Lightweight · musl libc | x86_64 · i686 · aarch64 · armv6l · armv7l |
| [repo-server](https://github.com/T4n-Labs/repo-server) | Server & daemon packages | x86_64 · i686 · aarch64 · armv6l · armv7l |
| [repo-security](https://github.com/T4n-Labs/repo-security) | Security & auditing tools | x86_64 · i686 · aarch64 · armv6l · armv7l |

## Cara pasang repository

```sh
mkdir -p /etc/xbps.d
echo 'repository=https://t4n-labs.github.io/repo-glibc/x86_64/' | sudo tee /etc/xbps.d/10-glibc.conf
xbps-install -S
```

> Ganti URL & nama `.conf` sesuai repo dan arsitektur yang diinginkan.
> Daftar lengkap semua perintah tersedia di [website](https://repo.t4nlabs.web.id).

## Struktur

```
├── index.html          # Homepage
├── assets/
│   ├── script.js       # Otak homepage
│   └── style.css       # Style homepage
└── site/
    ├── glibc.html      # Search package glibc
    ├── musl.html       # Search package musl
    ├── server.html     # Search package server
    ├── security.html   # Search package security
    └── assets/
        ├── script.js   # Search engine
        └── style.css   # Style halaman search
```

## Search package

Data paket dibaca dari `<arch>/packages.json` di masing-masing repo.
Jika belum ada, otomatis fallback ke GitHub Trees API.

- Repo sudah terisi → daftar paket + pagination (10 paket per halaman)
- Repo belum ada / masih kosong → tampil: *Repository repo-xxx belum tersedia / masih dibangun*

---

© 2026 T4n Labs · Project Community · Built based on Void Linux