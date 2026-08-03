const pool = require('../db/pool');

async function seed(clientId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Insert Property
    const propertyRes = await client.query(
      `INSERT INTO properties (
        client_id, property_name, location, configuration_types, 
        price_min, price_max, possession_date, brochure_url, 
        welcome_message, active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)
      RETURNING property_id`,
      [
        clientId,
        'Beta Green Apartments',
        'Green Valley Road, Sector 12, Pune',
        JSON.stringify(['2BHK', '3BHK']),
        6500000,      // ₹65L
        8500000,      // ₹85L
        '2024-06-01', // Ready to move
        'https://example.com/beta-greens-brochure.pdf',
        '🏡 Great choice! Here are the key details for {{property_name}}.\n\n📍 Location: {{property_location}}\n\n🛋️ Configuration: 2 & 3 BHK Luxury Apartments\n\n💰 Starting Price: {{property_price}}*\n\n🔑 Possession Status: {{property_possession}}\n\n✨ Key Highlights & Amenities:\n\n• Modern Clubhouse & Fully Equipped Gym\n\n• 24/7 Gated Security & Power Backup\n\n• Landscaped Gardens & Swimming Pool\n\n• 10 mins from Highway & Metro Station'
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

    // 3. Insert Visit Slots (real upcoming dates)
    const now = new Date();
    const slots = [];
    
    // Tomorrow 10 AM, 2 PM, 4 PM
    const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
    slots.push({ label: 'Tomorrow 10:00 AM', time: new Date(tomorrow.setHours(10, 0, 0, 0)) });
    slots.push({ label: 'Tomorrow 2:00 PM', time: new Date(tomorrow.setHours(14, 0, 0, 0)) });
    slots.push({ label: 'Tomorrow 4:00 PM', time: new Date(tomorrow.setHours(16, 0, 0, 0)) });

    // Saturday 11 AM, 3 PM
    const saturday = new Date(now); saturday.setDate(saturday.getDate() + (6 - saturday.getDay() + 7) % 7 || 7);
    slots.push({ label: 'Saturday 11:00 AM', time: new Date(saturday.setHours(11, 0, 0, 0)) });
    slots.push({ label: 'Saturday 3:00 PM', time: new Date(saturday.setHours(15, 0, 0, 0)) });

    // Sunday 10 AM, 12 PM
    const sunday = new Date(saturday); sunday.setDate(sunday.getDate() + 1);
    slots.push({ label: 'Sunday 10:00 AM', time: new Date(sunday.setHours(10, 0, 0, 0)) });
    slots.push({ label: 'Sunday 12:00 PM', time: new Date(sunday.setHours(12, 0, 0, 0)) });

    for (const s of slots) {
      await client.query(
        `INSERT INTO property_visit_options (property_id, slot_label, slot_time, active)
         VALUES ($1, $2, $3, TRUE)`,
        [propertyId, s.label, s.time.toISOString()]
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