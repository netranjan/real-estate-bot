const pool = require('../db/pool');

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔧 Checking database...');

    // Check if leads has client_id
    const checkLead = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'leads' AND column_name = 'client_id'
    `);
    
    if (checkLead.rows.length === 0) {
      console.log('➕ Adding client_id to leads...');
      await client.query(`ALTER TABLE leads ADD COLUMN client_id INTEGER DEFAULT 1`);
      await client.query(`ALTER TABLE leads ADD CONSTRAINT fk_leads_client FOREIGN KEY (client_id) REFERENCES clients(client_id) ON DELETE CASCADE`);
      console.log('✅ leads.client_id added');
    }

    // Check if properties has client_id
    const checkProp = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'properties' AND column_name = 'client_id'
    `);
    
    if (checkProp.rows.length === 0) {
      console.log('➕ Adding client_id to properties...');
      await client.query(`ALTER TABLE properties ADD COLUMN client_id INTEGER DEFAULT 1`);
      console.log('✅ properties.client_id added');
    }

    // Check if properties has new columns
    const cols = ['price_min', 'price_max', 'configuration_types', 'possession_date', 'brochure_url'];
    for (const col of cols) {
      const check = await client.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'properties' AND column_name = $1
      `, [col]);
      if (check.rows.length === 0) {
        let type = 'VARCHAR(500)';
        if (col === 'price_min' || col === 'price_max') type = 'NUMERIC(15,2)';
        if (col === 'configuration_types') type = 'JSONB';
        if (col === 'possession_date') type = 'DATE';
        await client.query(`ALTER TABLE properties ADD COLUMN ${col} ${type}`);
        console.log(`✅ properties.${col} added`);
      }
    }

    // Ensure clients table exists with one default client
    const clientCheck = await client.query(`SELECT * FROM clients LIMIT 1`);
    if (clientCheck.rows.length === 0) {
      await client.query(`
        INSERT INTO clients (business_name, active) 
        VALUES ('Godrej Properties Wakad', TRUE)
      `);
      console.log('✅ Default client created');
    }

    // Ensure node_types exist
    await client.query(`
      INSERT INTO node_types (node_type_code, node_type_name, description) VALUES
      ('send_message', 'Send WhatsApp Message', 'Sends text, button, or list message'),
      ('collect_input', 'Collect User Input', 'Asks a question and saves the answer'),
      ('show_list', 'Show Dynamic List', 'Displays a dynamic list from database'),
      ('send_document', 'Send Document/PDF', 'Sends a document or brochure'),
      ('book_appointment', 'Book Site Visit', 'Handles site visit booking'),
      ('request_callback', 'Request Callback', 'Creates a callback request with SLA'),
      ('property_welcome', 'Property Welcome', 'Shows property welcome message + actions'),
      ('assign_agent', 'Assign to Agent', 'Assigns lead to a sales agent'),
      ('calculate_score', 'Calculate AI Score', 'Calculates and updates lead score')
      ON CONFLICT (node_type_code) DO NOTHING
    `);
    console.log('✅ Node types ready');

    console.log('🎉 Migration complete. Run: npm run seed');
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    await pool.end();
    process.exit(1);
  }
}

migrate();