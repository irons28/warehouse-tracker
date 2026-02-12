/**
 * Warehouse Tracker - Google Sheets Integration
 *
 * Paste this entire script into Apps Script as Code.gs (replace all),
 * then Deploy as Web App:
 * - Execute as: Me
 * - Who has access: Anyone
 *
 * This script:
 * - Keeps your existing per-customer tabs (so nothing breaks)
 * - Maintains Activity Log + Removals History
 * - ✅ Adds Daily_Storage (date + customer + pallets in storage) with UPSERT (no duplicates)
 */

const ACTIVITY_SHEET_NAME = "Activity Log";
const REMOVALS_SHEET_NAME = "Removals History";
const DAILY_STORAGE_SHEET_NAME = "Daily_Storage";

function doGet() {
  return createResponse({ success: true, message: "Warehouse Sheets Web App running" });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return createResponse({ success: false, message: "Missing request body" });
    }

    const req = JSON.parse(e.postData.contents);
    const action = req.action;
    const payload = req.data || {};

    Logger.log("Received action: " + action);
    Logger.log("Payload: " + JSON.stringify(payload));

    switch (action) {
      case "test":
        getOrCreateActivitySheet();
        getOrCreateRemovalsSheet();
        getOrCreateDailyStorageSheet();
        return createResponse({ success: true, message: "Connection successful!" });

      case "add_pallet":
        return handleAddPallet(payload);

      case "remove_pallet":
        return handleRemovePallet(payload);

      case "update_quantity":
        return handleUpdateQuantity(payload);

      case "partial_remove":
        return handleUpdateQuantity(payload);

      case "units_remove":
        return handleUnitsRemove(payload);

      case "sync_all":
        return handleSyncAll(payload);

      // ✅ OPTIONAL UPGRADE ACTION
      case "daily_snapshot":
        return handleDailySnapshot(payload);

      default:
        return createResponse({ success: false, message: "Unknown action: " + action });
    }
  } catch (error) {
    Logger.log("Error: " + error.toString());
    return createResponse({ success: false, message: "Error: " + error.toString() });
  }
}

function createResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function safeSheetName_(name) {
  const cleaned = String(name || "Unknown")
    .trim()
    .replace(/[\\/?*[\]:]/g, "-")
    .slice(0, 80);
  return cleaned || "Unknown";
}

function ensureHeaders_(sheet, headers, style) {
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  const existing = headerRange.getValues()[0];
  const isEmpty = existing.every(v => v === "" || v === null);

  if (isEmpty) {
    headerRange.setValues([headers]);

    if (style && style.bg && style.fg) {
      headerRange.setFontWeight("bold");
      headerRange.setBackground(style.bg);
      headerRange.setFontColor(style.fg);
    }

    sheet.setFrozenRows(1);
  }
}

// ========================
// Customer Sheet
// ========================
function getOrCreateCustomerSheet(customerName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tabName = safeSheetName_(customerName);

  let sheet = ss.getSheetByName(tabName);
  if (!sheet) sheet = ss.insertSheet(tabName);

  const headers = [
    "Product ID",
    "Location",
    "Pallets",
    "Units/Pallet (Spec)",
    "Current Units",
    "Parts List",
    "Date Added",
    "Scanned In By",
    "Last Removal Date",
    "Last Removal Qty",
    "Last Removal By",
    "Status"
  ];

  ensureHeaders_(sheet, headers, { bg: "#4285f4", fg: "#ffffff" });

  sheet.setColumnWidth(1, 150);
  sheet.setColumnWidth(2, 100);
  sheet.setColumnWidth(3, 80);
  sheet.setColumnWidth(4, 130);
  sheet.setColumnWidth(5, 110);
  sheet.setColumnWidth(6, 260);
  sheet.setColumnWidth(7, 140);
  sheet.setColumnWidth(8, 140);
  sheet.setColumnWidth(9, 150);
  sheet.setColumnWidth(10, 130);
  sheet.setColumnWidth(11, 140);
  sheet.setColumnWidth(12, 100);

  return sheet;
}

