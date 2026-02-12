/* Warehouse Tracker - locked working build
   NOTE: Load-guard prevents duplicate execution (e.g., service worker cache / double script tags).
*/
(() => {
  if (window.__WT_APP_LOADED__) {
    console.warn("Warehouse Tracker app.js already loaded - skipping duplicate execution.");
    return;
  }
  window.__WT_APP_LOADED__ = true;

const API_URL = window.location.origin;

const app = {
  view: 'tracker',
    setView(view) {
    this.view = view;
    this.sidebarOpen = false; // close sidebar on nav click
    this.scanMode = null;     // safety: exit scanner mode if any
    if (typeof this.render === "function") this.render();
  },
  
  trackerView: 'table',
  sidebarOpen: false,
  pallets: [],
  locations: [],
  stats: {},
  activityLog: [],
  customers: [],
  selectedCustomer: '',
  scanMode: null,
  tempPallet: null,
  tempCheckoutUnits: null,
  searchTerm: '',
  scanner: null,
  loading: false,
  charts: {},

  // ✅ Option B (server-side Sheets): this is now loaded from /api/settings
  googleSheetsUrl: '',
  socket: null,
  autoRefreshInterval: null,
  lastRefresh: Date.now(),

  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ';
    toast.innerHTML = `<div style="font-size: 24px;">${icon}</div><div style="flex: 1;">${message}</div>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('hiding');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  },

  showModal(title, content, buttons = []) {
  return new Promise((resolve) => {
    // Ensure modal root exists (fixes "container is null" issues)
    let container = document.getElementById("modal-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "modal-container";
      document.body.appendChild(container);
    }

    const close = (result = null) => {
      container.innerHTML = "";
      container.classList.remove("open");
      resolve(result);
    };

    const btnHtml = (buttons || []).map((b, i) => {
      const cls = b.class || "bg-gray-200 text-gray-900 px-4 py-2 rounded-lg font-semibold";
      const text = b.text || `Button ${i + 1}`;
      return `<button data-modal-btn="${i}" class="${cls}">${text}</button>`;
    }).join("");

    container.innerHTML = `
      <div class="wt-modal-backdrop" style="
        position:fixed; inset:0; background:rgba(0,0,0,.55);
        display:flex; align-items:center; justify-content:center;
        z-index:9999; padding:16px;
      ">
        <div class="wt-modal" style="
          width:min(720px, 100%); background:#fff; border-radius:16px;
          box-shadow:0 20px 60px rgba(0,0,0,.25);
          overflow:hidden;
        ">
          <div style="display:flex; align-items:center; justify-content:space-between; padding:16px 18px; border-bottom:1px solid #eee;">
            <h3 style="margin:0; font-size:18px; font-weight:800;">${title || ""}</h3>
            <button id="wt-modal-x" aria-label="Close" style="
              font-size:24px; line-height:1; border:0; background:transparent; cursor:pointer; padding:4px 10px;
            ">×</button>
          </div>

          <div style="padding:18px;">
            ${content || ""}
          </div>

          ${btnHtml ? `
            <div style="display:flex; gap:10px; justify-content:flex-end; padding:14px 18px; border-top:1px solid #eee;">
              ${btnHtml}
            </div>
          ` : ""}
        </div>
      </div>
    `;

    container.classList.add("open");

    // Close handlers
    const backdrop = container.querySelector(".wt-modal-backdrop");
    const xBtn = container.querySelector("#wt-modal-x");
    if (xBtn) xBtn.addEventListener("click", () => close(null));
    if (backdrop) backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close(null);
    });

    // Button handlers
    const btnEls = container.querySelectorAll("[data-modal-btn]");
    btnEls.forEach((el) => {
      el.addEventListener("click", async () => {
        const idx = Number(el.getAttribute("data-modal-btn"));
        const cfg = buttons[idx];
        try {
          if (cfg && typeof cfg.handler === "function") {
            const out = await cfg.handler();
            // If handler explicitly returns something, close with it
            if (out !== undefined) close(out);
          } else {
            close(idx);
          }
        } catch (err) {
          console.error("Modal button handler error:", err);
          // Keep modal open so you can correct inputs
        }
      });
    });

    // Escape to close
    const onKey = (e) => {
      if (e.key === "Escape") {
        document.removeEventListener("keydown", onKey);
        close(null);
      }
    };
    document.addEventListener("keydown", onKey);
  });
},

  closeModal(buttonIndex) {
    const container = document.getElementById('modal-container');
    const input = container.querySelector('input');
    const textarea = container.querySelector('textarea');
    const inputValue = input ? input.value : (textarea ? textarea.value : null);
    container.innerHTML = '';
    if (window.modalResolve) {
      const buttonValue = window.modalButtons[buttonIndex].value;
      if (buttonValue === 'ok' && inputValue !== null) {
        window.modalResolve(inputValue);
      } else {
        window.modalResolve(buttonValue);
      }
    }
  },

  async confirm(title, message) {
    const result = await this.showModal(title, `<p class="text-gray-700">${message}</p>`, [
      { text: 'Cancel', value: false },
      { text: 'Confirm', value: true, primary: true }
    ]);
    return result;
  },

  async prompt(title, message, defaultValue = '') {
    const inputId = 'modal-input-' + Date.now();
    return new Promise((resolve) => {
      const container = document.getElementById('modal-container');
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      const modal = document.createElement('div');
      modal.className = 'modal';
      modal.innerHTML = `
        <div class="p-6">
          <h3 class="text-xl font-bold mb-4">${title}</h3>
          <div class="mb-6">
            <p class="text-gray-700 mb-3">${message}</p>
            <input id="${inputId}" type="text" value="${defaultValue}" class="w-full border border-gray-300 rounded-lg px-4 py-2 text-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" autofocus/>
          </div>
          <div class="flex gap-2 justify-end">
            <button onclick="app.closePrompt('${inputId}', null)" class="px-4 py-2 rounded-lg font-semibold bg-gray-200 text-gray-700 hover:bg-gray-300">Cancel</button>
            <button onclick="app.closePrompt('${inputId}', 'ok')" class="px-4 py-2 rounded-lg font-semibold bg-blue-600 text-white hover:bg-blue-700">OK</button>
          </div>
        </div>
      `;
      container.appendChild(backdrop);
      container.appendChild(modal);
      setTimeout(() => {
        const input = document.getElementById(inputId);
        if (input) {
          input.focus();
          input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.closePrompt(inputId, 'ok');
          });
        }
      }, 100);
      window.promptResolve = resolve;
    });
  },

  // NEW: Multi-line prompt for listing parts
  async promptMultiline(title, message, defaultValue = '') {
    const inputId = 'modal-textarea-' + Date.now();
    return new Promise((resolve) => {
      const container = document.getElementById('modal-container');
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      const modal = document.createElement('div');
      modal.className = 'modal';
      modal.style.maxWidth = '600px';
      modal.innerHTML = `
        <div class="p-6">
          <h3 class="text-xl font-bold mb-4">${title}</h3>
          <div class="mb-6">
            <p class="text-gray-700 mb-3">${message}</p>
            <textarea id="${inputId}" rows="6" class="w-full border border-gray-300 rounded-lg px-4 py-2 text-base focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono" autofocus>${defaultValue}</textarea>
            <p class="text-xs text-gray-500 mt-2">Enter one part per line. Format: Part Number | Quantity<br>Example: ABC123 | 50</p>
          </div>
          <div class="flex gap-2 justify-end">
            <button onclick="app.closePrompt('${inputId}', null)" class="px-4 py-2 rounded-lg font-semibold bg-gray-200 text-gray-700 hover:bg-gray-300">Cancel</button>
            <button onclick="app.closePrompt('${inputId}', 'ok')" class="px-4 py-2 rounded-lg font-semibold bg-blue-600 text-white hover:bg-blue-700">OK</button>
          </div>
        </div>
      `;
      container.appendChild(backdrop);
      container.appendChild(modal);
      setTimeout(() => {
        const input = document.getElementById(inputId);
        if (input) input.focus();
      }, 100);
      window.promptResolve = resolve;
    });
  },

  closePrompt(inputId, action) {
    const container = document.getElementById('modal-container');
    const input = document.getElementById(inputId);
    const value = input ? input.value : '';
    container.innerHTML = '';
    if (window.promptResolve) {
      window.promptResolve(action === null ? null : value);
      window.promptResolve = null;
    }
  },

  setLoading(isLoading) {
    this.loading = isLoading;
    if (isLoading) {
      const loadingEl = document.getElementById('loading-overlay');
      if (!loadingEl) {
        const overlay = document.createElement('div');
        overlay.id = 'loading-overlay';
        overlay.className = 'fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50';
        overlay.innerHTML = '<div class="spinner"></div>';
        document.body.appendChild(overlay);
      }
    } else {
      const loadingEl = document.getElementById('loading-overlay');
      if (loadingEl) loadingEl.remove();
    }
  },

  // =========================
  // ✅ (B/C) Server-side settings + Sheets
  // =========================
  async loadServerSettings() {
    try {
      const res = await fetch(`${API_URL}/api/settings`, { cache: "no-store" });
      const settings = await res.json();
      this.googleSheetsUrl = settings.googleSheetsUrl || "";
    } catch (e) {
      console.error("Failed to load server settings:", e);
    }
  },

  // Option B: server does syncing; keep this as a no-op for compatibility
  async syncToGoogleSheets(action, data) {
    return;
  },

  async saveGoogleSheetsUrl(url) {
    const clean = (url || "").trim();
    this.googleSheetsUrl = clean;

    try {
      const res = await fetch(`${API_URL}/api/settings/google-sheets-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: clean })
      });

      const data = await res.json();
      if (!res.ok) {
        this.showToast(data.error || "Failed to save URL", "error");
        return;
      }

      this.showToast(clean ? "Google Sheets URL saved on server!" : "Google Sheets sync disabled", "success");
    } catch (e) {
      console.error(e);
      this.showToast("Failed to save URL on server", "error");
    }
  },

  async testGoogleSheetsConnection() {
    this.setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/sheets/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      const data = await res.json();
      this.showToast("Server test sent! Check your Google Sheet.", "info");
      console.log("Sheets test result:", data);
    } catch (e) {
      console.error(e);
      this.showToast("Server test failed.", "error");
    } finally {
      this.setLoading(false);
    }
  },

  async syncAllToGoogleSheets() {
    if (!this.googleSheetsUrl) {
      this.showToast('Please configure Google Sheets URL first', 'error');
      return;
    }

    const confirmed = await this.confirm(
      'Smart Sync',
      `<div class="space-y-2">
        <p>This will sync <strong>${this.pallets.length} active pallets</strong> to Google Sheets.</p>
        <p class="text-sm text-gray-600">Missing pallets will be added. Existing pallets will be updated.</p>
        <p class="text-sm font-semibold text-green-700">✓ Removal history will be preserved</p>
      </div>
      <p class="mt-3">Continue?</p>`
    );

    if (!confirmed) return;

    this.setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/sheets/sync-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      const data = await res.json();
      console.log("Sync-all result:", data);
      this.showToast("Smart sync requested from server.", "success");
    } catch (e) {
      console.error(e);
      this.showToast("Smart sync failed.", "error");
    } finally {
      this.setLoading(false);
    }
  },

  // =========================
  // ✅ init (C)
  // =========================
  async init() {
    this.setLoading(true);
    try {
      await Promise.all([
        this.loadStats(),
        this.loadPallets(),
        this.loadLocations(),
        this.loadActivity(),
        this.loadCustomers()
      ]);

      // ✅ Load server settings (Google Sheets URL stored on server)
      await this.loadServerSettings();

      this.render();

      // Stamp last updated
      const last = document.getElementById('wt-last-updated');
      if (last) last.textContent = new Date().toLocaleTimeString();

      
      // Close sidebar with Escape
      if (!this._escBound) {
        this._escBound = true;
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') this.wtCloseSidebar();
        });
      }

      // Connect to WebSocket for real-time sync
      this.connectWebSocket();

      // Fallback auto-refresh
      this.startAutoRefresh();
    } catch (e) {
      console.error(e);
      this.showToast('Error loading data. Please refresh the page.', 'error');
    } finally {
      this.setLoading(false);
    }
  },

  startAutoRefresh() {
    if (this._autoRefreshTimer) return;

    const refresh = async () => {
      try {
        if (document.hidden) return;

        await Promise.all([
          this.loadPallets(),
          this.loadStats(),
          this.loadActivity()
        ]);

        // ✅ Re-render on any data-driven page (tracker/history/dashboard)
        if (this.view === 'tracker' || this.view === 'history' || this.view === 'dashboard') {
          this.render();
          if (this.view === 'dashboard') {
            setTimeout(() => this.initCharts(), 50);
          }
        }

        const el = document.getElementById('last-updated');
        if (el) el.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
      } catch (err) {
        console.error('Auto-refresh failed:', err);
      }
    };

    refresh();
    this._autoRefreshTimer = setInterval(refresh, 5000);
    console.log('🔄 Auto-refresh enabled (5s)');
  },

  stopAutoRefresh() {
    if (this._autoRefreshTimer) {
      clearInterval(this._autoRefreshTimer);
      this._autoRefreshTimer = null;
      console.log('⏹️ Auto-refresh stopped');
    }
  },

  // =========================
  // ✅ WebSocket connect (D)
  // =========================
