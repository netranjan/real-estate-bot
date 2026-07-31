const pool = require('../db/pool');

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ═══════════════════════════════════════
    // 1. NODE TYPES
    // ═══════════════════════════════════════
    await client.query(`
      INSERT INTO node_types (node_type_code, node_type_name, description)
      VALUES 
        ('send_message', 'Send WhatsApp Message', 'Sends text, button, or list message'),
        ('collect_input', 'Collect User Input', 'Asks a question and saves the answer'),
        ('show_list', 'Show Dynamic List', 'Displays a dynamic list from database'),
        ('send_document', 'Send Document/PDF', 'Sends a document or brochure'),
        ('book_appointment', 'Book Site Visit', 'Handles site visit booking'),
        ('request_callback', 'Request Callback', 'Creates a callback request with SLA'),
        ('property_welcome', 'Property Welcome', 'Shows property welcome message + action buttons'),
        ('assign_agent', 'Assign to Agent', 'Assigns lead to a sales agent'),
        ('calculate_score', 'Calculate AI Score', 'Calculates and updates lead score')
      ON CONFLICT (node_type_code) DO NOTHING;
    `);

    // ═══════════════════════════════════════
    // 2. DEFAULT CLIENT
    // ═══════════════════════════════════════
    let clientId;
    const existingClient = await client.query(
      `SELECT client_id FROM clients WHERE business_name = 'Default Client'`
    );

    if (existingClient.rows.length > 0) {
      clientId = existingClient.rows[0].client_id;
    } else {
      const newClient = await client.query(
        `INSERT INTO clients (business_name, meta_waba_id, meta_phone_number_id, meta_access_token, active)
         VALUES ('Default Client', 'YOUR_WABA_ID', 'YOUR_PHONE_NUMBER_ID', 'YOUR_ACCESS_TOKEN', TRUE)
         RETURNING client_id`
      );
      clientId = newClient.rows[0].client_id;
    }

    // ═══════════════════════════════════════
    // 3. DEFAULT AGENT
    // ═══════════════════════════════════════
    const existingAgent = await client.query(
      `SELECT agent_id FROM agents WHERE client_id = $1 LIMIT 1`,
      [clientId]
    );
    if (existingAgent.rows.length === 0) {
      await client.query(
        `INSERT INTO agents (client_id, name, phone, active)
         VALUES ($1, 'Sales Team', '+91 98765 43210', TRUE)`,
        [clientId]
      );
    }

    // ═══════════════════════════════════════
    // 4. SAMPLE PROPERTIES
    // ═══════════════════════════════════════
    const propertyData = [
      {
        name: 'Project Alpha (Tower A)',
        price: 10500000,
        config: '["3 BHK"]',
        possession: '2026-12-01',
        brochure: 'https://your-cdn.com/alpha-brochure.pdf',
        welcome: 'Welcome to Project Alpha! Premium 3 BHK homes with world-class amenities. Possession: Dec 2026.',
        map: 'https://maps.google.com/?q=Project+Alpha+Wakad',
        ref: 'PROJ_ALPHA_01'
      },
      {
        name: 'Project Beta Greens',
        price: 11200000,
        config: '["3 BHK"]',
        possession: null,
        brochure: 'https://your-cdn.com/beta-brochure.pdf',
        welcome: 'Welcome to Project Beta Greens! Ready to move 3 BHK homes surrounded by lush greenery.',
        map: 'https://maps.google.com/?q=Project+Beta+Wakad',
        ref: 'PROJ_BETA_02'
      },
      {
        name: 'Project Gamma',
        price: 11800000,
        config: '["3 BHK"]',
        possession: null,
        brochure: 'https://your-cdn.com/gamma-brochure.pdf',
        welcome: 'Welcome to Project Gamma! Luxury ready-to-move homes with premium fittings and modern design.',
        map: 'https://maps.google.com/?q=Project+Gamma+Wakad',
        ref: 'PROJ_GAMMA_03'
      }
    ];

    for (const p of propertyData) {
      await client.query(
        `INSERT INTO properties 
          (client_id, property_name, price_min, price_max, configuration_types, possession_date,
           brochure_url, welcome_message, google_map_url, referral_code, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)
         ON CONFLICT (referral_code) DO UPDATE SET
           property_name = EXCLUDED.property_name,
           price_min = EXCLUDED.price_min,
           price_max = EXCLUDED.price_max,
           configuration_types = EXCLUDED.configuration_types,
           possession_date = EXCLUDED.possession_date,
           brochure_url = EXCLUDED.brochure_url,
           welcome_message = EXCLUDED.welcome_message,
           google_map_url = EXCLUDED.google_map_url,
           active = EXCLUDED.active;`,
        [clientId, p.name, p.price, p.price, p.config, p.possession, p.brochure, p.welcome, p.map, p.ref]
      );
    }

    const props = await client.query(
      `SELECT property_id, property_name, referral_code FROM properties WHERE client_id = $1`,
      [clientId]
    );

    // ═══════════════════════════════════════
    // 5. VISIT OPTIONS
    // ═══════════════════════════════════════
    for (const p of props.rows) {
      await client.query(
        `DELETE FROM property_visit_options WHERE property_id = $1`,
        [p.property_id]
      );
      await client.query(
        `INSERT INTO property_visit_options (property_id, option_name, active)
         VALUES ($1, 'Visit Saturday', TRUE), ($1, 'Visit Sunday', TRUE), ($1, 'Other Day', TRUE)`,
        [p.property_id]
      );
    }

    // ═══════════════════════════════════════
    // 6. CONVERSATION FLOW
    // ═══════════════════════════════════════
    let flowId;
    const existingFlow = await client.query(
      `SELECT flow_id FROM conversation_flows WHERE client_id = $1 AND flow_name = 'Main Flow'`,
      [clientId]
    );

    if (existingFlow.rows.length > 0) {
      flowId = existingFlow.rows[0].flow_id;
      await client.query(`DELETE FROM flow_edges WHERE flow_id = $1`, [flowId]);
      await client.query(`DELETE FROM flow_nodes WHERE flow_id = $1`, [flowId]);
    } else {
      const newFlow = await client.query(
        `INSERT INTO conversation_flows (client_id, flow_name, flow_version, is_active, start_node_id)
         VALUES ($1, 'Main Flow', 1, TRUE, NULL)
         RETURNING flow_id`,
        [clientId]
      );
      flowId = newFlow.rows[0].flow_id;
    }

    // ═══════════════════════════════════════
    // 7. FLOW NODES
    // ═══════════════════════════════════════
    const nodeDefs = [
      {
        code: 'welcome',
        type: 'collect_input',
        name: 'Welcome & Purpose',
        config: {
          text: 'Namaste! Welcome to our Properties. 🙏\n\nThank you for your interest. How can we assist you today?',
          options: [
            { label: 'Buy for Self-Use', value: 'Buy for Self-Use' },
            { label: 'Investment / Rent', value: 'Investment / Rent' }
          ],
          field: 'requirement_type',
          header: 'Welcome'
        }
      },
      {
        code: 'config_select',
        type: 'collect_input',
        name: 'Configuration Selection',
        config: {
          text: 'Great! Please choose your preferred unit configuration:',
          options: [
            { label: '2 BHK (750 - 850 sq.ft.)', value: '2 BHK' },
            { label: '3 BHK (1100 - 1300 sq.ft.)', value: '3 BHK' },
            { label: '3.5 BHK / Duplex (1500+ sq.ft.)', value: '3.5 BHK / Duplex' },
            { label: 'Penthouse / Custom', value: 'Penthouse / Custom' }
          ],
          field: 'configuration',
          list_title: 'Configurations',
          button_text: 'View Configs'
        }
      },
      {
        code: 'budget_select',
        type: 'collect_input',
        name: 'Budget Selection',
        config: {
          text: 'Understood. What is your overall budget range (All Inclusive)?',
          options: [
            { label: '₹85 L – ₹1.0 Cr', value: '₹85 L – ₹1.0 Cr' },
            { label: '₹1.0 Cr – ₹1.2 Cr', value: '₹1.0 Cr – ₹1.2 Cr' },
            { label: '₹1.2 Cr – ₹1.5 Cr', value: '₹1.2 Cr – ₹1.5 Cr' },
            { label: 'Above ₹1.5 Cr', value: 'Above ₹1.5 Cr' }
          ],
          field: 'budget_range',
          list_title: 'Budget Ranges',
          button_text: 'Select Budget'
        }
      },
      {
        code: 'property_listing',
        type: 'show_list',
        name: 'Property Listing',
        config: {
          text: 'Here are the top matching properties for your selection:',
          source_table: 'properties',
          filter_by: ['configuration', 'budget_range'],
          list_title: 'Matching Properties',
          button_text: 'Select Property'
        }
      },
      {
        code: 'property_welcome',
        type: 'property_welcome',
        name: 'Property Welcome & Actions',
        config: {
          suffix_text: '\n\nWhat would you like to do next?',
          buttons: [
            { id: 'GET_BROCHURE', title: 'Get Brochure' },
            { id: 'BOOK_VISIT', title: 'Book Site Visit' },
            { id: 'CALL_ME', title: 'Call Me First' }
          ],
          header: 'Property Details'
        }
      },
      {
        code: 'send_brochure',
        type: 'send_document',
        name: 'Send Brochure',
        config: {
          document_url_field: 'selected_property.brochure_url',
          filename: 'Brochure.pdf',
          fallback_text: 'Sorry, the brochure is not available at the moment.'
        }
      },
      {
        code: 'post_brochure_menu',
        type: 'send_message',
        name: 'Post-Brochure Menu',
        config: {
          text: 'Would you like to take the next step?',
          buttons: [
            { id: 'BOOK_VISIT', title: 'Book Site Visit' },
            { id: 'CALL_ME', title: 'Call Me First' }
          ]
        }
      },
      {
        code: 'visit_day_select',
        type: 'show_list',
        name: 'Visit Day Selection',
        config: {
          text: 'Please choose your preferred visit day:',
          source_table: 'property_visit_options',
          list_title: 'Visit Options',
          button_text: 'Choose Day'
        }
      },
      {
        code: 'visit_confirmed',
        type: 'send_message',
        name: 'Visit Confirmation',
        config: {
          text: 'Your site visit has been booked successfully. Our team will contact you shortly with the details. 🏠\n\nE-Gate Pass Status: PENDING'
        }
      },
      {
        code: 'request_callback',
        type: 'request_callback',
        name: 'Request Callback',
        config: {
          sla_minutes: 15,
          assign_to: 'available_agent',
          confirmation_message: 'Got it! Our sales representative will call you on this WhatsApp number within 15 minutes. 📞\n\nThank you for reaching out!'
        }
      }
    ];

    const nodeMap = {};
    for (let i = 0; i < nodeDefs.length; i++) {
      const n = nodeDefs[i];
      const res = await client.query(
        `INSERT INTO flow_nodes (flow_id, node_code, node_type, node_name, config, order_index, active)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE)
         RETURNING node_id`,
        [flowId, n.code, n.type, n.name, JSON.stringify(n.config), i]
      );
      nodeMap[n.code] = res.rows[0].node_id;
    }

    await client.query(
      `UPDATE conversation_flows SET start_node_id = $1 WHERE flow_id = $2`,
      [nodeMap['welcome'], flowId]
    );

    // ═══════════════════════════════════════
    // 8. FLOW EDGES
    // ═══════════════════════════════════════
    const staticEdges = [
      { from: 'welcome', to: 'config_select', input: 'Buy for Self-Use' },
      { from: 'welcome', to: 'config_select', input: 'Investment / Rent' },
      { from: 'config_select', to: 'budget_select', input: null },
      { from: 'budget_select', to: 'property_listing', input: null },
      { from: 'property_listing', to: 'property_welcome', input: null }, // dynamic property IDs handled below
      { from: 'property_welcome', to: 'send_brochure', input: 'GET_BROCHURE' },
      { from: 'property_welcome', to: 'visit_day_select', input: 'BOOK_VISIT' },
      { from: 'property_welcome', to: 'request_callback', input: 'CALL_ME' },
      { from: 'send_brochure', to: 'post_brochure_menu', input: null },
      { from: 'post_brochure_menu', to: 'visit_day_select', input: 'BOOK_VISIT' },
      { from: 'post_brochure_menu', to: 'request_callback', input: 'CALL_ME' }
    ];

    for (const e of staticEdges) {
      await client.query(
        `INSERT INTO flow_edges (flow_id, from_node_id, to_node_id, user_input_value, condition_logic, priority, active)
         VALUES ($1, $2, $3, $4, '{}', 0, TRUE)`,
        [flowId, nodeMap[e.from], nodeMap[e.to], e.input]
      );
    }

    // Dynamic property edges: PROPERTY_1 → property_welcome
    for (const p of props.rows) {
      await client.query(
        `INSERT INTO flow_edges (flow_id, from_node_id, to_node_id, user_input_value, condition_logic, priority, active)
         VALUES ($1, $2, $3, $4, '{}', 0, TRUE)`,
        [flowId, nodeMap['property_listing'], nodeMap['property_welcome'], `PROPERTY_${p.property_id}`]
      );
    }

    // Dynamic visit option edges: VISIT_1 → visit_confirmed
    const visitOpts = await client.query(
      `SELECT visit_option_id FROM property_visit_options WHERE property_id = ANY($1)`,
      [props.rows.map(p => p.property_id)]
    );
    for (const vo of visitOpts.rows) {
      await client.query(
        `INSERT INTO flow_edges (flow_id, from_node_id, to_node_id, user_input_value, condition_logic, priority, active)
         VALUES ($1, $2, $3, $4, '{}', 0, TRUE)`,
        [flowId, nodeMap['visit_day_select'], nodeMap['visit_confirmed'], `VISIT_${vo.visit_option_id}`]
      );
    }

    await client.query('COMMIT');

    console.log('✅ Flow seeded successfully');
    console.log('├─ Client ID:', clientId);
    console.log('├─ Flow ID:', flowId);
    console.log('├─ Properties:', props.rows.map(p => p.property_name).join(', '));
    console.log('├─ Nodes:', Object.keys(nodeMap).length);
    console.log('└─ Visit Options:', visitOpts.rows.length);
    console.log('\n⚠️  ACTION REQUIRED: Update .env DEFAULT_CLIENT_ID=' + clientId);
    console.log('⚠️  ACTION REQUIRED: Replace YOUR_WABA_ID, YOUR_PHONE_NUMBER_ID, YOUR_ACCESS_TOKEN in clients table');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();