// ========================
// Activity Log
// ========================
function getOrCreateActivitySheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(ACTIVITY_SHEET_NAME);

  if (!sheet) sheet = ss.insertSheet(ACTIVITY_SHEET_NAME, 0);

  const headers = [
    "Timestamp",
    "Customer",
    "Product ID",
    "Location",
    "Action",
    "Quantity Changed",
    "Before",
    "After",
    "Notes",
    "By"
  ];

  ensureHeaders_(sheet, headers, { bg: "#ea4335", fg: "#ffffff" });

  sheet.setColumnWidth(1, 170);
  sheet.setColumnWidth(2, 140);
  sheet.setColumnWidth(3, 180);
  sheet.setColumnWidth(4, 110);
  sheet.setColumnWidth(5, 150);
  sheet.setColumnWidth(6, 140);
  sheet.setColumnWidth(7, 90);
  sheet.setColumnWidth(8, 90);
  sheet.setColumnWidth(9, 320);
  sheet.setColumnWidth(10, 140);

  return sheet;
}

// ========================
// Removals History
// ========================
function getOrCreateRemovalsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(REMOVALS_SHEET_NAME);

  if (!sheet) sheet = ss.insertSheet(REMOVALS_SHEET_NAME, 1);

  const headers = [
    "Timestamp",
    "Customer",
    "Product ID",
    "Location",
    "Removal Type",
    "Qty Removed",
    "Qty Before",
    "Qty After",
    "Notes",
    "Removed By"
  ];

  ensureHeaders_(sheet, headers, { bg: "#ff9800", fg: "#ffffff" });

  sheet.setColumnWidth(1, 170);
  sheet.setColumnWidth(2, 140);
  sheet.setColumnWidth(3, 180);
  sheet.setColumnWidth(4, 110);
  sheet.setColumnWidth(5, 150);
  sheet.setColumnWidth(6, 120);
  sheet.setColumnWidth(7, 100);
  sheet.setColumnWidth(8, 100);
  sheet.setColumnWidth(9, 320);
  sheet.setColumnWidth(10, 140);

  return sheet;
}

// ========================
// ✅ Daily Storage Snapshot (Invoice-ready)
// ========================
function getOrCreateDailyStorageSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(DAILY_STORAGE_SHEET_NAME);

  if (!sheet) sheet = ss.insertSheet(DAILY_STORAGE_SHEET_NAME, 2);

  const headers = ["Date", "Customer", "Pallets in Storage"];
  ensureHeaders_(sheet, headers, { bg: "#0f9d58", fg: "#ffffff" });

  sheet.setColumnWidth(1, 120);
  sheet.setColumnWidth(2, 180);
  sheet.setColumnWidth(3, 150);

  return sheet;
}

function logActivity(customer, productId, location, action, quantityChanged, before, after, notes, by) {
  const sheet = getOrCreateActivitySheet();
  sheet.appendRow([
    new Date(),
    customer || "Unknown",
    productId || "",
    location || "",
    action || "",
    quantityChanged || "",
    before || "",
    after || "",
    notes || "",
    by || ""
  ]);

  sortSheetByTimestampDesc_(sheet, 10);
}

function logRemoval(customer, productId, location, removalType, qtyRemoved, qtyBefore, qtyAfter, notes, removedBy) {
  const sheet = getOrCreateRemovalsSheet();
  sheet.appendRow([
    new Date(),
    customer || "Unknown",
    productId || "",
    location || "",
    removalType || "",
    qtyRemoved || "",
    qtyBefore || "",
    qtyAfter || "",
    notes || "",
    removedBy || ""
  ]);

  sortSheetByTimestampDesc_(sheet, 10);
}

function sortSheetByTimestampDesc_(sheet, colCount) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 2) return;
  const range = sheet.getRange(2, 1, lastRow - 1, colCount);
  range.sort({ column: 1, ascending: false });
}

function formatPartsList(parts) {
  if (!parts || !parts.length) return "";
  return parts.map(p => `${p.part_number} (x${p.quantity || 1})`).join(", ");
}

