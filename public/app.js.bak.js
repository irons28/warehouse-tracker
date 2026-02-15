/* Warehouse Tracker - Locked Working SaaS UI (single-file app.js)
   - Sidebar layout
   - Modal system (manual entry + generate pallet QR)
   - Pallet QR payload supports autofill (customer/product/units)
   - Location QR generation + print
   - Table tracker view
   - Scanner flow using html5-qrcode
*/
(() => {
  // Prevent double execution (common with SW cache or duplicate script tags)
  if (window.__WT_APP_LOADED__) {
    console.warn("Warehouse Tracker: app.js already loaded (skipping duplicate).");
    return;
  }
  window.__WT_APP_LOADED__ = true;

  const API_URL = window.location.origin;

  // --------------------------
  // QR payload helpers (v1)
  // --------------------------
  const WT_QR_PREFIX = "WT|PALLET|v1|";

  function wtBase64UrlEncode(str) {
    const b64 = btoa(unescape(encodeURIComponent(str)));
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  function wtBase64UrlDecode(b64url) {
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const txt = atob(b64 + pad);
    return decodeURIComponent(escape(txt));
  }

  function wtMakePalletQrPayload(data) {
    const payload = {
      id: String(data.id || "").trim(),       // required
      c: String(data.customer || "").trim(),  // customer
      p: String(data.productId || "").trim(), // product id
      u: Number(data.unitsPerPallet || 0) || 0, // units/pallet
    };
    return WT_QR_PREFIX + wtBase64UrlEncode(JSON.stringify(payload));
  }

  function wtParsePalletQr(text) {
    if (!text || typeof text !== "string") return null;

    if (text.startsWith(WT_QR_PREFIX)) {
      try {
        const raw = text.slice(WT_QR_PREFIX.length);
        const json = wtBase64UrlDecode(raw);
        const obj = JSON.parse(json);
        if (!obj?.id) return null;
        return {
          id: String(obj.id),
          customer: String(obj.c || ""),
          productId: String(obj.p || ""),
          unitsPerPallet: Number(obj.u || 0) || 0,
          _format: "wt-v1",
        };
      } catch {
        return null;
      }
    }

    // legacy fallback: treat the whole text as pallet id
    return { id: text.trim(), customer: "", productId: "", unitsPerPallet: 0, _format: "legacy" };
  }

  // --------------------------
  // Safe fetch helpers
  // --------------------------
  async function apiFetch(path, opts = {}) {
    const url = path.startsWith("http") ? path : `${API_URL}${path}`;
    const headers = Object.assign(
      { "Content-Type": "application/json" },
      opts.headers || {}
    );

    const res = await fetch(url, {
      ...opts,
      headers,
      cache: "no-store",
      credentials: "same-origin",
    });

    const ct = res.headers.get("content-type") || "";
    const isJson = ct.includes("application/json");

    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      if (isJson) {
        try {
          const j = await res.json();
          msg = j?.error || j?.message || msg;
        } catch {}
      } else {
        try {
          msg = (await res.text()) || msg;
        } catch {}
      }
      throw new Error(msg);
    }

    if (isJson) return res.json();
    return res.text();
  }

  // --------------------------
  // App
  // --------------------------
  const app = {
    // state
    view: "scan",
    sidebarOpen: false,

    pallets: [],
    activityLog: [],
    locations: [],
    customers: [],
    stats: {},
    selectedCustomer: "",
    searchTerm: "",

    // scanner
    scanMode: null,            // 'checkin-pallet' | 'checkin-location' | 'checkout' | 'checkout-units'
    _scannedPallet: null,      // holds pallet QR payload between scans
    scanner: null,

    // QR views
    tempPallet: null,          // used for single QR view

    // settings
    googleSheetsUrl: "",       // loaded from server (/api/settings) in Option B setups

    // websocket
    socket: null,

    // ui
    lastUpdatedAt: "",
    loading: false,

    // --------------------------
    // UI: Toasts
    // --------------------------
    showToast(message, type = "info") {
      const container = document.getElementById("toast-container");
      if (!container) return;

      const toast = document.createElement("div");
      toast.className = `toast ${type}`;
      const icon = type === "success" ? "✓" : type === "error" ? "✗" : "ℹ";
      toast.innerHTML = `
        <div style="font-size: 20px; line-height: 1;">${icon}</div>
        <div style="flex:1;">${String(message || "")}</div>
      `;
      container.appendChild(toast);

      setTimeout(() => {
        toast.classList.add("hiding");
        setTimeout(() => toast.remove(), 250);
      }, 2800);
    },

    // --------------------------
    // UI: Modal (returns {action, fields} or cancelled)
    // --------------------------
    showModal(title, contentHtml, buttons = []) {
      return new Promise((resolve) => {
        const container = document.getElementById("modal-container");
        if (!container) {
          this.showToast("Missing modal container. Add <div id='modal-container'></div> to index.html", "error");
          resolve({ cancelled: true });
          return;
        }

        const modalId = `wt-modal-${Date.now()}`;

        const btnsHtml = buttons
          .map((b, idx) => {
            const cls = b.className || "rounded-xl bg-slate-100 px-4 py-2 font-semibold text-slate-800 hover:bg-slate-200";
            return `<button type="button" data-modal-btn="${idx}" class="${cls}">${b.label || "OK"}</button>`;
          })
          .join("");

        container.innerHTML = `
          <div class="wt-modal-backdrop" data-modal-backdrop="1">
            <div class="wt-modal" role="dialog" aria-modal="true" aria-labelledby="${modalId}">
              <div class="wt-modal-head">
                <div class="wt-modal-title" id="${modalId}">${title || ""}</div>
                <button class="wt-modal-x" type="button" data-modal-close="1" aria-label="Close">×</button>
              </div>
              <div class="wt-modal-body">
                ${contentHtml || ""}
              </div>
              <div class="wt-modal-foot">
                ${btnsHtml}
              </div>
            </div>
          </div>
        `;

        const close = (payload) => {
          container.innerHTML = "";
          resolve(payload);
        };

        const backdrop = container.querySelector("[data-modal-backdrop]");
        const xBtn = container.querySelector("[data-modal-close]");

        backdrop?.addEventListener("click", (e) => {
          if (e.target === backdrop) close({ cancelled: true });
        });
        xBtn?.addEventListener("click", () => close({ cancelled: true }));

        document.addEventListener(
          "keydown",
          (e) => {
            if (e.key === "Escape") close({ cancelled: true });
          },
          { once: true }
        );

        // button handlers
        buttons.forEach((b, idx) => {
          const el = container.querySelector(`[data-modal-btn="${idx}"]`);
          el?.addEventListener("click", () => {
            const fields = {};
            container.querySelectorAll("[data-modal-field]").forEach((inp) => {
              const key = inp.getAttribute("data-modal-field");
              fields[key] = inp.value;
            });
            close({ action: b.value, fields, cancelled: false });
          });
        });

        // autofocus first input
        const first = container.querySelector("[data-modal-field]");
        first?.focus?.();
      });
    },

    // convenience prompts built on showModal
    async prompt(title, message, defaultValue = "") {
      const html = `
        <p class="text-sm text-slate-600 mb-4">${message || ""}</p>
        <input data-modal-field="v" class="w-full rounded-xl border border-slate-300 px-3 py-2" value="${String(defaultValue ?? "")}" />
      `;
      const res = await this.showModal(title, html, [
        { label: "Cancel", value: "cancel" },
        { label: "OK", value: "ok", className: "rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700" },
      ]);
      if (!res || res.cancelled || res.action !== "ok") return null;
      return res.fields?.v ?? "";
    },

    async confirm(title, message) {
      const html = `<p class="text-sm text-slate-700">${message || ""}</p>`;
      const res = await this.showModal(title, html, [
        { label: "No", value: "no" },
        { label: "Yes", value: "yes", className: "rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700" },
      ]);
      return !!(res && !res.cancelled && res.action === "yes");
    },

    async promptMultiline(title, message, defaultValue = "") {
      const html = `
        <p class="text-sm text-slate-600 mb-4">${message || ""}</p>
        <textarea data-modal-field="v" rows="7" class="w-full rounded-xl border border-slate-300 px-3 py-2 font-mono text-sm">${String(defaultValue ?? "")}</textarea>
        <p class="mt-2 text-xs text-slate-500">Example: PART-001 x10 (one per line)</p>
      `;
      const res = await this.showModal(title, html, [
        { label: "Cancel", value: "cancel" },
        { label: "Save", value: "ok", className: "rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700" },
      ]);
      if (!res || res.cancelled || res.action !== "ok") return null;
      return res.fields?.v ?? "";
    },

    parsePartsList(text) {
      const lines = String(text || "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      const parts = [];
      for (const line of lines) {
        // accept: "ABC123 x10" OR "ABC123 10" OR "ABC123"
        const m = line.match(/^(.+?)(?:\s*[xX]\s*(\d+))?$/);
        if (!m) continue;
        const part_number = String(m[1] || "").trim();
        const quantity = m[2] ? Number(m[2]) : 1;
        if (!part_number) continue;
        parts.push({ part_number, quantity: Number.isFinite(quantity) ? quantity : 1 });
      }
      return parts;
    },

    // --------------------------
    // Navigation / shell
    // --------------------------
    setView(view) {
      this.view = view;
      this.sidebarOpen = false;
      this.scanMode = null;
      this._scannedPallet = null;
      this.render();
    },

    wtToggleSidebar() {
      this.sidebarOpen = !this.sidebarOpen;
      this.render();
    },
    wtCloseSidebar() {
      this.sidebarOpen = false;
      this.render();
    },

    renderShell(contentHtml) {
      const sidebarOpen = !!this.sidebarOpen;

      return `
        <div class="wt-shell ${sidebarOpen ? "sidebar-open" : ""}">
          <div class="wt-topbar">
            <button class="wt-icon-btn wt-menu-btn" aria-label="Open menu" onclick="app.wtToggleSidebar()">☰</button>
            <div class="wt-brand">
              <span class="wt-brand-emoji">📦</span>
              <div class="wt-brand-text">
                <div class="wt-brand-title">Warehouse Tracker</div>
                <div class="wt-brand-sub">Live inventory • PWA</div>
              </div>
            </div>
            <div class="wt-topbar-right">
              <span class="wt-pill wt-pill-gray" id="wt-conn-pill">
                <span id="wt-dot-inline" class="wt-dot is-warn"></span>
                <span id="wt-conn-text">Connecting…</span>
              </span>
              <span class="wt-pill wt-pill-gray" id="wt-last-pill" title="Last refresh time">
                <span class="wt-dot is-ok"></span>
                <span id="wt-last-text">—</span>
              </span>
            </div>
          </div>

          <div class="wt-body">
            <aside class="wt-sidebar" aria-label="Navigation">
              <div class="wt-sidebar-inner">
                <button class="wt-nav-btn" data-nav="scan" onclick="app.setView('scan')">Scan</button>
                <button class="wt-nav-btn" data-nav="tracker" onclick="app.setView('tracker')">Tracker</button>
                <button class="wt-nav-btn" data-nav="history" onclick="app.setView('history')">History</button>
                <button class="wt-nav-btn" data-nav="settings" onclick="app.setView('settings')">Settings</button>

                <div class="wt-sidebar-sep"></div>

                <div class="wt-sidebar-meta">
                  <div class="wt-meta-row">
                    <span class="wt-meta-label">Server</span>
                    <span class="wt-meta-value">${API_URL}</span>
                  </div>
                  <div class="wt-meta-row">
                    <span class="wt-meta-label">Sync</span>
                    <span class="wt-meta-value" id="wt-status-text">Connecting…</span>
                  </div>
                </div>
              </div>
            </aside>

            <main class="wt-main">
              <div class="wt-main-inner">
                ${contentHtml}
              </div>
            </main>
          </div>

          <button class="wt-backdrop" aria-label="Close menu" onclick="app.wtCloseSidebar()"></button>
        </div>
      `;
    },

    // --------------------------
    // Render
    // --------------------------
    render() {
      const appEl = document.getElementById("app");
      if (!appEl) return;

      if (this.scanMode) {
        appEl.innerHTML = this.renderScanner();
        this._postRender();
        return;
      }

      const content =
        this.view === "scan" ? this.renderScan() :
        this.view === "tracker" ? this.renderTracker() :
        this.view === "history" ? this.renderHistory() :
        this.view === "settings" ? this.renderSettings() :
        this.view === "location-qrs" ? this.renderLocationQRs() :
        this.view === "single-qr" ? this.renderSingleQR() :
        `<div class="text-slate-600">Unknown view.</div>`;

      appEl.innerHTML = this.renderShell(content);
      this._postRender();
    },

    _postRender() {
      // active nav highlight
      document.querySelectorAll(".wt-nav-btn").forEach((b) => {
        const v = b.getAttribute("data-nav");
        b.classList.toggle("is-active", v === this.view);
      });

      // last refresh badge
      this._updateTopRightLastUpdated();

      // tracker bindings
      if (this.view === "tracker") {
        const search = document.getElementById("search-input");
        if (search && !search.__wtBound) {
          search.__wtBound = true;
          search.addEventListener("input", (e) => this.search(String(e.target.value || "")));
        }
        const cust = document.getElementById("customer-filter");
        if (cust && !cust.__wtBound) {
          cust.__wtBound = true;
          cust.value = this.selectedCustomer || "";
          cust.addEventListener("change", (e) => {
            this.selectedCustomer = String(e.target.value || "");
            this.refreshAll().catch(() => {});
          });
        }
      }

      // history filter
      if (this.view === "history") {
        const cust = document.getElementById("history-customer-filter");
        if (cust && !cust.__wtBound) {
          cust.__wtBound = true;
          cust.value = this.selectedCustomer || "";
          cust.addEventListener("change", (e) => {
            this.selectedCustomer = String(e.target.value || "");
            this.refreshAll().catch(() => {});
          });
        }
      }

      // QR render: single pallet
      if (this.view === "single-qr" && this.tempPallet) {
        const text = this.tempPallet._qrText || wtMakePalletQrPayload({
          id: this.tempPallet.id,
          customer: this.tempPallet.customer || "",
          productId: this.tempPallet.product || "",
          unitsPerPallet: this.tempPallet.productQty || 0,
        });

        const canvas = document.getElementById("single-qr-canvas");
        if (canvas) {
          // store payload in title for quick inspection
          canvas.title = text;
          this.generateQRCode(text, "single-qr-canvas").catch(() => {});
        }
      }

      // QR render: location sheet
      if (this.view === "location-qrs") {
        this._renderLocationQrCanvas().catch(() => {});
      }
    },

    _updateTopRightLastUpdated() {
      const el = document.getElementById("wt-last-text");
      if (el) el.textContent = this.lastUpdatedAt || "—";
    },

    // --------------------------
    // Views
    // --------------------------
    renderScan() {
      return `
        <div class="fade-in">
          <div class="mx-auto max-w-5xl">
            <div class="mb-6">
              <div class="text-sm font-semibold text-slate-600">Scan</div>
              <h2 class="mt-1 text-3xl font-extrabold tracking-tight text-slate-900">Quick actions</h2>
              <p class="mt-2 text-slate-600">Fast check-in, check-out and partial unit removal.</p>
            </div>

            <div class="rounded-2xl border border-slate-200 bg-white/80 shadow-sm backdrop-blur">
              <div class="flex items-center justify-between gap-3 border-b border-slate-200 px-6 py-4">
                <div>
                  <div class="text-sm font-semibold text-slate-700">Pallet operations</div>
                  <div class="text-sm text-slate-500">Use camera scanning or manual entry.</div>
                </div>
                <span class="inline-flex items-center rounded-full bg-slate-900/5 px-3 py-1 text-xs font-semibold text-slate-700">
                  Recommended
                </span>
              </div>

              <div class="grid grid-cols-1 gap-4 p-6 sm:grid-cols-2">
                <button type="button" onclick="app.startScanner('checkin-pallet')"
                  class="group w-full rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-[1px] hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <div class="flex items-start gap-4">
                    <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-700">
                      <span class="text-lg font-black">IN</span>
                    </div>
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <div class="text-base font-bold text-slate-900">Check in</div>
                        <span class="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-700">scan</span>
                      </div>
                      <div class="mt-1 text-sm text-slate-600">Scan pallet QR, then scan a location.</div>
                    </div>
                  </div>
                </button>

                <button type="button" onclick="app.startScanner('checkout')"
                  class="group w-full rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-[1px] hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <div class="flex items-start gap-4">
                    <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-rose-500/10 text-rose-700">
                      <span class="text-lg font-black">OUT</span>
                    </div>
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <div class="text-base font-bold text-slate-900">Check out</div>
                        <span class="rounded-full bg-rose-500/10 px-2 py-0.5 text-xs font-semibold text-rose-700">remove</span>
                      </div>
                      <div class="mt-1 text-sm text-slate-600">Remove a whole pallet entry from inventory.</div>
                    </div>
                  </div>
                </button>

                <button type="button" onclick="app.startScanner('checkout-units')"
                  class="group w-full rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-[1px] hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <div class="flex items-start gap-4">
                    <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/10 text-amber-800">
                      <span class="text-lg font-black">−</span>
                    </div>
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <div class="text-base font-bold text-slate-900">Remove units</div>
                        <span class="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-800">partial</span>
                      </div>
                      <div class="mt-1 text-sm text-slate-600">Scan a pallet and remove units (partial).</div>
                    </div>
                  </div>
                </button>

                <button type="button" onclick="app.showManualEntry()"
                  class="group w-full rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-[1px] hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <div class="flex items-start gap-4">
                    <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-500/10 text-blue-700">
                      <span class="text-lg font-black">✎</span>
                    </div>
                    <div class="min-w-0">
                      <div class="text-base font-bold text-slate-900">Manual entry</div>
                      <div class="mt-1 text-sm text-slate-600">Enter pallet + location without scanning.</div>
                    </div>
                  </div>
                </button>
              </div>
            </div>

            <div class="mt-6 rounded-2xl border border-slate-200 bg-white/80 p-6 shadow-sm backdrop-blur">
              <div class="mb-4">
                <div class="text-sm font-semibold text-slate-700">QR tools</div>
                <div class="text-sm text-slate-500">Print labels for pallets and locations.</div>
              </div>

              <div class="flex flex-wrap gap-3">
                <button type="button" onclick="app.generatePalletQR()"
                  class="rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500">
                  Generate pallet QR
                </button>
                <button type="button" onclick="app.generateLocationQRs()"
                  class="rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-900 shadow-sm hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500">
                  Location QR codes
                </button>
              </div>
            </div>

            <div class="mt-6 text-xs text-slate-500">
              Tip: pallets with multiple parts can include a parts list (Manual entry).
            </div>
          </div>
        </div>
      `;
    },

    renderScanner() {
      const msg =
        this.scanMode === "checkin-pallet" ? "Scan pallet QR" :
        this.scanMode === "checkin-location" ? "Scan location QR" :
        this.scanMode === "checkout" ? "Scan pallet to check out" :
        this.scanMode === "checkout-units" ? "Scan pallet to remove units" : "Scan";

      return `
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div class="w-full max-w-xl rounded-2xl bg-white p-5 shadow-2xl">
            <div class="mb-3 flex items-center justify-between">
              <div class="text-lg font-extrabold text-slate-900">${msg}</div>
              <button class="wt-icon-btn" onclick="app.stopScanner()" aria-label="Close">×</button>
            </div>
            <div id="qr-reader" class="overflow-hidden rounded-xl border border-slate-200"></div>
            <div class="mt-4 flex gap-2">
              <button class="rounded-xl bg-slate-100 px-4 py-2 font-semibold text-slate-800 hover:bg-slate-200" onclick="app.stopScanner()">
                Cancel
              </button>
              <div class="ml-auto text-xs text-slate-500 flex items-center">
                Ensure camera permission is allowed.
              </div>
            </div>
          </div>
        </div>
      `;
    },

    renderTracker() {
      let pallets = Array.isArray(this.pallets) ? this.pallets.slice() : [];

      const term = String(this.searchTerm || "").toLowerCase().trim();
      if (term) {
        pallets = pallets.filter((p) => {
          const a = String(p.product_id || "").toLowerCase();
          const b = String(p.location || "").toLowerCase();
          const c = String(p.customer_name || "").toLowerCase();
          return a.includes(term) || b.includes(term) || c.includes(term);
        });
      }

      return `
        <div class="space-y-5 fade-in">
          <div class="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div class="text-sm font-semibold text-slate-600">Tracker</div>
              <h2 class="mt-1 text-2xl font-extrabold text-slate-900">Inventory</h2>
              <p class="mt-1 text-slate-600 text-sm">All pallets currently stored.</p>
            </div>
            <button class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              onclick="app.refreshAll().catch(()=>{})">
              Refresh
            </button>
          </div>

          <div class="flex flex-wrap gap-3 items-center">
            <select id="customer-filter" class="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-900">
              <option value="">All customers</option>
              ${(this.customers || []).map((c) => `<option value="${c}">${c}</option>`).join("")}
            </select>

            <input id="search-input" type="text" value="${this.searchTerm || ""}"
              placeholder="Search product / location / customer..."
              class="min-w-[240px] flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm" />

            <a class="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50"
              href="${API_URL}/api/export${this.selectedCustomer ? `?customer=${encodeURIComponent(this.selectedCustomer)}` : ""}"
              download>
              Export CSV
            </a>
          </div>

          <div class="wt-table-wrap">
            <table class="wt-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Customer</th>
                  <th>Location</th>
                  <th class="wt-th-num">Pallets</th>
                  <th class="wt-th-num">Units/Pallet</th>
                  <th class="wt-th-num">Total Units</th>
                  <th>Added</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${
                  pallets.length
                    ? pallets.map((p) => {
                        const pq = Number(p.pallet_quantity) || 0;
                        const up = Number(p.product_quantity) || 0;
                        const total = up > 0 ? (p.current_units ?? (pq * up)) : "";
                        const added = p.date_added ? new Date(p.date_added).toLocaleDateString() : "";
                        return `
                          <tr class="wt-row">
                            <td class="wt-cell wt-strong">${p.product_id || ""}</td>
                            <td class="wt-cell">${p.customer_name || ""}</td>
                            <td class="wt-cell">${p.location || ""}</td>
                            <td class="wt-cell wt-num">${pq}</td>
                            <td class="wt-cell wt-num">${up || ""}</td>
                            <td class="wt-cell wt-num">${total}</td>
                            <td class="wt-cell">${added}</td>
                            <td class="wt-cell wt-actions">
                              <button class="wt-btn wt-btn-purple" onclick="app.reprintPalletQR('${p.id}')">Reprint</button>
                              ${up > 0 ? `<button class="wt-btn wt-btn-yellow" onclick="app.removePartialUnits('${p.id}')">Remove units</button>` : ""}
                              <button class="wt-btn wt-btn-blue" onclick="app.showProductInfo('${p.id}')">Info</button>
                            </td>
                          </tr>
                        `;
                      }).join("")
                    : `
                      <tr>
                        <td class="wt-cell" colspan="8">
                          <div class="py-10 text-center text-slate-500">
                            <div class="text-4xl mb-2">📦</div>
                            No pallets found.
                          </div>
                        </td>
                      </tr>
                    `
                }
              </tbody>
            </table>
          </div>
        </div>
      `;
    },

    renderHistory() {
      const logs = Array.isArray(this.activityLog) ? this.activityLog : [];
      return `
        <div class="space-y-5 fade-in">
          <div>
            <div class="text-sm font-semibold text-slate-600">History</div>
            <h2 class="mt-1 text-2xl font-extrabold text-slate-900">Activity</h2>
            <p class="mt-1 text-slate-600 text-sm">Latest events (check-in, check-out, units removed).</p>
          </div>

          <div class="flex flex-wrap gap-3 items-center">
            <select id="history-customer-filter" class="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-900">
              <option value="">All customers</option>
              ${(this.customers || []).map((c) => `<option value="${c}">${c}</option>`).join("")}
            </select>
            <button class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              onclick="app.refreshAll().catch(()=>{})">
              Refresh
            </button>
          </div>

          <div class="space-y-2">
            ${
              logs.length
                ? logs.slice(0, 100).map((a) => {
                    const ts = a.timestamp ? new Date(a.timestamp).toLocaleString() : "";
                    return `
                      <div class="rounded-2xl border border-slate-200 bg-white p-4">
                        <div class="flex flex-wrap items-center justify-between gap-2">
                          <div class="font-bold text-slate-900">${a.product_id || ""}</div>
                          <div class="text-xs text-slate-500">${ts}</div>
                        </div>
                        <div class="mt-1 text-sm text-slate-700">
                          <span class="font-semibold">${a.customer_name || ""}</span>
                          • ${a.location || ""}
                          • <span class="font-semibold">${a.action || ""}</span>
                          ${a.quantity_changed != null ? ` • Δ ${a.quantity_changed}` : ""}
                        </div>
                        ${a.notes ? `<div class="mt-2 text-xs text-slate-500">${a.notes}</div>` : ""}
                      </div>
                    `;
                  }).join("")
                : `<div class="text-slate-500">No activity yet.</div>`
            }
          </div>
        </div>
      `;
    },

    renderSettings() {
      const url = this.googleSheetsUrl || "";
      return `
        <div class="space-y-5 fade-in">
          <div>
            <div class="text-sm font-semibold text-slate-600">Settings</div>
            <h2 class="mt-1 text-2xl font-extrabold text-slate-900">Integrations</h2>
            <p class="mt-1 text-slate-600 text-sm">Google Sheets server-side sync (Option B) is controlled by the server.</p>
          </div>

          <div class="rounded-2xl border border-slate-200 bg-white p-5">
            <div class="font-bold text-slate-900">Google Sheets</div>
            <div class="mt-2 text-sm text-slate-600">Current Apps Script URL:</div>
            <div class="mt-2 break-all rounded-xl bg-slate-50 p-3 text-sm font-mono text-slate-800">${url || "Not set"}</div>
            <div class="mt-4 flex flex-wrap gap-2">
              <button class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                onclick="app.testGoogleSheetsConnection()">
                Test connection
              </button>
              <button class="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50"
                onclick="app.syncAllToGoogleSheets()">
                Smart sync
              </button>
            </div>
          </div>

          <div class="rounded-2xl border border-slate-200 bg-white p-5">
            <div class="font-bold text-slate-900">PWA</div>
            <div class="mt-2 text-sm text-slate-600">
              If you’re testing updates, use a hard refresh and ensure you’re not serving an old cached app.js.
            </div>
          </div>
        </div>
      `;
    },

    renderLocationQRs() {
      return `
        <div class="space-y-5 fade-in">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div class="text-sm font-semibold text-slate-600">QR tools</div>
              <h2 class="mt-1 text-2xl font-extrabold text-slate-900">Location QR codes</h2>
              <p class="mt-1 text-slate-600 text-sm">Print location labels for scanning.</p>
            </div>
            <div class="flex gap-2">
              <button class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800" onclick="window.print()">
                Print
              </button>
              <button class="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50" onclick="app.setView('scan')">
                Back
              </button>
            </div>
          </div>

          <div id="wt-location-qr-grid" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3"></div>
        </div>
      `;
    },

    renderSingleQR() {
      const p = this.tempPallet;
      if (!p) return `<div class="text-slate-600">No pallet selected.</div>`;

      return `
        <div class="max-w-2xl mx-auto space-y-6 fade-in">
          <div class="flex justify-between items-center print:hidden">
            <h2 class="text-2xl font-extrabold text-slate-900">Pallet label</h2>
            <div class="flex gap-2">
              <button onclick="window.print()"
                class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
                Print
              </button>
              <button onclick="app.setView('scan')"
                class="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50">
                Back
              </button>
            </div>
          </div>

          <div class="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
            <div id="single-qr-canvas" class="flex justify-center mb-5"></div>
            <div class="text-xl font-extrabold text-slate-900">${p.id}</div>
            <div class="mt-2 space-y-1 text-sm text-slate-700">
              <div><span class="font-semibold">Customer:</span> ${p.customer || ""}</div>
              ${p.product ? `<div><span class="font-semibold">Product:</span> ${p.product}</div>` : ""}
              <div><span class="font-semibold">Pallet qty:</span> ${p.palletQty || 1}</div>
              ${p.productQty > 0 ? `<div><span class="font-semibold">Units/pallet:</span> ${p.productQty}</div>` : ""}
            </div>
          </div>
        </div>
      `;
    },

    // --------------------------
    // Actions
    // --------------------------
    async refreshAll() {
      try {
        await Promise.allSettled([
          this.loadPallets(),
          this.loadActivity(),
          this.loadLocations(),
          this.loadStats(),
          this.loadSettings(),
        ]);
        this.lastUpdatedAt = new Date().toLocaleTimeString();
        this._updateTopRightLastUpdated();
        this.render();
      } catch (e) {
        this.showToast(e.message || "Refresh failed", "error");
      }
    },

    async loadPallets() {
      const q = this.selectedCustomer ? `?customer=${encodeURIComponent(this.selectedCustomer)}` : "";
      const data = await apiFetch(`/api/pallets${q}${q ? "&" : "?"}_t=${Date.now()}`.replace("?&", "?"));
      this.pallets = Array.isArray(data) ? data : [];
      this.customers = Array.from(new Set(this.pallets.map((p) => p.customer_name).filter(Boolean))).sort();
    },

    async loadActivity() {
      const q = this.selectedCustomer ? `?customer=${encodeURIComponent(this.selectedCustomer)}` : "";
      const data = await apiFetch(`/api/activity${q}${q ? "&" : "?"}_t=${Date.now()}`.replace("?&", "?"));
      this.activityLog = Array.isArray(data) ? data : [];
    },

    async loadLocations() {
      const data = await apiFetch(`/api/locations?_t=${Date.now()}`);
      this.locations = Array.isArray(data) ? data : [];
    },

    async loadStats() {
      const q = this.selectedCustomer ? `?customer=${encodeURIComponent(this.selectedCustomer)}` : "";
      const data = await apiFetch(`/api/stats${q}${q ? "&" : "?"}_t=${Date.now()}`.replace("?&", "?"));
      this.stats = data || {};
    },

    async loadSettings() {
      try {
        const s = await apiFetch(`/api/settings?_t=${Date.now()}`);
        this.googleSheetsUrl = s?.googleSheetsUrl || s?.appsScriptUrl || this.googleSheetsUrl || "";
      } catch {
        // non-fatal
      }
    },

    search(term) {
      this.searchTerm = String(term || "");
      this.render();
    },

    async testGoogleSheetsConnection() {
      try {
        await apiFetch("/api/sheets/test", { method: "POST", body: JSON.stringify({}) });
        this.showToast("Google Sheets: connection OK", "success");
      } catch (e) {
        this.showToast(`Google Sheets test failed: ${e.message}`, "error");
      }
    },

    async syncAllToGoogleSheets() {
      try {
        await apiFetch("/api/sheets/sync", { method: "POST", body: JSON.stringify({}) });
        this.showToast("Google Sheets: sync triggered", "success");
      } catch (e) {
        this.showToast(`Sync failed: ${e.message}`, "error");
      }
    },

    // --------------------------
    // Manual entry (includes parts list)
    // --------------------------
    async showManualEntry() {
  const modalHtml = `
    <p class="text-sm text-slate-600 mb-5">
      Enter customer, product, quantities, and location. (Same result as scanning a check-in.)
    </p>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <label class="text-sm font-semibold text-slate-700">Customer</label>
        <input data-modal-field="customer" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
          placeholder="e.g. COUNCIL" />
      </div>

      <div>
        <label class="text-sm font-semibold text-slate-700">Product ID</label>
        <input data-modal-field="productId" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
          placeholder="e.g. 715326" />
      </div>

      <div>
        <label class="text-sm font-semibold text-slate-700">Pallet qty</label>
        <input data-modal-field="palletQty" type="number" min="1"
          class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
          value="1" />
      </div>

      <div>
        <label class="text-sm font-semibold text-slate-700">Units / pallet</label>
        <input data-modal-field="unitsPerPallet" type="number" min="0"
          class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
          value="0" />
        <div class="mt-1 text-xs text-slate-500">Set 0 if you’re not tracking units.</div>
      </div>

      <div class="md:col-span-2">
        <label class="text-sm font-semibold text-slate-700">Location</label>
        <input data-modal-field="location" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
          placeholder="e.g. A1-L3" />
      </div>

      <div class="md:col-span-2">
        <label class="text-sm font-semibold text-slate-700">Parts list (optional)</label>
        <textarea data-modal-field="partsText" rows="5"
          class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 font-mono text-sm"
          placeholder="One per line, e.g.
PART-001 x 10
PART-ABC x2"></textarea>
        <div class="mt-2 text-xs text-slate-500">
          Format accepted: <code>PART-001 x 10</code> or <code>PART-001 10</code>
        </div>
      </div>
    </div>

    <div class="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
      This will create a new pallet record (same as scanning a pallet check-in).
    </div>
  `;

  const res = await this.showModal("Manual entry", modalHtml, [
    {
      label: "Cancel",
      value: "cancel",
      className: "rounded-xl bg-slate-100 px-4 py-2 font-semibold text-slate-800 hover:bg-slate-200"
    },
    {
      label: "Save",
      value: "save",
      className: "rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700"
    },
  ]);

  if (!res || res.cancelled || res.action !== "save") return;

  const customerName = (res.fields.customer || "").trim();
  const productId = (res.fields.productId || "").trim();
  const palletQty = Number(res.fields.palletQty || 1) || 1;
  const unitsPerPallet = Number(res.fields.unitsPerPallet || 0) || 0;
  const location = (res.fields.location || "").trim();

  if (!customerName) return this.showToast("Customer is required", "error");
  if (!productId) return this.showToast("Product ID is required", "error");
  if (!location) return this.showToast("Location is required", "error");

  // Optional parts parsing (uses your existing helper if present)
  let parts = null;
  const partsText = (res.fields.partsText || "").trim();
  if (partsText) {
    if (typeof this.parsePartsList === "function") parts = this.parsePartsList(partsText);
    else parts = partsText; // fallback (won't break if helper missing)
  }

  // Same final call you already use
  this.checkIn(customerName, productId, palletQty, unitsPerPallet, location, parts);
},

    // --------------------------
    // Generate pallet QR (modal)
    // --------------------------
    async generatePalletQR() {
      const suggestedId = `P-${Date.now()}`;

      const modalHtml = `
        <p class="text-sm text-slate-600 mb-5">
          Create a printable pallet label. Customer + product can be stored in the QR for fast check-in.
        </p>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label class="text-sm font-semibold text-slate-700">Pallet ID</label>
            <input data-modal-field="palletId" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
              value="${suggestedId}" />
            <div class="mt-1 text-xs text-slate-500">Leave as suggested unless you already have an ID.</div>
          </div>

          <div>
            <label class="text-sm font-semibold text-slate-700">Pallet qty</label>
            <input data-modal-field="palletQty" type="number" min="1"
              class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
              value="1" />
          </div>

          <div>
            <label class="text-sm font-semibold text-slate-700">Customer (stored in QR)</label>
            <input data-modal-field="customer" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="e.g. COUNCIL" />
          </div>

          <div>
            <label class="text-sm font-semibold text-slate-700">Product ID (stored in QR)</label>
            <input data-modal-field="productId" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="e.g. 715326" />
          </div>

          <div class="md:col-span-2">
            <label class="text-sm font-semibold text-slate-700">Units per pallet (optional)</label>
            <input data-modal-field="unitsPerPallet" type="number" min="0"
              class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
              value="0" />
          </div>
        </div>

        <div class="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
          Tip: storing customer + product in the QR means staff can scan the pallet and most fields can auto-fill on check-in.
        </div>
      `;

      const res = await this.showModal("Generate pallet QR", modalHtml, [
        { label: "Cancel", value: "cancel", className: "rounded-xl bg-slate-100 px-4 py-2 font-semibold text-slate-800 hover:bg-slate-200" },
        { label: "Create QR", value: "create", className: "rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700" },
      ]);

      if (!res || res.cancelled || res.action !== "create") return;

      const palletId = String(res.fields.palletId || "").trim();
      const customer = String(res.fields.customer || "").trim();
      const productId = String(res.fields.productId || "").trim();
      const palletQty = Number(res.fields.palletQty || 1) || 1;
      const unitsPerPallet = Number(res.fields.unitsPerPallet || 0) || 0;

      if (!palletId) {
        this.showToast("Pallet ID is required", "error");
        return;
      }

      const qrText = wtMakePalletQrPayload({ id: palletId, customer, productId, unitsPerPallet });

      this.tempPallet = {
        id: palletId,
        customer,
        product: productId,
        palletQty,
        productQty: unitsPerPallet,
        _qrText: qrText,
      };

      this.setView("single-qr");
    },

    generateLocationQRs() {
      this.setView("location-qrs");
    },

    // --------------------------
    // Scanner flow
    // --------------------------
    async startScanner(mode) {
      this.scanMode = mode;
      this._scannedPallet = null;
      this.render();

      // Must exist globally: Html5Qrcode
      if (typeof Html5Qrcode === "undefined") {
        this.showToast("html5-qrcode library not loaded", "error");
        return;
      }

      const el = document.getElementById("qr-reader");
      if (!el) return;

      // stop existing
      await this.stopScanner(true);

      this.scanner = new Html5Qrcode("qr-reader");

      const onScanSuccess = async (decodedText) => {
        try {
          await this._handleScan(decodedText);
        } catch (e) {
          this.showToast(e.message || "Scan failed", "error");
        }
      };

      try {
        await this.scanner.start(
          { facingMode: "environment" },
          { fps: 12, qrbox: 280 },
          onScanSuccess
        );
      } catch (e) {
        this.showToast(`Camera start failed: ${e.message || e}`, "error");
      }
    },

    async stopScanner(silent = false) {
      try {
        if (this.scanner) {
          const s = this.scanner;
          this.scanner = null;
          if (s.isScanning) await s.stop();
          await s.clear();
        }
      } catch {
        // ignore
      } finally {
        this.scanMode = null;
        this._scannedPallet = null;
        if (!silent) this.render();
      }
    },

    async _handleScan(text) {
      if (!text) return;

      // CHECK IN FLOW
      if (this.scanMode === "checkin-pallet") {
        const payload = wtParsePalletQr(text);
        if (!payload?.id) {
          this.showToast("Invalid pallet QR", "error");
          return;
        }
        this._scannedPallet = payload;
        this.showToast(`Pallet scanned: ${payload.id}`, "success");

        // next step: location scan
        this.scanMode = "checkin-location";
        this.render();
        return;
      }

      if (this.scanMode === "checkin-location") {
        const loc = String(text).trim();
        if (!loc) return;

        const pal = this._scannedPallet;
        if (!pal?.id) {
          this.showToast("Missing pallet step. Scan pallet first.", "error");
          return;
        }

        // If QR includes customer/product/units, use them. Otherwise prompt user.
        let customer = pal.customer || "";
        let productId = pal.productId || "";
        let unitsPerPallet = pal.unitsPerPallet || 0;

        if (!customer) {
          const v = await this.prompt("Customer Name", "Customer name:");
          if (v === null) return;
          customer = String(v).trim();
        }
        if (!productId) {
          const v = await this.prompt("Product ID", "Product ID:");
          if (v === null) return;
          productId = String(v).trim();
        }
        if (!unitsPerPallet) {
          const v = await this.prompt("Units per pallet (optional)", "Units per pallet (0 if not tracking):", "0");
          if (v === null) return;
          unitsPerPallet = Number(v) || 0;
        }

        const palletQtyStr = await this.prompt("Pallet quantity", "How many pallets for this entry?", "1");
        if (palletQtyStr === null) return;
        const palletQty = parseInt(palletQtyStr, 10) || 1;

        await this.checkIn(customer, productId, palletQty, unitsPerPallet, loc, null);

        await this.stopScanner(true);
        this.setView("tracker");
        return;
      }

      // CHECK OUT FLOW (whole entry)
      if (this.scanMode === "checkout") {
        const payload = wtParsePalletQr(text);
        const id = payload?.id || String(text).trim();
        if (!id) return;

        const ok = await this.confirm("Check out pallet", `Remove pallet entry ${id} from inventory?`);
        if (!ok) return;

        await this.checkOut(id);
        await this.stopScanner(true);
        this.setView("tracker");
        return;
      }

      // REMOVE UNITS FLOW
      if (this.scanMode === "checkout-units") {
        const payload = wtParsePalletQr(text);
        const id = payload?.id || String(text).trim();
        if (!id) return;

        await this.stopScanner(true);
        await this.removePartialUnits(id);
        this.setView("tracker");
        return;
      }
    },

    // --------------------------
    // Server mutations
    // --------------------------
    async checkIn(customer, productId, palletQty, unitsPerPallet, location, parts) {
      try {
        await apiFetch("/api/checkin", {
          method: "POST",
          body: JSON.stringify({
            customer_name: customer,
            product_id: productId,
            pallet_quantity: palletQty,
            product_quantity: unitsPerPallet,
            location,
            parts: parts || null,
          }),
        });
        this.showToast("Checked in", "success");
        await this.refreshAll();
      } catch (e) {
        this.showToast(`Check-in failed: ${e.message}`, "error");
      }
    },

    async checkOut(palletId) {
      try {
        await apiFetch("/api/checkout", {
          method: "POST",
          body: JSON.stringify({ pallet_id: palletId }),
        });
        this.showToast("Checked out", "success");
        await this.refreshAll();
      } catch (e) {
        this.showToast(`Check-out failed: ${e.message}`, "error");
      }
    },

    async removePartialUnits(palletId) {
      const pallet = (this.pallets || []).find((p) => p.id === palletId);
      if (!pallet) {
        this.showToast("Pallet not found", "error");
        return;
      }
      const up = Number(pallet.product_quantity) || 0;
      if (up <= 0) {
        this.showToast("This pallet has no units tracking.", "error");
        return;
      }

      const currentUnits = Number(pallet.current_units ?? (Number(pallet.pallet_quantity) * up)) || 0;
      const qtyStr = await this.prompt("Remove units", `Current units: ${currentUnits}\nHow many units to remove?`, "1");
      if (qtyStr === null) return;

      const removeUnits = Math.max(0, parseInt(qtyStr, 10) || 0);
      if (removeUnits <= 0) return;

      if (removeUnits > currentUnits) {
        this.showToast("Cannot remove more units than currently stored.", "error");
        return;
      }

      try {
        await apiFetch("/api/remove-units", {
          method: "POST",
          body: JSON.stringify({ pallet_id: palletId, units: removeUnits }),
        });
        this.showToast("Units removed", "success");
        await this.refreshAll();
      } catch (e) {
        this.showToast(`Remove units failed: ${e.message}`, "error");
      }
    },

    async showProductInfo(palletId) {
      const pallet = (this.pallets || []).find((p) => p.id === palletId);
      if (!pallet) return this.showToast("Pallet not found", "error");

      const parts = Array.isArray(pallet.parts) ? pallet.parts : [];
      const partsHtml = parts.length
        ? `<div class="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
             <div class="text-sm font-bold text-slate-900 mb-2">Parts list</div>
             ${parts.map((x) => `
               <div class="flex justify-between text-sm text-slate-700">
                 <span>${x.part_number || ""}</span>
                 <span class="font-semibold">×${x.quantity || 1}</span>
               </div>
             `).join("")}
           </div>`
        : `<div class="mt-3 text-sm text-slate-600">No parts list.</div>`;

      const html = `
        <div class="text-sm text-slate-700">
          <div><span class="font-semibold">Product:</span> ${pallet.product_id || ""}</div>
          <div><span class="font-semibold">Customer:</span> ${pallet.customer_name || ""}</div>
          <div><span class="font-semibold">Location:</span> ${pallet.location || ""}</div>
          <div><span class="font-semibold">Pallets:</span> ${pallet.pallet_quantity || 0}</div>
          <div><span class="font-semibold">Units/pallet:</span> ${pallet.product_quantity || 0}</div>
          ${partsHtml}
        </div>
      `;

      await this.showModal("Pallet info", html, [
        { label: "Close", value: "close", className: "rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white hover:bg-slate-800" },
      ]);
    },

    async reprintPalletQR(palletId) {
      const pallet = (this.pallets || []).find((p) => p.id === palletId);
      if (!pallet) return this.showToast("Pallet not found", "error");

      const qrText = wtMakePalletQrPayload({
        id: pallet.id,
        customer: pallet.customer_name || "",
        productId: pallet.product_id || "",
        unitsPerPallet: Number(pallet.product_quantity) || 0,
      });

      this.tempPallet = {
        id: pallet.id,
        customer: pallet.customer_name || "",
        product: pallet.product_id || "",
        palletQty: Number(pallet.pallet_quantity) || 1,
        productQty: Number(pallet.product_quantity) || 0,
        _qrText: qrText,
      };

      this.setView("single-qr");
    },

    // --------------------------
    // QR generation helpers
    // --------------------------
    async generateQRCode(text, containerId) {
      return new Promise((resolve) => {
        setTimeout(() => {
          const container = document.getElementById(containerId);
          if (!container) return resolve();

          container.innerHTML = "";
          try {
            if (typeof QRCode === "undefined") {
              console.error("QRCode library missing");
              this.showToast("QRCode library missing", "error");
              return resolve();
            }
            new QRCode(container, {
              text: String(text || ""),
              width: 200,
              height: 200,
              colorDark: "#000000",
              colorLight: "#ffffff",
              correctLevel: QRCode.CorrectLevel.H,
            });
          } catch (e) {
            console.error("QR code generation error:", e);
          }
          resolve();
        }, 50);
      });
    },

    async _renderLocationQrCanvas() {
      const grid = document.getElementById("wt-location-qr-grid");
      if (!grid) return;

      const locs = Array.isArray(this.locations) ? this.locations : [];
      grid.innerHTML = "";

      for (const loc of locs) {
        const id = String(loc.id || loc.location || "").trim();
        if (!id) continue;

        const item = document.createElement("div");
        item.className = "rounded-xl border border-slate-200 bg-white p-3 text-center";
        item.innerHTML = `
          <div class="flex justify-center" id="loc-qr-${CSS.escape(id)}"></div>
          <div class="mt-2 text-sm font-bold text-slate-900">${id}</div>
        `;
        grid.appendChild(item);

        // render QR
        const holderId = `loc-qr-${id}`;
        const holder = item.querySelector(`#loc-qr-${CSS.escape(id)}`);
        if (holder) {
          try {
            new QRCode(holder, { text: id, width: 128, height: 128 });
          } catch (e) {
            console.error("Location QR error:", e);
          }
        }
      }
    },

    // --------------------------
    // Websocket status (optional)
    // --------------------------
    connectSocket() {
      const setStatus = (state, text) => {
        const dot = document.getElementById("wt-dot-inline");
        const t1 = document.getElementById("wt-conn-text");
        const t2 = document.getElementById("wt-status-text");

        if (dot) {
          dot.classList.remove("is-ok", "is-warn", "is-bad");
          dot.classList.add(state);
        }
        if (t1) t1.textContent = text;
        if (t2) t2.textContent = text;
      };

      setStatus("is-warn", "Connecting…");

      try {
        if (window.io) {
          this.socket = window.io();
          this.socket.on("connect", () => setStatus("is-ok", "Live sync connected"));
          this.socket.on("disconnect", () => setStatus("is-warn", "Live sync disconnected"));
          this.socket.on("connect_error", () => setStatus("is-bad", "Connection error"));

          // optional: if server emits "db_updated", refresh
          this.socket.on("db_updated", () => {
            this.refreshAll().catch(() => {});
          });
        } else {
          setStatus("is-warn", "No socket library");
        }
      } catch {
        setStatus("is-bad", "Socket init failed");
      }
    },

    // --------------------------
    // Init
    // --------------------------
    async init() {
      try {
        await this.refreshAll();
      } catch {
        // ignore
      }
      this.connectSocket();
      this.render();
    },
  };

  // expose for inline onclick
  window.app = app;

  // boot once
  document.addEventListener("DOMContentLoaded", () => {
    app.init().catch((e) => console.error("Init error:", e));
  });
})();