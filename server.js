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

// Initialize database
const db = new sqlite3.Database("./warehouse.db", (err) => {
  if (err) {
    console.error("Database connection error:", err);
  } else {
    console.log("✓ Connected to warehouse database");
  }
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
      const hasPalletQuantity = columns.some(
        (col) => col.name === "pallet_quantity",
      );
      const hasParts = columns.some((col) => col.name === "parts");
      const hasCurrentUnits = columns.some((col) => col.name === "current_units");
      const hasScannedBy = columns.some((col) => col.name === "scanned_by");

      if (hasQuantity && !hasPalletQuantity) {
        console.log("🔄 Migrating database to new schema...");

        db.run(
          "ALTER TABLE pallets ADD COLUMN pallet_quantity INTEGER DEFAULT 1",
        );
        db.run(
          "ALTER TABLE pallets ADD COLUMN product_quantity INTEGER DEFAULT 0",
        );

        setTimeout(() => {
          db.run(
            "UPDATE pallets SET pallet_quantity = quantity WHERE pallet_quantity IS NULL OR pallet_quantity = 0",
          );
          db.run(
            "UPDATE pallets SET product_quantity = 0 WHERE product_quantity IS NULL",
          );
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
            // Initialize current_units from product_quantity for existing records
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
    },
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
    },
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
    },
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
      const aisles = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
      const stmt = db.prepare(
        "INSERT INTO locations (id, aisle, rack, level) VALUES (?, ?, ?, ?)",
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

// API Routes

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
    
    // Parse parts JSON for each row
    const palletsWithParts = rows.map(row => ({
      ...row,
      parts: row.parts ? JSON.parse(row.parts) : null
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
      
      // Parse parts JSON for each row
      const palletsWithParts = rows.map(row => ({
        ...row,
        parts: row.parts ? JSON.parse(row.parts) : null
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
    return res
      .status(400)
      .json({ error: "Customer name, Product ID and location required" });
  }

  const palletId = id || `PLT-${Date.now()}`;
  const partsJson = parts ? JSON.stringify(parts) : null;
  const currentUnits = product_quantity || 0; // Initialize to full capacity
  const scannedByPerson = scanned_by || 'Unknown';

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

      // Log activity
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
        ],
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
    },
  );
});

// Partial quantity removal
app.post("/api/pallets/:id/remove-quantity", (req, res) => {
  const { id } = req.params;
  const { quantity_to_remove, scanned_by } = req.body;
  const scannedByPerson = scanned_by || 'Unknown';

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
        return res
          .status(400)
          .json({ error: "Cannot remove more than available quantity" });
      }

      if (quantityAfter === 0) {
        // Remove entire pallet if quantity reaches 0
        db.run(
          'UPDATE pallets SET status = "removed", date_removed = CURRENT_TIMESTAMP, pallet_quantity = 0 WHERE id = ?',
          [row.id],
          (err) => {
            if (err) return res.status(500).json({ error: err.message });

            db.run("UPDATE locations SET is_occupied = 0 WHERE id = ?", [
              row.location,
            ]);

            // Log activity
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
              ],
            );

            res.json({
              message: "All pallets removed. Location freed.",
              quantity_removed: quantity_to_remove,
              quantity_remaining: 0,
              pallet_removed: true,
            });
          },
        );
      } else {
        // Update quantity
        db.run(
          "UPDATE pallets SET pallet_quantity = ? WHERE id = ?",
          [quantityAfter, row.id],
          (err) => {
            if (err) return res.status(500).json({ error: err.message });

            // Log activity
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
              ],
            );

            res.json({
              message: `Removed ${quantity_to_remove} pallet(s). ${quantityAfter} remaining.`,
              quantity_removed: quantity_to_remove,
              quantity_remaining: quantityAfter,
              pallet_removed: false,
            });
          },
        );
      }
    }
  );
});

