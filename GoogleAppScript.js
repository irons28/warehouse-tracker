/**
 * Warehouse Tracker - Google Sheets Integration
 * 
 * This script creates separate tabs for each customer and tracks both
 * check-ins and removals (check-outs, partial removals, unit removals)
 * 
 * SETUP INSTRUCTIONS:
 * 1. Open your Google Sheet
 * 2. Go to Extensions > Apps Script
 * 3. Delete any existing code
 * 4. Paste this entire script
 * 5. Click Save (disk icon)
 * 6. Click Deploy > New Deployment
 * 7. Click gear icon > Select "Web app"
 * 8. Set "Execute as" to "Me"
 * 9. Set "Who has access" to "Anyone"
 * 10. Click Deploy
 * 11. Copy the Web App URL and paste it in Warehouse Tracker Settings
 */

// Main function - handles all requests from the warehouse tracker
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;
    const payload = data.data;
    
    Logger.log('Received action: ' + action);
    Logger.log('Payload: ' + JSON.stringify(payload));
    
    switch(action) {
      case 'test':
        return createResponse({ success: true, message: 'Connection successful!' });
        
      case 'add_pallet':
        return handleAddPallet(payload);
        
      case 'remove_pallet':
        return handleRemovePallet(payload);
        
      case 'update_quantity':
        return handleUpdateQuantity(payload);
        
      case 'partial_remove':
        return handlePartialRemove(payload);
        
      case 'units_remove':
        return handleUnitsRemove(payload);
        
      case 'sync_all':
        return handleSyncAll(payload);
        
      default:
        return createResponse({ success: false, message: 'Unknown action: ' + action });
    }
  } catch (error) {
    Logger.log('Error: ' + error.toString());
    return createResponse({ success: false, message: 'Error: ' + error.toString() });
  }
}

// Helper function to create HTTP response
function createResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// Get or create a sheet for a specific customer
function getOrCreateCustomerSheet(customerName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(customerName);
  
  if (!sheet) {
    // Create new sheet for this customer
    sheet = ss.insertSheet(customerName);
    
    // Set up headers with styling - NOW WITH REMOVAL TRACKING
    const headers = [
      'Product ID', 
      'Location', 
      'Pallets', 
      'Units/Pallet (Spec)', 
      'Current Units',
      'Parts List',
      'Date Added',
      'Last Removal Date',
      'Last Removal Qty',
      'Status'
    ];
    
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setValues([headers]);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#4285f4');
    headerRange.setFontColor('#ffffff');
    
    // Set column widths
    sheet.setColumnWidth(1, 150); // Product ID
    sheet.setColumnWidth(2, 100); // Location
    sheet.setColumnWidth(3, 80);  // Pallets
    sheet.setColumnWidth(4, 100); // Units/Pallet
    sheet.setColumnWidth(5, 100); // Total Units
    sheet.setColumnWidth(6, 200); // Parts List
    sheet.setColumnWidth(7, 120); // Date Added
    sheet.setColumnWidth(8, 130); // Last Removal Date
    sheet.setColumnWidth(9, 130); // Last Removal Qty
    sheet.setColumnWidth(10, 100); // Status
    
    // Freeze header row
    sheet.setFrozenRows(1);
  }
  
  return sheet;
}

// Get or create the Activity Log sheet
function getOrCreateActivitySheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Activity Log');
  
  if (!sheet) {
    sheet = ss.insertSheet('Activity Log', 0); // Insert as first sheet
    
    const headers = [
      'Timestamp',
      'Customer',
      'Product ID',
      'Location',
      'Action',
      'Quantity Changed',
      'Before',
      'After',
      'Notes'
    ];
    
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setValues([headers]);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#ea4335');
    headerRange.setFontColor('#ffffff');
    
    // Set column widths
    sheet.setColumnWidth(1, 150); // Timestamp
    sheet.setColumnWidth(2, 120); // Customer
    sheet.setColumnWidth(3, 150); // Product ID
    sheet.setColumnWidth(4, 100); // Location
    sheet.setColumnWidth(5, 120); // Action
    sheet.setColumnWidth(6, 120); // Quantity Changed
    sheet.setColumnWidth(7, 80);  // Before
    sheet.setColumnWidth(8, 80);  // After
    sheet.setColumnWidth(9, 250); // Notes
    
    sheet.setFrozenRows(1);
  }
  
  return sheet;
}

