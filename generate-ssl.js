const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const sslDir = path.join(__dirname, 'ssl');

// Create ssl directory if it doesn't exist
if (!fs.existsSync(sslDir)) {
  fs.mkdirSync(sslDir);
  console.log('✓ Created ssl directory');
}

console.log('\n🔐 Generating self-signed SSL certificates...\n');

try {
  // Generate self-signed certificate valid for 365 days
  execSync(
    `openssl req -x509 -newkey rsa:4096 -keyout ${path.join(sslDir, 'key.pem')} -out ${path.join(sslDir, 'cert.pem')} -days 365 -nodes -subj "/C=US/ST=State/L=City/O=Warehouse/CN=localhost"`,
    { stdio: 'inherit' }
  );

  console.log('\n✅ SSL certificates generated successfully!');
  console.log(`   Location: ${sslDir}`);
  console.log('\n📝 Files created:');
  console.log(`   - key.pem (private key)`);
  console.log(`   - cert.pem (certificate)`);
  console.log('\n🚀 You can now start the server with HTTPS support!');
  console.log('   Run: node server.js\n');
  console.log('⚠️  Note: Your browser will show a security warning because');
  console.log('   this is a self-signed certificate. Click "Advanced" and');
  console.log('   "Proceed" to accept it.\n');
} catch (error) {
  console.error('\n❌ Error generating certificates.');
  console.error('\nOpenSSL might not be installed. Please install it:');
  console.error('  Windows: Download from https://slproweb.com/products/Win32OpenSSL.html');
  console.error('  Mac: brew install openssl');
  console.error('  Linux: sudo apt-get install openssl\n');
  console.error('Or use the manual method below:\n');
  
  console.log('Manual generation command:');
  console.log('openssl req -x509 -newkey rsa:4096 -keyout ssl/key.pem -out ssl/cert.pem -days 365 -nodes\n');
  
  process.exit(1);
}