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
    
    // Set up headers with styling
    const headers = [
      'Product ID', 
      'Location', 
      'Pallets', 
      'Units/Pallet', 
      'Total Units',
      'Parts List',
      'Date Added',
      'Status',
      'Last Updated'
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
    sheet.setColumnWidth(8, 100); // Status
    sheet.setColumnWidth(9, 120); // Last Updated
    
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

// Handle adding a new pallet
function handleAddPallet(data) {
  const sheet = getOrCreateCustomerSheet(data.customer_name);
  const productId = data.product_id;
  const location = data.location;
  const palletQty = data.pallet_quantity || 1;
  const productQty = data.product_quantity || 0;
  const totalUnits = palletQty * productQty;
  const parts = data.parts ? formatPartsList(data.parts) : '';
  const dateAdded = new Date(data.date_added || new Date());
  
  // Check if this product/location already exists
  const dataRange = sheet.getDataRange();
  const values = dataRange.getValues();
  let existingRow = -1;
  
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === productId && values[i][1] === location && values[i][7] === 'Active') {
      existingRow = i + 1;
      break;
    }
  }
  
  if (existingRow > 0) {
    // Update existing entry
    const currentPallets = values[existingRow - 1][2];
    const newPallets = currentPallets + palletQty;
    const newTotalUnits = newPallets * productQty;
    
    sheet.getRange(existingRow, 3).setValue(newPallets);
    sheet.getRange(existingRow, 5).setValue(newTotalUnits);
    sheet.getRange(existingRow, 9).setValue(new Date());
    
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
    // Add new row
    sheet.appendRow([
      productId,
      location,
      palletQty,
      productQty,
      totalUnits,
      parts,
      dateAdded,
      'Active',
      new Date()
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
      
      // Mark as removed instead of deleting
      sheet.getRange(row, 8).setValue('Removed');
      sheet.getRange(row, 9).setValue(new Date());
      
      // Color the row gray
      sheet.getRange(row, 1, 1, 9).setBackground('#e0e0e0');
      
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
  const sheet = getOrCreateCustomerSheet(data.customer_name || 'Unknown');
  const productId = data.product_id;
  const location = data.location;
  const newQuantity = data.new_quantity;
  
  const dataRange = sheet.getDataRange();
  const values = dataRange.getValues();
  
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === productId && values[i][1] === location && values[i][7] === 'Active') {
      const row = i + 1;
      const oldQuantity = values[i][2];
      const productQty = values[i][3];
      const newTotalUnits = newQuantity * productQty;
      const quantityRemoved = oldQuantity - newQuantity;
      
      if (newQuantity === 0) {
        // Mark as removed
        sheet.getRange(row, 8).setValue('Removed');
        sheet.getRange(row, 1, 1, 9).setBackground('#e0e0e0');
      }
      
      sheet.getRange(row, 3).setValue(newQuantity);
      sheet.getRange(row, 5).setValue(newTotalUnits);
      sheet.getRange(row, 9).setValue(new Date());
      
      logActivity(
        data.customer_name || 'Unknown',
        productId,
        location,
        'PARTIAL_REMOVE',
        quantityRemoved,
        oldQuantity,
        newQuantity,
        `Removed ${quantityRemoved} pallets`
      );
      
      return createResponse({ success: true, message: 'Quantity updated' });
    }
  }
  
  return createResponse({ success: false, message: 'Pallet not found' });
}

// Handle partial pallet removal
function handlePartialRemove(data) {
  // This is the same as update_quantity
  return handleUpdateQuantity(data);
}

// Handle units removal
function handleUnitsRemove(data) {
  const sheet = getOrCreateCustomerSheet(data.customer_name || 'Unknown');
  const productId = data.product_id;
  const location = data.location;
  const unitsRemoved = data.units_removed;
  const newPalletQty = data.new_pallet_quantity;
  const unitsPerPallet = data.units_per_pallet;
  
  const dataRange = sheet.getDataRange();
  const values = dataRange.getValues();
  
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === productId && values[i][1] === location && values[i][7] === 'Active') {
      const row = i + 1;
      const oldPalletQty = values[i][2];
      const oldTotalUnits = oldPalletQty * unitsPerPallet;
      const newTotalUnits = newPalletQty * unitsPerPallet;
      
      if (newPalletQty === 0) {
        // Mark as removed
        sheet.getRange(row, 8).setValue('Removed');
        sheet.getRange(row, 1, 1, 9).setBackground('#e0e0e0');
      }
      
      sheet.getRange(row, 3).setValue(newPalletQty);
      sheet.getRange(row, 5).setValue(newTotalUnits);
      sheet.getRange(row, 9).setValue(new Date());
      
      logActivity(
        data.customer_name || 'Unknown',
        productId,
        location,
        'UNITS_REMOVE',
        unitsRemoved,
        oldTotalUnits,
        newTotalUnits,
        `Removed ${unitsRemoved} units (${oldPalletQty} → ${newPalletQty} pallets)`
      );
      
      return createResponse({ success: true, message: 'Units removed and sheet updated' });
    }
  }
  
  return createResponse({ success: false, message: 'Pallet not found' });
}

// Handle syncing all pallets
function handleSyncAll(data) {
  const pallets = data.pallets;
  
  // Clear all existing customer sheets (except Activity Log)
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets();
  
  for (let i = sheets.length - 1; i >= 0; i--) {
    const sheetName = sheets[i].getName();
    if (sheetName !== 'Activity Log') {
      ss.deleteSheet(sheets[i]);
    }
  }
  
  // Add all pallets
  pallets.forEach(pallet => {
    const sheet = getOrCreateCustomerSheet(pallet.customer_name);
    const productQty = pallet.product_quantity || 0;
    const totalUnits = pallet.pallet_quantity * productQty;
    const parts = pallet.parts ? formatPartsList(pallet.parts) : '';
    
    sheet.appendRow([
      pallet.product_id,
      pallet.location,
      pallet.pallet_quantity,
      productQty,
      totalUnits,
      parts,
      new Date(pallet.date_added),
      'Active',
      new Date()
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
    `Full sync completed: ${pallets.length} pallets across ${ss.getSheets().length - 1} customers`
  );
  
  return createResponse({ 
    success: true, 
    message: `Synced ${pallets.length} pallets across ${ss.getSheets().length - 1} customer sheets` 
  });
}

// Test function - you can run this from the Apps Script editor to test
function testConnection() {
  Logger.log('Test connection successful!');
  return 'Google Apps Script is working correctly!';
}