// Get or create the Removals sheet
function getOrCreateRemovalsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Removals History');
  
  if (!sheet) {
    sheet = ss.insertSheet('Removals History', 1); // Insert as second sheet after Activity Log
    
    const headers = [
      'Timestamp',
      'Customer',
      'Product ID',
      'Location',
      'Removal Type',
      'Qty Removed',
      'Qty Before',
      'Qty After',
      'Notes',
      'Removed By'
    ];
    
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setValues([headers]);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#ff9800');
    headerRange.setFontColor('#ffffff');
    
    // Set column widths
    sheet.setColumnWidth(1, 150); // Timestamp
    sheet.setColumnWidth(2, 120); // Customer
    sheet.setColumnWidth(3, 150); // Product ID
    sheet.setColumnWidth(4, 100); // Location
    sheet.setColumnWidth(5, 120); // Removal Type
    sheet.setColumnWidth(6, 100); // Qty Removed
    sheet.setColumnWidth(7, 80);  // Qty Before
    sheet.setColumnWidth(8, 80);  // Qty After
    sheet.setColumnWidth(9, 250); // Notes
    sheet.setColumnWidth(10, 100); // Removed By
    
    sheet.setFrozenRows(1);
  }
  
  return sheet;
}

// Log activity to the Activity Log sheet
function logActivity(customer, productId, location, action, quantityChanged, before, after, notes) {
  const sheet = getOrCreateActivitySheet();
  const timestamp = new Date();
  
  sheet.appendRow([
    timestamp,
    customer,
    productId,
    location,
    action,
    quantityChanged,
    before,
    after,
    notes || ''
  ]);
  
  // Sort by timestamp descending (newest first)
  const lastRow = sheet.getLastRow();
  if (lastRow > 2) {
    const range = sheet.getRange(2, 1, lastRow - 1, 9);
    range.sort({column: 1, ascending: false});
  }
}

// Log removal to the Removals History sheet
function logRemoval(customer, productId, location, removalType, qtyRemoved, qtyBefore, qtyAfter, notes, removedBy) {
  const sheet = getOrCreateRemovalsSheet();
  const timestamp = new Date();
  
  sheet.appendRow([
    timestamp,
    customer,
    productId,
    location,
    removalType,
    qtyRemoved,
    qtyBefore,
    qtyAfter,
    notes || '',
    removedBy || 'System'
  ]);
  
  // Sort by timestamp descending (newest first)
  const lastRow = sheet.getLastRow();
  if (lastRow > 2) {
    const range = sheet.getRange(2, 1, lastRow - 1, 10);
    range.sort({column: 1, ascending: false});
  }
}

// Handle adding a new pallet
function handleAddPallet(data) {
  const sheet = getOrCreateCustomerSheet(data.customer_name);
  const productId = data.product_id;
  const location = data.location;
  const palletQty = data.pallet_quantity || 1;
  const productQty = data.product_quantity || 0;
  const currentUnits = data.current_units || productQty; // Use provided or default to full
  const parts = data.parts ? formatPartsList(data.parts) : '';
  const dateAdded = new Date(data.date_added || new Date());
  
  // Check if this product/location already exists
  const dataRange = sheet.getDataRange();
  const values = dataRange.getValues();
  let existingRow = -1;
  
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === productId && values[i][1] === location && values[i][9] === 'Active') {
      existingRow = i + 1;
      break;
    }
  }
  
  if (existingRow > 0) {
    // Update existing entry
    const currentPallets = values[existingRow - 1][2];
    const currentUnitsExisting = values[existingRow - 1][4];
    const newPallets = currentPallets + palletQty;
    const newCurrentUnits = currentUnitsExisting + currentUnits;
    
    sheet.getRange(existingRow, 3).setValue(newPallets);
    sheet.getRange(existingRow, 5).setValue(newCurrentUnits);
    
    logActivity(
      data.customer_name,
      productId,
      location,
      'CHECK_IN (Added to existing)',
      palletQty,
      currentPallets,
      newPallets,
      `Added ${palletQty} pallets to existing entry`
    );
  } else {
    // Add new row - with new columns for removal tracking
    sheet.appendRow([
      productId,
      location,
      palletQty,
      productQty, // Units/Pallet (original spec)
      currentUnits, // Current Units (starts at full)
      parts,
      dateAdded,
      '', // Last Removal Date (empty initially)
      '', // Last Removal Qty (empty initially)
      'Active'
    ]);
    
    logActivity(
      data.customer_name,
      productId,
      location,
      'CHECK_IN (New)',
      palletQty,
      0,
      palletQty,
      parts ? 'Includes parts list' : ''
    );
  }
  
  return createResponse({ success: true, message: 'Pallet added to sheet' });
}

// Format parts list for display
function formatPartsList(parts) {
  if (!parts || parts.length === 0) return '';
  
  return parts.map(part => `${part.part_number} (×${part.quantity})`).join(', ');
}

