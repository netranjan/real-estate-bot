// scripts/seed-client.js
// Usage: node scripts/seed-client.js "Client Name" [waba_id] [phone_number_id] [access_token]
const pool = require('../db/pool');

const clientName = process.argv[2];
if (!clientName) {
  console.error('❌ Please provide a client name.');
  console.error('   Usage: node scripts/seed-client.js "My Real Estate Co" [waba_id] [phone_number_id] [access_token]');
  process.exit(1);
}

const metaWabaId = process.argv[3] || null;
const metaPhoneNumberId = process.argv[4] || null;
const metaAccessToken = process.argv[5] || null;

(async () => {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `INSERT INTO clients (business_name, meta_waba_id, meta_phone_number_id, meta_access_token, active)
       VALUES ($1, $2, $3, $4, TRUE) RETURNING client_id, business_name`,
      [clientName, metaWabaId, metaPhoneNumberId, metaAccessToken]
    );

    const newClient = res.rows[0];
    console.log(`✅ Client created successfully!`);
    console.log(`   ID: ${newClient.client_id}`);
    console.log(`   Name: ${newClient.business_name}`);
    console.log(`\n   Next step: node scripts/seed-templates.js ${newClient.client_id}`);
  } catch (err) {
    console.error('❌ Failed to create client:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();