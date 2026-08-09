const pool = require('../db/pool');

// Free publicly available media URLs
const PUBLIC_IMAGES = {
  beta1: 'https://picsum.photos/seed/betagreenext/800/600',
  beta2: 'https://picsum.photos/seed/betagreenlr/800/600',
  skyline1: 'https://picsum.photos/seed/skylinetower/800/600',
  skyline2: 'https://picsum.photos/seed/skylinepool/800/600',
  royal1: 'https://picsum.photos/seed/royalvillaext/800/600',
  royal2: 'https://picsum.photos/seed/royalvillaint/800/600',
  urban1: 'https://picsum.photos/seed/urbanbldg/800/600',
  urban2: 'https://picsum.photos/seed/urbanflat/800/600',
};

const PUBLIC_VIDEOS = {
  tour1: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
  tour2: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
};

const PUBLIC_PDF = 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf';

const PROPERTIES = [
  {
    name: 'Beta Green Apartments',
    configs: ['2BHK', '3BHK'],
    priceMin: 6500000,
    priceMax: 8500000,
    possession: '2024-06-01',
    brochure: PUBLIC_PDF,
    welcome: `🏡 Great choice! Here are the key details for {{property_name}}.

🛋️ Configuration: 2 & 3 BHK Luxury Apartments
💰 Starting Price: {{property_price}}*
🔑 Possession Status: {{property_possession}}

✨ Key Highlights:
• Modern Clubhouse & Fully Equipped Gym
• 24/7 Gated Security & Power Backup
• Landscaped Gardens & Swimming Pool
• 10 mins from Highway & Metro Station`,
    assets: [
      { type: 'image', url: PUBLIC_IMAGES.beta1, name: 'Exterior View' },
      { type: 'image', url: PUBLIC_IMAGES.beta2, name: 'Living Room' },
      { type: 'video', url: PUBLIC_VIDEOS.tour1, name: 'Site Tour' },
      { type: 'document', url: PUBLIC_PDF, name: 'Floor Plan' }
    ],
    slots: ['Tomorrow 10:00 AM', 'Tomorrow 2:00 PM', 'Tomorrow 4:00 PM', 'Saturday 11:00 AM', 'Saturday 3:00 PM']
  },
  {
    name: 'Skyline Heights',
    configs: ['1BHK', '2BHK', 'STUDIO'],
    priceMin: 4500000,
    priceMax: 6200000,
    possession: '2025-03-01',
    brochure: PUBLIC_PDF,
    welcome: `🏙️ Welcome to {{property_name}}!

🛋️ Configuration: 1, 2 BHK & Studio Apartments
💰 Price Range: {{property_price}} - {{property_price_max}}*
🔑 Possession: {{property_possession}}

✨ Highlights:
• Rooftop Infinity Pool & Sky Lounge
• Co-working Spaces & Library
• Pet-friendly Community
• 5 mins from IT Park`,
    assets: [
      { type: 'image', url: PUBLIC_IMAGES.skyline1, name: 'Tower View' },
      { type: 'image', url: PUBLIC_IMAGES.skyline2, name: 'Pool Deck' },
      { type: 'document', url: PUBLIC_PDF, name: 'Brochure' }
    ],
    slots: ['Tomorrow 11:00 AM', 'Tomorrow 3:00 PM', 'Sunday 10:00 AM', 'Sunday 2:00 PM']
  },
  {
    name: 'Royal Villa Estates',
    configs: ['4BHK', '5BHK'],
    priceMin: 12000000,
    priceMax: 18000000,
    possession: '2023-12-01',
    brochure: PUBLIC_PDF,
    welcome: `👑 Welcome to {{property_name}} — where luxury meets legacy.

🛋️ Configuration: 4 & 5 BHK Independent Villas
💰 Starting Price: {{property_price}}*
🔑 Possession: {{property_possession}} (Ready to Move)

✨ Highlights:
• Private Garden & Home Theatre
• Smart Home Automation
• Golf Course Access
• 24/7 Concierge Service`,
    assets: [
      { type: 'image', url: PUBLIC_IMAGES.royal1, name: 'Villa Exterior' },
      { type: 'image', url: PUBLIC_IMAGES.royal2, name: 'Interior' },
      { type: 'video', url: PUBLIC_VIDEOS.tour2, name: 'Walkthrough' },
      { type: 'document', url: PUBLIC_PDF, name: 'Brochure' }
    ],
    slots: ['Saturday 10:00 AM', 'Saturday 4:00 PM', 'Sunday 11:00 AM']
  },
  {
    name: 'Urban Nest Budget Homes',
    configs: ['1BHK', '2BHK'],
    priceMin: 2800000,
    priceMax: 4200000,
    possession: '2025-08-01',
    brochure: PUBLIC_PDF,
    welcome: `🏠 Welcome to {{property_name}} — affordable living, premium lifestyle.

🛋️ Configuration: 1 & 2 BHK Compact Homes
💰 Price Range: {{property_price}} - {{property_price_max}}*
🔑 Possession: {{property_possession}}

✨ Highlights:
• Zero Maintenance for 2 Years
• Kids Play Area & Jogging Track
• EMI Starts at ₹21,000/month
• Near Proposed Metro Line`,
    assets: [
      { type: 'image', url: PUBLIC_IMAGES.urban1, name: 'Building View' },
      { type: 'image', url: PUBLIC_IMAGES.urban2, name: 'Sample Flat' },
      { type: 'document', url: PUBLIC_PDF, name: 'Brochure' }
    ],
    slots: ['Tomorrow 12:00 PM', 'Tomorrow 5:00 PM', 'Saturday 2:00 PM']
  }
];

async function seed(clientId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const p of PROPERTIES) {
      const propertyRes = await client.query(
        `INSERT INTO properties (
          client_id, property_name, configuration_types,
          price_min, price_max, possession_date, brochure_url,
          welcome_message, active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
        RETURNING property_id`,
        [
          clientId,
          p.name,
          JSON.stringify(p.configs),
          p.priceMin,
          p.priceMax,
          p.possession,
          p.brochure,
          p.welcome
        ]
      );
      const propertyId = propertyRes.rows[0].property_id;

      for (const a of p.assets) {
        await client.query(
          `INSERT INTO media_assets (property_id, asset_type, asset_url, asset_name)
           VALUES ($1, $2, $3, $4)`,
          [propertyId, a.type, a.url, a.name]
        );
      }

      for (const slot of p.slots) {
        await client.query(
          `INSERT INTO property_visit_options (property_id, option_name, active)
           VALUES ($1, $2, TRUE)`,
          [propertyId, slot]
        );
      }

      console.log(`✅ Seeded "${p.name}" (ID: ${propertyId}) with ${p.assets.length} assets and ${p.slots.length} slots.`);
    }

    await client.query('COMMIT');
    console.log(`\n🎉 Seeded ${PROPERTIES.length} properties for client ${clientId}`);
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