// Handle removing a pallet completely
function handleRemovePallet(data) {
  const sheet = getOrCreateCustomerSheet(data.customer_name || 'Unknown');
  const productId = data.product_id;
  const location = data.location;
  
  const dataRange = sheet.getDataRange();
  const values = dataRange.getValues();
  
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === productId && values[i][1] === location && values[i][7] === 'Active') {
      const row = i + 1;
      const palletsBefore = values[i][2];
      
      // DELETE the row entirely
      Logger.log('Complete removal - DELETING row ' + row);
      sheet.deleteRow(row);
      Logger.log('Row deleted');
      
      // Log to removals sheet
      logRemoval(
        data.customer_name || 'Unknown',
        productId,
        location,
        'CHECK_OUT (Complete)',
        palletsBefore,
        palletsBefore,
        0,
        'Complete removal from inventory - entry deleted'
      );
      
      logActivity(
        data.customer_name || 'Unknown',
        productId,
        location,
        'CHECK_OUT (Complete)',
        palletsBefore,
        palletsBefore,
        0,
        'Complete removal from inventory'
      );
      
      return createResponse({ success: true, message: 'Pallet marked as removed' });
    }
  }
  
  return createResponse({ success: false, message: 'Pallet not found' });
}

// Handle updating quantity (partial removal)
function handleUpdateQuantity(data) {
  Logger.log('handleUpdateQuantity called with data: ' + JSON.stringify(data));
  
  const customerName = data.customer_name || 'Unknown';
  const sheet = getOrCreateCustomerSheet(customerName);
  const productId = data.product_id;
  const location = data.location;
  const newQuantity = parseFloat(data.new_quantity); // Allow decimals like 3.5
  
  Logger.log(`Looking for: ${productId} at ${location} for customer ${customerName}`);
  Logger.log(`New quantity should be: ${newQuantity}`);
  
  const dataRange = sheet.getDataRange();
  const values = dataRange.getValues();
  
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === productId && values[i][1] === location && values[i][9] === 'Active') {
      const row = i + 1;
      const oldQuantity = parseFloat(values[i][2]);
      const productQty = parseFloat(values[i][3]);
      const newTotalUnits = newQuantity * productQty;
      const quantityRemoved = oldQuantity - newQuantity;
      
      Logger.log(`Found pallet at row ${row}. Updating from ${oldQuantity} to ${newQuantity} pallets`);
      
      if (newQuantity === 0) {
        // DELETE the row entirely when quantity reaches 0
        Logger.log('Quantity is 0 - DELETING row ' + row);
        sheet.deleteRow(row);
        Logger.log('Row deleted');
      } else {
        // Update the quantities AND track the removal
        const removalDate = new Date();
        const removalQty = productQty > 0 ? 
          (quantityRemoved * productQty).toFixed(0) + ' units' : 
          quantityRemoved.toFixed(2) + ' pallets';
        
        sheet.getRange(row, 3).setValue(newQuantity); // Pallets
        sheet.getRange(row, 5).setValue(newTotalUnits); // Total Units
        sheet.getRange(row, 8).setValue(removalDate); // Last Removal Date
        sheet.getRange(row, 9).setValue(removalQty); // Last Removal Qty
        
        Logger.log(`Updated row ${row}: Pallets=${newQuantity}, Total Units=${newTotalUnits}`);
        Logger.log(`Removal tracked: ${removalQty} on ${removalDate}`);
      }
      
      // Log to removals sheet
      logRemoval(
        customerName,
        productId,
        location,
        'PARTIAL_REMOVE',
        quantityRemoved,
        oldQuantity,
        newQuantity,
        productQty > 0 ? (quantityRemoved * productQty) + ' units removed' : quantityRemoved + ' pallets removed'
      );
      
      // Log to activity
      logActivity(
        customerName,
        productId,
        location,
        'PARTIAL_REMOVE',
        quantityRemoved,
        oldQuantity,
        newQuantity,
        newQuantity === 0 ? 'Removed all pallets - entry deleted' : `Removed ${quantityRemoved} pallets. ${newQuantity} remaining.`
      );
      
      Logger.log('Update complete');
      return createResponse({ success: true, message: 'Quantity updated' });
    }
  }
  
  Logger.log('ERROR: Pallet not found in sheet');
  return createResponse({ success: false, message: 'Pallet not found' });
}

// Handle partial pallet removal
function handlePartialRemove(data) {
  // This is the same as update_quantity
  return handleUpdateQuantity(data);
}

