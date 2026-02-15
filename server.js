const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const bodyParser = require("body-parser");
const path = require("path");
const https = require("https");
const http = require("http");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const settingsPath = path.join(__dirname, "server-settings.json");

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

// Check if SSL certificates exist
const sslKeyPath = path.join(__dirname, "ssl", "key.pem");
const sslCertPath = path.join(__dirname, "ssl", "cert.pem");
const hasSSL = fs.existsSync(sslKeyPath) && fs.existsSync(sslCertPath);

// Create servers (HTTP always; HTTPS optional)
const httpServer = http.createServer(app);
let httpsServer = null;

if (hasSSL) {
  const sslOptions = {
    key: fs.readFileSync(sslKeyPath),
    cert: fs.readFileSync(sslCertPath),
  };
  httpsServer = https.createServer(sslOptions, app);
}

// Socket.IO attached to the server users actually visit
const { Server } = require("socket.io");
const io = new Server(hasSSL ? httpsServer : httpServer);

// Socket.IO connection handling
let connectedClients = 0;
io.on("connection", (socket) => {
  connectedClients++;
  console.log(`✓ Device connected (${connectedClients} total)`);

  socket.on("disconnect", () => {
    connectedClients--;
    console.log(`✗ Device disconnected (${connectedClients} remaining)`);
  });
});

// Helper to broadcast inventory changes to all connected clients
function broadcastInventoryChange(action, data) {
  try {
    console.log(`📡 Broadcasting: ${action}`);
    const payload = { action, data, timestamp: Date.now() };
    io.emit("inventory_update", payload);
    // Backward-compat for older client listeners
    io.emit("db_updated", payload);
  } catch (e) {
    console.error("Broadcast failed:", e);
  }
}

function safeParseParts(partsValue) {
  if (!partsValue) return null;
  try {
    return JSON.parse(partsValue);
  } catch {
    return null;
  }
}