// ========================
// Handlers
// ========================
function handleAddPallet(data) {
  const customerName = data.customer_name || "Unknown";
  const sheet = getOrCreateCustomerSheet(customerName);

  const productId = data.product_id || "";
  const location = data.location || "";
  const palletQty = Number(data.pallet_quantity || 1);
  const productQty = Number(data.product_quantity || 0);

  const currentUnits = (data.current_units !== undefined && data.current_units !== null)
    ? Number(data.current_units)
    : Number(productQty);

  const parts = data.parts ? formatPartsList(data.parts) : "";
  const dateAdded = data.date_added ? new Date(data.date_added) : new Date();
  const scannedBy = data.scanned_by || "Unknown";

  const values = sheet.getDataRange().getValues();
  let existingRow = -1;

  for (let i = 1; i < values.length; i++) {
    const isMatch = values[i][0] === productId && values[i][1] === location;
    const isActive = values[i][11] === "Active";
    if (isMatch && isActive) {
      existingRow = i + 1;
      break;
    }
  }

  if (existingRow > 0) {
    const currentPallets = Number(values[existingRow - 1][2] || 0);
    const currentUnitsExisting = Number(values[existingRow - 1][4] || 0);

    const newPallets = currentPallets + palletQty;
    const newCurrentUnits = currentUnitsExisting + currentUnits;

    sheet.getRange(existingRow, 3).setValue(newPallets);
    sheet.getRange(existingRow, 5).setValue(newCurrentUnits);

    logActivity(
      customerName,
      productId,
      location,
      "CHECK_IN (Added to existing)",
      palletQty,
      currentPallets,
      newPallets,
      `Added ${palletQty} pallets to existing entry`,
      scannedBy
    );

    return createResponse({ success: true, message: "Pallet added to existing row" });
  }

  sheet.appendRow([
    productId,
    location,
    palletQty,
    productQty,
    currentUnits,
    parts,
    dateAdded,
    scannedBy,
    "",
    "",
    "",
    "Active"
  ]);

  logActivity(
    customerName,
    productId,
    location,
    "CHECK_IN (New)",
    palletQty,
    0,
    palletQty,
    parts ? "Includes parts list" : "",
    scannedBy
  );

  return createResponse({ success: true, message: "Pallet added to sheet" });
}

function handleRemovePallet(data) {
  const customerName = data.customer_name || "Unknown";
  const sheet = getOrCreateCustomerSheet(customerName);

  const productId = data.product_id || "";
  const location = data.location || "";
  const removedBy = data.scanned_by || "Unknown";

  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    const isMatch = values[i][0] === productId && values[i][1] === location;
    const isActive = values[i][11] === "Active";
    if (isMatch && isActive) {
      const row = i + 1;
      const palletsBefore = Number(values[i][2] || 0);
      const unitsBefore = Number(values[i][4] || 0);

      sheet.deleteRow(row);

      logRemoval(
        customerName,
        productId,
        location,
        "CHECK_OUT (Complete)",
        palletsBefore,
        palletsBefore,
        0,
        "Complete removal from inventory - entry deleted",
        removedBy
      );

      logActivity(
        customerName,
        productId,
        location,
        "CHECK_OUT (Complete)",
        palletsBefore,
        palletsBefore,
        0,
        `Removed row (units before: ${unitsBefore})`,
        removedBy
      );

      return createResponse({ success: true, message: "Pallet removed (row deleted)" });
    }
  }

  return createResponse({ success: false, message: "Pallet not found" });
}

