# Warehouse Pallet Tracker

A real time warehouse management system for tracking pallets across rack locations using QR codes and mobile devices.

## Features

- 📱 **Mobile-First Design** - Works on any smartphone or tablet
- 📷 **QR Code Scanning** - Fast check-in/check-out using device camera
- 🗄️ **480 Rack Locations** - Pre-configured for A-J aisles, 8 racks, 6 levels
- ✅ **Two-Step Check-In** - Scan pallet → Scan location → Done
- ❌ **Quick Check-Out** - Single scan to remove pallet
- 🔍 **Real-Time Search** - Find pallets by product ID or location
- 📊 **Live Statistics** - Track total pallets, occupied/available locations
- 💾 **CSV Export** - Download complete inventory reports
- 👥 **Multi-User Support** - Multiple devices access the same database
- 📝 **Manual Entry** - Fallback option when QR codes unavailable

## 🏗️ System Architecture
┌─────────────────┐
│ Mobile Phones │ (Scan QR codes, view inventory)
│ & Tablets │
└────────┬────────┘
│ WiFi/Network
│
┌────────▼────────┐
│ Windows PC │ (Server + Database)
│ - Node.js │
│ - SQLite DB │
└─────────────────┘

text

## 🚀 Installation

### Prerequisites

- **Node.js** (v14 or higher) - [Download here](https://nodejs.org/)
- **Git** (optional, for cloning)

### Setup on Mac (Development)

```bash
# Clone the repository
git clone https://github.com/irons28/Warehouse-tracker.git
cd Warehouse-tracker

# Install dependencies
npm install

# Start the server
node server.js