function readServerSettings() {
  try {
    if (!fs.existsSync(settingsPath)) return {};
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Initialize database
const db = new sqlite3.Database("./warehouse.db", (err) => {
  if (err) console.error("Database connection error:", err);
  else console.log("✓ Connected to warehouse database");
});

// Create tables
db.serialize(() => {
  // Check and migrate pallets table
  db.all("PRAGMA table_info(pallets)", (err, columns) => {
    if (err) {
      console.error("Error checking table structure:", err);
      return;
    }

    if (columns.length > 0) {
      const hasQuantity = columns.some((col) => col.name === "quantity");
      const hasPalletQuantity = columns.some((col) => col.name === "pallet_quantity");
      const hasParts = columns.some((col) => col.name === "parts");
      const hasCurrentUnits = columns.some((col) => col.name === "current_units");
      const hasScannedBy = columns.some((col) => col.name === "scanned_by");

      if (hasQuantity && !hasPalletQuantity) {
        console.log("🔄 Migrating database to new schema...");

        db.run("ALTER TABLE pallets ADD COLUMN pallet_quantity INTEGER DEFAULT 1");
        db.run("ALTER TABLE pallets ADD COLUMN product_quantity INTEGER DEFAULT 0");

        setTimeout(() => {
          db.run(
            "UPDATE pallets SET pallet_quantity = quantity WHERE pallet_quantity IS NULL OR pallet_quantity = 0"
          );
          db.run("UPDATE pallets SET product_quantity = 0 WHERE product_quantity IS NULL");
          console.log("✓ Migration complete");
        }, 500);
      }

      if (!hasParts) {
        console.log("🔄 Adding parts column...");
        db.run("ALTER TABLE pallets ADD COLUMN parts TEXT", (err) => {
          if (err) console.error("Error adding parts column:", err);
          else console.log("✓ Parts column added");
        });
      }

      if (!hasCurrentUnits) {
        console.log("🔄 Adding current_units column...");
        db.run("ALTER TABLE pallets ADD COLUMN current_units INTEGER DEFAULT 0", (err) => {
          if (err) console.error("Error adding current_units column:", err);
          else {
            console.log("✓ current_units column added");
            setTimeout(() => {
              db.run(
                "UPDATE pallets SET current_units = product_quantity * pallet_quantity WHERE current_units IS NULL OR current_units = 0",
                (err) => {
                  if (err) console.error("Error initializing current_units:", err);
                  else console.log("✓ current_units initialized");
                }
              );
            }, 500);
          }
        });
      }

      if (!hasScannedBy) {
        console.log("🔄 Adding scanned_by column...");
        db.run("ALTER TABLE pallets ADD COLUMN scanned_by TEXT DEFAULT 'Unknown'", (err) => {
          if (err) console.error("Error adding scanned_by column:", err);
          else console.log("✓ scanned_by column added");
        });
      }
    }
  });

  // Pallets table
  db.run(
    `CREATE TABLE IF NOT EXISTS pallets (
      id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      product_id TEXT NOT NULL,
      pallet_quantity INTEGER DEFAULT 1,
      product_quantity INTEGER DEFAULT 0,
      current_units INTEGER DEFAULT 0,
      location TEXT NOT NULL,
      parts TEXT,
      scanned_by TEXT DEFAULT 'Unknown',
      date_added DATETIME DEFAULT CURRENT_TIMESTAMP,
      date_removed DATETIME,
      status TEXT DEFAULT 'active'
    )`,
    (err) => {
      if (err) console.error("Error creating pallets table:", err);
      else console.log("✓ Pallets table ready");
    }
  );

  // Locations table
  db.run(
    `CREATE TABLE IF NOT EXISTS locations (
      id TEXT PRIMARY KEY,
      aisle TEXT,
      rack INTEGER,
      level INTEGER,
      is_occupied INTEGER DEFAULT 0
    )`,
    (err) => {
      if (err) console.error("Error creating locations table:", err);
      else console.log("✓ Locations table ready");
    }
  );

  // Activity/History table
  db.run(
    `CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pallet_id TEXT,
      customer_name TEXT,
      product_id TEXT,
      action TEXT,
      quantity_changed INTEGER,
      quantity_before INTEGER,
      quantity_after INTEGER,
      location TEXT,
      notes TEXT,
      scanned_by TEXT DEFAULT 'Unknown',
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    (err) => {
      if (err) console.error("Error creating activity_log table:", err);
      else console.log("✓ Activity log table ready");
    }
  );

  // Add scanned_by column to activity_log if it doesn't exist
  db.all("PRAGMA table_info(activity_log)", (err, columns) => {
    if (!err && columns) {
      const hasScannedBy = columns.some((col) => col.name === "scanned_by");
      if (!hasScannedBy) {
        console.log("🔄 Adding scanned_by to activity_log...");
        db.run("ALTER TABLE activity_log ADD COLUMN scanned_by TEXT DEFAULT 'Unknown'", (err) => {
          if (err) console.error("Error adding scanned_by to activity_log:", err);
          else console.log("✓ scanned_by column added to activity_log");
        });
      }
    }
  });

  // Populate locations if empty
  db.get("SELECT COUNT(*) as count FROM locations", (err, row) => {
    if (err) {
      console.error("Error checking locations:", err);
      return;
    }

    if (row.count === 0) {
      const aisles = ["A","B","C","D","E","F","G","H","I","J"];
      const stmt = db.prepare(
        "INSERT INTO locations (id, aisle, rack, level) VALUES (?, ?, ?, ?)"
      );

      aisles.forEach((aisle) => {
        for (let rack = 1; rack <= 8; rack++) {
          for (let level = 1; level <= 6; level++) {
            const locationId = `${aisle}${rack}-L${level}`;
            stmt.run(locationId, aisle, rack, level);
          }
        }
      });

      stmt.finalize(() => {
        console.log("✓ Initialized 480 rack locations (A-J, 1-8, L1-L6)");
      });
    } else {
      console.log(`✓ Found ${row.count} existing locations`);
    }
  });
});

// =====================
// API ROUTES
// =====================

// Get all active pallets
app.get("/api/pallets", (req, res) => {
  const { customer } = req.query;

  let query = 'SELECT * FROM pallets WHERE status = "active"';
  let params = [];

  if (customer) {
    query += " AND customer_name = ?";
    params.push(customer);
  }

  query += " ORDER BY date_added DESC";

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const palletsWithParts = rows.map((row) => ({
      ...row,
      parts: safeParseParts(row.parts),
    }));

    res.json(palletsWithParts);
  });
});

// Search pallets
app.get("/api/pallets/search", (req, res) => {
  const { q } = req.query;
  db.all(
    'SELECT * FROM pallets WHERE status = "active" AND (product_id LIKE ? OR location LIKE ? OR customer_name LIKE ?) ORDER BY date_added DESC',
    [`%${q}%`, `%${q}%`, `%${q}%`],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });

      const palletsWithParts = rows.map((row) => ({
        ...row,
        parts: safeParseParts(row.parts),
      }));

      res.json(palletsWithParts);
    }
  );
});

// Check in a pallet
app.post("/api/pallets", (req, res) => {
  const {
    id,
    customer_name,
    product_id,
    pallet_quantity,
    product_quantity,
    location,
    parts,
    scanned_by,
  } = req.body;

  if (!customer_name || !product_id || !location) {
    return res.status(400).json({ error: "Customer name, Product ID and location required" });
  }

  const palletId = id || `PLT-${Date.now()}`;
  const partsJson = parts ? JSON.stringify(parts) : null;
  const palletQty = Number(pallet_quantity) || 1;
  const unitsPerPallet = Number(product_quantity) || 0;
  const currentUnits = palletQty * unitsPerPallet;
  const scannedByPerson = scanned_by || "Unknown";

  db.run(
    "INSERT INTO pallets (id, customer_name, product_id, pallet_quantity, product_quantity, current_units, location, parts, scanned_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      palletId,
      customer_name,
      product_id,
      palletQty,
      unitsPerPallet,
      currentUnits,
      location,
      partsJson,
      scannedByPerson,
    ],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });

      db.run("UPDATE locations SET is_occupied = 1 WHERE id = ?", [location]);

      db.run(
        "INSERT INTO activity_log (pallet_id, customer_name, product_id, action, quantity_changed, quantity_after, location) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          palletId,
          customer_name,
          product_id,
          "CHECK_IN",
          palletQty,
          palletQty,
          location,
        ]
      );

      res.json({
        id: palletId,
        customer_name,
        product_id,
        pallet_quantity: palletQty,
        product_quantity: unitsPerPallet,
        location,
        parts: parts || null,
        message: "Pallet checked in successfully",
      });

      broadcastInventoryChange("add_pallet", {
        id: palletId,
        customer_name,
        product_id,
        pallet_quantity: palletQty,
        product_quantity: unitsPerPallet,
        current_units: currentUnits,
        location,
        parts,
        scanned_by: scannedByPerson,
      });
    }
  );
});

// Partial quantity removal
app.post("/api/pallets/:id/remove-quantity", (req, res) => {
  const { id } = req.params;
  const { quantity_to_remove, scanned_by } = req.body;
  const scannedByPerson = scanned_by || "Unknown";

  if (!quantity_to_remove || quantity_to_remove <= 0) {
    return res.status(400).json({ error: "Valid quantity required" });
  }

  db.get(
    'SELECT * FROM pallets WHERE (id = ? OR product_id = ?) AND status = "active"',
    [id, id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: "Pallet not found" });

      const quantityBefore = row.pallet_quantity;
      const quantityAfter = quantityBefore - quantity_to_remove;

      if (quantityAfter < 0) {
        return res.status(400).json({ error: "Cannot remove more than available quantity" });
      }

      if (quantityAfter === 0) {
        db.run(
          'UPDATE pallets SET status = "removed", date_removed = CURRENT_TIMESTAMP, pallet_quantity = 0 WHERE id = ?',
          [row.id],
          (err) => {
            if (err) return res.status(500).json({ error: err.message });

            db.run("UPDATE locations SET is_occupied = 0 WHERE id = ?", [row.location]);

            db.run(
              "INSERT INTO activity_log (pallet_id, customer_name, product_id, action, quantity_changed, quantity_before, quantity_after, location, notes, scanned_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              [
                row.id,
                row.customer_name,
                row.product_id,
                "PARTIAL_REMOVE",
                quantity_to_remove,
                quantityBefore,
                0,
                row.location,
                "Pallet emptied and removed",
                scannedByPerson,
              ]
            );

            res.json({
              message: "All pallets removed. Location freed.",
              quantity_removed: quantity_to_remove,
              quantity_remaining: 0,
              pallet_removed: true,
            });

            broadcastInventoryChange("delete_pallet", {
              customer_name: row.customer_name,
              product_id: row.product_id,
              location: row.location,
              quantity_removed: quantity_to_remove,
              scanned_by: scannedByPerson,
            });
          }
        );
      } else {
        db.run(
          "UPDATE pallets SET pallet_quantity = ? WHERE id = ?",
          [quantityAfter, row.id],
          (err) => {
            if (err) return res.status(500).json({ error: err.message });

            db.run(
              "INSERT INTO activity_log (pallet_id, customer_name, product_id, action, quantity_changed, quantity_before, quantity_after, location, scanned_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
              [
                row.id,
                row.customer_name,
                row.product_id,
                "PARTIAL_REMOVE",
                quantity_to_remove,
                quantityBefore,
                quantityAfter,
                row.location,
                scannedByPerson,
              ]
            );

            res.json({
              message: `Removed ${quantity_to_remove} pallet(s). ${quantityAfter} remaining.`,
              quantity_removed: quantity_to_remove,
              quantity_remaining: quantityAfter,
              pallet_removed: false,
            });

            broadcastInventoryChange("remove_pallets", {
              customer_name: row.customer_name,
              product_id: row.product_id,
              location: row.location,
              quantity_removed: quantity_to_remove,
              quantity_remaining: quantityAfter,
              scanned_by: scannedByPerson,
            });
          }
        );
      }
    }
  );
});

// Remove partial units from pallet
app.post("/api/pallets/:id/remove-units", (req, res) => {
  const { id } = req.params;
  const { units_to_remove, scanned_by } = req.body;
  const scannedByPerson = scanned_by || "Unknown";

  if (!units_to_remove || units_to_remove <= 0) {
    return res.status(400).json({ error: "Valid unit quantity required" });
  }

  db.get(
    'SELECT * FROM pallets WHERE (id = ? OR product_id = ?) AND status = "active"',
    [id, id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: "Pallet not found" });

      if (!row.product_quantity || row.product_quantity === 0) {
        return res.status(400).json({
          error: "This pallet does not track individual units. Use remove-quantity endpoint instead.",
        });
      }

      const totalUnits = Number(row.current_units) || 0;
      const unitsAfter = totalUnits - units_to_remove;

      if (unitsAfter < 0) {
        return res.status(400).json({
          error: `Cannot remove ${units_to_remove} units. Only ${totalUnits} units available.`,
        });
      }

      if (unitsAfter === 0) {
        db.run(
          'UPDATE pallets SET status = "removed", date_removed = CURRENT_TIMESTAMP, pallet_quantity = 0, product_quantity = 0, current_units = 0 WHERE id = ?',
          [row.id],
          (err) => {
            if (err) return res.status(500).json({ error: err.message });

            db.run("UPDATE locations SET is_occupied = 0 WHERE id = ?", [row.location]);

            db.run(
              "INSERT INTO activity_log (pallet_id, customer_name, product_id, action, quantity_changed, quantity_before, quantity_after, location, notes, scanned_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              [
                row.id,
                row.customer_name,
                row.product_id,
                "UNITS_REMOVE",
                units_to_remove,
                totalUnits,
                0,
                row.location,
                "All units removed. Pallet cleared.",
                scannedByPerson,
              ]
            );

            res.json({
              message: "All units removed. Location freed.",
              units_removed: units_to_remove,
              units_remaining: 0,
              pallets_remaining: 0,
              pallet_removed: true,
            });

            broadcastInventoryChange("delete_pallet", {
              customer_name: row.customer_name,
              product_id: row.product_id,
              location: row.location,
              units_removed: units_to_remove,
              scanned_by: scannedByPerson,
            });
          }
        );
      } else {
        db.run(
          "UPDATE pallets SET current_units = ? WHERE id = ?",
          [unitsAfter, row.id],
          (err) => {
            if (err) return res.status(500).json({ error: err.message });

            db.run(
              "INSERT INTO activity_log (pallet_id, customer_name, product_id, action, quantity_changed, quantity_before, quantity_after, location, notes, scanned_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              [
                row.id,
                row.customer_name,
                row.product_id,
                "UNITS_REMOVE",
                units_to_remove,
                totalUnits,
                unitsAfter,
                row.location,
                `Removed ${units_to_remove} units. ${unitsAfter} total units remaining.`,
                scannedByPerson,
              ]
            );

            res.json({
              message: `Removed ${units_to_remove} units. ${unitsAfter} total units remaining.`,
              units_removed: units_to_remove,
              units_remaining: unitsAfter,
              pallets_remaining: row.pallet_quantity,
              units_per_pallet: row.product_quantity,
              current_units: unitsAfter,
              pallet_removed: false,
            });

            broadcastInventoryChange("remove_units", {
              customer_name: row.customer_name,
              product_id: row.product_id,
              location: row.location,
              units_removed: units_to_remove,
              units_remaining: unitsAfter,
              scanned_by: scannedByPerson,
            });
          }
        );
      }
    }
  );
});

// Check out a pallet
app.delete("/api/pallets/:id", (req, res) => {
  const { id } = req.params;

  db.get(
    'SELECT * FROM pallets WHERE (id = ? OR product_id = ?) AND status = "active"',
    [id, id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: "Pallet not found" });

      db.run(
        'UPDATE pallets SET status = "removed", date_removed = CURRENT_TIMESTAMP WHERE id = ? OR product_id = ?',
        [id, id],
        (err) => {
          if (err) return res.status(500).json({ error: err.message });

          db.run("UPDATE locations SET is_occupied = 0 WHERE id = ?", [row.location]);

          db.run(
            "INSERT INTO activity_log (pallet_id, customer_name, product_id, action, quantity_changed, quantity_before, location, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
              row.id,
              row.customer_name,
              row.product_id,
              "CHECK_OUT",
              row.pallet_quantity,
              row.pallet_quantity,
              row.location,
              "Full pallet removed",
            ]
          );

          res.json({ message: "Pallet checked out successfully" });

          broadcastInventoryChange("delete_pallet", {
            customer_name: row.customer_name,
            product_id: row.product_id,
            location: row.location,
            scanned_by: row.scanned_by || "Unknown",
          });
        }
      );
    }
  );
});

// Locations
app.get("/api/locations", (req, res) => {
  db.all("SELECT * FROM locations ORDER BY aisle, rack, level", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Stats
app.get("/api/stats", (req, res) => {
  const { customer } = req.query;

  let palletQuery = 'SELECT COUNT(*) as total_pallets FROM pallets WHERE status = "active"';
  let params = [];

  if (customer) {
    palletQuery += " AND customer_name = ?";
    params.push(customer);
  }

  db.get(palletQuery, params, (err, palletRow) => {
    if (err) return res.status(500).json({ error: err.message });

    db.get(
      `SELECT 
        (SELECT COUNT(*) FROM locations WHERE is_occupied = 1) as occupied_locations,
        (SELECT COUNT(*) FROM locations) as total_locations`,
      (err, locationRow) => {
        if (err) return res.status(500).json({ error: err.message });

        res.json({
          total_pallets: palletRow.total_pallets,
          occupied_locations: locationRow.occupied_locations,
          total_locations: locationRow.total_locations,
        });
      }
    );
  });
});

// Activity log
app.get("/api/activity", (req, res) => {
  const { customer, limit } = req.query;

  let query = "SELECT * FROM activity_log";
  let params = [];

  if (customer) {
    query += " WHERE customer_name = ?";
    params.push(customer);
  }

  query += " ORDER BY timestamp DESC";

  if (limit) {
    query += " LIMIT ?";
    params.push(parseInt(limit));
  }

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Export to CSV
app.get("/api/export", (req, res) => {
  const { customer } = req.query;

  let query = 'SELECT * FROM pallets WHERE status = "active"';
  let params = [];

  if (customer) {
    query += " AND customer_name = ?";
    params.push(customer);
  }

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const csv = ["Customer,Product ID,Pallet Qty,Product Qty,Location,Date Added"]
      .concat(
        rows.map(
          (p) =>
            `${p.customer_name},${p.product_id},${p.pallet_quantity},${p.product_quantity},${p.location},${p.date_added}`
        )
      )
      .join("\n");

    res.header("Content-Type", "text/csv");
    res.attachment("inventory.csv");
    res.send(csv);
  });
});

// Customers
app.get("/api/customers", (req, res) => {
  db.all(
    'SELECT DISTINCT customer_name FROM pallets WHERE status = "active" ORDER BY customer_name',
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows.map((r) => r.customer_name));
    }
  );
});

app.get("/api/settings", (req, res) => {
  const settings = readServerSettings();
  res.json({
    googleSheetsUrl: settings.googleSheetsUrl || settings.appsScriptUrl || "",
    appsScriptUrl: settings.appsScriptUrl || settings.googleSheetsUrl || "",
  });
});

app.post("/api/sheets/test", async (req, res) => {
  const settings = readServerSettings();
  const url = String(settings.googleSheetsUrl || settings.appsScriptUrl || "").trim();
  if (!url) {
    return res.status(400).json({ error: "Google Sheets URL not configured in server-settings.json" });
  }

  try {
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      return res.status(502).json({ error: `Sheets endpoint responded ${response.status}` });
    }
    return res.json({ ok: true, message: "Google Sheets endpoint reachable" });
  } catch (err) {
    return res.status(502).json({ error: err.message || "Failed to reach Google Sheets endpoint" });
  }
});

app.post("/api/sheets/sync", async (req, res) => {
  const settings = readServerSettings();
  const url = String(settings.googleSheetsUrl || settings.appsScriptUrl || "").trim();
  if (!url) {
    return res.status(400).json({ error: "Google Sheets URL not configured in server-settings.json" });
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "warehouse-tracker", trigger: "manual-sync" }),
    });
    if (!response.ok) {
      return res.status(502).json({ error: `Sheets sync failed (${response.status})` });
    }
    return res.json({ ok: true, message: "Sync request sent to Google Sheets" });
  } catch (err) {
    return res.status(502).json({ error: err.message || "Failed to call Google Sheets sync endpoint" });
  }
});

// -----------------------------
// Invoicing (v2) - weekly billing with customer rates + handling fees
// -----------------------------
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS customer_rates (
    customer_name TEXT PRIMARY KEY,
    rate_per_pallet_week REAL NOT NULL DEFAULT 0,
    handling_fee_flat REAL NOT NULL DEFAULT 0,
    handling_fee_per_pallet REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'GBP',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.all("PRAGMA table_info(customer_rates)", (err, columns) => {
    if (err || !columns) return;
    const hasWeekRate = columns.some((c) => c.name === "rate_per_pallet_week");
    const hasDayRate = columns.some((c) => c.name === "rate_per_pallet_day");
    const hasHandlingFlat = columns.some((c) => c.name === "handling_fee_flat");
    const hasHandlingPerPallet = columns.some((c) => c.name === "handling_fee_per_pallet");
    const hasCurrency = columns.some((c) => c.name === "currency");

    if (!hasWeekRate) {
      db.run("ALTER TABLE customer_rates ADD COLUMN rate_per_pallet_week REAL NOT NULL DEFAULT 0");
      if (hasDayRate) {
        db.run("UPDATE customer_rates SET rate_per_pallet_week = rate_per_pallet_day * 7 WHERE rate_per_pallet_week = 0");
      }
    }
    if (!hasHandlingFlat) db.run("ALTER TABLE customer_rates ADD COLUMN handling_fee_flat REAL NOT NULL DEFAULT 0");
    if (!hasHandlingPerPallet) db.run("ALTER TABLE customer_rates ADD COLUMN handling_fee_per_pallet REAL NOT NULL DEFAULT 0");
    if (!hasCurrency) db.run("ALTER TABLE customer_rates ADD COLUMN currency TEXT NOT NULL DEFAULT 'GBP'");
  });

  db.run(`CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    billing_cycle TEXT NOT NULL DEFAULT 'WEEKLY',
    pallet_days INTEGER NOT NULL,
    rate_per_pallet_day REAL NOT NULL DEFAULT 0,
    rate_per_pallet_week REAL NOT NULL DEFAULT 0,
    handling_fee_flat REAL NOT NULL DEFAULT 0,
    handling_fee_per_pallet REAL NOT NULL DEFAULT 0,
    handled_pallets INTEGER NOT NULL DEFAULT 0,
    base_total REAL NOT NULL DEFAULT 0,
    handling_total REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'GBP',
    details_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.all("PRAGMA table_info(invoices)", (err, columns) => {
    if (err || !columns) return;
    const has = (name) => columns.some((c) => c.name === name);
    if (!has("billing_cycle")) db.run("ALTER TABLE invoices ADD COLUMN billing_cycle TEXT NOT NULL DEFAULT 'WEEKLY'");
    if (!has("rate_per_pallet_week")) db.run("ALTER TABLE invoices ADD COLUMN rate_per_pallet_week REAL NOT NULL DEFAULT 0");
    if (!has("handling_fee_flat")) db.run("ALTER TABLE invoices ADD COLUMN handling_fee_flat REAL NOT NULL DEFAULT 0");
    if (!has("handling_fee_per_pallet")) db.run("ALTER TABLE invoices ADD COLUMN handling_fee_per_pallet REAL NOT NULL DEFAULT 0");
    if (!has("handled_pallets")) db.run("ALTER TABLE invoices ADD COLUMN handled_pallets INTEGER NOT NULL DEFAULT 0");
    if (!has("base_total")) db.run("ALTER TABLE invoices ADD COLUMN base_total REAL NOT NULL DEFAULT 0");
    if (!has("handling_total")) db.run("ALTER TABLE invoices ADD COLUMN handling_total REAL NOT NULL DEFAULT 0");
    if (!has("currency")) db.run("ALTER TABLE invoices ADD COLUMN currency TEXT NOT NULL DEFAULT 'GBP'");
    if (!has("details_json")) db.run("ALTER TABLE invoices ADD COLUMN details_json TEXT");
    if (!has("status")) db.run("ALTER TABLE invoices ADD COLUMN status TEXT NOT NULL DEFAULT 'DRAFT'");
    if (!has("sent_at")) db.run("ALTER TABLE invoices ADD COLUMN sent_at TEXT");
    if (!has("paid_at")) db.run("ALTER TABLE invoices ADD COLUMN paid_at TEXT");
  });
});

function parseYmdToUtcDate(ymd) {
  const s = String(ymd || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

function formatYmdUtc(dateObj) {
  return new Date(dateObj).toISOString().slice(0, 10);
}

function addDaysYmd(ymd, daysToAdd) {
  const d = parseYmdToUtcDate(ymd);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + daysToAdd);
  return formatYmdUtc(d);
}

function endOfDayIso(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59)).toISOString();
}

function calculateInvoiceMetrics(customerName, startDate, endDate, done) {
  const start = parseYmdToUtcDate(startDate);
  const end = parseYmdToUtcDate(endDate);
  if (!start || !end || end < start) return done(new Error("Invalid date range"));

  db.all(
    `SELECT pallet_id, action, quantity_after, timestamp
     FROM activity_log
     WHERE customer_name = ?
       AND datetime(timestamp) <= datetime(?)
     ORDER BY datetime(timestamp) ASC`,
    [customerName, `${endDate}T23:59:59Z`],
    (err, rows) => {
      if (err) return done(err);

      const state = new Map();
      let idx = 0;
      const dayMs = 24 * 60 * 60 * 1000;
      const days = Math.floor((end - start) / dayMs) + 1;
      let palletDays = 0;

      for (let di = 0; di < days; di++) {
        const day = new Date(start.getTime() + di * dayMs);
        const cutoff = endOfDayIso(day);

        while (idx < rows.length && new Date(rows[idx].timestamp).toISOString() <= cutoff) {
          const r = rows[idx];
          const qty = Number(r.quantity_after) || 0;

          if (r.action === "CHECK_IN") state.set(r.pallet_id, qty);
          else if (r.action === "CHECK_OUT") state.delete(r.pallet_id);
          else if (r.action === "PARTIAL_REMOVE") (qty > 0 ? state.set(r.pallet_id, qty) : state.delete(r.pallet_id));

          idx++;
        }

        let occ = 0;
        for (const q of state.values()) occ += (Number(q) || 0);
        palletDays += occ;
      }

      db.get(
        `SELECT COALESCE(SUM(quantity_changed), 0) AS handled
         FROM activity_log
         WHERE customer_name = ?
           AND action = 'CHECK_IN'
           AND datetime(timestamp) >= datetime(?)
           AND datetime(timestamp) <= datetime(?)`,
        [customerName, `${startDate}T00:00:00Z`, `${endDate}T23:59:59Z`],
        (err2, row2) => {
          if (err2) return done(err2);
          return done(null, {
            pallet_days: palletDays,
            days_in_range: days,
            handled_pallets: Number(row2?.handled || 0),
            pallet_weeks: palletDays / 7,
          });
        }
      );
    }
  );
}

function buildInvoicePreview(input, done) {
  const customerName = String(input?.customer_name || "").trim();
  const startDate = String(input?.start_date || "").trim();
  const endDate = String(input?.end_date || "").trim();
  const rateOverrideRaw = input?.rate_per_pallet_week;
  const handlingFlatOverrideRaw = input?.handling_fee_flat;
  const handlingPerPalletOverrideRaw = input?.handling_fee_per_pallet;

  const rateOverride = Number(rateOverrideRaw);
  const handlingFlatOverride = Number(handlingFlatOverrideRaw);
  const handlingPerPalletOverride = Number(handlingPerPalletOverrideRaw);

  if (!customerName || !startDate || !endDate) {
    return done(new Error("customer_name, start_date, end_date are required"));
  }

  calculateInvoiceMetrics(customerName, startDate, endDate, (err, metrics) => {
    if (err) return done(err);

    db.get("SELECT * FROM customer_rates WHERE customer_name = ?", [customerName], (rateErr, rateRow) => {
      if (rateErr) return done(rateErr);

      const hasRateOverride = rateOverrideRaw !== undefined && rateOverrideRaw !== null && rateOverrideRaw !== "";
      const hasFlatOverride = handlingFlatOverrideRaw !== undefined && handlingFlatOverrideRaw !== null && handlingFlatOverrideRaw !== "";
      const hasPerPalletOverride = handlingPerPalletOverrideRaw !== undefined && handlingPerPalletOverrideRaw !== null && handlingPerPalletOverrideRaw !== "";

      const ratePerWeek = hasRateOverride ? rateOverride : Number(rateRow?.rate_per_pallet_week || 0);
      const handlingFlat = hasFlatOverride ? handlingFlatOverride : Number(rateRow?.handling_fee_flat || 0);
      const handlingPerPallet = hasPerPalletOverride ? handlingPerPalletOverride : Number(rateRow?.handling_fee_per_pallet || 0);
      const currency = String(rateRow?.currency || "GBP");

      if (!Number.isFinite(ratePerWeek) || ratePerWeek < 0) {
        return done(new Error("No valid customer weekly rate found. Set /api/rates first or pass rate_per_pallet_week."));
      }
      if (!Number.isFinite(handlingFlat) || handlingFlat < 0) {
        return done(new Error("handling_fee_flat must be a valid number >= 0"));
      }
      if (!Number.isFinite(handlingPerPallet) || handlingPerPallet < 0) {
        return done(new Error("handling_fee_per_pallet must be a valid number >= 0"));
      }

      const baseTotal = Number((metrics.pallet_weeks * ratePerWeek).toFixed(2));
      const handlingTotal = Number((handlingFlat + (handlingPerPallet * metrics.handled_pallets)).toFixed(2));
      const grandTotal = Number((baseTotal + handlingTotal).toFixed(2));

      return done(null, {
        ok: true,
        billing_cycle: "WEEKLY",
        customer_name: customerName,
        start_date: startDate,
        end_date: endDate,
        days_in_range: metrics.days_in_range,
        pallet_days: metrics.pallet_days,
        pallet_weeks: Number(metrics.pallet_weeks.toFixed(4)),
        handled_pallets: metrics.handled_pallets,
        rate_per_pallet_week: ratePerWeek,
        handling_fee_flat: handlingFlat,
        handling_fee_per_pallet: handlingPerPallet,
        currency,
        base_total: baseTotal,
        handling_total: handlingTotal,
        total: grandTotal,
      });
    });
  });
}

app.get("/api/rates", (req, res) => {
  const customer = String(req.query.customer || "").trim();
  if (customer) {
    db.get("SELECT * FROM customer_rates WHERE customer_name = ?", [customer], (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });
      if (!row) return res.status(404).json({ error: "Rate not found" });
      return res.json(row);
    });
    return;
  }

  db.all("SELECT * FROM customer_rates ORDER BY customer_name ASC", (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" });
    res.json(rows || []);
  });
});

