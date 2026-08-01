// scripts/seed-templates.js
const pool = require('../db/pool');

const FLOWS = [
  // 1. Standard Property Sales Flow
  {
    name: 'Standard Sales Flow',
    nodes: [
      { code:'welcome', type:'collect_input', name:'Welcome', config:{text:'Welcome! How can we help?', options:[{label:'Buy',value:'Buy'},{label:'Rent',value:'Rent'}], field:'requirement_type'}},
      { code:'config', type:'collect_input', name:'Configuration', config:{text:'Preferred configuration?', options:[{label:'2BHK',value:'2BHK'},{label:'3BHK',value:'3BHK'}], field:'configuration'}},
      { code:'budget', type:'collect_input', name:'Budget', config:{text:'Your budget range?', options:[{label:'<1Cr',value:'<1Cr'},{label:'1-1.5Cr',value:'1-1.5Cr'},{label:'>1.5Cr',value:'>1.5Cr'}], field:'budget_range'}},
      { code:'list', type:'show_list', name:'Properties', config:{text:'Matching properties:', filter_mode:'filtered', match_dimensions:['configuration','budget_range']}},
      { code:'prop_welcome', type:'property_welcome', name:'Property Details', config:{text:'What would you like?', buttons:[{title:'Brochure',id:'BROCHURE'},{title:'Visit',id:'BOOK_VISIT'},{title:'Call',id:'CALL_ME'}]}},
      { code:'media', type:'send_document', name:'Brochure', config:{media_items:[
        { type:'image', url:'https://example.com/property.jpg', caption:'Beautiful living room', filename:'' },
        { type:'document', url:'https://example.com/brochure.pdf', caption:'Download our detailed brochure', filename:'Brochure.pdf' }
      ]}},
      { code:'visit', type:'book_appointment', name:'Book Visit', config:{options:[]}},  // empty = use property slots
      { code:'callback', type:'request_callback', name:'Callback', config:{}},
      { code:'end', type:'end_conversation', name:'End', config:{text:'Thank you!'}}
    ],
    edges: [
      {from:'welcome',to:'config',input:'Buy'},{from:'welcome',to:'config',input:'Rent'},
      {from:'config',to:'budget'},{from:'budget',to:'list'},
      {from:'list',to:'prop_welcome'},{from:'prop_welcome',to:'media',input:'BROCHURE'},
      {from:'prop_welcome',to:'visit',input:'BOOK_VISIT'},{from:'prop_welcome',to:'callback',input:'CALL_ME'},
      {from:'media',to:'prop_welcome'},{from:'visit',to:'end'},{from:'callback',to:'end'}
    ]
  },
  // 2. Quick Inquiry Flow
  {
    name: 'Quick Inquiry Flow',
    nodes: [
      { code:'greet', type:'send_message', name:'Greeting', config:{text:'Hello! How can we assist?'}},
      { code:'purpose', type:'collect_input', name:'Purpose', config:{text:'What do you need?', options:[{label:'Price',value:'price'},{label:'Visit',value:'visit'},{label:'Brochure',value:'brochure'}], field:'purpose'}},
      { code:'price_info', type:'send_message', name:'Price Info', config:{text:'Prices start at ₹1 Cr.'}},
      { code:'visit_book', type:'book_appointment', name:'Book Visit', config:{options:[]}},
      { code:'brochure_send', type:'send_document', name:'Brochure', config:{media_items:[
        { type:'document', url:'https://example.com/brochure.pdf', caption:'Here is the brochure you requested', filename:'Brochure.pdf' }
      ]}},
      { code:'end', type:'end_conversation', name:'End', config:{text:'Have a great day!'}}
    ],
    edges: [
      {from:'greet',to:'purpose'},{from:'purpose',to:'price_info',input:'price'},
      {from:'purpose',to:'visit_book',input:'visit'},{from:'purpose',to:'brochure_send',input:'brochure'},
      {from:'price_info',to:'end'},{from:'visit_book',to:'end'},{from:'brochure_send',to:'end'}
    ]
  },
  // 3. Event Registration Flow
  {
    name: 'Event Registration',
    nodes: [
      { code:'ask_name', type:'collect_input', name:'Name', config:{text:'Please enter your name:', field:'name'}},
      { code:'ask_phone', type:'collect_input', name:'Phone', config:{text:'Your WhatsApp number:', field:'phone'}},
      { code:'event_slots', type:'book_appointment', name:'Choose Slot', config:{options:[{label:'Sat 10 AM',value:'sat10'},{label:'Sun 2 PM',value:'sun2'}]}},
      { code:'confirm', type:'send_message', name:'Confirmation', config:{text:'You are registered! We will send a reminder.'}},
      { code:'end', type:'end_conversation', name:'End', config:{text:'Thank you!'}}
    ],
    edges: [
      {from:'ask_name',to:'ask_phone'},{from:'ask_phone',to:'event_slots'},
      {from:'event_slots',to:'confirm'},{from:'confirm',to:'end'}
    ]
  },
  // 4. Feedback Collection Flow
  {
    name: 'Feedback Collection',
    nodes: [
      { code:'rating', type:'collect_input', name:'Rating', config:{text:'How would you rate us? (1-5)', options:[{label:'⭐1',value:'1'},{label:'⭐2',value:'2'},{label:'⭐3',value:'3'},{label:'⭐4',value:'4'},{label:'⭐5',value:'5'}], field:'rating'}},
      { code:'comment', type:'collect_input', name:'Comment', config:{text:'Any additional comments?', field:'comment'}},
      { code:'thanks', type:'send_message', name:'Thanks', config:{text:'Thank you for your feedback!'}},
      { code:'end', type:'end_conversation', name:'End', config:{text:'Have a nice day!'}}
    ],
    edges: [
      {from:'rating',to:'comment'},{from:'comment',to:'thanks'},{from:'thanks',to:'end'}
    ]
  },
  // 5. Support / Call‑Back Flow
  {
    name: 'Support Callback',
    nodes: [
      { code:'issue', type:'collect_input', name:'Issue', config:{text:'Please describe your issue:', field:'issue'}},
      { code:'callback', type:'request_callback', name:'Request Callback', config:{sla_minutes:15}},
      { code:'assign', type:'assign_agent', name:'Assign Agent', config:{}},
      { code:'end', type:'end_conversation', name:'End', config:{text:'An agent will contact you shortly.'}}
    ],
    edges: [
      {from:'issue',to:'callback'},{from:'callback',to:'assign'},{from:'assign',to:'end'}
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
        await client.query(`UPDATE conversation_flows SET start_node_id=$1 WHERE flow_id=$2`, [nodeMap[tpl.nodes[0].code], flowId]);
      }

      for (const e of tpl.edges) {
        await client.query(
          `INSERT INTO flow_edges (flow_id, from_node_id, to_node_id, user_input_value, condition_logic, priority, active)
           VALUES ($1, $2, $3, $4, '{}', 0, TRUE)`,
          [flowId, nodeMap[e.from], nodeMap[e.to], e.input || null]
        );
      }

      // dynamic property edges if 'list' -> 'prop_welcome' exists
      if (nodeMap['list'] && nodeMap['prop_welcome']) {
        const props = await client.query(`SELECT property_id FROM properties WHERE client_id=$1`, [clientId]);
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
    console.log(`✅ Seeded ${FLOWS.length} flow templates for client ${clientId}`);
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