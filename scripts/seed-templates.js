// scripts/seed-templates.js
const pool = require('../db/pool');

const FLOWS = [
  // Standard Property Sales Flow
  {
    name: 'Standard Sales Flow',
    nodes: [
      {
        code: 'welcome',
        type: 'collect_input',
        name: 'Welcome',
        config: {
          text: 'Welcome! How can we help?',
          options: [
            { label: 'Self Use', value: 'BUY' },
            { label: 'Investment', value: 'RENT' }
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
          text: 'What would you like to do?',
          buttons: [
            { title: 'Brochure', id: 'BROCHURE' },
            { title: 'Book Visit', id: 'VISIT' },
            { title: 'Callback', id: 'CALL' }
          ]
        }
      },
      {
        code: 'media',
        type: 'send_document',
        name: 'Brochure',
        config: {
          media_items: [
            {
              type: 'document',
              url: 'https://example.com/brochure.pdf',
              caption: 'Here is the brochure you requested',
              filename: 'Brochure.pdf'
            }
          ]
        }
      },
      {
        code: 'visit',
        type: 'book_appointment',
        name: 'Book Visit',
        config: { options: [] } // empty = use property's own slots
      },
      {
        code: 'callback',
        type: 'request_callback',
        name: 'Callback',
        config: {}
      },
      {
        code: 'end',
        type: 'end_conversation',
        name: 'End',
        config: { text: 'Thank you for your interest!' }
      }
    ],
    edges: [
      // Welcome → Configuration (both Self Use & Investment)
      { from: 'welcome', to: 'config', input: 'BUY' },
      { from: 'welcome', to: 'config', input: 'RENT' },

      // Configuration → Property List
      { from: 'config', to: 'list' },

      // Property Welcome → Actions
      { from: 'prop_welcome', to: 'media', input: 'BROCHURE' },
      { from: 'prop_welcome', to: 'visit', input: 'VISIT' },
      { from: 'prop_welcome', to: 'callback', input: 'CALL' },

      // Brochure → back to Property Welcome (user can choose another action)
      { from: 'media', to: 'prop_welcome' },

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