connectWebSocket() {
    try {
      if (!window.io) {
        console.warn('Socket.IO client not loaded');
        this.updateConnectionUI('is-warn', 'No socket library');
        const foot = document.getElementById('wt-foot-text');
        if (foot) foot.textContent = 'No socket library';
        return;
      }

      // Reuse existing socket if possible
      if (this.socket && this.socket.connected) return;

      this.updateConnectionUI('is-warn', 'Connecting…');
      const foot = document.getElementById('wt-foot-text');
      if (foot) foot.textContent = 'Connecting…';

      this.socket = io();

      this.socket.on('connect', () => {
        console.log('✅ WebSocket connected');
        this.updateConnectionUI('is-ok', 'Live sync connected');
        const foot2 = document.getElementById('wt-foot-text');
        if (foot2) foot2.textContent = 'Live sync connected';
      });

      this.socket.on('connect_error', (err) => {
        console.warn('⚠️ WebSocket connection error:', err?.message || err);
        this.updateConnectionUI('is-bad', 'Connection error');
        const foot2 = document.getElementById('wt-foot-text');
        if (foot2) foot2.textContent = 'Connection error';
      });

      this.socket.on('disconnect', () => {
        console.log('❌ WebSocket disconnected');
        this.updateConnectionUI('is-warn', 'Live sync disconnected');
        const foot2 = document.getElementById('wt-foot-text');
        if (foot2) foot2.textContent = 'Live sync disconnected';
        this.showToast('Real-time sync disconnected', 'error');
      });

      this.socket.on('inventory_update', async (update) => {
        console.log('📡 Received update from another device:', update);

        const { action } = update || {};
        this.showToast(`Inventory updated (${action || 'update'})`, 'info');

        await Promise.all([
          this.loadPallets(),
          this.loadActivityLog(),
          this.loadStats(),
          this.loadCustomers()
        ]);

        // Update last updated stamp
        const last = document.getElementById('wt-last-updated');
        if (last) last.textContent = new Date().toLocaleTimeString();

        // Re-render current view (keeps sidebar state)
        this.render();
      });
    } catch (e) {
      console.warn('Socket init failed', e);
      this.updateConnectionUI('is-bad', 'Socket init failed');
      const foot = document.getElementById('wt-foot-text');
      if (foot) foot.textContent = 'Socket init failed';
    }
  },


  async loadPallets() {
    try {
      let url = `${API_URL}/api/pallets`;
      if (this.selectedCustomer) {
        url += `?customer=${encodeURIComponent(this.selectedCustomer)}`;
      }
      url += (url.includes('?') ? '&' : '?') + '_t=' + Date.now();

      console.log('Loading pallets from:', url);
      const res = await fetch(url, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      this.pallets = await res.json();
      console.log('Loaded pallets:', this.pallets.length, 'pallets');

      if (this.pallets.length > 0) {
        console.log('Sample pallet data:', this.pallets.map(p => ({
          id: p.id,
          product_id: p.product_id,
          pallet_qty: p.pallet_quantity,
          unit_qty: p.product_quantity,
          total: p.pallet_quantity * p.product_quantity
        })));
      }
    } catch (e) {
      console.error('Error loading pallets:', e);
      throw e;
    }
  },

  async loadCustomers() {
    try {
      const res = await fetch(`${API_URL}/api/customers`);
      this.customers = await res.json();
    } catch (e) {
      console.error('Error loading customers:', e);
    }
  },

  async loadLocations() {
    try {
      const res = await fetch(`${API_URL}/api/locations`);
      this.locations = await res.json();
    } catch (e) {
      console.error('Error loading locations:', e);
      throw e;
    }
  },

  async loadStats() {
    try {
      let url = `${API_URL}/api/stats`;
      if (this.selectedCustomer) {
        url += `?customer=${encodeURIComponent(this.selectedCustomer)}`;
      }
      const res = await fetch(url, { cache: "no-store" });
      this.stats = await res.json();
    } catch (e) {
      console.error('Error loading stats:', e);
      throw e;
    }
  },

  async loadActivity() {
    try {
      let url = `${API_URL}/api/activity?limit=100`;
      if (this.selectedCustomer) {
        url += `&customer=${encodeURIComponent(this.selectedCustomer)}`;
      }
      const res = await fetch(url, { cache: "no-store" });
      this.activityLog = await res.json();
    } catch (e) {
      console.error('Error loading activity:', e);
      throw e;
    }
  },

  // ENHANCED: Check in with support for multiple parts per pallet and scanned by tracking
  async checkIn(customerName, productId, palletQuantity, productQuantity, location, parts = null, scannedBy = 'Unknown') {
    this.setLoading(true);
    try {
      const payload = {
        customer_name: customerName,
        product_id: productId,
        pallet_quantity: palletQuantity,
        product_quantity: productQuantity,
        location,
        scanned_by: scannedBy
      };

      if (parts) payload.parts = parts;

      const res = await fetch(`${API_URL}/api/pallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      this.showToast(data.message || `Checked in by ${scannedBy}`, 'success');

      // ✅ Sheets now syncs on the SERVER (nothing needed here)

      console.log('===== RELOADING DATA AFTER CHECK-IN =====');
      await new Promise(resolve => setTimeout(resolve, 200));
      this.pallets = [];

      await this.loadCustomers();
      await this.loadPallets();
      await this.loadStats();
      await this.loadActivity();

      console.log('===== DATA RELOADED, RENDERING =====');
      this.render();
      console.log('===== UI UPDATED =====');
    } catch (e) {
      this.showToast('Error checking in pallet', 'error');
      console.error(e);
    } finally {
      this.setLoading(false);
    }
  },

  async checkOut(palletId, scannedBy = null, skipConfirm = false) {
    if (!skipConfirm) {
      const confirmed = await this.confirm('Remove Pallet', 'Are you sure you want to remove this entire pallet from inventory?');
      if (!confirmed) return;
    }

    const pallet = this.pallets.find(p => p.id === palletId);

    if (scannedBy === null) {
      const input = await this.prompt('Scanned By', 'Who is checking out this pallet?', '');
      scannedBy = input?.trim() || 'Unknown';
    }

    this.setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/pallets/${palletId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanned_by: scannedBy })
      });
      const data = await res.json();
      this.showToast(data.message || `Checked out by ${scannedBy}`, 'success');

      // ✅ Sheets now syncs on the SERVER

      await this.loadPallets();
      await this.loadStats();
      await this.loadActivity();
      this.render();
    } catch (e) {
      this.showToast('Error checking out pallet', 'error');
      console.error(e);
    } finally {
      this.setLoading(false);
    }
  },

  // ENHANCED: Remove partial pallets
  async removePartialQuantity(palletId, qtyToRemove = null, scannedBy = null) {
    const pallet = this.pallets.find(p => p.id === palletId);
    if (!pallet) {
      this.showToast('Pallet not found', 'error');
      return;
    }

    console.log('BEFORE REMOVAL - Pallet state:', {
      id: pallet.id,
      product_id: pallet.product_id,
      pallet_quantity: pallet.pallet_quantity,
      product_quantity: pallet.product_quantity,
      total_units: pallet.pallet_quantity * pallet.product_quantity
    });

    if (qtyToRemove === null) {
      const input = await this.prompt(
        'Remove Pallets',
        `Current pallet quantity: <strong>${pallet.pallet_quantity}</strong><br><br>How many pallets to remove?`,
        '1'
      );
      if (input === null) return;
      qtyToRemove = parseInt(input);
    }

    const qty = qtyToRemove;
    if (isNaN(qty) || qty <= 0) {
      this.showToast('Please enter a valid quantity', 'error');
      return;
    }

    if (qty > pallet.pallet_quantity) {
      this.showToast(`Cannot remove ${qty} pallets. Only ${pallet.pallet_quantity} available.`, 'error');
      return;
    }

    if (scannedBy === null) {
      const input = await this.prompt('Scanned By', 'Who is removing these pallets?', '');
      scannedBy = input?.trim() || 'Unknown';
    }

    this.setLoading(true);
    try {
      console.log('===== STARTING PALLET REMOVAL =====');
      console.log('Removing pallets:', qty, 'from pallet:', pallet.id, 'by:', scannedBy);

      const res = await fetch(`${API_URL}/api/pallets/${palletId}/remove-quantity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity_to_remove: qty, scanned_by: scannedBy })
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Server error');
      }

      const data = await res.json();
      console.log('===== SERVER RESPONSE =====');
      console.log('Full response:', data);
      this.showToast(data.message || `Removed by ${scannedBy}`, 'success');

      // ✅ Sheets now syncs on the SERVER

      console.log('===== RELOADING DATA =====');
      await new Promise(resolve => setTimeout(resolve, 200));
      this.pallets = [];

      await Promise.all([
        this.loadPallets(),
        this.loadStats(),
        this.loadActivity()
      ]);

      console.log('===== DATA RELOADED =====');
      console.log('Total pallets:', this.pallets.length);

      const updatedPallet = this.pallets.find(p => p.id === pallet.id);
      if (updatedPallet) {
        console.log('===== FOUND UPDATED PALLET =====');
        console.log('New state:', {
          pallet_quantity: updatedPallet.pallet_quantity,
          product_quantity: updatedPallet.product_quantity,
          total_units: updatedPallet.pallet_quantity * updatedPallet.product_quantity
        });
      } else {
        console.log('===== PALLET REMOVED =====');
      }

      this.render();
      console.log('===== RENDER COMPLETE =====');
    } catch (e) {
      console.error('===== ERROR REMOVING PALLETS =====', e);
      this.showToast('Error removing pallets: ' + e.message, 'error');
    } finally {
      this.setLoading(false);
    }
  },

  // NEW: Remove partial units from pallet (for individual parts/items)
  async removePartialUnits(palletId, unitsToRemove = null, scannedBy = null) {
    const pallet = this.pallets.find(p => p.id === palletId || p.product_id === palletId);
    if (!pallet) {
      this.showToast('Pallet not found', 'error');
      return;
    }

    if (!pallet.product_quantity || pallet.product_quantity === 0) {
      this.showToast('This pallet does not track individual units. Use "Remove Pallets" instead.', 'error');
      return;
    }

    const currentUnits = pallet.current_units || (pallet.pallet_quantity * pallet.product_quantity);
    const totalUnits = pallet.pallet_quantity * currentUnits;

    console.log('BEFORE REMOVAL - Pallet state:', {
      id: pallet.id,
      product_id: pallet.product_id,
      pallet_quantity: pallet.pallet_quantity,
      product_quantity: pallet.product_quantity,
      current_units: currentUnits,
      total_units: totalUnits
    });

    if (unitsToRemove === null) {
      const input = await this.prompt(
        'Remove Units',
        `<div class="space-y-2">
          <p><strong>Original Capacity:</strong> ${pallet.product_quantity} units/pallet</p>
          <p><strong>Current Units:</strong> ${currentUnits} units (${pallet.pallet_quantity} pallet${pallet.pallet_quantity > 1 ? 's' : ''})</p>
          <p class="font-bold text-lg">Available: ${totalUnits} total units</p>
        </div>
        <p class="mt-3">How many units to remove?</p>`,
        '1'
      );

      if (input === null) return;
      unitsToRemove = parseInt(input);
    }

    const units = unitsToRemove;
    if (isNaN(units) || units <= 0) {
      this.showToast('Please enter a valid quantity', 'error');
      return;
    }

    if (units > totalUnits) {
      this.showToast(`Cannot remove ${units} units. Only ${totalUnits} available.`, 'error');
      return;
    }

    if (scannedBy === null) {
      const input = await this.prompt('Scanned By', 'Who is removing these units?', '');
      scannedBy = input?.trim() || 'Unknown';
    }

    this.setLoading(true);
    try {
      console.log('===== STARTING UNIT REMOVAL =====');
      console.log('Removing units:', units, 'from pallet:', pallet.id, 'by:', scannedBy);

      const res = await fetch(`${API_URL}/api/pallets/${pallet.id}/remove-units`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          units_to_remove: units,
          scanned_by: scannedBy
        })
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Server error');
      }

      const data = await res.json();
      console.log('===== SERVER RESPONSE =====');
      console.log('Full response:', data);

      // ✅ Sheets now syncs on the SERVER

      this.showToast(data.message || `Removed by ${scannedBy}`, 'success');

      console.log('===== RELOADING DATA =====');
      await new Promise(resolve => setTimeout(resolve, 200));
      this.pallets = [];

      await Promise.all([
        this.loadPallets(),
        this.loadStats(),
        this.loadActivity()
      ]);

      console.log('===== DATA RELOADED =====');
      console.log('Total pallets loaded:', this.pallets.length);

      this.render();
      console.log('===== RENDER COMPLETE =====');

    } catch (e) {
      console.error('===== ERROR REMOVING UNITS =====', e);
      this.showToast('Error removing units: ' + e.message, 'error');
    } finally {
      this.setLoading(false);
    }
  },


  // Compatibility aliases (older instructions referenced these names)
  removeUnits(palletId) {
    return this.removePartialUnits(palletId);
  },

  _startQrReader(mode) {
    // Older builds used this; we now use startScanner().
    return this.startScanner(mode);
  },

  // NEW: Show detailed product information including removal history
  async showProductInfo(palletId) {
    const pallet = this.pallets.find(p => p.id === palletId);
    if (!pallet) {
      this.showToast('Pallet not found', 'error');
      return;
    }

    const removalHistory = this.activityLog.filter(a =>
      a.product_id === pallet.product_id &&
      a.location === pallet.location &&
      (a.action === 'PARTIAL_REMOVE' || a.action === 'UNITS_REMOVE')
    );

    const totalUnits = pallet.current_units || (pallet.pallet_quantity * pallet.product_quantity);

    const content = `
      <div class="space-y-4">
        <div class="bg-gradient-to-r from-blue-50 to-blue-100 p-4 rounded-lg border-l-4 border-blue-500">
          <h4 class="font-bold text-lg text-gray-900 mb-3">${pallet.product_id}</h4>

          <div class="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span class="text-gray-600">Customer:</span>
              <span class="font-semibold ml-2">${pallet.customer_name}</span>
            </div>
            <div>
              <span class="text-gray-600">Location:</span>
              <span class="font-semibold ml-2">${pallet.location}</span>
            </div>
            <div>
              <span class="text-gray-600">Pallets:</span>
              <span class="font-semibold ml-2">${pallet.pallet_quantity}</span>
            </div>
            <div>
              <span class="text-gray-600">Units/Pallet:</span>
              <span class="font-semibold ml-2">${pallet.product_quantity || 'N/A'}</span>
            </div>
            ${pallet.product_quantity > 0 ? `
              <div class="col-span-2">
                <span class="text-gray-600">Current Units:</span>
                <span class="font-bold ml-2 text-blue-600">${totalUnits}</span>
              </div>
            ` : ''}
            <div class="col-span-2">
              <span class="text-gray-600">Date Added:</span>
              <span class="font-semibold ml-2">${new Date(pallet.date_added).toLocaleString()}</span>
            </div>
            <div class="col-span-2">
              <span class="text-gray-600">Scanned In By:</span>
              <span class="font-bold ml-2 text-green-600">👤 ${pallet.scanned_by || 'Unknown'}</span>
            </div>
          </div>

          ${pallet.parts && pallet.parts.length > 0 ? `
            <div class="mt-4 p-3 bg-white rounded-lg">
              <p class="text-sm font-semibold text-gray-700 mb-2">📋 Parts List:</p>
              <div class="space-y-1">
                ${pallet.parts.map(part => `
                  <div class="text-sm text-gray-700 flex justify-between">
                    <span>${part.part_number}</span>
                    <span class="font-semibold">×${part.quantity}</span>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}
        </div>

        ${removalHistory.length > 0 ? `
          <div>
            <h5 class="font-bold text-gray-900 mb-2 flex items-center gap-2">
              <span class="text-red-500">🗑️</span> Removal History
            </h5>
            <div class="max-h-48 overflow-y-auto space-y-2">
              ${removalHistory.map(r => `
                <div class="bg-red-50 p-3 rounded-lg border border-red-200 text-sm">
                  <div class="flex justify-between items-start mb-1">
                    <span class="font-semibold text-red-700">${r.action === 'UNITS_REMOVE' ? 'Units Removed' : 'Pallets Removed'}</span>
                    <span class="text-xs text-gray-500">${new Date(r.timestamp).toLocaleString()}</span>
                  </div>
                  <div class="grid grid-cols-3 gap-2 text-xs mt-2">
                    <div>
                      <span class="text-gray-600">Removed:</span>
                      <span class="font-bold ml-1">${r.quantity_changed}</span>
                    </div>
                    <div>
                      <span class="text-gray-600">Before:</span>
                      <span class="font-semibold ml-1">${r.quantity_before}</span>
                    </div>
                    <div>
                      <span class="text-gray-600">After:</span>
                      <span class="font-semibold ml-1">${r.quantity_after}</span>
                    </div>
                  </div>
                  <div class="mt-2 pt-2 border-t border-red-100">
                    <span class="text-xs text-gray-600">Removed by:</span>
                    <span class="text-xs font-bold text-red-700 ml-1">👤 ${r.scanned_by || 'Unknown'}</span>
                  </div>
                  ${r.notes ? `<p class="text-xs text-gray-600 mt-2 italic">${r.notes}</p>` : ''}
                </div>
              `).join('')}
            </div>
          </div>
        ` : `
          <div class="bg-green-50 p-3 rounded-lg border border-green-200 text-sm text-green-700">
            ✓ No removals yet - full original quantity
          </div>
        `}

        <div class="pt-3 border-t border-gray-200">
          <p class="text-xs text-gray-500 mb-3">Need to remove this pallet completely?</p>
          <button
            onclick="app.closeModal(); app.checkOut('${pallet.id}')"
            class="w-full bg-red-500 text-white px-4 py-2 rounded-lg font-semibold hover:bg-red-600"
          >
            🗑️ Remove All (Complete Checkout)
          </button>
        </div>
      </div>
    `;

    await this.showModal('Product Information', content, [
      { text: 'Close', value: 'close' }
    ]);
  },

  startScanner(mode) {
    this.scanMode = mode;
    this.render();

    setTimeout(() => {
      const html5QrCode = new Html5Qrcode("qr-reader");
      this.scanner = html5QrCode;

      Html5Qrcode.getCameras().then(cameras => {
        if (cameras && cameras.length > 0) {
          const cameraId = cameras.length > 1 ? cameras[1].id : cameras[0].id;

          html5QrCode.start(
            cameraId,
            { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 },
            (decodedText) => {
              this.handleScan(decodedText);
              html5QrCode.stop().catch(err => console.log('Stop error:', err));
            },
            () => {}
          ).catch(err => {
            console.error("Camera start error:", err);
            this.showToast("Camera access denied. Please enable camera permissions.", 'error');
            this.stopScanner();
            this.scanMode = null;
            this.render();
          });
        } else {
          this.showToast("No cameras found. Please use manual entry.", 'error');
          this.stopScanner();
          this.scanMode = null;
          this.render();
        }
      }).catch(err => {
        console.error("Camera detection error:", err);
        this.showToast("Unable to access camera. Please ensure camera permissions are enabled.", 'error');
        this.stopScanner();
        this.scanMode = null;
        this.render();
      });
    }, 100);
  },

  async handleScan(code) {
    let palletData = null;
    try {
      const parsed = JSON.parse(code);
      if (parsed.type === 'PALLET') palletData = parsed;
    } catch (_) {}

    if (this.scanMode === 'checkin-pallet') {
      this.tempPallet = palletData || code;
      this.stopScanner();
      this.showToast('Pallet scanned! Now scan location...', 'success');
      setTimeout(() => {
        this.scanMode = 'checkin-location';
        this.startScanner('checkin-location');
      }, 500);

    } else if (this.scanMode === 'checkin-location') {
      this.stopScanner();

      if (this.tempPallet && typeof this.tempPallet === 'object' && this.tempPallet.customer) {
        const palletsInThisLocation = await this.prompt(
          'Pallets for This Location',
          `<div class="space-y-2">
            <p><strong>Product:</strong> ${this.tempPallet.product}</p>
            <p><strong>Customer:</strong> ${this.tempPallet.customer}</p>
            <p><strong>Location:</strong> ${code}</p>
            <p class="text-sm text-gray-600 mt-3">QR code says ${this.tempPallet.palletQty} pallet(s) total</p>
          </div>
          <p class="font-semibold mt-3">How many pallets are you putting in THIS location?</p>`,
          this.tempPallet.palletQty.toString()
        );

        if (palletsInThisLocation === null) {
          this.scanMode = null;
          this.tempPallet = null;
          this.render();
          return;
        }

        const qtyForThisLocation = parseInt(palletsInThisLocation);
        if (isNaN(qtyForThisLocation) || qtyForThisLocation <= 0) {
          this.showToast('Please enter a valid quantity', 'error');
          this.scanMode = null;
          this.tempPallet = null;
          this.render();
          return;
        }

        if (qtyForThisLocation > this.tempPallet.palletQty) {
          this.showToast(`Cannot put ${qtyForThisLocation} pallets - QR only has ${this.tempPallet.palletQty}`, 'error');
          this.scanMode = null;
          this.tempPallet = null;
          this.render();
          return;
        }

        const scannedBy = await this.prompt('Scanned By', 'Who is checking in this pallet?', '');
        if (scannedBy === null) {
          this.scanMode = null;
          this.tempPallet = null;
          this.render();
          return;
        }

        await this.checkIn(
          this.tempPallet.customer,
          this.tempPallet.product,
          qtyForThisLocation,
          this.tempPallet.productQty,
          code,
          this.tempPallet.parts,
          scannedBy.trim() || 'Unknown'
        );

        const remaining = this.tempPallet.palletQty - qtyForThisLocation;
        if (remaining > 0) {
          const continueScanning = await this.confirm(
            'More Pallets?',
            `<div class="space-y-2">
              <p>✅ Checked in <strong>${qtyForThisLocation} pallet(s)</strong> at ${code}</p>
              <p class="text-lg font-bold text-orange-600">⚠️ ${remaining} pallet(s) remaining</p>
            </div>
            <p class="mt-3">Do you want to scan another location for the remaining pallets?</p>`
          );

          if (continueScanning) {
            this.tempPallet.palletQty = remaining;
            this.scanMode = 'checkin-location';
            this.startScanner('checkin-location');
            return;
          }
        }

        this.scanMode = null;
        this.tempPallet = null;

      } else {
        const customerName = await this.prompt('Customer Name', 'Enter customer name:');
        if (!customerName) {
          this.scanMode = null;
          this.tempPallet = null;
          this.render();
          return;
        }

        const palletQty = await this.prompt('Pallet Quantity', 'How many pallets?', '1');
        if (palletQty === null) {
          this.scanMode = null;
          this.tempPallet = null;
          this.render();
          return;
        }

        const productQty = await this.prompt('Product Quantity (Optional)', 'Units per pallet (leave blank if not tracking):', '0');
        if (productQty === null) {
          this.scanMode = null;
          this.tempPallet = null;
          this.render();
          return;
        }

        const addParts = await this.confirm('Add Parts List', 'Would you like to add a detailed parts list for this pallet?');
        let parts = null;

        if (addParts) {
          const partsList = await this.promptMultiline(
            'Parts List',
            'Enter parts for this pallet (one per line):',
            ''
          );

          if (partsList && partsList.trim()) {
            parts = this.parsePartsList(partsList);
          }
        }

        const scannedBy = await this.prompt('Scanned By', 'Who is checking in this pallet?', '');

        this.checkIn(customerName, this.tempPallet, parseInt(palletQty) || 1, parseInt(productQty) || 0, code, parts, scannedBy?.trim() || 'Unknown');
        this.scanMode = null;
        this.tempPallet = null;
      }

    } else if (this.scanMode === 'checkout') {
      // Checkout = remove the entire pallet entry
      const palletId = decodedText.trim();
      this.stopScanner();
      this.scanMode = null;

      const pallet = this.pallets.find(p => String(p.id) === String(palletId));
      if (!pallet) {
        alert('Pallet not found: ' + palletId);
        this.render();
        return;
      }

      const ok = confirm(`Check out pallet ${pallet.product_id || palletId} at ${pallet.location || ''}?`);
      if (!ok) {
        this.render();
        return;
      }

      try {
        await fetch(`${API_URL}/api/pallets/${encodeURIComponent(palletId)}/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scanned_by: 'scanner' })
        });
        await this.refreshAll();
        this.setView('history');
      } catch (err) {
        console.error(err);
        alert('Checkout failed.');
        this.render();
      }
      return;
    }

    if (this.scanMode === 'checkout-units') {
      this.stopScanner();

      const palletId = palletData ? palletData.id : code;
      const pallet = this.pallets.find(p => p.id === palletId || p.product_id === palletId);

      if (!pallet) {
        this.showToast('Pallet not found in inventory', 'error');
        this.scanMode = null;
        this.render();
        return;
      }

      if (!pallet.product_quantity || pallet.product_quantity === 0) {
        this.showToast('This pallet does not track individual units. Use "Check Out Pallet" instead.', 'error');
        this.scanMode = null;
        this.render();
        return;
      }

      const currentUnits = pallet.current_units || (pallet.pallet_quantity * pallet.product_quantity);
      const unitsToRemove = await this.prompt(
        'Check Out Units',
        `<div class="mb-3">
          <p class="font-bold text-lg mb-2">${pallet.product_id}</p>
          <p class="text-sm text-gray-600">Customer: ${pallet.customer_name}</p>
          <p class="text-sm text-gray-600">Location: ${pallet.location}</p>
          <p class="text-sm font-semibold mt-2">Available: ${currentUnits} units</p>
        </div>
        <p class="font-semibold">How many units to check out?</p>`,
        '1'
      );

      if (unitsToRemove === null) {
        this.scanMode = null;
        return;
      }

      const scannedBy = await this.prompt('Scanned By', 'Who is checking out these units?', '');
      if (scannedBy === null) {
        this.scanMode = null;
        return;
      }

      await this.removePartialUnits(palletId, parseInt(unitsToRemove), scannedBy?.trim() || 'Unknown');
      this.scanMode = null;
    }
  },

  // NEW: Parse parts list from text input
  parsePartsList(text) {
    const lines = text.split('\n').filter(line => line.trim());
    const parts = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const separators = ['|', ',', '\t'];
      let parsed = false;

      for (const sep of separators) {
        if (trimmed.includes(sep)) {
          const [partNum, qty] = trimmed.split(sep).map(s => s.trim());
          if (partNum) {
            parts.push({
              part_number: partNum,
              quantity: parseInt(qty) || 1
            });
            parsed = true;
            break;
          }
        }
      }

      if (!parsed) {
        parts.push({
          part_number: trimmed,
          quantity: 1
        });
      }
    }

    return parts.length > 0 ? parts : null;
  },

  stopScanner() {
    if (this.scanner) {
      try {
        this.scanner.stop().then(() => {
          this.scanner.clear();
        }).catch(e => {
          console.log('Scanner stop error:', e);
        });
      } catch (e) {
        console.log('Scanner already stopped');
      }
      this.scanner = null;
    }
  },

  // ENHANCED: Manual entry with parts support
  showManualEntry() {
  // Ensure modal + toast containers exist (in case renderShell didn't create them yet)
  this._ensureUiOverlays();

  const partsHelp = `Optional parts list (one per line):
PART-001 x 10
PART-ABC x2`;

  const html = `
    <div class="space-y-4">
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label class="block text-sm font-semibold text-slate-700 mb-1">Customer</label>
          <input id="me_customer" class="w-full rounded-xl border border-slate-300 px-3 py-2" placeholder="e.g. COUNCIL" />
        </div>
        <div>
          <label class="block text-sm font-semibold text-slate-700 mb-1">Product ID</label>
          <input id="me_product" class="w-full rounded-xl border border-slate-300 px-3 py-2" placeholder="e.g. 715326" />
        </div>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label class="block text-sm font-semibold text-slate-700 mb-1">Pallet qty</label>
          <input id="me_palletQty" type="number" min="1" value="1"
            class="w-full rounded-xl border border-slate-300 px-3 py-2" />
        </div>
        <div>
          <label class="block text-sm font-semibold text-slate-700 mb-1">Units / pallet</label>
          <input id="me_unitsPer" type="number" min="0" value="0"
            class="w-full rounded-xl border border-slate-300 px-3 py-2" />
        </div>
        <div>
          <label class="block text-sm font-semibold text-slate-700 mb-1">Location</label>
          <input id="me_location" class="w-full rounded-xl border border-slate-300 px-3 py-2" placeholder="e.g. A1-L3" />
        </div>
      </div>

      <div>
        <label class="block text-sm font-semibold text-slate-700 mb-1">Parts list (optional)</label>
        <textarea id="me_parts" rows="5"
          class="w-full rounded-xl border border-slate-300 px-3 py-2 font-mono text-sm"
          placeholder="${partsHelp.replaceAll('"', '&quot;')}"></textarea>
        <div class="mt-2 text-xs text-slate-500">${partsHelp.replaceAll('\n', '<br/>')}</div>
      </div>

      <div class="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">
        This will create a new pallet record (same as scanning a pallet check-in).
      </div>
    </div>
  `;

  this.showModal("Manual entry", html, [
    { label: "Cancel", value: null, style: "secondary" },
    { label: "Save", value: "save", style: "primary" },
  ]).then(async (result) => {
    if (result !== "save") return;

    const customer = (document.getElementById("me_customer")?.value || "").trim();
    const product = (document.getElementById("me_product")?.value || "").trim();
    const location = (document.getElementById("me_location")?.value || "").trim();

    const palletQty = parseInt(document.getElementById("me_palletQty")?.value || "1", 10);
    const unitsPer = parseInt(document.getElementById("me_unitsPer")?.value || "0", 10);

    const partsRaw = (document.getElementById("me_parts")?.value || "").trim();
    const parts = this._parsePartsList(partsRaw);

    if (!customer || !product || !location) {
      this.showToast("Customer, Product ID and Location are required.", "error");
      return;
    }
    if (!Number.isFinite(palletQty) || palletQty <= 0) {
      this.showToast("Pallet qty must be 1 or more.", "error");
      return;
    }
    if (!Number.isFinite(unitsPer) || unitsPer < 0) {
      this.showToast("Units/pallet must be 0 or more.", "error");
      return;
    }

    try {
      await this.apiPost("/api/pallets", {
        customer_name: customer,
        product_id: product,
        pallet_quantity: palletQty,
        product_quantity: unitsPer,
        location,
        parts: parts.length ? parts : null,
        scanned_by: "Manual entry",
      });

      this.showToast("Saved ✅", "success");

      // Refresh local state
      await Promise.allSettled([
        this.loadPallets?.(),
        this.loadActivity?.(),
        this.loadStats?.(),
        this.loadLocations?.(),
      ]);

      this.setView?.("tracker");
      this.render?.();
    } catch (e) {
      this.showToast(e?.message || "Save failed", "error");
    }
  });
},

_ensureUiOverlays() {
  // modal root
  if (!document.getElementById("modal-root")) {
    const mr = document.createElement("div");
    mr.id = "modal-root";
    document.body.appendChild(mr);
  }
  // toast container
  if (!document.getElementById("toast-container")) {
    const tc = document.createElement("div");
    tc.id = "toast-container";
    document.body.appendChild(tc);
  }
},

_parsePartsList(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // Accept formats:
  // PART-001 x 10
  // PART-001 x10
  // PART-001,10
  // PART-001 10
  const parts = [];
  for (const line of lines) {
    let part_number = "";
    let quantity = 1;

    // Try "x"
    const xMatch = line.match(/^(.+?)\s*x\s*(\d+)$/i);
    if (xMatch) {
      part_number = xMatch[1].trim();
      quantity = parseInt(xMatch[2], 10);
    } else {
      // Try comma
      const cMatch = line.match(/^(.+?),\s*(\d+)$/);
      if (cMatch) {
        part_number = cMatch[1].trim();
        quantity = parseInt(cMatch[2], 10);
      } else {
        // Try space split last token as number
        const sMatch = line.match(/^(.+?)\s+(\d+)$/);
        if (sMatch) {
          part_number = sMatch[1].trim();
          quantity = parseInt(sMatch[2], 10);
        } else {
          part_number = line.trim();
          quantity = 1;
        }
      }
    }

    if (!part_number) continue;
    if (!Number.isFinite(quantity) || quantity <= 0) quantity = 1;

    parts.push({ part_number, quantity });
  }
  return parts;
},

  async generateQRCode(text, containerId) {
    return new Promise((resolve) => {
      setTimeout(() => {
        const container = document.getElementById(containerId);
        if (container) {
          container.innerHTML = '';
          try {
            new QRCode(container, {
              text: text,
              width: 200,
              height: 200,
              colorDark: "#000000",
              colorLight: "#ffffff",
              correctLevel: QRCode.CorrectLevel.H
            });
            resolve();
          } catch (error) {
            console.error('QR Code generation error:', error);
            resolve();
          }
        } else {
          console.error('Container not found:', containerId);
          resolve();
        }
      }, 100);
    });
  },

  async generateLocationQRs() {
    this.view = 'location-qrs';
    this.render();
    this.setLoading(true);

    setTimeout(async () => {
      const aisles = this.locations.reduce((acc, loc) => {
        if (!acc.includes(loc.aisle)) acc.push(loc.aisle);
        return acc;
      }, []).sort();

      for (const aisle of aisles) {
        const aisleLocations = this.locations.filter(l => l.aisle === aisle);
        for (const loc of aisleLocations) {
          await this.generateQRCode(loc.id, `qr-${loc.id}`);
        }
      }

      this.setLoading(false);
      this.showToast('All QR codes generated successfully!', 'success');
    }, 200);
  },

  async generatePalletQR() {
  try {
    // Ask for details (simple + reliable)
    const customer = prompt("Customer name? (required)", "")?.trim();
    if (!customer) return;

    const product = prompt("Product ID / name? (optional)", "")?.trim() || "";
    const palletQty = Number(prompt("Pallet quantity? (default 1)", "1") || 1) || 1;
    const unitsPerPallet = Number(prompt("Units per pallet? (0 if not used)", "0") || 0) || 0;

    // Create a temp pallet payload used by renderSingleQR()
    const id = `PAL-${Date.now().toString(36).toUpperCase()}`;
    this.tempPallet = {
      id,
      customer,
      product,
      palletQty,
      productQty: unitsPerPallet,
    };

    // Go to the existing single-qr screen (it has #single-qr-canvas)
    this.view = "single-qr";
    this.render();

    // Wait for the canvas element to exist, then draw QR into it
    const waitForEl = (selector, ms = 1500) =>
      new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
          const el = document.querySelector(selector);
          if (el) return resolve(el);
          if (Date.now() - started > ms) return reject(new Error(`Missing element: ${selector}`));
          requestAnimationFrame(tick);
        };
        tick();
      });

    const mount = await waitForEl("#single-qr-canvas");

    // Clear and render QR
    mount.innerHTML = "";
    // QRCODEJS: new QRCode(element, { text, width, height })
    new QRCode(mount, {
      text: id,
      width: 220,
      height: 220,
    });
  } catch (err) {
    console.error("generatePalletQR failed:", err);
    this.showToast?.("QR generation failed — check console for details", "error");
  }
},

  async reprintPalletQR(palletId) {
    const pallet = this.pallets.find(p => p.id === palletId);
    if (!pallet) {
      this.showToast('Pallet not found', 'error');
      return;
    }

    const qrData = {
      type: 'PALLET',
      id: pallet.id,
      customer: pallet.customer_name,
      product: pallet.product_id,
      palletQty: pallet.pallet_quantity,
      productQty: pallet.product_quantity,
      parts: pallet.parts
    };

    this.view = 'single-qr';
    this.tempPallet = qrData;
    this.render();

    setTimeout(async () => {
      await this.generateQRCode(JSON.stringify(qrData), 'single-qr-canvas');
      this.showToast('QR code ready to reprint!', 'success');
    }, 100);
  },

  printQRCodes() {
    window.print();
  },

  initCharts() {
    Object.values(this.charts).forEach(chart => {
      if (chart) chart.destroy();
    });
    this.charts = {};
    this.createCustomerChart();
    this.createLocationChart();
    this.createActivityChart();
  },

  createCustomerChart() {
    const canvas = document.getElementById('customerChart');
    if (!canvas) return;
    const customerData = {};
    this.pallets.forEach(p => {
      customerData[p.customer_name] = (customerData[p.customer_name] || 0) + 1;
    });
    const labels = Object.keys(customerData);
    const data = Object.values(customerData);
    const colors = this.generateColors(labels.length);
    this.charts.customer = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          label: 'Pallets per Customer',
          data: data,
          backgroundColor: colors,
          borderWidth: 2,
          borderColor: '#fff'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { padding: 15, font: { size: 12, weight: 'bold' }}},
          title: { display: true, text: 'Inventory by Customer', font: { size: 16, weight: 'bold' }, padding: 20 }
        }
      }
    });
  },

  createLocationChart() {
    const canvas = document.getElementById('locationChart');
    if (!canvas) return;
    const aisleData = {};
    this.pallets.forEach(p => {
      const aisle = p.location.charAt(0);
      aisleData[aisle] = (aisleData[aisle] || 0) + 1;
    });
    const labels = Object.keys(aisleData).sort();
    const data = labels.map(aisle => aisleData[aisle]);
    this.charts.location = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels.map(l => `Aisle ${l}`),
        datasets: [{
          label: 'Pallets',
          data: data,
          backgroundColor: 'rgba(59, 130, 246, 0.8)',
          borderColor: 'rgba(59, 130, 246, 1)',
          borderWidth: 2,
          borderRadius: 8
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          title: { display: true, text: 'Pallets by Aisle', font: { size: 16, weight: 'bold' }, padding: 20 }
        },
        scales: { y: { beginAtZero: true, ticks: { stepSize: 1 }}}
      }
    });
  },

  createActivityChart() {
    const canvas = document.getElementById('activityChart');
    if (!canvas) return;
    const dates = [];
    const checkIns = [];
    const checkOuts = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      dates.push(date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));

      const dayCheckIns = this.activityLog.filter(a =>
        a.timestamp.startsWith(dateStr) && a.action === 'CHECK_IN'
      ).length;
      const dayCheckOuts = this.activityLog.filter(a =>
        a.timestamp.startsWith(dateStr) && (a.action === 'CHECK_OUT' || a.action === 'PARTIAL_REMOVE')
      ).length;

      checkIns.push(dayCheckIns);
      checkOuts.push(dayCheckOuts);
    }

    this.charts.activity = new Chart(canvas, {
      type: 'line',
      data: {
        labels: dates,
        datasets: [
          {
            label: 'Check Ins',
            data: checkIns,
            borderColor: 'rgba(34, 197, 94, 1)',
            backgroundColor: 'rgba(34, 197, 94, 0.1)',
            borderWidth: 3,
            fill: true,
            tension: 0.4
          },
          {
            label: 'Check Outs',
            data: checkOuts,
            borderColor: 'rgba(239, 68, 68, 1)',
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            borderWidth: 3,
            fill: true,
            tension: 0.4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { padding: 15, font: { size: 12, weight: 'bold' }}},
          title: { display: true, text: '7-Day Activity', font: { size: 16, weight: 'bold' }, padding: 20 }
        },
        scales: { y: { beginAtZero: true, ticks: { stepSize: 1 }}}
      }
    });
  },

  generateColors(count) {
    const colors = [
      'rgba(59, 130, 246, 0.8)', 'rgba(34, 197, 94, 0.8)', 'rgba(239, 68, 68, 0.8)',
      'rgba(234, 179, 8, 0.8)', 'rgba(168, 85, 247, 0.8)', 'rgba(236, 72, 153, 0.8)',
      'rgba(20, 184, 166, 0.8)', 'rgba(249, 115, 22, 0.8)', 'rgba(99, 102, 241, 0.8)'
    ];
    while (colors.length < count) colors.push(...colors);
    return colors.slice(0, count);
  },

  filterByCustomer(customer) {
    this.selectedCustomer = customer;
    this.loadPallets();
    this.loadStats();
    this.loadActivity();
    this.render();
  },
setView(view) {
    this.view = view;

    // Always close sidebar after navigation (mobile + desktop)
    this.sidebarOpen = false;

    // Leaving scanner states
    this.scanMode = null;
    this.stopScanner?.();

    this.render();

    if (view === 'dashboard') {
      setTimeout(() => this.initCharts?.(), 100);
    }
  },


  search(term) {
    this.searchTerm = term.toLowerCase();
    this.render();
  },
  render() {
    const appEl = document.getElementById('app');
    if (!appEl) return;

    // Scanner is full-screen modal content
    if (this.scanMode) {
      appEl.innerHTML = this.renderScanner();
      this._postRender();
      return;
    }

    // View content
    const content =
      this.view === 'scan' ? this.renderScan() :
      this.view === 'tracker' ? this.renderTracker() :
      this.view === 'history' ? this.renderHistory() :
      this.view === 'dashboard' ? this.renderDashboard() :
      this.view === 'settings' ? this.renderSettings() :
      this.view === 'location-qrs' ? this.renderLocationQRs() :
      this.view === 'single-qr' ? this.renderSingleQR() :
      '';

    appEl.innerHTML = this.renderShell(content);
    this._postRender();
  },

  _postRender() {
    // Highlight active nav
    this._setActiveNav();

    // Tracker bindings
    if (this.view === 'tracker') {
      const searchInput = document.getElementById('search-input');
      if (searchInput && !searchInput.__wtBound) {
        searchInput.__wtBound = true;
        searchInput.addEventListener('input', (e) => this.search(e.target.value));
      }

      const customerFilter = document.getElementById('customer-filter');
      if (customerFilter) customerFilter.value = this.selectedCustomer || '';
    }

    // History bindings
    if (this.view === 'history') {
      const customerFilter = document.getElementById('history-customer-filter');
      if (customerFilter) customerFilter.value = this.selectedCustomer || '';
    }
  },

  updateConnectionUI(state, text) {
    const dot1 = document.getElementById('wt-dot-inline');
    const dot2 = document.getElementById('wt-dot');
    const t1 = document.getElementById('wt-conn-text');
    const t2 = document.getElementById('wt-status-text');

    [dot1, dot2].forEach((d) => {
      if (!d) return;
      d.classList.remove('is-ok', 'is-warn', 'is-bad');
      d.classList.add(state);
    });

    if (t1) t1.textContent = text;
    if (t2) t2.textContent = text;
  },

  wtToggleSidebar() {
    this.sidebarOpen = !this.sidebarOpen;
    this.render();
  },

  wtCloseSidebar() {
    if (!this.sidebarOpen) return;
    this.sidebarOpen = false;
    this.render();
  },

  _setActiveNav() {
    const ids = ['scan', 'tracker', 'history', 'dashboard', 'settings'];
    ids.forEach((v) => {
      const el = document.getElementById(`wt-nav-${v}`);
      if (!el) return;
      const active = this.view === v;
      el.classList.toggle('is-active', active);
      if (active) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });
  },

  renderShell(contentHtml) {
    const sidebarOpen = !!this.sidebarOpen;

    const navBtn = (id, label) => {
      const active = this.view === id ? ' is-active' : '';
      const current = this.view === id ? ' aria-current="page"' : '';
      return `<button id="wt-nav-${id}" class="wt-nav-btn${active}" onclick="app.setView('${id}')"${current}>${label}</button>`;
    };

    return `
      <div id="wtShell" class="wt-shell ${sidebarOpen ? 'sidebar-open' : ''}">
        <div class="wt-topbar">
          <button class="wt-icon-btn wt-menu-btn" aria-label="Open menu" onclick="app.wtToggleSidebar()">☰</button>

          <div class="wt-topbar-left">
            <div class="wt-brand">
              <span class="wt-brand-emoji">📦</span>
              <div class="wt-brand-text">
                <div class="wt-brand-title">Warehouse Tracker</div>
                <div class="wt-brand-sub">Live inventory • PWA</div>
              </div>
            </div>

            <span class="wt-pill wt-pill-gray" id="wt-conn-pill">
              <span id="wt-dot-inline" class="wt-dot is-warn"></span>
              <span id="wt-conn-text">Connecting…</span>
            </span>
          </div>

          <div class="wt-topbar-right">
            <div class="wt-updated">
              <div class="wt-updated-label">Last updated</div>
              <div class="wt-updated-value" id="wt-last-updated">—</div>
            </div>
          </div>
        </div>

        <div class="wt-body">
          <aside class="wt-sidebar" aria-label="Navigation">
            <div class="wt-sidebar-inner">
              <div class="wt-sidebar-title">Warehouse Tracker</div>
              <div class="wt-sidebar-sub">Live inventory</div>

              <div class="wt-sidebar-nav">
                ${navBtn('scan', '📷 Scan')}
                ${navBtn('tracker', '📋 Tracker')}
                ${navBtn('history', '📜 History')}
                ${navBtn('dashboard', '📊 Dashboard')}
                ${navBtn('settings', '⚙️ Settings')}
              </div>

              <div class="wt-sidebar-sep"></div>

              <div class="wt-sidebar-meta">
                <div class="wt-meta-row">
                  <span class="wt-meta-label">Server</span>
                  <span class="wt-meta-value" id="wt-server-origin">${window.location.origin}</span>
                </div>
                <div class="wt-meta-row">
                  <span class="wt-meta-label">Sync</span>
                  <span class="wt-meta-value" id="wt-status-text">Connecting…</span>
                </div>
              </div>

              <div class="wt-sidebar-footer">
                <div class="wt-pill wt-pill-gray">
                  <span id="wt-dot" class="wt-dot is-warn"></span>
                  <span id="wt-foot-text">Connecting…</span>
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

  
  renderScan() {
  return `
    <div class="fade-in">
      <div class="mx-auto max-w-5xl space-y-6">

        <!-- Header -->
        <div class="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div class="text-sm font-semibold text-slate-600">Scan</div>
            <h2 class="mt-1 text-3xl font-extrabold tracking-tight text-slate-900">
              Quick actions
            </h2>
            <p class="mt-2 text-slate-600">
              Check in, check out, remove units, or enter manually.
            </p>
          </div>

          <div class="flex items-center gap-2">
            <span class="inline-flex items-center rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-700">
              Recommended workflow: Scan → Confirm details
            </span>
          </div>
        </div>

        <!-- Primary actions -->
        <div class="rounded-2xl border border-slate-200 bg-white/80 shadow-sm backdrop-blur">
          <div class="border-b border-slate-200 px-6 py-4">
            <div class="text-sm font-semibold text-slate-800">Pallet operations</div>
            <div class="text-sm text-slate-500">Use the camera or manual entry.</div>
          </div>

          <div class="grid grid-cols-1 gap-4 p-6 sm:grid-cols-2">
            <!-- Check in -->
            <button
              type="button"
              onclick="app.startScanner('checkin-pallet')"
              class="group w-full rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-[1px] hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <div class="flex items-start gap-4">
                <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-700">
                  <span class="text-base font-black">IN</span>
                </div>
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <div class="text-base font-bold text-slate-900">Check in</div>
                    <span class="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                      scan
                    </span>
                  </div>
                  <div class="mt-1 text-sm text-slate-600">
                    Scan pallet QR, then scan a location.
                  </div>
                  <div class="mt-3 text-xs font-semibold text-slate-500 group-hover:text-slate-700">
                    Opens the details prompt after scanning →
                  </div>
                </div>
              </div>
            </button>

            <!-- Check out -->
            <button
              type="button"
              onclick="app.startScanner('checkout')"
              class="group w-full rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-[1px] hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <div class="flex items-start gap-4">
                <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-rose-500/10 text-rose-700">
                  <span class="text-base font-black">OUT</span>
                </div>
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <div class="text-base font-bold text-slate-900">Check out</div>
                    <span class="rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-semibold text-rose-700">
                      remove
                    </span>
                  </div>
                  <div class="mt-1 text-sm text-slate-600">
                    Remove an entire pallet entry from inventory.
                  </div>
                  <div class="mt-3 text-xs font-semibold text-slate-500 group-hover:text-slate-700">
                    Requires pallet QR →
                  </div>
                </div>
              </div>
            </button>

            <!-- Remove units -->
            <button
              type="button"
              onclick="app.startScanner('checkout-units')"
              class="group w-full rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-[1px] hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <div class="flex items-start gap-4">
                <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/10 text-amber-800">
                  <span class="text-lg font-black">−</span>
                </div>
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <div class="text-base font-bold text-slate-900">Remove units</div>
                    <span class="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                      partial
                    </span>
                  </div>
                  <div class="mt-1 text-sm text-slate-600">
                    Scan a pallet and remove some units.
                  </div>
                  <div class="mt-3 text-xs font-semibold text-slate-500 group-hover:text-slate-700">
                    For unit-tracked pallets →
                  </div>
                </div>
              </div>
            </button>

            <!-- Manual entry -->
            <button
              type="button"
              onclick="app.showManualEntry()"
              class="group w-full rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-[1px] hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <div class="flex items-start gap-4">
                <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-500/10 text-blue-700">
                  <span class="text-lg font-black">✎</span>
                </div>
                <div class="min-w-0">
                  <div class="text-base font-bold text-slate-900">Manual entry</div>
                  <div class="mt-1 text-sm text-slate-600">
                    Enter customer, product, quantities, and location.
                  </div>
                  <div class="mt-3 text-xs font-semibold text-slate-500 group-hover:text-slate-700">
                    We’ll add “Parts list” here next →
                  </div>
                </div>
              </div>
            </button>
          </div>
        </div>

        <!-- QR tools (secondary) -->
        <div class="rounded-2xl border border-slate-200 bg-white/80 shadow-sm backdrop-blur">
          <div class="border-b border-slate-200 px-6 py-4">
            <div class="text-sm font-semibold text-slate-800">QR tools</div>
            <div class="text-sm text-slate-500">Generate printable labels.</div>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-3 px-6 py-5">
            <div class="text-sm text-slate-600">
              Use these when you need new pallet labels or full location label sets.
            </div>

            <div class="flex flex-wrap gap-3">
              <button
                type="button"
                onclick="app.generatePalletQR()"
                class="rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                Generate pallet QR
              </button>

              <button
                type="button"
                onclick="app.generateLocationQRs()"
                class="rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-900 shadow-sm hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                Location QR codes
              </button>
            </div>
          </div>
        </div>

      </div>
    </div>
  `;
},

  renderScanner() {
    const message = this.scanMode === 'checkin-pallet' ? 'Scan Pallet QR Code' :
                   this.scanMode === 'checkin-location' ? 'Scan Location QR Code' :
                   this.scanMode === 'checkout' ? 'Scan Pallet to Check Out' :
                   this.scanMode === 'checkout-units' ? 'Scan Pallet to Check Out Units' : '';
    
    return `
      <div class="fixed inset-0 bg-black bg-opacity-90 z-50 flex items-center justify-center">
        <div class="bg-white rounded-2xl p-6 max-w-lg w-full mx-4">
          <div class="flex justify-between items-center mb-4">
            <h3 class="text-2xl font-bold text-gray-900">${message}</h3>
            <button 
              onclick="app.stopScanner(); app.scanMode = null; app.render();" 
              class="text-gray-500 hover:text-gray-700 text-3xl"
            >
              ×
            </button>
          </div>
          <div id="qr-reader" class="rounded-lg overflow-hidden shadow-lg"></div>
          <button 
            onclick="app.stopScanner(); app.scanMode = null; app.render();" 
            class="mt-4 w-full bg-gray-500 text-white p-3 rounded-lg font-semibold hover:bg-gray-600"
          >
            Cancel
          </button>
        </div>
      </div>
    `;
  },
  
  renderLocationQRs() {
    const aisles = this.locations.reduce((acc, loc) => {
      if (!acc.includes(loc.aisle)) acc.push(loc.aisle);
      return acc;
    }, []).sort();
    
    return `
      <div class="space-y-6">
        <div class="flex justify-between items-center print:hidden">
          <h2 class="text-3xl font-bold text-gray-900">Location QR Codes</h2>
          <div class="flex gap-3">
            <button onclick="app.printQRCodes()" class="bg-blue-600 text-white px-6 py-3 rounded-xl font-semibold hover:bg-blue-700 shadow-lg">
              🖨️ Print All
            </button>
            <button onclick="app.setView('scan')" class="bg-gray-500 text-white px-6 py-3 rounded-xl font-semibold hover:bg-gray-600 shadow-lg">
              ← Back
            </button>
          </div>
        </div>
        
        ${aisles.map(aisle => `
          <div class="print:break-after-page">
            <h3 class="text-2xl font-bold text-gray-900 mb-4 print:text-3xl">Aisle ${aisle}</h3>
            <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 print:grid-cols-6 print:gap-2">
              ${this.locations.filter(l => l.aisle === aisle).map(loc => `
                <div class="bg-white p-4 rounded-xl shadow-lg border-2 border-gray-200 text-center print:p-0 print:border">
                  <div id="qr-${loc.id}" class="mb-2 flex justify-center"></div>
                  <p class="font-bold text-lg text-gray-900 print:text-xs">${loc.id}</p>
                </div>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  },
  
  renderSingleQR() {
    const p = this.tempPallet;
    return `
      <div class="max-w-2xl mx-auto space-y-6">
        <div class="flex justify-between items-center print:hidden">
          <h2 class="text-3xl font-bold text-gray-900">Pallet QR Code</h2>
          <div class="flex gap-3">
            <button onclick="window.print()" class="bg-blue-600 text-white px-6 py-3 rounded-xl font-semibold hover:bg-blue-700 shadow-lg">
              🖨️ Print
            </button>
            <button onclick="app.setView('scan')" class="bg-gray-500 text-white px-6 py-3 rounded-xl font-semibold hover:bg-gray-600 shadow-lg">
              ← Back
            </button>
          </div>
        </div>
        
        <div class="bg-white p-8 rounded-2xl shadow-2xl border-2 border-gray-200 text-center">
          <div id="single-qr-canvas" class="flex justify-center mb-6"></div>
          <h3 class="text-3xl font-bold text-gray-900 mb-2">${p.id}</h3>
          <div class="space-y-2 text-lg text-gray-700">
            <p><strong>Customer:</strong> ${p.customer}</p>
            ${p.product ? `<p><strong>Product:</strong> ${p.product}</p>` : ''}
            <p><strong>Pallets:</strong> ${p.palletQty}</p>
            ${p.productQty > 0 ? `<p><strong>Units/Pallet:</strong> ${p.productQty}</p>` : ''}
          </div>
        </div>
      </div>
    `;
  },
  
  renderDashboard() {
    const last24h = this.activityLog.filter(a => {
      const activityDate = new Date(a.timestamp);
      const now = new Date();
      return (now - activityDate) < 24 * 60 * 60 * 1000;
    }).length;
    
    const customerCounts = {};
    this.pallets.forEach(p => {
      customerCounts[p.customer_name] = (customerCounts[p.customer_name] || 0) + 1;
    });
    const topCustomers = Object.entries(customerCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    
    const aisleCounts = {};
    this.pallets.forEach(p => {
      const aisle = p.location.charAt(0);
      aisleCounts[aisle] = (aisleCounts[aisle] || 0) + 1;
    });
    const topLocations = Object.entries(aisleCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    
    const utilizationRate = this.stats.total_locations > 0 
      ? Math.round((this.stats.occupied_locations / this.stats.total_locations) * 100) 
      : 0;
    
    const avgPalletsPerEntry = this.pallets.length > 0 
      ? (this.pallets.reduce((sum, p) => sum + p.pallet_quantity, 0) / this.pallets.length).toFixed(1)
      : '0';
    
    return `
      <div class="space-y-6 fade-in">
        <div>
          <h2 class="text-3xl font-bold text-gray-900 mb-2">📊 Dashboard</h2>
          <p class="text-gray-600">Real-time warehouse analytics and insights</p>
        </div>
        
        <!-- Stats Cards -->
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <div class="bg-gradient-to-br from-blue-500 to-blue-600 text-white p-6 rounded-xl shadow-lg">
            <div class="flex justify-between items-start">
              <div>
                <p class="text-blue-100 text-sm font-semibold">Total Pallets</p>
                <h3 class="text-4xl font-bold mt-2">${this.stats.total_pallets || 0}</h3>
              </div>
              <div class="text-5xl opacity-50">📦</div>
            </div>
          </div>
          
          <div class="bg-gradient-to-br from-green-500 to-green-600 text-white p-6 rounded-xl shadow-lg">
            <div class="flex justify-between items-start">
              <div>
                <p class="text-green-100 text-sm font-semibold">Inventory Entries</p>
                <h3 class="text-4xl font-bold mt-2">${this.pallets.length}</h3>
              </div>
              <div class="text-5xl opacity-50">📊</div>
            </div>
          </div>
          
          <div class="bg-gradient-to-br from-purple-500 to-purple-600 text-white p-6 rounded-xl shadow-lg">
            <div class="flex justify-between items-start">
              <div>
                <p class="text-purple-100 text-sm font-semibold">Space Used</p>
                <h3 class="text-4xl font-bold mt-2">${utilizationRate}%</h3>
              </div>
              <div class="text-5xl opacity-50">📍</div>
            </div>
          </div>
          
          <div class="bg-gradient-to-br from-orange-500 to-orange-600 text-white p-6 rounded-xl shadow-lg">
            <div class="flex justify-between items-start">
              <div>
                <p class="text-orange-100 text-sm font-semibold">24h Activity</p>
                <h3 class="text-4xl font-bold mt-2">${last24h}</h3>
              </div>
              <div class="text-5xl opacity-50">⚡</div>
            </div>
          </div>
        </div>
        
        <!-- Charts Row -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div class="bg-white p-6 rounded-xl shadow-lg border border-gray-200">
            <div style="height: 300px;">
              <canvas id="customerChart"></canvas>
            </div>
          </div>
          
          <div class="bg-white p-6 rounded-xl shadow-lg border border-gray-200">
            <div style="height: 300px;">
              <canvas id="locationChart"></canvas>
            </div>
          </div>
        </div>
        
        <!-- Activity Chart -->
        <div class="bg-white p-6 rounded-xl shadow-lg border border-gray-200">
          <div style="height: 300px;">
            <canvas id="activityChart"></canvas>
          </div>
        </div>
        
        <!-- Top Lists -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <!-- Top Customers -->
          <div class="bg-white p-6 rounded-xl shadow-lg border border-gray-200">
            <h3 class="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
              <span class="text-2xl">👥</span> Top Customers
            </h3>
            <div class="space-y-3">
              ${topCustomers.length === 0 ? 
                '<p class="text-gray-500 text-center py-8">No customer data yet</p>' :
                topCustomers.map((c, i) => `
                  <div class="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <div class="flex items-center gap-3">
                      <div class="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold">
                        ${i + 1}
                      </div>
                      <span class="font-semibold text-gray-900">${c[0]}</span>
                    </div>
                    <span class="bg-blue-100 text-blue-700 px-3 py-1 rounded-full font-bold text-sm">
                      ${c[1]} pallets
                    </span>
                  </div>
                `).join('')
              }
            </div>
          </div>
          
          <!-- Busiest Aisles -->
          <div class="bg-white p-6 rounded-xl shadow-lg border border-gray-200">
            <h3 class="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
              <span class="text-2xl">📍</span> Busiest Aisles
            </h3>
            <div class="space-y-3">
              ${topLocations.length === 0 ? 
                '<p class="text-gray-500 text-center py-8">No location data yet</p>' :
                topLocations.map((l, i) => `
                  <div class="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <div class="flex items-center gap-3">
                      <div class="w-8 h-8 rounded-full bg-purple-600 text-white flex items-center justify-center font-bold">
                        ${i + 1}
                      </div>
                      <span class="font-semibold text-gray-900">Aisle ${l[0]}</span>
                    </div>
                    <span class="bg-purple-100 text-purple-700 px-3 py-1 rounded-full font-bold text-sm">
                      ${l[1]} pallets
                    </span>
                  </div>
                `).join('')
              }
            </div>
          </div>
        </div>
        
        <!-- Summary Stats -->
        <div class="bg-gradient-to-r from-gray-50 to-gray-100 p-6 rounded-xl border border-gray-200">
          <h3 class="text-xl font-bold text-gray-900 mb-4">📈 Summary Statistics</h3>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div class="text-center">
              <p class="text-gray-600 text-sm font-semibold">Avg Pallets/Entry</p>
              <p class="text-3xl font-bold text-gray-900 mt-1">${avgPalletsPerEntry}</p>
            </div>
            <div class="text-center">
              <p class="text-gray-600 text-sm font-semibold">Active Customers</p>
              <p class="text-3xl font-bold text-gray-900 mt-1">${this.customers.length}</p>
            </div>
            <div class="text-center">
              <p class="text-gray-600 text-sm font-semibold">Available Spaces</p>
              <p class="text-3xl font-bold text-gray-900 mt-1">${this.stats.total_locations - this.stats.occupied_locations}</p>
            </div>
            <div class="text-center">
              <p class="text-gray-600 text-sm font-semibold">Inventory Entries</p>
              <p class="text-3xl font-bold text-gray-900 mt-1">${this.pallets.length}</p>
            </div>
          </div>
        </div>
      </div>
    `;
  },
  
  renderSettings() {
    return `
      <div class="max-w-2xl mx-auto space-y-6">
        <div>
          <h2 class="text-3xl font-bold text-gray-900 flex items-center gap-3 mb-2">
            ⚙️ Settings
          </h2>
          <p class="text-gray-600">Configure Google Sheets integration and other options</p>
        </div>
        
        <!-- Google Sheets Integration -->
        <div class="bg-white p-6 rounded-xl shadow-lg border border-gray-200">
          <div class="flex items-start gap-4 mb-4">
            <div class="text-4xl">📊</div>
            <div class="flex-1">
              <h3 class="text-xl font-bold text-gray-900 mb-2">Google Sheets Integration</h3>
              <p class="text-gray-600 text-sm mb-4">
                Automatically sync inventory to Google Sheets for customer access
              </p>
              
              <div class="space-y-3">
                <div>
                  <label class="block text-sm font-semibold text-gray-700 mb-2">
                    Google Apps Script Web App URL
                  </label>
                  <input 
                    type="text" 
                    id="google-sheets-url"
                    value="${this.googleSheetsUrl}"
                    placeholder="https://script.google.com/macros/s/..."
                    class="w-full border-2 border-gray-300 p-3 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
                    oninput="app.saveGoogleSheetsUrl(this.value)"
                    onblur="app.saveGoogleSheetsUrl(this.value)"
                  />
                  <p class="text-xs text-gray-500 mt-2">
                    Paste the Web App URL from your Google Apps Script deployment
                  </p>
                </div>
                
                <div class="flex gap-2">
                  <button 
                    onclick="app.testGoogleSheetsConnection()" 
                    class="bg-gray-500 text-white px-4 py-2 rounded-lg font-semibold hover:bg-gray-600 text-sm"
                  >
                    Test Connection
                  </button>
                  <button 
                    onclick="app.syncAllToGoogleSheets()" 
                    class="bg-blue-600 text-white px-4 py-2 rounded-lg font-semibold hover:bg-blue-700 text-sm flex items-center gap-2"
                  >
                    <span>🔄</span> Smart Sync (Add Missing Items)
                  </button>
                </div>
                
                <div class="bg-blue-50 border border-blue-200 p-3 rounded-lg text-sm text-blue-800">
                  <p class="font-semibold mb-1">ℹ️ About Smart Sync</p>
                  <p>Adds any missing pallets to Google Sheets and updates quantities. <strong>Removal history is preserved.</strong></p>
                  <p class="mt-1 text-xs">Use this if you notice pallets missing from sheets or quantities are out of sync.</p>
                </div>
                
                ${this.googleSheetsUrl ? `
                  <div class="bg-green-50 border border-green-200 p-3 rounded-lg">
                    <p class="text-sm text-green-800 flex items-center gap-2">
                      <span class="text-lg">✓</span> 
                      Auto-sync is <strong>enabled</strong> - Changes sync automatically
                    </p>
                  </div>
                ` : `
                  <div class="bg-yellow-50 border border-yellow-200 p-3 rounded-lg">
                    <p class="text-sm text-yellow-800 flex items-center gap-2">
                      <span class="text-lg">⚠</span> 
                      Auto-sync is <strong>disabled</strong> - Enter URL above to enable
                    </p>
                  </div>
                `}
              </div>
            </div>
          </div>
        </div>
        
        <!-- About -->
        <div class="bg-gray-50 p-6 rounded-xl border border-gray-200">
          <h3 class="text-lg font-bold text-gray-900 mb-2">About Warehouse Tracker</h3>
          <p class="text-sm text-gray-600">
            Version 2.0 - Enhanced with multi-part tracking and partial unit removal<br>
            Built with modern web technologies for efficient warehouse management
          </p>
        </div>
      </div>
    `;
  },
  
  renderTracker() {
    let pallets = this.pallets;

    if (this.searchTerm) {
      pallets = pallets.filter(p =>
        (p.product_id || '').toLowerCase().includes(this.searchTerm) ||
        (p.location || '').toLowerCase().includes(this.searchTerm) ||
        (p.customer_name || '').toLowerCase().includes(this.searchTerm)
      );
    }

    const rows = pallets.map(p => {
      const palletsQty = Number(p.pallet_quantity) || 0;
      const unitsPerPallet = Number(p.product_quantity) || 0;
      const totalUnits = unitsPerPallet > 0 ? (p.current_units ?? (palletsQty * unitsPerPallet)) : '';
      const added = p.date_added ? new Date(p.date_added).toLocaleDateString() : '';
      const partsCount = Array.isArray(p.parts) ? p.parts.length : 0;

      return `
        <tr class="wt-row">
          <td class="wt-cell wt-strong">
            ${p.product_id || ''}
            ${partsCount ? `<span class="wt-pill wt-pill-gray" title="Parts list attached">📋 ${partsCount}</span>` : ''}
          </td>
          <td class="wt-cell wt-link">${p.customer_name || ''}</td>
          <td class="wt-cell">${p.location || ''}</td>
          <td class="wt-cell wt-num">${palletsQty}</td>
          <td class="wt-cell wt-num">${unitsPerPallet || ''}</td>
          <td class="wt-cell wt-num">${totalUnits}</td>
          <td class="wt-cell">${added}</td>
          <td class="wt-cell wt-actions">
            <button onclick="app.reprintPalletQR('${p.id}')" class="wt-btn wt-btn-purple">🖨️ Reprint</button>
            ${unitsPerPallet > 0 ? `<button onclick="app.removePartialUnits('${p.id}')" class="wt-btn wt-btn-yellow">📦 Remove Units</button>` : ''}
            <button onclick="app.showProductInfo('${p.id}')" class="wt-btn wt-btn-blue">ℹ️ Info</button>
          </td>
        </tr>
      `;
    }).join('');

    return `
      <div class="space-y-6 fade-in">
        <div>
          <h2 class="text-3xl font-bold text-gray-900 mb-2">📋 Inventory Tracker</h2>
          <p class="text-gray-600">Table view of all pallets</p>
        </div>

        <div class="flex gap-3 flex-wrap items-center">
          ${this.customers.length > 0 ? `
            <select
              id="customer-filter"
              class="border-2 border-gray-300 p-3 rounded-xl text-base bg-white font-semibold focus:ring-2 focus:ring-blue-500 focus:border-blue-500 shadow-sm"
              onchange="app.filterByCustomer(this.value)"
            >
              <option value="">All Customers</option>
              ${this.customers.map(customer => `
                <option value="${customer}" ${this.selectedCustomer === customer ? 'selected' : ''}>
                  ${customer}
                </option>
              `).join('')}
            </select>
          ` : ''}

          <input
            id="search-input"
            type="text"
            placeholder="🔍 Search product, location, customer..."
            value="${this.searchTerm}"
            class="flex-1 min-w-[260px] border-2 border-gray-300 p-3 rounded-xl text-base focus:ring-2 focus:ring-blue-500 focus:border-blue-500 shadow-sm"
          />

          <a href="${API_URL}/api/export${this.selectedCustomer ? '?customer=' + encodeURIComponent(this.selectedCustomer) : ''}" download
            class="bg-blue-600 text-white px-6 py-3 rounded-xl flex items-center whitespace-nowrap font-semibold hover:bg-blue-700 shadow-lg">
            ⬇ Export CSV
          </a>
        </div>

        ${this.selectedCustomer ? `
          <div class="bg-blue-50 border-l-4 border-blue-500 px-5 py-3 rounded-r-xl shadow-sm">
            <p class="text-sm text-blue-800">
              <strong class="font-bold">${pallets.length} pallet(s)</strong> for <strong class="font-bold">${this.selectedCustomer}</strong>
            </p>
          </div>
        ` : ''}

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
              ${rows || `
                <tr><td class="wt-cell" colspan="8">
                  <div class="text-center text-gray-500 py-10">
                    <div class="text-5xl mb-3">📦</div>
                    <div class="text-lg font-semibold">No pallets found</div>
                    <p class="text-gray-400">${this.selectedCustomer ? `No inventory for ${this.selectedCustomer}` : 'Start by checking in a pallet'}</p>
                  </div>
                </td></tr>
              `}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  
  renderHistory() {
    const getActionBadge = (action) => {
      if (action === 'CHECK_IN') return '<span class="bg-green-100 text-green-800 px-3 py-1 rounded-full text-xs font-bold">✓ Check In</span>';
      if (action === 'CHECK_OUT') return '<span class="bg-red-100 text-red-800 px-3 py-1 rounded-full text-xs font-bold">✗ Check Out</span>';
      if (action === 'PARTIAL_REMOVE') return '<span class="bg-orange-100 text-orange-800 px-3 py-1 rounded-full text-xs font-bold">↓ Partial Remove</span>';
      if (action === 'UNITS_REMOVE') return '<span class="bg-yellow-100 text-yellow-800 px-3 py-1 rounded-full text-xs font-bold">📦 Units Remove</span>';
      return action;
    };
    
    return `
      <div class="mb-6">
        <div class="flex justify-between items-center mb-4 flex-wrap gap-3">
          <div>
            <h2 class="text-2xl font-bold text-gray-900 flex items-center gap-2">
              📜 Activity History
            </h2>
            <p class="text-sm text-gray-600 mt-1">Last 100 activities</p>
          </div>
          
          ${this.customers.length > 0 ? `
            <select 
              id="history-customer-filter"
              class="border-2 border-gray-300 p-3 rounded-xl text-sm bg-white font-semibold focus:ring-2 focus:ring-blue-500 focus:border-blue-500 shadow-sm"
              onchange="app.filterByCustomer(this.value)"
            >
              <option value="">All Customers</option>
              ${this.customers.map(customer => `
                <option value="${customer}" ${this.selectedCustomer === customer ? 'selected' : ''}>
                  ${customer}
                </option>
              `).join('')}
            </select>
          ` : ''}
        </div>
        
        ${this.selectedCustomer ? `
          <div class="bg-blue-50 border-l-4 border-blue-500 px-5 py-3 rounded-r-xl shadow-sm">
            <p class="text-sm text-blue-800">
              Showing activity for <strong class="font-bold">${this.selectedCustomer}</strong>
              <button onclick="app.filterByCustomer('')" class="ml-3 underline font-semibold hover:text-blue-600">Clear Filter</button>
            </p>
          </div>
        ` : ''}
      </div>
      
      <div class="space-y-3">
        ${this.activityLog.length === 0 ? 
          `<div class="text-center text-gray-500 py-16">
            <div class="text-6xl mb-4">📋</div>
            <div class="text-xl font-semibold mb-2">No activity yet</div>
            <p class="text-gray-400">${this.selectedCustomer ? `No activity for ${this.selectedCustomer}` : 'Activity will appear here after check-ins/check-outs'}</p>
          </div>` :
          this.activityLog.map(a => `
            <div class="bg-white p-5 rounded-xl shadow-sm card-hover border border-gray-100">
              <div class="flex justify-between items-start mb-3">
                <div class="flex-1">
                  <h3 class="font-bold text-lg text-gray-900">${a.product_id}</h3>
                  <p class="text-blue-600 font-semibold text-sm mt-1 flex items-center gap-2">
                    <span>👤</span> ${a.customer_name}
                  </p>
                </div>
                ${getActionBadge(a.action)}
              </div>
              
              <div class="grid grid-cols-2 gap-3 text-sm mt-4">
                <div class="bg-gray-50 p-2 rounded-lg">
                  <span class="text-gray-600 text-xs">Location:</span>
                  <span class="font-semibold ml-2 text-gray-900">${a.location}</span>
                </div>
                ${a.action === 'PARTIAL_REMOVE' || a.action === 'CHECK_OUT' || a.action === 'UNITS_REMOVE' ? `
                  <div class="bg-red-50 p-2 rounded-lg">
                    <span class="text-gray-600 text-xs">Removed:</span>
                    <span class="font-bold ml-2 text-red-600">${a.quantity_changed}</span>
                  </div>
                ` : ''}
                ${a.action === 'PARTIAL_REMOVE' || a.action === 'UNITS_REMOVE' ? `
                  <div class="bg-gray-50 p-2 rounded-lg">
                    <span class="text-gray-600 text-xs">Before:</span>
                    <span class="font-semibold ml-2">${a.quantity_before}</span>
                  </div>
                  <div class="bg-gray-50 p-2 rounded-lg">
                    <span class="text-gray-600 text-xs">After:</span>
                    <span class="font-semibold ml-2">${a.quantity_after}</span>
                  </div>
                ` : ''}
                ${a.action === 'CHECK_IN' ? `
                  <div class="bg-green-50 p-2 rounded-lg">
                    <span class="text-gray-600 text-xs">Quantity:</span>
                    <span class="font-bold ml-2 text-green-600">${a.quantity_after}</span>
                  </div>
                ` : ''}
              </div>
              
              ${a.notes ? `
                <div class="mt-3 p-3 bg-gray-50 rounded-lg">
                  <p class="text-xs text-gray-600 italic">${a.notes}</p>
                </div>
              ` : ''}
              
              <p class="text-xs text-gray-400 mt-3 flex items-center gap-2">
                <span>📅</span> ${new Date(a.timestamp).toLocaleString()}
              </p>
            </div>
          `).join('')
        }
      </div>
    `;
  }
};
// Make sure inline onclick="app.xxx()" works
window.app = app;

// Boot once DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  try {
    if (typeof app.init === "function") app.init();
    else if (typeof app.render === "function") app.render();
  } catch (e) {
    console.error("App boot error:", e);
  }
});

// Initialize app
app.init();

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  app.stopAutoRefresh();
});

// Also cleanup on page hide (mobile browsers)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    console.log('Page hidden - pausing auto-refresh');
  } else {
    console.log('Page visible - resuming auto-refresh');
    app.startAutoRefresh();
  }
});
})();
