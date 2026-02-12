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
    io.emit("inventory_update", { action, data, timestamp: Date.now() });
  } catch (e) {
    console.error("Broadcast failed:", e);
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
                "UPDATE pallets SET current_units = product_quantity WHERE current_units IS NULL OR current_units = 0",
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
      parts: row.parts ? JSON.parse(row.parts) : null,
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
        parts: row.parts ? JSON.parse(row.parts) : null,
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
  const currentUnits = product_quantity || 0;
  const scannedByPerson = scanned_by || "Unknown";

  db.run(
    "INSERT INTO pallets (id, customer_name, product_id, pallet_quantity, product_quantity, current_units, location, parts, scanned_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      palletId,
      customer_name,
      product_id,
      pallet_quantity || 1,
      product_quantity || 0,
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
          pallet_quantity || 1,
          pallet_quantity || 1,
          location,
        ]
      );

      res.json({
        id: palletId,
        customer_name,
        product_id,
        pallet_quantity: pallet_quantity || 1,
        product_quantity: product_quantity || 0,
        location,
        parts: parts || null,
        message: "Pallet checked in successfully",
      });

      broadcastInventoryChange("add_pallet", {
        id: palletId,
        customer_name,
        product_id,
        pallet_quantity: pallet_quantity || 1,
        product_quantity: product_quantity || 0,
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

      const currentUnits = row.current_units || row.product_quantity;
      const totalUnits = row.pallet_quantity * currentUnits;
      const unitsAfter = totalUnits - units_to_remove;

      if (unitsAfter < 0) {
        return res.status(400).json({
          error: `Cannot remove ${units_to_remove} units. Only ${totalUnits} units available.`,
        });
      }

      if (unitsAfter === 0) {
        db.run(
          'UPDATE pallets SET status = "removed", date_removed = CURRENT_TIMESTAMP, pallet_quantity = 0, product_quantity = 0 WHERE id = ?',
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
                `Removed ${units_to_remove} units. ${unitsAfter} of ${row.product_quantity} units remaining on pallet.`,
                scannedByPerson,
              ]
            );

            res.json({
              message: `Removed ${units_to_remove} units. ${unitsAfter} of ${row.product_quantity} units remaining on pallet.`,
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
  
// -----------------------------
// Invoicing (v1) - pallet-day billing
// -----------------------------
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS customer_rates (
    customer_name TEXT PRIMARY KEY,
    rate_per_pallet_day REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'GBP',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    pallet_days INTEGER NOT NULL,
    rate_per_pallet_day REAL NOT NULL,
    total REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
});

app.get('/api/invoices', (req, res) => {
  const customer = req.query.customer;
  const sql = customer
    ? `SELECT * FROM invoices WHERE customer_name = ? ORDER BY id DESC LIMIT 200`
    : `SELECT * FROM invoices ORDER BY id DESC LIMIT 200`;

  db.all(sql, customer ? [customer] : [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows || []);
  });
});

app.post('/api/invoices/generate', (req, res) => {
  const customer_name = String(req.body?.customer_name || '').trim();
  const start_date = String(req.body?.start_date || '').trim();
  const end_date = String(req.body?.end_date || '').trim();
  const rate = Number(req.body?.rate_per_pallet_day || 0);

  if (!customer_name || !start_date || !end_date || !Number.isFinite(rate) || rate <= 0) {
    return res.status(400).json({ error: 'customer_name, start_date, end_date, rate_per_pallet_day required' });
  }

  const start = new Date(start_date + 'T00:00:00Z');
  const end = new Date(end_date + 'T00:00:00Z');
  if (isNaN(start) || isNaN(end) || end < start) return res.status(400).json({ error: 'Invalid date range' });

  db.all(
    `SELECT pallet_id, action, quantity_after, timestamp
     FROM activity_log
     WHERE customer_name = ?
       AND datetime(timestamp) <= datetime(?)
     ORDER BY datetime(timestamp) ASC`,
    [customer_name, end_date + 'T23:59:59Z'],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'DB error' });

      const state = new Map();
      let idx = 0;
      const dayMs = 24 * 60 * 60 * 1000;
      const days = Math.floor((end - start) / dayMs) + 1;

      const endOfDayIso = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59)).toISOString();

      let palletDays = 0;

      for (let di = 0; di < days; di++) {
        const day = new Date(start.getTime() + di * dayMs);
        const cutoff = endOfDayIso(day);

        while (idx < rows.length && new Date(rows[idx].timestamp).toISOString() <= cutoff) {
          const r = rows[idx];
          const qty = Number(r.quantity_after) || 0;

          if (r.action === 'CHECK_IN') state.set(r.pallet_id, qty);
          else if (r.action === 'CHECK_OUT') state.delete(r.pallet_id);
          else if (r.action === 'PARTIAL_REMOVE') (qty > 0 ? state.set(r.pallet_id, qty) : state.delete(r.pallet_id));

          idx++;
        }

        let occ = 0;
        for (const q of state.values()) occ += (Number(q) || 0);
        palletDays += occ;
      }

      const total = Number((palletDays * rate).toFixed(2));

      db.run(
        `INSERT INTO invoices (customer_name, start_date, end_date, pallet_days, rate_per_pallet_day, total)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [customer_name, start_date, end_date, palletDays, rate, total],
        function (err2) {
          if (err2) return res.status(500).json({ error: 'DB error' });
          res.json({ ok: true, invoice_id: this.lastID, customer_name, start_date, end_date, pallet_days: palletDays, rate_per_pallet_day: rate, total });
        }
      );
    }
  );
});


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