function handleUpdateQuantity(data) {
  const customerName = data.customer_name || "Unknown";
  const sheet = getOrCreateCustomerSheet(customerName);

  const productId = data.product_id || "";
  const location = data.location || "";
  const newQuantity = Number(data.new_quantity);
  const scannedBy = data.scanned_by || "Unknown";

  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    const isMatch = values[i][0] === productId && values[i][1] === location;
    const isActive = values[i][11] === "Active";
    if (!isMatch || !isActive) continue;

    const row = i + 1;
    const oldQuantity = Number(values[i][2] || 0);
    const unitsPerPalletSpec = Number(values[i][3] || 0);

    const quantityRemoved = oldQuantity - newQuantity;

    if (isNaN(newQuantity)) {
      return createResponse({ success: false, message: "new_quantity is not a number" });
    }

    if (newQuantity <= 0) {
      sheet.deleteRow(row);

      logRemoval(
        customerName,
        productId,
        location,
        "PARTIAL_REMOVE (All)",
        quantityRemoved,
        oldQuantity,
        0,
        "Removed all pallets - entry deleted",
        scannedBy
      );

      logActivity(
        customerName,
        productId,
        location,
        "PARTIAL_REMOVE (All)",
        quantityRemoved,
        oldQuantity,
        0,
        "Removed all pallets - entry deleted",
        scannedBy
      );

      return createResponse({ success: true, message: "Quantity updated (row deleted)" });
    }

    const newTotalUnits = unitsPerPalletSpec > 0 ? (newQuantity * unitsPerPalletSpec) : values[i][4];

    sheet.getRange(row, 3).setValue(newQuantity);
    sheet.getRange(row, 5).setValue(newTotalUnits);

    sheet.getRange(row, 9).setValue(new Date());
    sheet.getRange(row, 10).setValue(
      unitsPerPalletSpec > 0
        ? `${Math.round(quantityRemoved * unitsPerPalletSpec)} units`
        : `${quantityRemoved} pallets`
    );
    sheet.getRange(row, 11).setValue(scannedBy);

    logRemoval(
      customerName,
      productId,
      location,
      "PARTIAL_REMOVE",
      quantityRemoved,
      oldQuantity,
      newQuantity,
      unitsPerPalletSpec > 0
        ? `${Math.round(quantityRemoved * unitsPerPalletSpec)} units removed`
        : `${quantityRemoved} pallets removed`,
      scannedBy
    );

    logActivity(
      customerName,
      productId,
      location,
      "PARTIAL_REMOVE",
      quantityRemoved,
      oldQuantity,
      newQuantity,
      `Removed ${quantityRemoved} pallets. ${newQuantity} remaining.`,
      scannedBy
    );

    return createResponse({ success: true, message: "Quantity updated" });
  }

  return createResponse({ success: false, message: "Pallet not found" });
}

function handleUnitsRemove(data) {
  const customerName = data.customer_name || "Unknown";
  const sheet = getOrCreateCustomerSheet(customerName);

  const productId = data.product_id || "";
  const location = data.location || "";
  const unitsRemoved = Number(data.units_removed || 0);
  const scannedBy = data.scanned_by || "Unknown";

  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    const isMatch = values[i][0] === productId && values[i][1] === location;
    const isActive = values[i][11] === "Active";
    if (!isMatch || !isActive) continue;

    const row = i + 1;

    const unitsPerPalletSpec = Number(values[i][3] || 0);
    const oldCurrentUnits = Number(values[i][4] || 0);
    const newCurrentUnits = oldCurrentUnits - unitsRemoved;

    if (newCurrentUnits <= 0) {
      sheet.deleteRow(row);

      logRemoval(
        customerName,
        productId,
        location,
        "UNITS_REMOVE (All)",
        unitsRemoved,
        oldCurrentUnits,
        0,
        "All units removed - entry deleted",
        scannedBy
      );

      logActivity(
        customerName,
        productId,
        location,
        "UNITS_REMOVE (All)",
        unitsRemoved,
        oldCurrentUnits,
        0,
        `Removed all units. Spec: ${unitsPerPalletSpec} units/pallet`,
        scannedBy
      );

      return createResponse({ success: true, message: "All units removed (row deleted)" });
    }

    sheet.getRange(row, 5).setValue(newCurrentUnits);

    sheet.getRange(row, 9).setValue(new Date());
    sheet.getRange(row, 10).setValue(`${unitsRemoved} units`);
    sheet.getRange(row, 11).setValue(scannedBy);

    logRemoval(
      customerName,
      productId,
      location,
      "UNITS_REMOVE",
      unitsRemoved,
      oldCurrentUnits,
      newCurrentUnits,
      `Removed ${unitsRemoved} units (${oldCurrentUnits} -> ${newCurrentUnits})`,
      scannedBy
    );

    logActivity(
      customerName,
      productId,
      location,
      "UNITS_REMOVE",
      unitsRemoved,
      oldCurrentUnits,
      newCurrentUnits,
      `Removed ${unitsRemoved} units. Spec: ${unitsPerPalletSpec} units/pallet`,
      scannedBy
    );

    return createResponse({ success: true, message: "Units removed and sheet updated" });
  }

  return createResponse({ success: false, message: "Pallet not found in sheet for customer: " + customerName });
}

