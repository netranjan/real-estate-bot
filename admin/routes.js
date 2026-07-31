const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const db = require('../db/queries');
const clientService = require('../services/client-service');
const flowService = require('../services/flow-service');

// ── Simple Auth ──
function requireAuth(req, res, next) {
  const key = req.query.key || req.headers['x-admin-key'] || req.body.admin_key;
  const adminKey = process.env.ADMIN_KEY || 'dev-secret-key';

  if (process.env.NODE_ENV === 'development' && !process.env.ADMIN_KEY) {
    return next();
  }
  if (key !== adminKey) {
    return res.status(401).send('<h1>Unauthorized</h1><p>Add ?key=YOUR_KEY to URL or set ADMIN_KEY in .env</p>');
  }
  next();
}

router.use(requireAuth);

// ── Middleware: make client list available to all views ──
router.use(async (req, res, next) => {
  try {
    res.locals.allClients = await clientService.listClients('');
  } catch (e) {
    res.locals.allClients = [];
  }
  next();
});

// ── Helpers ──
function resolveClientId(req) {
  if (req.query.clientId) return parseInt(req.query.clientId, 10);
  if (req.body && req.body.clientId) return parseInt(req.body.clientId, 10);
  return parseInt(process.env.DEFAULT_CLIENT_ID, 10) || 1;
}

function redirectWithQuery(res, req, path) {
  const q = [];
  if (req.query.key) q.push(`key=${encodeURIComponent(req.query.key)}`);
  if (req.query.clientId) q.push(`clientId=${encodeURIComponent(req.query.clientId)}`);
  const url = path + (q.length ? '?' + q.join('&') : '');
  res.redirect(url);
}

function render(req, res, view, data) {
  res.render(view, { ...data, req });
}

// ═══════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════

router.get('/', async (req, res) => {
  const clientId = resolveClientId(req);

  const leadsQ = await pool.query('SELECT COUNT(*) FROM leads WHERE client_id = $1', [clientId]);
  const propsQ = await pool.query('SELECT COUNT(*) FROM properties WHERE client_id = $1 AND active = TRUE', [clientId]);
  const cbQ = await pool.query(`
    SELECT COUNT(*) FROM callback_requests cr 
    JOIN leads l ON cr.lead_id = l.lead_id 
    WHERE l.client_id = $1 AND cr.status = 'PENDING'`, [clientId]);
  const visitQ = await pool.query(`
    SELECT COUNT(*) FROM site_visits sv 
    JOIN leads l ON sv.lead_id = l.lead_id 
    WHERE l.client_id = $1 AND DATE(sv.created_at) = CURRENT_DATE`, [clientId]);

  render(req, res, 'admin/dashboard', {
    title: 'Dashboard',
    clientId,
    stats: {
      leads: parseInt(leadsQ.rows[0].count),
      properties: parseInt(propsQ.rows[0].count),
      callbacks: parseInt(cbQ.rows[0].count),
      visits: parseInt(visitQ.rows[0].count),
    }
  });
});

// ═══════════════════════════════════════
// PROPERTIES CRUD
// ═══════════════════════════════════════

router.get('/properties', async (req, res) => {
  const clientId = resolveClientId(req);
  const properties = await db.getPropertiesByClient(clientId);
  render(req, res, 'admin/properties', { title: 'Properties', properties, clientId });
});

