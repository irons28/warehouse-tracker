const API_URL = window.location.origin;

const app = {
  view: 'scan',
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
  googleSheetsUrl: localStorage.getItem('googleSheetsUrl') || '',
  
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
      const container = document.getElementById('modal-container');
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      const modal = document.createElement('div');
      modal.className = 'modal';
      modal.innerHTML = `
        <div class="p-6">
          <h3 class="text-xl font-bold mb-4">${title}</h3>
          <div class="mb-6">${content}</div>
          <div class="flex gap-2 justify-end">
            ${buttons.map((btn, i) => `
              <button onclick="app.closeModal(${i})" class="px-4 py-2 rounded-lg font-semibold ${btn.primary ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}">
                ${btn.text}
              </button>
            `).join('')}
          </div>
        </div>
      `;
      container.appendChild(backdrop);
      container.appendChild(modal);
      window.modalResolve = resolve;
      window.modalButtons = buttons;
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
        if (input) {
          input.focus();
        }
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
      this.render();
    } catch (e) {
      this.showToast('Error loading data. Please refresh the page.', 'error');
    } finally {
      this.setLoading(false);
    }
  },
  
  async loadPallets() {
    try {
      let url = `${API_URL}/api/pallets`;
      if (this.selectedCustomer) {
        url += `?customer=${encodeURIComponent(this.selectedCustomer)}`;
      }
      // Add timestamp to prevent caching
      url += (url.includes('?') ? '&' : '?') + '_t=' + Date.now();
      
      console.log('Loading pallets from:', url);
      const res = await fetch(url, {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      });
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      
      this.pallets = await res.json();
      console.log('Loaded pallets:', this.pallets.length, 'pallets');
      
      // Log the specific pallet quantities for debugging
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
      const res = await fetch(url);
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
      const res = await fetch(url);
      this.activityLog = await res.json();
    } catch (e) {
      console.error('Error loading activity:', e);
      throw e;
    }
  },
  
  // ENHANCED: Check in with support for multiple parts per pallet
  async checkIn(customerName, productId, palletQuantity, productQuantity, location, parts = null) {
    this.setLoading(true);
    try {
      const payload = { 
        customer_name: customerName, 
        product_id: productId, 
        pallet_quantity: palletQuantity,
        product_quantity: productQuantity,
        location 
      };
      
      // Add parts list if provided
      if (parts) {
        payload.parts = parts;
      }
      
      const res = await fetch(`${API_URL}/api/pallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      this.showToast(data.message || 'Pallet checked in successfully!', 'success');
      
      if (this.googleSheetsUrl) {
        await this.syncToGoogleSheets('add_pallet', {
          customer_name: customerName,
          product_id: productId,
          pallet_quantity: palletQuantity,
          product_quantity: productQuantity,
          location: location,
          parts: parts,
          date_added: new Date().toISOString()
        });
      }
      
      await this.loadCustomers();
      await this.loadPallets();
      await this.loadStats();
      await this.loadActivity();
      this.render();
    } catch (e) {
      this.showToast('Error checking in pallet', 'error');
      console.error(e);
    } finally {
      this.setLoading(false);
    }
  },
  
  async checkOut(palletId) {
    const confirmed = await this.confirm('Remove Pallet', 'Are you sure you want to remove this entire pallet from inventory?');
    if (!confirmed) return;
    
    const pallet = this.pallets.find(p => p.id === palletId);
    
    this.setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/pallets/${palletId}`, { method: 'DELETE' });
      const data = await res.json();
      this.showToast(data.message || 'Pallet checked out successfully!', 'success');
      
      if (this.googleSheetsUrl && pallet) {
        await this.syncToGoogleSheets('remove_pallet', {
          customer_name: pallet.customer_name,
          product_id: pallet.product_id,
          location: pallet.location
        });
      }
      
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
  async removePartialQuantity(palletId) {
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
    
    const qtyToRemove = await this.prompt(
      'Remove Pallets',
      `Current pallet quantity: <strong>${pallet.pallet_quantity}</strong><br><br>How many pallets to remove?`,
      '1'
    );
    
    if (qtyToRemove === null) return;
    
    const qty = parseInt(qtyToRemove);
    if (isNaN(qty) || qty <= 0) {
      this.showToast('Please enter a valid quantity', 'error');
      return;
    }
    
    if (qty > pallet.pallet_quantity) {
      this.showToast(`Cannot remove ${qty} pallets. Only ${pallet.pallet_quantity} available.`, 'error');
      return;
    }
    
    this.setLoading(true);
    try {
      console.log('===== STARTING PALLET REMOVAL =====');
      console.log('Removing pallets:', qty, 'from pallet:', pallet.id);
      const res = await fetch(`${API_URL}/api/pallets/${palletId}/remove-quantity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity_to_remove: qty })
      });
      
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Server error');
      }
      
      const data = await res.json();
      console.log('===== SERVER RESPONSE =====');
      console.log('Full response:', data);
      this.showToast(data.message || 'Pallets removed successfully!', 'success');
      
      if (this.googleSheetsUrl) {
        console.log('===== SYNCING TO GOOGLE SHEETS =====');
        const newQuantity = pallet.pallet_quantity - qty;
        if (newQuantity === 0) {
          await this.syncToGoogleSheets('remove_pallet', {
            customer_name: pallet.customer_name,
            product_id: pallet.product_id,
            location: pallet.location
          });
        } else {
          await this.syncToGoogleSheets('update_quantity', {
            customer_name: pallet.customer_name,
            product_id: pallet.product_id,
            location: pallet.location,
            new_quantity: newQuantity
          });
        }
        console.log('Google Sheets sync complete');
      }
      
      // Reload data with cache busting
      console.log('===== RELOADING DATA =====');
      console.log('Waiting 200ms for database to settle...');
      await new Promise(resolve => setTimeout(resolve, 200));
      
      console.log('Clearing cached data...');
      this.pallets = [];
      
      console.log('Fetching fresh data...');
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
  async removePartialUnits(palletId) {
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
    
    const unitsToRemove = await this.prompt(
      'Remove Units',
      `<div class="space-y-2">
        <p><strong>Original Capacity:</strong> ${pallet.product_quantity} units/pallet</p>
        <p><strong>Current Units:</strong> ${currentUnits} units (${pallet.pallet_quantity} pallet${pallet.pallet_quantity > 1 ? 's' : ''})</p>
        <p class="font-bold text-lg">Available: ${totalUnits} total units</p>
      </div>
      <p class="mt-3">How many units to remove?</p>`,
      '1'
    );
    
    if (unitsToRemove === null) return;
    
    const units = parseInt(unitsToRemove);
    if (isNaN(units) || units <= 0) {
      this.showToast('Please enter a valid quantity', 'error');
      return;
    }
    
    if (units > totalUnits) {
      this.showToast(`Cannot remove ${units} units. Only ${totalUnits} available.`, 'error');
      return;
    }
    
    this.setLoading(true);
    try {
      console.log('===== STARTING UNIT REMOVAL =====');
      console.log('Removing units:', units, 'from pallet:', pallet.id);
      
      const res = await fetch(`${API_URL}/api/pallets/${pallet.id}/remove-units`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ units_to_remove: units })
      });
      
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Server error');
      }
      
      const data = await res.json();
      console.log('===== SERVER RESPONSE =====');
      console.log('Full response:', data);
      console.log('Updated pallet should be:', data.updated_pallet);
      
      // Sync to Google Sheets
      if (this.googleSheetsUrl) {
        console.log('===== SYNCING TO GOOGLE SHEETS =====');
        const newPalletQty = data.pallets_remaining;
        if (newPalletQty === 0) {
          await this.syncToGoogleSheets('remove_pallet', {
            customer_name: pallet.customer_name,
            product_id: pallet.product_id,
            location: pallet.location
          });
        } else {
          await this.syncToGoogleSheets('units_remove', {
            customer_name: pallet.customer_name,
            product_id: pallet.product_id,
            location: pallet.location,
            units_removed: units,
            new_pallet_quantity: newPalletQty,
            units_per_pallet: pallet.product_quantity
          });
        }
        console.log('Google Sheets sync complete');
      }
      
      // Show success message
      this.showToast(data.message || 'Units removed successfully!', 'success');
      
      // Force reload with delay and cache busting
      console.log('===== RELOADING DATA =====');
      console.log('Waiting 200ms for database to settle...');
      await new Promise(resolve => setTimeout(resolve, 200));
      
      console.log('Clearing cached data...');
      this.pallets = []; // Clear cache
      
      console.log('Fetching fresh data...');
      await Promise.all([
        this.loadPallets(),
        this.loadStats(),
        this.loadActivity()
      ]);
      
      console.log('===== DATA RELOADED =====');
      console.log('Total pallets loaded:', this.pallets.length);
      console.log('All pallet data:', this.pallets.map(p => ({
        id: p.id,
        product_id: p.product_id,
        pallet_qty: p.pallet_quantity,
        product_qty: p.product_quantity,
        total_units: p.pallet_quantity * p.product_quantity
      })));
      
      // Find the updated pallet
      const updatedPallet = this.pallets.find(p => p.id === pallet.id);
      if (updatedPallet) {
        console.log('===== FOUND UPDATED PALLET =====');
        console.log('Updated pallet data:', {
          id: updatedPallet.id,
          product_id: updatedPallet.product_id,
          pallet_quantity: updatedPallet.pallet_quantity,
          product_quantity: updatedPallet.product_quantity,
          total_units: updatedPallet.pallet_quantity * updatedPallet.product_quantity
        });
      } else {
        console.log('===== PALLET REMOVED FROM INVENTORY =====');
        console.log('Pallet', pallet.id, 'is no longer in active inventory (quantity reached 0)');
      }
      
      // Force re-render
      console.log('===== FORCING RE-RENDER =====');
      this.render();
      console.log('===== RENDER COMPLETE =====');
      
    } catch (e) {
      console.error('===== ERROR REMOVING UNITS =====', e);
      this.showToast('Error removing units: ' + e.message, 'error');
    } finally {
      this.setLoading(false);
    }
  },
  
  // NEW: Show detailed product information including removal history
  async showProductInfo(palletId) {
    const pallet = this.pallets.find(p => p.id === palletId);
    if (!pallet) {
      this.showToast('Pallet not found', 'error');
      return;
    }
    
    // Get removal history for this pallet from activity log
    const removalHistory = this.activityLog.filter(a => 
      a.product_id === pallet.product_id && 
      a.location === pallet.location &&
      (a.action === 'PARTIAL_REMOVE' || a.action === 'UNITS_REMOVE')
    );
    
    const totalUnits = pallet.pallet_quantity * pallet.product_quantity;
    
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
                <span class="text-gray-600">Total Units:</span>
                <span class="font-bold ml-2 text-blue-600">${totalUnits}</span>
              </div>
            ` : ''}
            <div class="col-span-2">
              <span class="text-gray-600">Date Added:</span>
              <span class="font-semibold ml-2">${new Date(pallet.date_added).toLocaleString()}</span>
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
                    <span class="text-xs text-gray-500">${new Date(r.timestamp).toLocaleDateString()}</span>
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
            (errorMessage) => {}
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
    if (this.scanMode === 'checkin-pallet') {
      this.tempPallet = code;
      this.stopScanner();
      this.showToast('Pallet scanned! Now scan location...', 'success');
      setTimeout(() => {
        this.scanMode = 'checkin-location';
        this.startScanner('checkin-location');
      }, 500);
    } else if (this.scanMode === 'checkin-location') {
      this.stopScanner();
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
      
      // NEW: Ask if they want to add a parts list
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
      
      this.checkIn(customerName, this.tempPallet, parseInt(palletQty) || 1, parseInt(productQty) || 0, code, parts);
      this.scanMode = null;
      this.tempPallet = null;
    } else if (this.scanMode === 'checkout') {
      this.stopScanner();
      this.checkOut(code);
      this.scanMode = null;
    } else if (this.scanMode === 'checkout-units') {
      this.stopScanner();
      this.tempCheckoutUnits = code;
      
      // Find the pallet
      const pallet = this.pallets.find(p => p.id === code || p.product_id === code);
      if (!pallet) {
        this.showToast('Pallet not found in inventory', 'error');
        this.scanMode = null;
        this.tempCheckoutUnits = null;
        this.render();
        return;
      }
      
      if (!pallet.product_quantity || pallet.product_quantity === 0) {
        this.showToast('This pallet does not track individual units. Use "Check Out Pallet" instead.', 'error');
        this.scanMode = null;
        this.tempCheckoutUnits = null;
        this.render();
        return;
      }
      
      // Show pallet info and ask for units to remove
      const totalUnits = pallet.pallet_quantity * pallet.product_quantity;
      const unitsToRemove = await this.prompt(
        'Check Out Units',
        `<div class="mb-3">
          <p class="font-bold text-lg mb-2">${pallet.product_id}</p>
          <p class="text-sm text-gray-600">Customer: ${pallet.customer_name}</p>
          <p class="text-sm text-gray-600">Location: ${pallet.location}</p>
          <p class="text-sm font-semibold mt-2">Available: ${totalUnits} units (${pallet.pallet_quantity} pallets × ${pallet.product_quantity} units/pallet)</p>
        </div>
        <p class="font-semibold">How many units to check out?</p>`,
        '1'
      );
      
      if (unitsToRemove !== null) {
        await this.removePartialUnits(code);
      }
      
      this.scanMode = null;
      this.tempCheckoutUnits = null;
    }
  },
  
  // NEW: Parse parts list from text input
  parsePartsList(text) {
    const lines = text.split('\n').filter(line => line.trim());
    const parts = [];
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      // Try to parse format: "Part Number | Quantity" or "Part Number, Quantity"
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
      
      // If no separator found, just use the whole line as part number
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
  async showManualEntry() {
    const customerName = await this.prompt('Customer Name', 'Enter customer name (e.g., Godbold, Council):');
    if (customerName === null) return;
    if (!customerName.trim()) {
      this.showToast('Customer name is required', 'error');
      return;
    }
    
    const productId = await this.prompt('Product ID', 'Enter product ID:');
    if (productId === null) return;
    if (!productId.trim()) {
      this.showToast('Product ID is required', 'error');
      return;
    }
    
    const palletQuantity = await this.prompt('Pallet Quantity', 'How many pallets?', '1');
    if (palletQuantity === null) return;
    
    const productQuantity = await this.prompt('Product Quantity (Optional)', 'Units per pallet (leave blank if not tracking):', '0');
    if (productQuantity === null) return;
    
    const location = await this.prompt('Location', 'Enter location (e.g., A1-L3):');
    if (location === null) return;
    if (!location.trim()) {
      this.showToast('Location is required', 'error');
      return;
    }
    
    // NEW: Ask if they want to add a parts list
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
    
    this.checkIn(customerName.trim(), productId.trim(), parseInt(palletQuantity) || 1, parseInt(productQuantity) || 0, location.trim(), parts);
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
    const palletId = await this.prompt('Pallet ID', 'Enter pallet ID (or leave blank for auto-generated):');
    if (palletId === null) return;
    
    const finalId = palletId.trim() || `PLT-${Date.now()}`;
    
    const customerName = await this.prompt('Customer Name', 'Enter customer name:');
    if (customerName === null) return;
    if (!customerName.trim()) {
      this.showToast('Customer name is required', 'error');
      return;
    }
    
    const productDesc = await this.prompt('Product Description', 'Enter product description (optional):', '');
    if (productDesc === null) return;
    
    const palletQuantity = await this.prompt('Pallet Quantity', 'How many pallets?', '1');
    if (palletQuantity === null) return;
    
    const productQuantity = await this.prompt('Product Quantity (Optional)', 'Units per pallet:', '0');
    if (productQuantity === null) return;
    
    this.view = 'single-qr';
    this.tempPallet = {
      id: finalId,
      customer: customerName.trim(),
      product: productDesc.trim(),
      palletQty: parseInt(palletQuantity) || 1,
      productQty: parseInt(productQuantity) || 0
    };
    this.render();
    
    setTimeout(async () => {
      await this.generateQRCode(finalId, 'single-qr-canvas');
      this.showToast('QR code generated successfully!', 'success');
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
    while (colors.length < count) {
      colors.push(...colors);
    }
    return colors.slice(0, count);
  },
  
  async syncToGoogleSheets(action, data) {
    if (!this.googleSheetsUrl) return;
    
    try {
      console.log('Syncing to Google Sheets:', action, data);
      const response = await fetch(this.googleSheetsUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, data })
      });
      console.log('Sync request sent for action:', action);
    } catch (e) {
      console.error('Google Sheets sync error:', e);
      // Don't show error to user - sync failures shouldn't block operations
    }
  },
  
  saveGoogleSheetsUrl(url) {
    this.googleSheetsUrl = url;
    localStorage.setItem('googleSheetsUrl', url);
    this.showToast('Google Sheets URL saved!', 'success');
  },
  
  async testGoogleSheetsConnection() {
    if (!this.googleSheetsUrl) {
      this.showToast('Please enter a Google Sheets URL first', 'error');
      return;
    }
    
    this.setLoading(true);
    try {
      await fetch(this.googleSheetsUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', data: {} })
      });
      this.showToast('Connection test sent! Check your Google Sheet.', 'info');
    } catch (e) {
      this.showToast('Connection test failed. Check your URL.', 'error');
      console.error(e);
    } finally {
      this.setLoading(false);
    }
  },
  
  async syncAllToGoogleSheets() {
    if (!this.googleSheetsUrl) {
      this.showToast('Please configure Google Sheets URL first', 'error');
      return;
    }
    
    this.setLoading(true);
    try {
      await this.syncToGoogleSheets('sync_all', {
        pallets: this.pallets.map(p => ({
          customer_name: p.customer_name,
          product_id: p.product_id,
          location: p.location,
          pallet_quantity: p.pallet_quantity,
          product_quantity: p.product_quantity,
          parts: p.parts,
          date_added: p.date_added
        }))
      });
      this.showToast('Full sync completed! Check your Google Sheet.', 'success');
    } catch (e) {
      this.showToast('Sync failed. Please check your connection.', 'error');
      console.error(e);
    } finally {
      this.setLoading(false);
    }
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
    this.scanMode = null;
    this.stopScanner();
    this.render();
    if (view === 'dashboard') {
      setTimeout(() => this.initCharts(), 100);
    }
  },
  
  search(term) {
    this.searchTerm = term.toLowerCase();
    this.render();
  },
  
  render() {
    const app = document.getElementById('app');
    
    if (this.scanMode) {
      app.innerHTML = this.renderScanner();
      return;
    }
    
    app.innerHTML = `
      <div class="min-h-screen">
        ${this.renderNav()}
        <div class="container mx-auto px-4 py-6">
          ${this.view === 'scan' ? this.renderScan() :
            this.view === 'tracker' ? this.renderTracker() :
            this.view === 'history' ? this.renderHistory() :
            this.view === 'dashboard' ? this.renderDashboard() :
            this.view === 'settings' ? this.renderSettings() :
            this.view === 'location-qrs' ? this.renderLocationQRs() :
            this.view === 'single-qr' ? this.renderSingleQR() :
            ''}
        </div>
      </div>
    `;
    
    if (this.view === 'tracker') {
      const searchInput = document.getElementById('search-input');
      if (searchInput) {
        searchInput.addEventListener('input', (e) => this.search(e.target.value));
      }
      
      const customerFilter = document.getElementById('customer-filter');
      if (customerFilter) {
        customerFilter.value = this.selectedCustomer;
      }
    }
    
    if (this.view === 'history') {
      const customerFilter = document.getElementById('history-customer-filter');
      if (customerFilter) {
        customerFilter.value = this.selectedCustomer;
      }
    }
  },
  
  renderNav() {
    return `
      <nav class="bg-gradient-to-r from-blue-600 to-blue-700 text-white shadow-lg print:hidden">
        <div class="container mx-auto px-4 py-4">
          <div class="flex justify-between items-center">
            <h1 class="text-3xl font-bold flex items-center gap-3">
              <span class="text-4xl">📦</span> Warehouse Tracker
            </h1>
            <div class="flex gap-2 flex-wrap">
              <button 
                onclick="app.setView('scan')" 
                class="px-4 py-2 rounded-lg font-semibold ${this.view === 'scan' ? 'bg-white text-blue-600' : 'bg-blue-500 hover:bg-blue-400'}"
              >
                📷 Scan
              </button>
              <button 
                onclick="app.setView('tracker')" 
                class="px-4 py-2 rounded-lg font-semibold ${this.view === 'tracker' ? 'bg-white text-blue-600' : 'bg-blue-500 hover:bg-blue-400'}"
              >
                📋 Tracker
              </button>
              <button 
                onclick="app.setView('history')" 
                class="px-4 py-2 rounded-lg font-semibold ${this.view === 'history' ? 'bg-white text-blue-600' : 'bg-blue-500 hover:bg-blue-400'}"
              >
                📜 History
              </button>
              <button 
                onclick="app.setView('dashboard')" 
                class="px-4 py-2 rounded-lg font-semibold ${this.view === 'dashboard' ? 'bg-white text-blue-600' : 'bg-blue-500 hover:bg-blue-400'}"
              >
                📊 Dashboard
              </button>
              <button 
                onclick="app.setView('settings')" 
                class="px-4 py-2 rounded-lg font-semibold ${this.view === 'settings' ? 'bg-white text-blue-600' : 'bg-blue-500 hover:bg-blue-400'}"
              >
                ⚙️ Settings
              </button>
            </div>
          </div>
        </div>
      </nav>
    `;
  },
  
  renderScan() {
    return `
      <div class="max-w-4xl mx-auto space-y-6 fade-in">
        <div class="text-center mb-8">
          <h2 class="text-4xl font-bold text-gray-900 mb-2">Quick Actions</h2>
          <p class="text-gray-600">Scan QR codes or enter information manually</p>
        </div>
        
        <!-- Main Actions Section -->
        <div class="bg-white p-6 rounded-2xl shadow-xl border-2 border-gray-200">
          <h3 class="text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
            <span class="text-2xl">📦</span> Pallet Operations
          </h3>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="bg-gradient-to-br from-green-500 to-green-600 text-white p-6 rounded-xl shadow-lg card-hover cursor-pointer" onclick="app.startScanner('checkin-pallet')">
              <div class="flex flex-col items-center text-center">
                <div class="text-6xl mb-3">📥</div>
                <h3 class="text-xl font-bold mb-1">Check In Pallet</h3>
                <p class="text-green-100 text-sm">Scan pallet QR code and location</p>
              </div>
            </div>
            
            <div class="bg-gradient-to-br from-red-500 to-red-600 text-white p-6 rounded-xl shadow-lg card-hover cursor-pointer" onclick="app.startScanner('checkout')">
              <div class="flex flex-col items-center text-center">
                <div class="text-6xl mb-3">📤</div>
                <h3 class="text-xl font-bold mb-1">Check Out Pallet</h3>
                <p class="text-red-100 text-sm">Remove entire pallet from inventory</p>
              </div>
            </div>
            
            <div class="bg-gradient-to-br from-orange-500 to-orange-600 text-white p-6 rounded-xl shadow-lg card-hover cursor-pointer" onclick="app.startScanner('checkout-units')">
              <div class="flex flex-col items-center text-center">
                <div class="text-6xl mb-3">📊</div>
                <h3 class="text-xl font-bold mb-1">Check Out Units</h3>
                <p class="text-orange-100 text-sm">Remove partial units from pallet</p>
              </div>
            </div>
            
            <div class="bg-gradient-to-br from-blue-500 to-blue-600 text-white p-6 rounded-xl shadow-lg card-hover cursor-pointer" onclick="app.showManualEntry()">
              <div class="flex flex-col items-center text-center">
                <div class="text-6xl mb-3">✍️</div>
                <h3 class="text-xl font-bold mb-1">Manual Entry</h3>
                <p class="text-blue-100 text-sm">Enter pallet information manually</p>
              </div>
            </div>
          </div>
        </div>
        
        <!-- QR Code Generation Section -->
        <div class="bg-white p-6 rounded-2xl shadow-xl border-2 border-gray-200">
          <h3 class="text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
            <span class="text-2xl">🔳</span> QR Code Generation
          </h3>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <button 
              onclick="app.generatePalletQR()" 
              class="bg-gradient-to-r from-purple-500 to-purple-600 text-white p-6 rounded-xl shadow-lg hover:from-purple-600 hover:to-purple-700 font-bold text-lg flex items-center justify-center gap-3"
            >
              <span class="text-4xl">📱</span>
              <div class="text-left">
                <div class="text-lg font-bold">Generate Pallet QR</div>
                <div class="text-sm text-purple-100 font-normal">Create QR code for new pallet</div>
              </div>
            </button>
            
            <button 
              onclick="app.generateLocationQRs()" 
              class="bg-gradient-to-r from-indigo-500 to-indigo-600 text-white p-6 rounded-xl shadow-lg hover:from-indigo-600 hover:to-indigo-700 font-bold text-lg flex items-center justify-center gap-3"
            >
              <span class="text-4xl">🏢</span>
              <div class="text-left">
                <div class="text-lg font-bold">Location QR Codes</div>
                <div class="text-sm text-indigo-100 font-normal">Generate all location codes</div>
              </div>
            </button>
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
                    onchange="app.saveGoogleSheetsUrl(this.value)"
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
                    <span>🔄</span> Sync All Inventory Now
                  </button>
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
        p.product_id.toLowerCase().includes(this.searchTerm) ||
        p.location.toLowerCase().includes(this.searchTerm) ||
        p.customer_name.toLowerCase().includes(this.searchTerm)
      );
    }
    
    return `
      <div class="space-y-6 fade-in">
        <div>
          <h2 class="text-3xl font-bold text-gray-900 mb-2">📋 Inventory Tracker</h2>
          <p class="text-gray-600">View and manage all pallets in the warehouse</p>
        </div>
        
        <div class="space-y-4">
          <div class="flex gap-3 flex-wrap">
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
              placeholder="🔍 Search product or location..." 
              value="${this.searchTerm}"
              class="flex-1 border-2 border-gray-300 p-3 rounded-xl text-base focus:ring-2 focus:ring-blue-500 focus:border-blue-500 shadow-sm"
            />
            
            <a href="${API_URL}/api/export${this.selectedCustomer ? '?customer=' + encodeURIComponent(this.selectedCustomer) : ''}" download class="bg-blue-600 text-white px-6 py-3 rounded-xl flex items-center whitespace-nowrap font-semibold hover:bg-blue-700 shadow-lg">
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
        </div>
        
        <div class="space-y-3 inventory-results">
          ${pallets.length === 0 ? 
            `<div class="text-center text-gray-500 py-16">
              <div class="text-6xl mb-4">📦</div>
              <div class="text-xl font-semibold mb-2">No pallets found</div>
              <p class="text-gray-400">${this.selectedCustomer ? `No inventory for ${this.selectedCustomer}` : 'Start by checking in a pallet'}</p>
            </div>` :
            pallets.map(p => `
              <div class="bg-white p-5 rounded-xl shadow-sm card-hover flex justify-between items-start border border-gray-100">
                <div class="flex-1">
                  <h3 class="font-bold text-xl text-gray-900">${p.product_id}</h3>
                  <p class="text-blue-600 font-semibold text-sm mt-2 flex items-center gap-2">
                    <span class="text-lg">👤</span> ${p.customer_name}
                  </p>
                  <p class="text-gray-600 text-sm mt-2 flex items-center gap-2">
                    <span class="text-lg">📍</span> ${p.location}
                  </p>
                  <div class="text-sm mt-3 flex items-center gap-3 flex-wrap">
                    <span class="bg-gradient-to-r from-green-100 to-green-50 text-green-700 px-3 py-1 rounded-full font-bold">
                      🎫 ${p.pallet_quantity} pallet${p.pallet_quantity > 1 ? 's' : ''}
                    </span>
                    ${p.product_quantity > 0 ? `
                      <span class="bg-gradient-to-r from-purple-100 to-purple-50 text-purple-700 px-3 py-1 rounded-full font-bold">
                        📦 ${p.product_quantity} units/pallet
                      </span>
                      <span class="bg-gradient-to-r from-blue-100 to-blue-50 text-blue-700 px-3 py-1 rounded-full font-bold">
                        = ${p.current_units || (p.pallet_quantity * p.product_quantity)} total units
                      </span>
                    ` : ''}
                    <span class="text-xs text-gray-500">Added ${new Date(p.date_added).toLocaleDateString()}</span>
                  </div>
                  ${p.parts && p.parts.length > 0 ? `
                    <div class="mt-3 p-3 bg-gray-50 rounded-lg">
                      <p class="text-xs font-semibold text-gray-700 mb-2">📋 Parts List:</p>
                      <div class="space-y-1">
                        ${p.parts.map(part => `
                          <div class="text-xs text-gray-600 flex justify-between">
                            <span>${part.part_number}</span>
                            <span class="font-semibold">×${part.quantity}</span>
                          </div>
                        `).join('')}
                      </div>
                    </div>
                  ` : ''}
                </div>
                <div class="flex flex-col gap-2 ml-4">
                  <button onclick="app.removePartialQuantity('${p.id}')" class="bg-orange-500 text-white px-4 py-2 rounded-xl text-sm font-bold hover:bg-orange-600 shadow-md whitespace-nowrap">
                    Remove Pallets
                  </button>
                  ${p.product_quantity > 0 ? `
                    <button onclick="app.removePartialUnits('${p.id}')" class="bg-yellow-500 text-white px-4 py-2 rounded-xl text-sm font-bold hover:bg-yellow-600 shadow-md whitespace-nowrap">
                      Remove Units
                    </button>
                  ` : ''}
                  <button onclick="app.showProductInfo('${p.id}')" class="bg-blue-500 text-white px-4 py-2 rounded-xl text-sm font-bold hover:bg-blue-600 shadow-md whitespace-nowrap">
                    Product Info
                  </button>
                </div>
              </div>
            `).join('')
          }
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

app.init();