function handleSyncAll(data) {
  const pallets = Array.isArray(data.pallets) ? data.pallets : [];

  let added = 0;
  let updated = 0;
  let skipped = 0;

  pallets.forEach(p => {
    const customerName = p.customer_name || "Unknown";
    const sheet = getOrCreateCustomerSheet(customerName);

    const productId = p.product_id || "";
    const location = p.location || "";
    const productQty = Number(p.product_quantity || 0);

    const currentUnits = (p.current_units !== undefined && p.current_units !== null)
      ? Number(p.current_units)
      : Number(p.pallet_quantity || 0) * productQty;

    const parts = p.parts ? formatPartsList(p.parts) : "";
    const scannedBy = p.scanned_by || "Unknown";
    const dateAdded = p.date_added ? new Date(p.date_added) : new Date();

    const values = sheet.getDataRange().getValues();
    let existingRow = -1;

    for (let i = 1; i < values.length; i++) {
      const isMatch = values[i][0] === productId && values[i][1] === location;
      const isActive = values[i][11] === "Active";
      if (isMatch && isActive) {
        existingRow = i + 1;
        break;
      }
    }

    if (existingRow > 0) {
      const palletsInSheet = Number(values[existingRow - 1][2] || 0);
      const unitsInSheet = Number(values[existingRow - 1][4] || 0);

      if (palletsInSheet !== Number(p.pallet_quantity || 0) || unitsInSheet !== currentUnits) {
        sheet.getRange(existingRow, 3).setValue(Number(p.pallet_quantity || 0));
        sheet.getRange(existingRow, 4).setValue(productQty);
        sheet.getRange(existingRow, 5).setValue(currentUnits);
        updated++;
      } else {
        skipped++;
      }
    } else {
      sheet.appendRow([
        productId,
        location,
        Number(p.pallet_quantity || 0),
        productQty,
        currentUnits,
        parts,
        dateAdded,
        scannedBy,
        "",
        "",
        "",
        "Active"
      ]);
      added++;
    }
  });

  logActivity(
    "SYSTEM",
    "SYNC_ALL",
    "-",
    "SYNC",
    pallets.length,
    0,
    pallets.length,
    `Smart sync: ${added} added, ${updated} updated, ${skipped} unchanged`,
    "SYSTEM"
  );

  return createResponse({
    success: true,
    message: `Smart sync complete: ${added} added, ${updated} updated, ${skipped} unchanged. Removal history preserved.`
  });
}

// ✅ New handler: daily snapshot UPSERT (no duplicate rows for same date+customer)
function handleDailySnapshot(data) {
  const sheet = getOrCreateDailyStorageSheet();

  const dateStr = String(data.date || "").trim(); // YYYY-MM-DD
  const customer = String(data.customer_name || "Unknown").trim();
  const qty = Number(data.pallets_in_storage || 0);

  if (!dateStr) {
    return createResponse({ success: false, message: "daily_snapshot missing date" });
  }

  const tz = Session.getScriptTimeZone();
  const values = sheet.getDataRange().getValues();

  // Find existing row with same Date+Customer
  // Row format: [Date, Customer, Pallets in Storage]
  let foundRow = -1;

  for (let i = 1; i < values.length; i++) {
    const cellDate = values[i][0];
    const cellCustomer = String(values[i][1] || "").trim();

    const normalizedCellDate =
      cellDate instanceof Date
        ? Utilities.formatDate(cellDate, tz, "yyyy-MM-dd")
        : String(cellDate || "").trim();

    if (normalizedCellDate === dateStr && cellCustomer === customer) {
      foundRow = i + 1;
      break;
    }
  }

  if (foundRow > 0) {
    sheet.getRange(foundRow, 3).setValue(qty);
  } else {
    // Store as a proper Date in the sheet
    const dateObj = new Date(dateStr + "T00:00:00");
    sheet.appendRow([dateObj, customer, qty]);
  }

  logActivity(
    customer,
    "DAILY_SNAPSHOT",
    "-",
    "DAILY_SNAPSHOT",
    qty,
    "",
    qty,
    `Snapshot recorded for ${dateStr}`,
    "SYSTEM"
  );

  return createResponse({ success: true, message: "Daily snapshot recorded", date: dateStr, customer, qty });
}