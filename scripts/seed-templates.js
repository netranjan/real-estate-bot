const pool = require('../db/pool');

// ═══════════════════════════════════════════════════════════════
// ADVANCED SALES FLOW
// 
// Routing strategy:
// • collect_input  → user_input_value per button (SELF_USE, INVESTMENT, etc.)
// • show_list      → default edge (outcome: selected) + dynamic PROPERTY_ edges
// • property_welcome → user_input_value per button (BROCHURE, VISIT, CALL)
// • send_document  → default edge back to welcome
// • book_appointment → default edge to end
// • request_callback → default edge to end
// 
// Stale-button recovery: all interactive nodes bookmark themselves.
// Clicking an old button rewinds to that node, re-saves the answer, and routes.
// ═══════════════════════════════════════════════════════════════

const FLOWS = [
  {
    name: 'Advanced Sales Flow',
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
        code: 'budget',
        type: 'collect_input',
        name: 'Budget Range',
        config: {
          text: 'What is your approximate budget range?',
          options: [
            { label: 'Under ₹50 Lakh', value: 'UNDER_50L' },
            { label: '₹50 Lakh - ₹1 Cr', value: '50L_TO_1CR' },
            { label: '₹1 Cr - ₹1.5 Cr', value: '1CR_TO_1_5CR' },
            { label: 'Above ₹1.5 Cr', value: 'ABOVE_1_5CR' }
          ],
          field: 'budget_range'
        }
      },
      {
        code: 'list',
        type: 'show_list',
        name: 'Matching Properties',
        config: {
          text: 'Here are the best properties matching your preference! Tap any property to view details.',
          filter_mode: 'filtered',
          match_dimensions: ['configuration', 'budget_range']
        }
      },
      {
        code: 'prop_welcome',
        type: 'property_welcome',
        name: 'Property Details',
        config: {
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
        name: 'Send Brochure',
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
          text: "Let\'s schedule your site visit! 🏗️\n\nPlease pick a convenient slot."
        }
      },
      {
        code: 'callback',
        type: 'request_callback',
        name: 'Request Callback',
        config: {
          text: 'Our property expert will call you shortly.',
          sla_minutes: 15,
          confirmation_message: 'Got it! {{agent_name}} will call you on this WhatsApp number within 15 minutes. 📞\n\nThank you for reaching out!'
        }
      },
      {
        code: 'end',
        type: 'end_conversation',
        name: 'Goodbye',
        config: {
          text: 'Thank you for your interest! Have a great day. 👋'
        }
      }
    ],
    edges: [
      // ── Welcome → Configuration (per button) ──
      { from: 'welcome', to: 'config', input: 'SELF_USE',   condition: { action: 'save_answer', field: 'requirement_type' } },
      { from: 'welcome', to: 'config', input: 'INVESTMENT', condition: { action: 'save_answer', field: 'requirement_type' } },

      // ── Configuration → Budget (per button) ──
      { from: 'config', to: 'budget', input: '1BHK',   condition: { action: 'save_answer', field: 'configuration' } },
      { from: 'config', to: 'budget', input: '2BHK',   condition: { action: 'save_answer', field: 'configuration' } },
      { from: 'config', to: 'budget', input: '3BHK',   condition: { action: 'save_answer', field: 'configuration' } },
      { from: 'config', to: 'budget', input: '4BHK',   condition: { action: 'save_answer', field: 'configuration' } },
      { from: 'config', to: 'budget', input: '5BHK',   condition: { action: 'save_answer', field: 'configuration' } },
      { from: 'config', to: 'budget', input: 'STUDIO', condition: { action: 'save_answer', field: 'configuration' } },

      // ── Budget → Property List (per button) ──
      { from: 'budget', to: 'list', input: 'UNDER_50L',    condition: { action: 'save_answer', field: 'budget_range' } },
      { from: 'budget', to: 'list', input: '50L_TO_1CR',   condition: { action: 'save_answer', field: 'budget_range' } },
      { from: 'budget', to: 'list', input: '1CR_TO_1_5CR', condition: { action: 'save_answer', field: 'budget_range' } },
      { from: 'budget', to: 'list', input: 'ABOVE_1_5CR',  condition: { action: 'save_answer', field: 'budget_range' } },

      // ── Property List → Property Welcome (default / outcome) ──
      { from: 'list', to: 'prop_welcome', outcome: 'selected' },
      { from: 'list', to: 'prop_welcome', outcome: 'no_match' },

      // ── Property Welcome → Actions (per button) ──
      { from: 'prop_welcome', to: 'brochure', input: 'BROCHURE' },
      { from: 'prop_welcome', to: 'visit',    input: 'VISIT' },
      { from: 'prop_welcome', to: 'callback', input: 'CALL' },

      // ── Brochure → back to Property Welcome ──
      { from: 'brochure', to: 'prop_welcome', outcome: 'sent' },
      { from: 'brochure', to: 'prop_welcome', outcome: 'not_found' },

      // ── Visit / Callback → End ──
      { from: 'visit',    to: 'end', outcome: 'slot_picked' },
      { from: 'visit',    to: 'end', outcome: 'no_slots' },
      { from: 'callback', to: 'end', outcome: 'requested' }
    ]
  }
];

async function seed(clientId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Deactivate any existing flows for this client
    await client.query(
      `UPDATE conversation_flows SET is_active = FALSE WHERE client_id = $1`,
      [clientId]
    );

    for (const tpl of FLOWS) {
      const flowRes = await client.query(
        `INSERT INTO conversation_flows (client_id, flow_name, flow_version, is_active, start_node_id)
         VALUES ($1, $2, 1, TRUE, NULL) RETURNING flow_id`,
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
          `INSERT INTO flow_edges (
            flow_id, from_node_id, to_node_id,
            user_input_value, outcome_name, condition_logic, priority, active
          ) VALUES ($1, $2, $3, $4, $5, $6, 0, TRUE)`,
          [
            flowId,
            nodeMap[e.from],
            nodeMap[e.to],
            e.input || null,
            e.outcome || null,
            JSON.stringify(e.condition || {})
          ]
        );
      }

      // Dynamic edges: list → prop_welcome for every property (by PROPERTY_ID)
      if (nodeMap['list'] && nodeMap['prop_welcome']) {
        const props = await client.query(
          `SELECT property_id FROM properties WHERE client_id=$1 AND active=TRUE`,
          [clientId]
        );
        for (const p of props.rows) {
          await client.query(
            `INSERT INTO flow_edges (
              flow_id, from_node_id, to_node_id,
              user_input_value, outcome_name, condition_logic, priority, active
            ) VALUES ($1, $2, $3, $4, NULL, '{}', 0, TRUE)`,
            [flowId, nodeMap['list'], nodeMap['prop_welcome'], `PROPERTY_${p.property_id}`]
          );
        }
        console.log(`🔗 Added ${props.rows.length} dynamic PROPERTY_ edges for flow "${tpl.name}"`);
      }

      console.log(`✅ Seeded flow "${tpl.name}" (ID: ${flowId}) with ${tpl.nodes.length} nodes and ${tpl.edges.length} static edges`);
    }

    await client.query('COMMIT');
    console.log(`\n🎉 Seeded ${FLOWS.length} flow template(s) for client ${clientId}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

const targetClientId = parseInt(process.argv[2], 10) || 1;
seed(targetClientId);