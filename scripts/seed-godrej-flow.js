const pool = require('../db/pool');

const FLOW_TEMPLATES = [
  {
    name: 'Real Estate Standard Flow',
    nodes: [
      {
        code: 'welcome',
        type: 'collect_input',
        name: 'Welcome & Purpose',
        config: {
          text: 'Namaste! Welcome to our Properties. 🙏\nHow can we assist you today?',
          options: [
            { label: 'Buy for Self-Use', value: 'Buy for Self-Use' },
            { label: 'Investment / Rent', value: 'Investment / Rent' }
          ],
          field: 'requirement_type'
        }
      },
      {
        code: 'config_select',
        type: 'collect_input',
        name: 'Configuration',
        config: {
          text: 'What configuration are you looking for?',
          options: [
            { label: '2 BHK', value: '2 BHK' },
            { label: '3 BHK', value: '3 BHK' }
          ],
          field: 'configuration'
        }
      },
      {
        code: 'budget_select',
        type: 'collect_input',
        name: 'Budget Range',
        config: {
          text: 'What is your budget?',
          options: [
            { label: '₹85L – ₹1Cr', value: '₹85L – ₹1Cr' },
            { label: '₹1Cr – ₹1.2Cr', value: '₹1Cr – ₹1.2Cr' }
          ],
          field: 'budget_range'
        }
      },
      {
        code: 'property_listing',
        type: 'show_list',
        name: 'Property Listing',
        config: {
          text: 'Here are matching properties:',
          source_table: 'properties',
          filter_mode: 'all',
          match_dimensions: []
        }
      },
      {
        code: 'property_welcome',
        type: 'property_welcome',
        name: 'Property Welcome',
        config: {
          text: 'What would you like to do?',
          buttons: [
            { id: 'GET_BROCHURE', title: 'Get Brochure' },
            { id: 'BOOK_VISIT', title: 'Book Site Visit' },
            { id: 'CALL_ME', title: 'Call Me' }
          ]
        }
      },
      {
        code: 'send_brochure',
        type: 'send_document',
        name: 'Send Brochure',
        config: {
          text: 'Here is your brochure:',
          document_url_field: 'selected_property.brochure_url',
          filename: 'Brochure.pdf'
        }
      },
      {
        code: 'visit_day_select',
        type: 'show_list',
        name: 'Visit Day',
        config: {
          text: 'Choose a preferred day:',
          source_table: 'property_visit_options'
        }
      },
      {
        code: 'visit_confirmed',
        type: 'send_message',
        name: 'Visit Confirmed',
        config: {
          text: 'Your visit is booked! Our team will contact you.'
        }
      },
      {
        code: 'request_callback',
        type: 'request_callback',
        name: 'Callback',
        config: {
          text: 'We will call you back shortly.',
          sla_minutes: 15
        }
      },
      {
        code: 'end_conversation',
        type: 'end_conversation',
        name: 'End Conversation',
        config: {
          text: 'Thank you for reaching out! Have a great day. 👋'
        }
      }
    ],
    edges: [
      { from: 'welcome', to: 'config_select', input: 'Buy for Self-Use' },
      { from: 'welcome', to: 'config_select', input: 'Investment / Rent' },
      { from: 'config_select', to: 'budget_select', input: null },
      { from: 'budget_select', to: 'property_listing', input: null },
      { from: 'property_listing', to: 'property_welcome', input: null }, // dynamic property IDs handled below
      { from: 'property_welcome', to: 'send_brochure', input: 'GET_BROCHURE' },
      { from: 'property_welcome', to: 'visit_day_select', input: 'BOOK_VISIT' },
      { from: 'property_welcome', to: 'request_callback', input: 'CALL_ME' },
      { from: 'send_brochure', to: 'property_welcome', input: null },
      { from: 'visit_day_select', to: 'visit_confirmed', input: null },
      { from: 'request_callback', to: 'end_conversation', input: null },
      { from: 'visit_confirmed', to: 'end_conversation', input: null }
    ]
  }
  // You can add more template objects here
];

async function seedTemplates(clientId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const tpl of FLOW_TEMPLATES) {
      // Insert the flow
      const flowRes = await client.query(
        `INSERT INTO conversation_flows (client_id, flow_name, flow_version, is_active, start_node_id)
         VALUES ($1, $2, 1, FALSE, NULL) RETURNING flow_id`,
        [clientId, tpl.name]
      );
      const flowId = flowRes.rows[0].flow_id;

      // Insert nodes
      const nodeMap = {};
      for (let i = 0; i < tpl.nodes.length; i++) {
        const n = tpl.nodes[i];
        const nodeRes = await client.query(
          `INSERT INTO flow_nodes (flow_id, node_code, node_type, node_name, config, order_index, active)
           VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING node_id`,
          [flowId, n.code, n.type, n.name, JSON.stringify(n.config), i]
        );
        nodeMap[n.code] = nodeRes.rows[0].node_id;
      }

      // Set start node if first node exists
      const firstNodeCode = tpl.nodes[0].code;
      if (nodeMap[firstNodeCode]) {
        await client.query(
          `UPDATE conversation_flows SET start_node_id = $1 WHERE flow_id = $2`,
          [nodeMap[firstNodeCode], flowId]
        );
      }

      // Insert edges
      for (const e of tpl.edges) {
        const fromId = nodeMap[e.from];
        const toId = nodeMap[e.to];
        if (fromId && toId) {
          await client.query(
            `INSERT INTO flow_edges (flow_id, from_node_id, to_node_id, user_input_value, condition_logic, priority, active)
             VALUES ($1, $2, $3, $4, '{}', 0, TRUE)`,
            [flowId, fromId, toId, e.input]
          );
        }
      }

      // Add dynamic edges for properties (if any)
      const props = await client.query(
        `SELECT property_id FROM properties WHERE client_id = $1`,
        [clientId]
      );
      const propertyListNode = nodeMap['property_listing'];
      const propertyWelcomeNode = nodeMap['property_welcome'];
      if (propertyListNode && propertyWelcomeNode) {
        for (const p of props.rows) {
          await client.query(
            `INSERT INTO flow_edges (flow_id, from_node_id, to_node_id, user_input_value, condition_logic, priority, active)
             VALUES ($1, $2, $3, $4, '{}', 0, TRUE)`,
            [flowId, propertyListNode, propertyWelcomeNode, `PROPERTY_${p.property_id}`]
          );
        }
      }
    }

    await client.query('COMMIT');
    console.log(`✅ Seeded ${FLOW_TEMPLATES.length} flow template(s) for client ${clientId}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

// Usage: Provide client ID as command line argument or use default
const targetClientId = parseInt(process.argv[2], 10) || 1;

(async () => {
  console.log(`Seeding templates for client ${targetClientId}…`);
  await seedTemplates(targetClientId);
})();