router.post('/properties', async (req, res) => {
  const clientId = resolveClientId(req);
  const {
    property_name, price_min, price_max, configuration_types,
    possession_date, brochure_url, welcome_message, google_map_url,
    referral_code, active
  } = req.body;

  try {
    await pool.query(
      `INSERT INTO properties 
        (client_id, property_name, price_min, price_max, configuration_types, possession_date,
         brochure_url, welcome_message, google_map_url, referral_code, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [clientId, property_name, price_min || null, price_max || null,
        JSON.stringify(configuration_types ? configuration_types.split(',').map(s => s.trim()) : []),
        possession_date || null, brochure_url || null, welcome_message || null,
        google_map_url || null, referral_code || null, active === 'on' || active === 'true']
    );
    redirectWithQuery(res, req, '/admin/properties');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

router.post('/properties/:id/update', async (req, res) => {
  const {
    property_name, price_min, price_max, configuration_types,
    possession_date, brochure_url, welcome_message, google_map_url,
    referral_code, active
  } = req.body;

  try {
    await pool.query(
      `UPDATE properties SET
        property_name = $1, price_min = $2, price_max = $3,
        configuration_types = $4, possession_date = $5,
        brochure_url = $6, welcome_message = $7, google_map_url = $8,
        referral_code = $9, active = $10, updated_at = NOW()
       WHERE property_id = $11`,
      [property_name, price_min || null, price_max || null,
        JSON.stringify(configuration_types ? configuration_types.split(',').map(s => s.trim()) : []),
        possession_date || null, brochure_url || null, welcome_message || null,
        google_map_url || null, referral_code || null,
        active === 'on' || active === 'true', req.params.id]
    );
    redirectWithQuery(res, req, '/admin/properties');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

router.post('/properties/:id/delete', async (req, res) => {
  try {
    await pool.query('DELETE FROM properties WHERE property_id = $1', [req.params.id]);
    redirectWithQuery(res, req, '/admin/properties');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// ═══════════════════════════════════════
// FLOW BUILDER
// ═══════════════════════════════════════

router.get('/flows', async (req, res) => {
  const clientId = resolveClientId(req);
  const flows = await db.getFlowsByClient(clientId);
  const activeFlow = flows.find(f => f.is_active) || null;

  let steps = [];
  if (activeFlow) {
    const fullFlow = await flowService.getFullFlow(activeFlow.flow_id);
    steps = fullFlow.nodes;
  }

  render(req, res, 'admin/flow-builder', {
    title: 'Flow Builder',
    flows,
    activeFlow,
    steps,
    clientId
  });
});

// Create new flow
router.post('/flows', async (req, res) => {
  const clientId = resolveClientId(req);
  const { flow_name, flow_version, is_active } = req.body;

  try {
    await db.createFlow({
      clientId,
      flowName: flow_name,
      flowVersion: parseInt(flow_version) || 1,
      isActive: is_active === 'on' || is_active === 'true'
    });
    redirectWithQuery(res, req, '/admin/flows');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Activate a flow
router.post('/flows/:id/activate', async (req, res) => {
  try {
    await db.deactivateOtherFlows(resolveClientId(req), req.params.id);
    await db.updateFlow(req.params.id, { isActive: true });
    redirectWithQuery(res, req, '/admin/flows');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Reorder nodes (drag & drop)
router.post('/flows/reorder', async (req, res) => {
  const { flowId, nodeIds } = req.body;
  try {
    await flowService.reorderNodes(parseInt(flowId), nodeIds);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Simulate flow
router.post('/flows/simulate', async (req, res) => {
  const { flowId, startNodeId, inputs } = req.body;
  try {
    const result = await flowService.simulateFullFlow(
      parseInt(flowId),
      parseInt(startNodeId),
      inputs || []
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Add new step
router.post('/flows/steps', async (req, res) => {
  const clientId = resolveClientId(req);
  const flow = await db.getActiveFlowForClient(clientId);
  if (!flow) return res.status(400).send('No active flow');

  const { step_name, message_text, step_type, options, save_field } = req.body;

  const typeMap = {
    'question': 'collect_input',
    'message': 'send_message',
    'property_list': 'show_list',
    'property_welcome': 'property_welcome',
    'brochure': 'send_document',
    'book_visit': 'book_appointment',
    'callback': 'request_callback'
  };

  const nodeType = typeMap[step_type] || 'send_message';
  const config = { text: message_text };

  if (options && (step_type === 'question' || step_type === 'property_welcome')) {
    const lines = options.split('\n').map(l => l.trim()).filter(l => l);
    config.options = lines.map(line => ({ label: line, value: line }));
    if (step_type === 'property_welcome') {
      config.buttons = lines.map(line => ({ title: line, id: line.toUpperCase().replace(/\s+/g, '_') }));
    }
  }

  // Property list config — NEW: parse match_dimensions from JSON
  if (step_type === 'property_list') {
    config.source_table = 'properties';
    try {
      const parsed = JSON.parse(options || '{}');
      config.filter_mode = parsed.mode || 'all';
      config.match_dimensions = parsed.match_dimensions || [];
      // Backward compat: keep filter_conditions if present
      config.filter_conditions = parsed.filter_conditions || [];
    } catch (e) {
      config.filter_mode = 'all';
      config.match_dimensions = [];
      config.filter_conditions = [];
    }
  }

  if (step_type === 'question') {
    config.field = save_field || step_name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  }

  const nodeCode = step_name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') + '_' + Date.now();

  try {
    const newNode = await db.createNode({
      flowId: flow.flow_id,
      nodeCode,
      nodeType,
      nodeName: step_name,
      config,
      orderIndex: 0
    });

    if (!flow.start_node_id) {
      await db.updateFlow(flow.flow_id, { startNodeId: newNode.node_id });
      console.log('🎯 Auto-set start_node_id to', newNode.node_id);
    }

    redirectWithQuery(res, req, '/admin/flows');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Update step
router.post('/flows/steps/:id/update', async (req, res) => {
  const { step_name, message_text, options } = req.body;

  try {
    const node = await db.getNodeById(req.params.id);
    const config = node.config || {};

    config.text = message_text;
    config.step_name = step_name;

    if (options && (node.node_type === 'collect_input' || node.node_type === 'property_welcome')) {
      const lines = options.split('\n').map(l => l.trim()).filter(l => l);
      if (node.node_type === 'property_welcome') {
        config.buttons = lines.map(line => ({ title: line, id: line.toUpperCase().replace(/\s+/g, '_') }));
      } else {
        config.options = lines.map(line => ({ label: line, value: line }));
      }
    }

    // Property list config on update — NEW: parse match_dimensions
    if (node.node_type === 'show_list') {
      config.source_table = 'properties';
      try {
        const parsed = JSON.parse(options || '{}');
        config.filter_mode = parsed.mode || 'all';
        config.match_dimensions = parsed.match_dimensions || [];
        config.filter_conditions = parsed.filter_conditions || [];
      } catch (e) {
        config.filter_mode = config.filter_mode || 'all';
        config.match_dimensions = config.match_dimensions || [];
        config.filter_conditions = config.filter_conditions || [];
      }
    }

    if (node.node_type === 'collect_input' && !config.field) {
      config.field = step_name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    }

    await db.updateNode(req.params.id, { nodeName: step_name, config });
    redirectWithQuery(res, req, '/admin/flows');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Delete step
router.post('/flows/steps/:id/delete', async (req, res) => {
  try {
    await db.deleteNode(req.params.id);
    redirectWithQuery(res, req, '/admin/flows');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Add connection with action
router.post('/flows/connections', async (req, res) => {
  const clientId = resolveClientId(req);
  const flow = await db.getActiveFlowForClient(clientId);
  if (!flow) return res.status(400).send('No active flow');

  const { from_step, to_step, user_choice, action_type, action_field } = req.body;

  const conditionLogic = flowService.buildEdgeAction(action_type, { field: action_field });

  try {
    await db.createEdge({
      flowId: flow.flow_id,
      fromNodeId: from_step,
      toNodeId: to_step,
      userInputValue: user_choice || null,
      conditionLogic
    });
    redirectWithQuery(res, req, '/admin/flows');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Delete connection
router.post('/flows/connections/:id/delete', async (req, res) => {
  try {
    await db.deleteEdge(req.params.id);
    redirectWithQuery(res, req, '/admin/flows');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// ═══════════════════════════════════════
// LEADS CRM
// ═══════════════════════════════════════

router.get('/leads', async (req, res) => {
  const clientId = resolveClientId(req);
  const { search, stage } = req.query;

  let sql = 'SELECT * FROM crm_leads_view WHERE client_id = $1';
  const params = [clientId];
  let idx = 2;

  if (search) {
    sql += ` AND (contact_name ILIKE $${idx} OR whatsapp_number ILIKE $${idx} OR lead_display_id ILIKE $${idx})`;
    params.push(`%${search}%`);
    idx++;
  }
  if (stage) {
    sql += ` AND current_pipeline_stage = $${idx++}`;
    params.push(stage);
  }

  sql += ' ORDER BY latest_contact_date DESC NULLS LAST LIMIT 100';

  const result = await pool.query(sql, params);
  render(req, res, 'admin/leads', { title: 'Leads', leads: result.rows, search, stage, clientId });
});

router.get('/leads/:id', async (req, res) => {
  const lead = await db.getLeadById(req.params.id);
  if (!lead) return res.status(404).send('Lead not found');

  const answers = await db.getLeadAnswers(req.params.id);
  const history = await pool.query(
    'SELECT * FROM lead_history WHERE lead_id = $1 ORDER BY created_at DESC',
    [req.params.id]
  );
  const timeline = await db.getLeadTimeline(req.params.id);

  render(req, res, 'admin/lead-detail', {
    title: `Lead ${lead.lead_id}`,
    lead,
    answers,
    history: history.rows,
    timeline
  });
});

// ═══════════════════════════════════════
// VISITS & CALLBACKS
// ═══════════════════════════════════════

router.get('/visits', async (req, res) => {
  const clientId = resolveClientId(req);

  const visitsRes = await pool.query(
    `SELECT * FROM crm_appointments_view 
     WHERE client_id = $1
     ORDER BY created_at DESC LIMIT 100`,
    [clientId]
  );

  const cbRes = await pool.query(
    `SELECT * FROM crm_callbacks_view
     WHERE client_id = $1
     ORDER BY created_at DESC LIMIT 100`,
    [clientId]
  );

  render(req, res, 'admin/visits-callbacks', {
    title: 'Visits & Callbacks',
    visits: visitsRes.rows,
    callbacks: cbRes.rows,
    clientId
  });
});

router.post('/visits/:id/update', async (req, res) => {
  const { status, gate_pass_status, visit_outcome, agent_notes } = req.body;
  try {
    await pool.query(
      `UPDATE site_visits SET status = $1, gate_pass_status = $2, visit_outcome = $3, agent_notes = $4, updated_at = NOW()
       WHERE site_visit_id = $5`,
      [status, gate_pass_status, visit_outcome, agent_notes, req.params.id]
    );
    redirectWithQuery(res, req, '/admin/visits');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

router.post('/callbacks/:id/update', async (req, res) => {
  const { status } = req.body;
  try {
    await pool.query(
      `UPDATE callback_requests SET status = $1, resolved_at = CASE WHEN $1 = 'RESOLVED' THEN NOW() ELSE resolved_at END
       WHERE callback_request_id = $2`,
      [status, req.params.id]
    );
    redirectWithQuery(res, req, '/admin/visits');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// ═══════════════════════════════════════
// CLIENTS
// ═══════════════════════════════════════

router.get('/clients', async (req, res, next) => {
  try {
    const search = req.query.search || '';
    const clients = await clientService.listClients(search);
    res.render('admin/clients', { title: 'Clients', clients, search, req });
  } catch (err) { next(err); }
});

router.get('/clients/new', (req, res) => {
  res.render('admin/client-form', { title: 'New Client', client: null, req });
});

router.post('/clients', async (req, res, next) => {
  try {
    await clientService.createClient({
      businessName: req.body.business_name,
      metaWabaId: req.body.meta_waba_id || null,
      metaPhoneNumberId: req.body.meta_phone_number_id || null,
      metaAccessToken: req.body.meta_access_token || null
    });
    redirectWithQuery(res, req, '/admin/clients');
  } catch (err) { next(err); }
});

router.get('/clients/:id', async (req, res, next) => {
  try {
    const client = await clientService.getClient(req.params.id);
    if (!client) return res.status(404).send('Client not found');

    const stats = await clientService.getClientStats(req.params.id);
    const activity = await clientService.getClientRecentActivity(req.params.id);

    res.render('admin/client-detail', {
      title: client.business_name,
      client,
      stats,
      ...activity,
      req
    });
  } catch (err) { next(err); }
});

router.get('/clients/:id/edit', async (req, res, next) => {
  try {
    const client = await clientService.getClient(req.params.id);
    if (!client) return res.status(404).send('Client not found');
    res.render('admin/client-form', { title: 'Edit Client', client, req });
  } catch (err) { next(err); }
});

router.post('/clients/:id', async (req, res, next) => {
  try {
    await clientService.updateClient(req.params.id, {
      businessName: req.body.business_name,
      metaWabaId: req.body.meta_waba_id || null,
      metaPhoneNumberId: req.body.meta_phone_number_id || null,
      metaAccessToken: req.body.meta_access_token || null,
      active: req.body.active === 'true' || req.body.active === 'on'
    });
    redirectWithQuery(res, req, '/admin/clients');
  } catch (err) { next(err); }
});

router.post('/clients/:id/toggle', async (req, res, next) => {
  try {
    await clientService.toggleClientActive(req.params.id);
    redirectWithQuery(res, req, '/admin/clients');
  } catch (err) { next(err); }
});

module.exports = router;