// Handle units removal
function handleUnitsRemove(data) {
  Logger.log('handleUnitsRemove called with data: ' + JSON.stringify(data));
  
  const customerName = data.customer_name || 'Unknown';
  const sheet = getOrCreateCustomerSheet(customerName);
  const productId = data.product_id;
  const location = data.location;
  const unitsRemoved = data.units_removed;
  const newPalletQty = data.new_pallet_quantity;
  const unitsPerPallet = data.units_per_pallet;
  
  Logger.log(`Looking for: ${productId} at ${location} for customer ${customerName}`);
  
  const dataRange = sheet.getDataRange();
  const values = dataRange.getValues();
  
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === productId && values[i][1] === location && values[i][9] === 'Active') {
      const row = i + 1;
      const oldPalletQty = parseFloat(values[i][2]);
      const unitsPerPalletSpec = parseFloat(values[i][3]); // Original spec (never changes)
      const oldCurrentUnits = parseFloat(values[i][4]); // Actual current units
      const newCurrentUnits = oldCurrentUnits - unitsRemoved;
      
      Logger.log(`Found pallet at row ${row}.`);
      Logger.log(`Spec: ${unitsPerPalletSpec} units/pallet (constant)`);
      Logger.log(`Old current: ${oldCurrentUnits} units`);
      Logger.log(`Removing: ${unitsRemoved} units`);
      Logger.log(`New current: ${newCurrentUnits} units`);
      
      if (newCurrentUnits === 0) {
        // DELETE the row entirely when all units are gone
        Logger.log('All units removed - DELETING row ' + row);
        sheet.deleteRow(row);
        Logger.log('Row deleted');
      } else {
        // Update current units while keeping spec constant
        const removalDate = new Date();
        const removalQty = unitsRemoved + ' units';
        
        sheet.getRange(row, 3).setValue(newPalletQty); // Pallets (stays same, usually 1)
        sheet.getRange(row, 4).setValue(unitsPerPalletSpec); // Units/Pallet Spec (NEVER changes)
        sheet.getRange(row, 5).setValue(newCurrentUnits); // Current Units (updated)
        sheet.getRange(row, 8).setValue(removalDate); // Last Removal Date
        sheet.getRange(row, 9).setValue(removalQty); // Last Removal Qty
        
        Logger.log(`Updated row ${row}: ${newPalletQty} pallets, ${unitsPerPalletSpec} spec, ${newCurrentUnits} current`);
        Logger.log(`Removal tracked: ${removalQty} on ${removalDate}`);
      }
      
      // Log to removals sheet
      logRemoval(
        customerName,
        productId,
        location,
        'UNITS_REMOVE',
        unitsRemoved,
        oldCurrentUnits,
        newCurrentUnits,
        newCurrentUnits === 0 ? 'All units removed - entry deleted' : `Removed ${unitsRemoved} units (${oldCurrentUnits} → ${newCurrentUnits} remaining)`
      );
      
      logActivity(
        customerName,
        productId,
        location,
        'UNITS_REMOVE',
        unitsRemoved,
        oldCurrentUnits,
        newCurrentUnits,
        `Removed ${unitsRemoved} units (${oldCurrentUnits} → ${newCurrentUnits}). Spec: ${unitsPerPalletSpec} units/pallet`
      );
      
      Logger.log('Units removal completed successfully');
      return createResponse({ success: true, message: 'Units removed and sheet updated' });
    }
  }
  
  Logger.log('ERROR: Pallet not found in sheet');
  return createResponse({ success: false, message: 'Pallet not found in sheet for customer: ' + customerName });
}

// Handle syncing all pallets
function handleSyncAll(data) {
  const pallets = data.pallets;
  
  // Clear all existing customer sheets (but KEEP Activity Log and Removals History)
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets();
  
  for (let i = sheets.length - 1; i >= 0; i--) {
    const sheetName = sheets[i].getName();
    // Only delete customer tabs, preserve Activity Log and Removals History
    if (sheetName !== 'Activity Log' && sheetName !== 'Removals History') {
      ss.deleteSheet(sheets[i]);
    }
  }
  
  // Add all pallets
  pallets.forEach(pallet => {
    const sheet = getOrCreateCustomerSheet(pallet.customer_name);
    const productQty = pallet.product_quantity || 0;
    const currentUnits = pallet.current_units || (pallet.pallet_quantity * productQty);
    const parts = pallet.parts ? formatPartsList(pallet.parts) : '';
    
    sheet.appendRow([
      pallet.product_id,
      pallet.location,
      pallet.pallet_quantity,
      productQty, // Units/Pallet (spec)
      currentUnits, // Current Units
      parts,
      new Date(pallet.date_added),
      '', // Last Removal Date (empty for sync)
      '', // Last Removal Qty (empty for sync)
      'Active'
    ]);
  });
  
  logActivity(
    'SYSTEM',
    'SYNC_ALL',
    '-',
    'SYNC',
    pallets.length,
    0,
    pallets.length,
    `Full sync completed: ${pallets.length} pallets across ${ss.getSheets().length - 2} customers (preserved Activity Log and Removals History)`
  );
  
  return createResponse({ 
    success: true, 
    message: `Synced ${pallets.length} pallets across ${ss.getSheets().length - 2} customer sheets. History preserved.` 
  });
}

// Test function - you can run this from the Apps Script editor to test
function testConnection() {
  Logger.log('Test connection successful!');
  return 'Google Apps Script is working correctly!';
}