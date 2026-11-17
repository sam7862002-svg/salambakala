const crypto = require('crypto');
const readline = require('readline');

const SECRET_SALT = 'RETAIL_POS_SECURE_KEY_2026';
// നിങ്ങളുടെ ഇഷ്ടമുള്ള അഡ്മിൻ പാസ്‌വേർഡ് ഇവിടെ നൽകുക (ഉദാഹരണത്തിന്: ALADI2026)
const ADMIN_PASSWORD = 'ALADI2026'; 

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('=====================================');
console.log('🔐 ADMIN LICENSE KEY GENERATOR');
console.log('=====================================');

rl.question('Enter Admin Password: ', (inputPassword) => {
  if (inputPassword.trim() !== ADMIN_PASSWORD) {
    console.log('\n❌ Incorrect Password! Access Denied.');
    rl.close();
    return;
  }

  console.log('\n✔ Access Granted!\n');
  rl.question('Enter Client Machine ID: ', (hwId) => {
    const cleanId = hwId.trim();
    const hash = crypto.createHmac('sha256', SECRET_SALT).update(cleanId).digest('hex').toUpperCase();
    const licenseKey = `${hash.slice(0, 4)}-${hash.slice(4, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}`;
    
    console.log('\n=====================================');
    console.log('Generated License Key: ', licenseKey);
    console.log('=====================================\n');
    rl.close();
  });
});