const pool = require('../db/pool');

async function seed(clientId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Insert Property
    const propertyRes = await client.query(
      `INSERT INTO properties (
    client_id, property_name, configuration_types, 
    price_min, price_max, possession_date, brochure_url, 
    welcome_message, active
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
  RETURNING property_id`,
      [
        clientId,
        'Beta Green Apartments',
        JSON.stringify(['2BHK', '3BHK']),
        6500000,
        8500000,
        '2024-06-01',
        'https://example.com/beta-greens-brochure.pdf',
        '🏡 Great choice! Here are the key details for {{property_name}}.\n\n🛋️ Configuration: 2 & 3 BHK Luxury Apartments\n\n💰 Starting Price: {{property_price}}*\n\n🔑 Possession Status: {{property_possession}}\n\n✨ Key Highlights & Amenities:\n\n• Modern Clubhouse & Fully Equipped Gym\n\n• 24/7 Gated Security & Power Backup\n\n• Landscaped Gardens & Swimming Pool\n\n• 10 mins from Highway & Metro Station'
      ]
    );
    const propertyId = propertyRes.rows[0].property_id;

    // 2. Insert Media Assets
    const assets = [
      { type: 'image', url: 'https://example.com/beta-greens-1.jpg', name: 'Exterior View' },
      { type: 'image', url: 'https://example.com/beta-greens-2.jpg', name: 'Living Room' },
      { type: 'image', url: 'https://example.com/beta-greens-3.jpg', name: 'Master Bedroom' },
      { type: 'video', url: 'https://example.com/beta-greens-tour.mp4', name: 'Site Tour' },
      { type: 'document', url: 'https://example.com/beta-greens-floorplan.pdf', name: 'Floor Plan' }
    ];

    for (const a of assets) {
      await client.query(
        `INSERT INTO media_assets (property_id, asset_type, asset_url, asset_name)
         VALUES ($1, $2, $3, $4)`,
        [propertyId, a.type, a.url, a.name]
      );
    }

    // 3. Insert Visit Slots (FIXED: uses schema column 'option_name' only)
    const slots = [
      'Tomorrow 10:00 AM',
      'Tomorrow 2:00 PM',
      'Tomorrow 4:00 PM',
      'Saturday 11:00 AM',
      'Saturday 3:00 PM',
      'Sunday 10:00 AM',
      'Sunday 12:00 PM'
    ];

    for (const label of slots) {
      await client.query(
        `INSERT INTO property_visit_options (property_id, option_name, active)
         VALUES ($1, $2, TRUE)`,
        [propertyId, label]
      );
    }

    await client.query('COMMIT');
    console.log(`✅ Seeded property "Beta Green Apartments" (ID: ${propertyId}) with ${assets.length} assets and ${slots.length} visit slots.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

const targetClientId = parseInt(process.argv[2], 10) || 1;
seed(targetClientId);