app.post("/api/rates", (req, res) => {
  const customerName = String(req.body?.customer_name || "").trim();
  const ratePerWeek = Number(req.body?.rate_per_pallet_week);
  const handlingFlat = Number(req.body?.handling_fee_flat || 0);
  const handlingPerPallet = Number(req.body?.handling_fee_per_pallet || 0);
  const currency = String(req.body?.currency || "GBP").trim() || "GBP";

  if (!customerName || !Number.isFinite(ratePerWeek) || ratePerWeek < 0) {
    return res.status(400).json({ error: "customer_name and valid rate_per_pallet_week are required" });
  }
  if (!Number.isFinite(handlingFlat) || handlingFlat < 0) {
    return res.status(400).json({ error: "handling_fee_flat must be a valid number >= 0" });
  }
  if (!Number.isFinite(handlingPerPallet) || handlingPerPallet < 0) {
    return res.status(400).json({ error: "handling_fee_per_pallet must be a valid number >= 0" });
  }

  db.run(
    `INSERT INTO customer_rates (customer_name, rate_per_pallet_week, handling_fee_flat, handling_fee_per_pallet, currency, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(customer_name) DO UPDATE SET
       rate_per_pallet_week = excluded.rate_per_pallet_week,
       handling_fee_flat = excluded.handling_fee_flat,
       handling_fee_per_pallet = excluded.handling_fee_per_pallet,
       currency = excluded.currency,
       updated_at = datetime('now')`,
    [customerName, ratePerWeek, handlingFlat, handlingPerPallet, currency],
    (err) => {
      if (err) return res.status(500).json({ error: "DB error" });
      db.get("SELECT * FROM customer_rates WHERE customer_name = ?", [customerName], (err2, row) => {
        if (err2) return res.status(500).json({ error: "DB error" });
        res.json({ ok: true, rate: row });
      });
    }
  );
});