// Remove partial units from pallet (NEW FEATURE)
app.post("/api/pallets/:id/remove-units", (req, res) => {
  const { id } = req.params;
  const { units_to_remove, scanned_by } = req.body;
  const scannedByPerson = scanned_by || 'Unknown';

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
          error: "This pallet does not track individual units. Use remove-quantity endpoint instead." 
        });
      }

      // Use current_units (actual remaining) not product_quantity (original spec)
      const currentUnits = row.current_units || row.product_quantity;
      const totalUnits = row.pallet_quantity * currentUnits;
      const unitsAfter = totalUnits - units_to_remove;

      if (unitsAfter < 0) {
        return res.status(400).json({ 
          error: `Cannot remove ${units_to_remove} units. Only ${totalUnits} units available.` 
        });
      }

      // Calculate new pallet quantity
      const newPalletQuantity = Math.ceil(unitsAfter / row.product_quantity);

      if (unitsAfter === 0 || newPalletQuantity === 0) {
        // Remove entire pallet if all units are removed
        db.run(
          'UPDATE pallets SET status = "removed", date_removed = CURRENT_TIMESTAMP, pallet_quantity = 0, product_quantity = 0 WHERE id = ?',
          [row.id],
          (err) => {
            if (err) return res.status(500).json({ error: err.message });

            db.run("UPDATE locations SET is_occupied = 0 WHERE id = ?", [row.location]);

            // Log activity
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
              ],
            );

            res.json({
              message: "All units removed. Location freed.",
              units_removed: units_to_remove,
              units_remaining: 0,
              pallets_remaining: 0,
              pallet_removed: true,
              updated_pallet: {
                id: row.id,
                pallet_quantity: 0,
                product_quantity: 0,
                status: 'removed'
              }
            });
          },
        );
      } else {
        // The pallet stays in the rack until all units are gone
        // product_quantity = original spec (never changes)
        // current_units = actual remaining units on the pallet (what we update)
        
        db.run(
          "UPDATE pallets SET current_units = ? WHERE id = ?",
          [unitsAfter, row.id],
          (err) => {
            if (err) return res.status(500).json({ error: err.message });

            // Log activity
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
              ],
            );

            res.json({
              message: `Removed ${units_to_remove} units. ${unitsAfter} of ${row.product_quantity} units remaining on pallet.`,
              units_removed: units_to_remove,
              units_remaining: unitsAfter,
              pallets_remaining: row.pallet_quantity, // Still 1 pallet
              units_per_pallet: row.product_quantity, // Original spec (unchanged)
              current_units: unitsAfter, // Actual remaining
              pallet_removed: false,
              updated_pallet: {
                id: row.id,
                pallet_quantity: row.pallet_quantity, // Stays same (1)
                product_quantity: row.product_quantity, // Original spec (stays 56)
                current_units: unitsAfter, // Updated (e.g., 46 after removing 10)
                total_units: unitsAfter
              }
            });
          }
        );
      }
    }
  );
});

// Check out a pallet (remove entirely)
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

          db.run("UPDATE locations SET is_occupied = 0 WHERE id = ?", [
            row.location,
          ]);

          // Log activity
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
            ],
          );

          res.json({ message: "Pallet checked out successfully" });
        },
      );
    }
  );
});

// Get all locations
app.get("/api/locations", (req, res) => {
  db.all("SELECT * FROM locations ORDER BY aisle, rack, level", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Get stats
app.get("/api/stats", (req, res) => {
  const { customer } = req.query;

  let palletQuery =
    'SELECT COUNT(*) as total_pallets FROM pallets WHERE status = "active"';
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

// Get activity log
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

    const csv = [
      "Customer,Product ID,Pallet Qty,Product Qty,Location,Date Added",
    ]
      .concat(
        rows.map(
          (p) =>
            `${p.customer_name},${p.product_id},${p.pallet_quantity},${p.product_quantity},${p.location},${p.date_added}`,
        ),
      )
      .join("\n");

    res.header("Content-Type", "text/csv");
    res.attachment("inventory.csv");
    res.send(csv);
  });
});

// Get list of customers
app.get("/api/customers", (req, res) => {
  db.all(
    'SELECT DISTINCT customer_name FROM pallets WHERE status = "active" ORDER BY customer_name',
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows.map((r) => r.customer_name));
    }
  );
});

// Get network interfaces to display IP addresses
function getLocalIPs() {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  const results = [];

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        results.push(net.address);
      }
    }
  }
  
  return results;
}

// Check if SSL certificates exist
const sslKeyPath = path.join(__dirname, 'ssl', 'key.pem');
const sslCertPath = path.join(__dirname, 'ssl', 'cert.pem');
const hasSSL = fs.existsSync(sslKeyPath) && fs.existsSync(sslCertPath);

// Start HTTP server
http.createServer(app).listen(PORT, "0.0.0.0", () => {
  console.log("\n🚀 Warehouse Server Running!");
  console.log(`\n📱 Access from devices on network:`);
  console.log(`   Local: http://localhost:${PORT}`);
  
  const ips = getLocalIPs();
  ips.forEach((ip) => {
    console.log(`   Network: http://${ip}:${PORT}`);
  });
  
  if (!hasSSL) {
    console.log("\n⚠️  HTTPS not enabled - camera features require HTTPS!");
    console.log("   To enable HTTPS, run: npm run generate-ssl");
  }
  console.log("");
});

// Start HTTPS server if certificates exist
if (hasSSL) {
  const httpsOptions = {
    key: fs.readFileSync(sslKeyPath),
    cert: fs.readFileSync(sslCertPath),
  };

  https.createServer(httpsOptions, app).listen(HTTPS_PORT, "0.0.0.0", () => {
    console.log("\n🔒 HTTPS Server Running!");
    console.log(`\n📱 Secure access (for camera features):`);
    console.log(`   Local: https://localhost:${HTTPS_PORT}`);
    
    const ips = getLocalIPs();
    ips.forEach((ip) => {
      console.log(`   Network: https://${ip}:${HTTPS_PORT}`);
    });
    
    console.log("\n✅ Camera scanning will work on mobile devices!");
    console.log(
      "   (You may need to accept the self-signed certificate warning)\n",
    );
  });
}