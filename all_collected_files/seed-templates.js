const pool = require('../db/pool');

const FLOWS = [
  {
    name: 'Standard Sales Flow',
    nodes: [
      {
        code: 'welcome',
        type: 'collect_input',
        name: 'Welcome',
        config: {
          text: 'Hello! 👋 Welcome to our premium property portal.\n\nMay I know your purpose? Are you looking for a home for self use or as an investment?',
          options: [
            { label: '🏠 Self Use', value: 'SELF_USE' },
            { label: '📈 Investment', value: 'INVESTMENT' }
          ],
          field: 'requirement_type'
        }
      },
      {
        code: 'config',
        type: 'collect_input',
        name: 'Configuration',
        config: {
          text: 'What configuration are you looking for?',
          options: [
            { label: '1 BHK', value: '1BHK' },
            { label: '2 BHK', value: '2BHK' },
            { label: '3 BHK', value: '3BHK' },
            { label: '4 BHK', value: '4BHK' },
            { label: '5 BHK', value: '5BHK' },
            { label: 'Studio', value: 'STUDIO' }
          ],
          field: 'configuration'
        }
      },
      {
        code: 'list',
        type: 'show_list',
        name: 'Properties',
        config: {
          text: 'Here are matching properties:',
          filter_mode: 'filtered',
          match_dimensions: ['configuration']
        }
      },
      {
        code: 'prop_welcome',
        type: 'property_welcome',
        name: 'Property Details',
        config: {
          // Main message comes from properties.welcome_message DB column
          // suffix_text is appended after it
          suffix_text: 'Tap an option below to proceed:',
          buttons: [
            { title: '📄 Brochure', id: 'BROCHURE' },
            { title: '📅 Site Visit', id: 'VISIT' },
            { title: '📞 Callback', id: 'CALL' }
          ]
        }
      },
      {
        code: 'brochure',
        type: 'send_document',
        name: 'Brochure',
        config: {
          text: 'Here is the brochure you requested.',
          source: 'property',
          property_asset_type: 'all'
        }
      },
      {
        code: 'visit',
        type: 'book_appointment',
        name: 'Book Visit',
        config: {
          text: 'Let\'s schedule your site visit! 🏗️\n\nPlease pick a convenient slot.'
        }
      },
      {
        code: 'callback',
        type: 'request_callback',
        name: 'Callback',
        config: {
          confirmation_message: 'Got it! Our sales representative will call you on this WhatsApp number within 15 minutes. 📞'
        }
      },
      {
        code: 'end',
        type: 'end_conversation',
        name: 'End',
        config: {
          text: 'Thank you for reaching out!'
        }
      }
    ],
    edges: [
      // Welcome → Configuration
      { from: 'welcome', to: 'config', input: 'SELF_USE' },
      { from: 'welcome', to: 'config', input: 'INVESTMENT' },

      // Configuration → Property List (default)
      { from: 'config', to: 'list' },

      // Property List → Property Welcome (default fallback for any selection)
      { from: 'list', to: 'prop_welcome' },

      // Property Welcome → Actions
      { from: 'prop_welcome', to: 'brochure', input: 'BROCHURE' },
      { from: 'prop_welcome', to: 'visit', input: 'VISIT' },
      { from: 'prop_welcome', to: 'callback', input: 'CALL' },

      // Brochure → back to Property Welcome (user can pick another action)
      { from: 'brochure', to: 'prop_welcome' },

      // Visit / Callback → End
      { from: 'visit', to: 'end' },
      { from: 'callback', to: 'end' }
    ]
  }
];

async function seed(clientId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const tpl of FLOWS) {
      const flowRes = await client.query(
        `INSERT INTO conversation_flows (client_id, flow_name, flow_version, is_active, start_node_id)
         VALUES ($1, $2, 1, FALSE, NULL) RETURNING flow_id`,
        [clientId, tpl.name]
      );
      const flowId = flowRes.rows[0].flow_id;

      const nodeMap = {};
      for (let i = 0; i < tpl.nodes.length; i++) {
        const n = tpl.nodes[i];
        const res = await client.query(
          `INSERT INTO flow_nodes (flow_id, node_code, node_type, node_name, config, order_index, active)
           VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING node_id`,
          [flowId, n.code, n.type, n.name, JSON.stringify(n.config), i]
        );
        nodeMap[n.code] = res.rows[0].node_id;
      }

      if (tpl.nodes.length > 0) {
        await client.query(
          `UPDATE conversation_flows SET start_node_id=$1 WHERE flow_id=$2`,
          [nodeMap[tpl.nodes[0].code], flowId]
        );
      }

      for (const e of tpl.edges) {
        await client.query(
          `INSERT INTO flow_edges (flow_id, from_node_id, to_node_id, user_input_value, condition_logic, priority, active)
           VALUES ($1, $2, $3, $4, '{}', 0, TRUE)`,
          [flowId, nodeMap[e.from], nodeMap[e.to], e.input || null]
        );
      }

      // Dynamic edges: list → prop_welcome for every property
      if (nodeMap['list'] && nodeMap['prop_welcome']) {
        const props = await client.query(
          `SELECT property_id FROM properties WHERE client_id=$1`,
          [clientId]
        );
        for (const p of props.rows) {
          await client.query(
            `INSERT INTO flow_edges (flow_id, from_node_id, to_node_id, user_input_value, condition_logic, priority, active)
             VALUES ($1, $2, $3, $4, '{}', 0, TRUE)`,
            [flowId, nodeMap['list'], nodeMap['prop_welcome'], `PROPERTY_${p.property_id}`]
          );
        }
      }
    }

    await client.query('COMMIT');
    console.log(`✅ Seeded ${FLOWS.length} flow template(s) for client ${clientId}`);
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