app.get("/api/invoices", (req, res) => {
  const customer = String(req.query.customer || "").trim();
  const sql = customer
    ? "SELECT * FROM invoices WHERE customer_name = ? ORDER BY id DESC LIMIT 200"
    : "SELECT * FROM invoices ORDER BY id DESC LIMIT 200";

  db.all(sql, customer ? [customer] : [], (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" });
    res.json(rows || []);
  });
});

app.post("/api/invoices/preview", (req, res) => {
  buildInvoicePreview(req.body || {}, (err, preview) => {
    if (err) return res.status(400).json({ error: err.message || "Invalid invoice inputs" });
    res.json(preview);
  });
});

app.post("/api/invoices/generate", (req, res) => {
  const customerName = String(req.body?.customer_name || "").trim();
  let startDate = String(req.body?.start_date || "").trim();
  let endDate = String(req.body?.end_date || "").trim();

  if (!startDate && req.body?.week_start) {
    startDate = String(req.body.week_start).trim();
    endDate = addDaysYmd(startDate, 6) || "";
  }

  if (!customerName || !startDate || !endDate) {
    return res.status(400).json({ error: "customer_name and either (start_date + end_date) or week_start are required" });
  }

  const previewInput = {
    customer_name: customerName,
    start_date: startDate,
    end_date: endDate,
    rate_per_pallet_week: req.body?.rate_per_pallet_week,
    handling_fee_flat: req.body?.handling_fee_flat,
    handling_fee_per_pallet: req.body?.handling_fee_per_pallet,
  };

  buildInvoicePreview(previewInput, (previewErr, preview) => {
    if (previewErr) return res.status(400).json({ error: previewErr.message || "Invalid invoice inputs" });

    const detailsJson = JSON.stringify({
      days_in_range: preview.days_in_range,
      pallet_weeks: preview.pallet_weeks,
      handled_pallets: preview.handled_pallets,
    });

    db.run(
      `INSERT INTO invoices (
          customer_name, start_date, end_date, billing_cycle, pallet_days,
          rate_per_pallet_day, rate_per_pallet_week,
          handling_fee_flat, handling_fee_per_pallet, handled_pallets,
          base_total, handling_total, total, currency, details_json, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        preview.customer_name,
        preview.start_date,
        preview.end_date,
        "WEEKLY",
        preview.pallet_days,
        Number((preview.rate_per_pallet_week / 7).toFixed(6)),
        preview.rate_per_pallet_week,
        preview.handling_fee_flat,
        preview.handling_fee_per_pallet,
        preview.handled_pallets,
        preview.base_total,
        preview.handling_total,
        preview.total,
        preview.currency || "GBP",
        detailsJson,
        "DRAFT",
      ],
      function insertInvoice(err) {
        if (err) return res.status(500).json({ error: "DB error" });
        res.json({
          ok: true,
          invoice_id: this.lastID,
          ...preview,
        });
      }
    );
  });
});

app.post("/api/invoices/:id/status", (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status || "").trim().toUpperCase();
  const allowed = new Set(["DRAFT", "SENT", "PAID"]);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid invoice id" });
  }
  if (!allowed.has(status)) {
    return res.status(400).json({ error: "status must be one of DRAFT, SENT, PAID" });
  }

  const nowIso = new Date().toISOString();
  let sentAt = null;
  let paidAt = null;
  if (status === "SENT") sentAt = nowIso;
  if (status === "PAID") paidAt = nowIso;

  db.run(
    `UPDATE invoices
     SET status = ?, sent_at = ?, paid_at = ?
     WHERE id = ?`,
    [status, sentAt, paidAt, id],
    function onStatusUpdated(err) {
      if (err) return res.status(500).json({ error: "DB error" });
      if (this.changes === 0) return res.status(404).json({ error: "Invoice not found" });

      db.get("SELECT * FROM invoices WHERE id = ?", [id], (err2, row) => {
        if (err2) return res.status(500).json({ error: "DB error" });
        return res.json({ ok: true, invoice: row });
      });
    }
  );
});

// Local IP helper
function getLocalIPs() {
  const { networkInterfaces } = require("os");
  const nets = networkInterfaces();
  const results = [];

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) results.push(net.address);
    }
  }
  return results;
}

// Redirect HTTP -> HTTPS if SSL exists
if (hasSSL) {
  app.use((req, res, next) => {
    if (!req.secure) {
      const host = req.headers.host ? req.headers.host.split(":")[0] : req.hostname;
      return res.redirect(301, `https://${host}:${HTTPS_PORT}${req.originalUrl}`);
    }
    next();
  });
}

// Start servers
if (hasSSL) {
httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => {
    console.log("\n🔒 HTTPS Warehouse Server Running (with WebSocket)!");
    console.log(`\n📱 Secure access (recommended):`);
    console.log(`   Local: https://localhost:${HTTPS_PORT}`);

    const ips = getLocalIPs();
    ips.forEach((ip) => console.log(`   Network: https://${ip}:${HTTPS_PORT}`));

    console.log("\n✅ Camera scanning works over HTTPS (accept self-signed cert warning if shown).\n");
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`HTTP redirect server listening on http://localhost:${PORT} -> HTTPS`);
  });
} else {
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log("\n🚀 Warehouse Server Running (HTTP with WebSocket)!");
    console.log(`\n📱 Access from devices on network:`);
    console.log(`   Local: http://localhost:${PORT}`);

    const ips = getLocalIPs();
    ips.forEach((ip) => console.log(`   Network: http://${ip}:${PORT}`));

    console.log("\n⚠️  HTTPS not enabled - camera features may require HTTPS in some browsers.");
    console.log("   To enable HTTPS, run: npm run generate-ssl\n");
  });
}
