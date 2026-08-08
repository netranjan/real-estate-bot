const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const db = require('../db/queries');
const clientService = require('../services/client-service');
const flowService = require('../services/flow-service');
const propertyService = require('../services/property-service');
const { requireLogin, requireRole } = require('../middleware/auth');
const { formatPrice } = require('../utils/format-price');

router.use(requireLogin);
router.use('/clients', requireRole('super_admin'));
router.use('/clients/:id', requireRole('super_admin'));

router.use(async (req, res, next) => {
  try { res.locals.allClients = await clientService.listClients(''); } catch (e) { res.locals.allClients = []; }
  next();
});

function resolveClientId(req) {
  if (req.query.clientId) return parseInt(req.query.clientId, 10);
  if (req.body && req.body.clientId) return parseInt(req.body.clientId, 10);
  return parseInt(process.env.DEFAULT_CLIENT_ID, 10) || 1;
}
function redirectWithQuery(res, req, path) {
  const q = [];
  if (req.query.clientId) q.push(`clientId=${encodeURIComponent(req.query.clientId)}`);
  res.redirect(path + (q.length ? '?' + q.join('&') : ''));
}
function render(req, res, view, data) { res.render(view, { ...data, req }); }
function respond(req, res, data, redirectPath) {
  if (req.headers.accept === 'application/json' || req.query.ajax === '1' || req.body.ajax === '1') {
    return res.json(data);
  }
  redirectWithQuery(res, req, redirectPath);
}

function resolvePriceFromBody(body) {
  const minRaw = body.price_min_custom;
  const maxRaw = body.price_max_custom;
  let priceMin = propertyService.parsePriceInput(minRaw);
  let priceMax = propertyService.parsePriceInput(maxRaw);
  if (priceMin !== null && priceMax !== null && priceMin > priceMax) {
    [priceMin, priceMax] = [priceMax, priceMin];
  }
  return { priceMin, priceMax };
}

async function syncPropertyAssets(propertyId, assetTypes, assetUrls, assetNames) {
  const types = Array.isArray(assetTypes) ? assetTypes : (assetTypes ? [assetTypes] : []);
  const urls = Array.isArray(assetUrls) ? assetUrls : (assetUrls ? [assetUrls] : []);
  const names = Array.isArray(assetNames) ? assetNames : (assetNames ? [assetNames] : []);
  const assets = types.map((t, i) => ({
    asset_type: t,
    asset_url: urls[i] || '',
    asset_name: names[i] || null
  })).filter(a => a.asset_type && a.asset_url);
  await propertyService.replaceAssets(propertyId, assets);
}

function getCanonicalId(label) {
  const lower = label.toLowerCase().replace(/\s+/g, '');
  if (lower.includes('brochure')) return 'BROCHURE';
  if (lower.includes('visit') || lower.includes('tour') || lower.includes('site')) return 'VISIT';
  if (lower.includes('call') || lower.includes('callback') || lower.includes('agent')) return 'CALL';
  if (lower.includes('buy') || lower.includes('purchase')) return 'BUY';
  if (lower.includes('rent')) return 'RENT';
  return label.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

// ═════════════════ DASHBOARD ═════════════════
router.get('/', async (req, res) => {
  const clientId = resolveClientId(req);
  const leadsQ = await pool.query('SELECT COUNT(*) FROM leads WHERE client_id = $1', [clientId]);
  const propsQ = await pool.query('SELECT COUNT(*) FROM properties WHERE client_id = $1 AND active = TRUE', [clientId]);
  const cbQ = await pool.query(`SELECT COUNT(*) FROM callback_requests cr JOIN leads l ON cr.lead_id = l.lead_id WHERE l.client_id = $1 AND cr.status = 'PENDING'`, [clientId]);
  const visitQ = await pool.query(`SELECT COUNT(*) FROM site_visits sv JOIN leads l ON sv.lead_id = l.lead_id WHERE l.client_id = $1 AND DATE(sv.created_at) = CURRENT_DATE`, [clientId]);
  render(req, res, 'admin/dashboard', { title: 'Dashboard', clientId, stats: { leads: parseInt(leadsQ.rows[0].count), properties: parseInt(propsQ.rows[0].count), callbacks: parseInt(cbQ.rows[0].count), visits: parseInt(visitQ.rows[0].count) } });
});

// ═════════════════ PROPERTIES CRUD ═════════════════
router.get('/properties', async (req, res) => {
  const clientId = resolveClientId(req);
  const client = await db.getClientByIdIncludingInactive(clientId);
  const currencySymbol = client?.currency_symbol || '₹';
  const properties = await db.getPropertiesByClient(clientId);
  for (let prop of properties) { prop.assets = await propertyService.getPropertyAssets(prop.property_id); }
  render(req, res, 'admin/properties', { title: 'Properties', properties, clientId, currencySymbol, formatPrice });
});

router.get('/properties/:id', async (req, res) => {
  const property = await db.getPropertyById(req.params.id);
  if (!property) return res.status(404).send('Property not found');
  const client = await db.getClientById(property.client_id);
  const currencySymbol = client?.currency_symbol || '₹';
  const slots = await db.getVisitOptionsForProperty(req.params.id);
  const assets = await propertyService.getPropertyAssets(req.params.id);
  render(req, res, 'admin/property-detail', { title: property.property_name, property, slots, assets, clientId: property.client_id, currencySymbol, formatPrice });
});

router.post('/properties', async (req, res) => {
  const clientId = resolveClientId(req);
  const { property_name, configuration_types, possession_date, welcome_message, google_map_url, referral_code, active } = req.body;
  const { priceMin, priceMax } = resolvePriceFromBody(req.body);
  try {
    const result = await pool.query(
      `INSERT INTO properties (client_id, property_name, price_min, price_max, configuration_types, possession_date, welcome_message, google_map_url, referral_code, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING property_id`,
      [clientId, property_name, priceMin, priceMax, JSON.stringify(configuration_types ? configuration_types.split(',').map(s => s.trim()) : []), possession_date || null, welcome_message || null, google_map_url || null, referral_code || null, active === 'on' || active === 'true']
    );
    await syncPropertyAssets(result.rows[0].property_id, req.body['asset_type'], req.body['asset_url'], req.body['asset_name']);
    redirectWithQuery(res, req, '/admin/properties');
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

router.post('/properties/:id/update', async (req, res) => {
  const { property_name, configuration_types, possession_date, welcome_message, google_map_url, referral_code, active } = req.body;
  const { priceMin, priceMax } = resolvePriceFromBody(req.body);
  try {
    await pool.query(
      `UPDATE properties SET property_name=$1, price_min=$2, price_max=$3, configuration_types=$4, possession_date=$5, welcome_message=$6, google_map_url=$7, referral_code=$8, active=$9, updated_at=NOW() WHERE property_id=$10`,
      [property_name, priceMin, priceMax, JSON.stringify(configuration_types ? configuration_types.split(',').map(s => s.trim()) : []), possession_date || null, welcome_message || null, google_map_url || null, referral_code || null, active === 'on' || active === 'true', req.params.id]
    );
    await syncPropertyAssets(req.params.id, req.body['asset_type'], req.body['asset_url'], req.body['asset_name']);
    redirectWithQuery(res, req, '/admin/properties');
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

router.post('/properties/:id/delete', async (req, res) => {
  try { await pool.query('DELETE FROM properties WHERE property_id = $1', [req.params.id]); redirectWithQuery(res, req, '/admin/properties'); }
  catch (err) { res.status(500).send('Error: ' + err.message); }
});

// ═════════════════ PROPERTY VISIT SLOTS ═════════════════
router.get('/properties/:id/slots', async (req, res) => {
  const property = await db.getPropertyById(req.params.id);
  if (!property) return res.status(404).send('Property not found');
  const slots = await db.getVisitOptionsForProperty(req.params.id);
  render(req, res, 'admin/property-slots', { title: `Slots - ${property.property_name}`, property, slots, clientId: property.client_id });
});

router.post('/properties/:id/slots', async (req, res) => {
  const { id } = req.params;
  const { option_name } = req.body;
  const clientId = req.query.clientId || req.body.clientId;
  if (!option_name) return res.status(400).send('Slot name required');
  try { await pool.query(`INSERT INTO property_visit_options (property_id, option_name, active) VALUES ($1, $2, TRUE)`, [id, option_name]); res.redirect(`/admin/properties/${id}/slots?clientId=${clientId}`); }
  catch (err) { res.status(500).send('Error: ' + err.message); }
});

router.post('/properties/:id/slots/:slotId/toggle', async (req, res) => {
  const { id, slotId } = req.params;
  const clientId = req.query.clientId || req.body.clientId;
  try {
    const slot = await pool.query('SELECT active FROM property_visit_options WHERE visit_option_id = $1', [slotId]);
    if (slot.rows.length === 0) return res.status(404).send('Slot not found');
    await pool.query('UPDATE property_visit_options SET active = $1 WHERE visit_option_id = $2', [!slot.rows[0].active, slotId]);
    res.redirect(`/admin/properties/${id}/slots?clientId=${clientId}`);
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

router.post('/properties/:id/slots/:slotId/delete', async (req, res) => {
  const { id, slotId } = req.params;
  const clientId = req.query.clientId || req.body.clientId;
  try { await pool.query('DELETE FROM property_visit_options WHERE visit_option_id = $1', [slotId]); res.redirect(`/admin/properties/${id}/slots?clientId=${clientId}`); }
  catch (err) { res.status(500).send('Error: ' + err.message); }
});

// ═════════════════ FLOW BUILDER ═════════════════
router.get('/flows', async (req, res) => {
  const clientId = resolveClientId(req);
  const flows = await db.getFlowsByClient(clientId);
  const nodeTypes = await db.getAllNodeTypes();
  let activeFlow = null;
  if (req.query.flowId) activeFlow = flows.find(f => f.flow_id == req.query.flowId) || null;
  if (!activeFlow) activeFlow = flows.find(f => f.is_active) || null;
  let steps = [];
  if (activeFlow) {
    const fullFlow = await flowService.getFullFlow(activeFlow.flow_id);
    steps = fullFlow.nodes;
    for (const step of steps) {
      const nt = nodeTypes.find(n => n.node_type_code === step.node_type);
      step.outcomes = nt?.outcomes || [];
    }
  }
  if (req.query.ajax === '1') return res.json({ success: true, flows, activeFlow, steps, nodeTypes, clientId });
  render(req, res, 'admin/flow-builder', { title: 'Flow Builder', flows, activeFlow, steps, nodeTypes, clientId });
});
router.post('/flows', async (req, res) => {
  const clientId = resolveClientId(req);
  const { flow_name } = req.body;
  try {
    const flow = await db.createFlow({ clientId, flowName: flow_name, flowVersion: 1, isActive: false });
    respond(req, res, { success: true, flow }, '/admin/flows?flowId=' + flow.flow_id);
  } catch (err) { respond(req, res, { success: false, error: err.message }, '/admin/flows'); }
});

router.post('/flows/:id/activate', async (req, res) => {
  try {
    await db.deactivateOtherFlows(resolveClientId(req), req.params.id);
    await db.updateFlow(req.params.id, { isActive: true });
    respond(req, res, { success: true }, '/admin/flows?flowId=' + req.params.id);
  } catch (err) { respond(req, res, { success: false, error: err.message }, '/admin/flows'); }
});

router.post('/flows/:id/clone', async (req, res) => {
  try {
    const newFlow = await flowService.cloneFlow(req.params.id, resolveClientId(req));
    respond(req, res, { success: true, flow: newFlow }, '/admin/flows?flowId=' + newFlow.flow_id);
  } catch (err) { respond(req, res, { success: false, error: err.message }, '/admin/flows'); }
});

router.post('/flows/:id/delete', async (req, res) => {
  try {
    await pool.query('DELETE FROM flow_edges WHERE flow_id = $1', [req.params.id]);
    await pool.query('DELETE FROM flow_nodes WHERE flow_id = $1', [req.params.id]);
    await pool.query('DELETE FROM conversation_flows WHERE flow_id = $1', [req.params.id]);
    respond(req, res, { success: true }, '/admin/flows');
  } catch (err) { respond(req, res, { success: false, error: err.message }, '/admin/flows'); }
});

router.post('/flows/reorder', async (req, res) => {
  const { flowId, nodeIds } = req.body;
  try { await flowService.reorderNodes(parseInt(flowId), nodeIds); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/flows/simulate', async (req, res) => {
  const { flowId, startNodeId, inputs } = req.body;
  try {
    const result = await flowService.simulateFullFlow(parseInt(flowId), parseInt(startNodeId), inputs || []);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Templates ──
const TEMPLATES = {
  property_sales: {
    name: 'Property Sales',
    nodes: [
      { code: 'welcome', type: 'collect_input', name: 'Welcome', config: { text: 'Hello! Welcome to our premium property portal. How can we help you today?', options: [{ label: '🏠 Self Use', value: 'SELF_USE' }, { label: '📈 Investment', value: 'INVESTMENT' }], field: 'requirement_type' } },
      { code: 'config', type: 'collect_input', name: 'Configuration', config: { text: 'Great choice! What configuration are you looking for?', options: [{ label: '1 BHK', value: '1BHK' }, { label: '2 BHK', value: '2BHK' }, { label: '3 BHK', value: '3BHK' }, { label: '4 BHK', value: '4BHK' }, { label: '5 BHK', value: '5BHK' }, { label: 'Studio', value: 'STUDIO' }], field: 'configuration' } },
      { code: 'list', type: 'show_list', name: 'Matching Properties', config: { text: 'Here are the best properties matching your preference! Tap any property to view details.', filter_mode: 'filtered', match_dimensions: ['configuration'] } },
      { code: 'menu', type: 'property_welcome', name: 'Property Menu', config: { text: 'Welcome to {{selected_property_name}}! How would you like to proceed?', buttons: [{ title: '📄 Brochure', id: 'BROCHURE' }, { title: '📅 Site Visit', id: 'VISIT' }, { title: '📞 Callback', id: 'CALL' }] } },
      { code: 'brochure', type: 'send_document', name: 'Send Brochure', config: { text: 'Here is the brochure for {{selected_property_name}}. Happy reading!', media_items: [{ type: 'document', url: '', caption: 'Project Brochure', filename: 'Brochure.pdf' }] } },
      { code: 'visit', type: 'book_appointment', name: 'Book Visit', config: { text: "Let's schedule your site visit! Please pick a convenient slot.", options: [] } },
      { code: 'callback', type: 'request_callback', name: 'Request Callback', config: { text: 'Our property expert will call you shortly! Thank you for your interest.' } },
      { code: 'end', type: 'end_conversation', name: 'Goodbye', config: { text: 'Thank you for your interest!' } }
    ],
    edges: [
      { from: 'welcome', to: 'config', input: 'SELF_USE' }, { from: 'welcome', to: 'config', input: 'INVESTMENT' },
      { from: 'config', to: 'list' }, { from: 'list', to: 'menu' },
      { from: 'menu', to: 'brochure', input: 'BROCHURE' }, { from: 'menu', to: 'visit', input: 'VISIT' }, { from: 'menu', to: 'callback', input: 'CALL' },
      { from: 'brochure', to: 'menu' }, { from: 'visit', to: 'end' }, { from: 'callback', to: 'end' }
    ]
  },
  rent_inquiry: {
    name: 'Rent Inquiry',
    nodes: [
      { code: 'greet', type: 'send_message', name: 'Greeting', config: { text: 'Hello! Looking to rent a property?' } },
      { code: 'type', type: 'collect_input', name: 'Property Type', config: { text: 'What type of property?', options: [{ label: 'Residential', value: 'residential' }, { label: 'Commercial', value: 'commercial' }], field: 'property_type' } },
      { code: 'budget', type: 'collect_input', name: 'Budget', config: { text: 'Monthly budget range?', options: [{ label: '< 30K', value: '<30k' }, { label: '30-60K', value: '30-60k' }, { label: '> 60K', value: '>60k' }], field: 'budget_range' } },
      { code: 'list', type: 'show_list', name: 'Rentals', config: { text: 'Available rentals:', filter_mode: 'all' } },
      { code: 'end', type: 'end_conversation', name: 'End', config: { text: 'We will contact you soon!' } }
    ],
    edges: [
      { from: 'greet', to: 'type' }, { from: 'type', to: 'budget' }, { from: 'budget', to: 'list' }, { from: 'list', to: 'end' }
    ]
  }
};

router.post('/flows/templates', async (req, res) => {
  const clientId = resolveClientId(req);
  const { template } = req.body;
  const tpl = TEMPLATES[template];
  if (!tpl) return res.status(400).json({ success: false, error: 'Unknown template' });
  try {
    const flow = await db.createFlow({ clientId, flowName: tpl.name, flowVersion: 1, isActive: false });
    const nodeMap = {};
    for (let i = 0; i < tpl.nodes.length; i++) {
      const n = tpl.nodes[i];
      const r = await db.createNode({ flowId: flow.flow_id, nodeCode: n.code, nodeType: n.type, nodeName: n.name, config: n.config, orderIndex: i });
      nodeMap[n.code] = r.node_id;
    }
    if (tpl.nodes.length > 0) await db.updateFlow(flow.flow_id, { startNodeId: nodeMap[tpl.nodes[0].code] });
    for (const e of tpl.edges) {
      await db.createEdge({ flowId: flow.flow_id, fromNodeId: nodeMap[e.from], toNodeId: nodeMap[e.to], userInputValue: e.input || null, conditionLogic: {}, priority: 0 });
    }
    respond(req, res, { success: true, flow }, '/admin/flows?flowId=' + flow.flow_id);
  } catch (err) { respond(req, res, { success: false, error: err.message }, '/admin/flows'); }
});
router.post('/flows/steps', async (req, res) => {
  const clientId = resolveClientId(req);
  const flowId = req.body.flow_id;
  if (!flowId) return res.status(400).json({ success: false, error: 'No flow specified' });
  const flow = await db.getFlowById(flowId);
  if (!flow) return res.status(400).json({ success: false, error: 'Flow not found' });
  const { step_name, message_text, step_type, options, save_field } = req.body;
  if (!step_name || !step_name.trim()) {
    return res.status(400).json({ success: false, error: 'Step name is required' });
  }
  if (!message_text || !message_text.trim()) {
    return res.status(400).json({ success: false, error: 'Message text is required' });
  }
  const typeRow = (await db.getAllNodeTypes()).find(t => t.node_type_code === step_type);
  const nodeType = typeRow ? typeRow.node_type_code : 'send_message';
  const config = { text: message_text };
  if (step_type === 'property_welcome') {
    const labels = req.body['button_label'] || [];
    const actions = req.body['button_action'] || [];
    config.buttons = [];
    for (let i = 0; i < labels.length; i++) {
      const label = String(labels[i] || '').trim();
      const action = String(actions[i] || '').trim();
      if (label && action) config.buttons.push({ title: label, id: action.toUpperCase() });
    }
    if (config.buttons.length === 0 && options) {
      config.buttons = options.split('\n').filter(l => l.trim()).map(line => {
        const [label, id] = line.split(':').map(s => s.trim());
        return { title: label, id: (id || getCanonicalId(label)).toUpperCase() };
      });
    }
  } else if (options && (step_type === 'collect_input' || step_type === 'book_appointment')) {
    const lines = options.split('\n').filter(l => l.trim());
    if (step_type === 'question') {
      config.options = lines.map(line => { const [label, value] = line.split(':').map(s => s.trim()); return { label, value: value || label }; });
      config.field = save_field || step_name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    } else {
      config.options = lines.map(line => ({ label: line, value: line }));
    }
  } else if (step_type === 'collect_input') {
    config.field = save_field || step_name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  }
  if (step_type === 'property_list') {
    config.source_table = 'properties';
    try { const parsed = JSON.parse(options || '{}'); config.filter_mode = parsed.mode || 'all'; config.match_dimensions = parsed.match_dimensions || []; } catch (e) { config.filter_mode = 'all'; config.match_dimensions = []; }
  }
  const nodeCode = step_name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') + '_' + Date.now();
  try {
    const newNode = await db.createNode({ flowId: flow.flow_id, nodeCode, nodeType, nodeName: step_name, config, orderIndex: 0 });
    if (!flow.start_node_id) await db.updateFlow(flow.flow_id, { startNodeId: newNode.node_id });
    respond(req, res, { success: true, node: newNode }, '/admin/flows?flowId=' + flow.flow_id);
  } catch (err) { respond(req, res, { success: false, error: err.message }, '/admin/flows'); }
});

router.post('/flows/steps/:id/update', async (req, res) => {
  const { step_name, message_text, options, save_field, document_url, fallback_node_id } = req.body;
  const flowId = req.body.flow_id;
  console.log('🔍 UPDATE BODY:', req.body);
  try {
    const node = await db.getNodeById(req.params.id);
    const meta = (await db.getAllNodeTypes()).find(t => t.node_type_code === node.node_type)?.builder_meta || {};
    if (!step_name || !step_name.trim()) {
      return res.status(400).json({ success: false, error: 'Step name is required' });
    }
    const hasTextField = (meta.fields || []).includes('text');
    if (hasTextField && message_text !== undefined && !message_text.trim()) {
      return res.status(400).json({ success: false, error: 'Message text is required' });
    }
    console.log('🔍 UPDATE BODY for node', req.params.id, ':', req.body);
    const config = node.config || {};
    console.log('DEBUG update node', req.params.id, 'body:', req.body, 'current config:', JSON.stringify(config));
    const fields = meta.fields || [];

    if (message_text !== undefined) config.text = message_text;

    if (fields.includes('options') && options !== undefined) {
      const lines = options.split('\n').filter(l => l.trim());
      if (node.node_type === 'collect_input') {
        config.options = lines.map(line => {
          const [label, value] = line.split(':').map(s => s.trim());
          return { label, value: value || label };
        });
      } else if (node.node_type === 'book_appointment') {
        config.options = lines.map(line => ({ label: line, value: line }));
      }
    }

    if (fields.includes('buttons')) {
      const labels = req.body['button_label'] || [];
      const actions = req.body['button_action'] || [];
      config.buttons = [];
      for (let i = 0; i < labels.length; i++) {
        const label = String(labels[i] || '').trim();
        const action = String(actions[i] || '').trim();
        if (label && action) config.buttons.push({ title: label, id: action.toUpperCase() });
      }
      if (config.buttons.length === 0 && options !== undefined) {
        config.buttons = options.split('\n').filter(l => l.trim()).map(line => {
          const [label, id] = line.split(':').map(s => s.trim());
          return { title: label, id: (id || getCanonicalId(label)).toUpperCase() };
        });
      }
      delete config.options;
    }

    if (fields.includes('field') && save_field !== undefined) {
      config.field = save_field || undefined;
    }

    if (fields.includes('list_mode')) {
      const listMode = req.body['list-mode'] || 'all';
      const matchDims = req.body['match_dimensions[]'] || req.body.match_dimensions || [];
      config.filter_mode = listMode;
      config.match_dimensions = Array.isArray(matchDims) ? matchDims : [matchDims];
      if (fallback_node_id) config.fallback_node_id = parseInt(fallback_node_id);
      else delete config.fallback_node_id;
      delete config.options;
    }

    if (fields.includes('source') && req.body.source) {
      config.source = req.body.source;
    }

    if (fields.includes('media_items') && req.body.media_items_json) {
      try {
        const items = JSON.parse(req.body.media_items_json);
        config.media_items = Array.isArray(items) && items.length > 0 ? items : [];
        delete config.document_url_field;
        delete config.filename;
      } catch (e) { }
    } else if (fields.includes('document_url') && document_url !== undefined) {
      config.document_url_field = document_url;
      delete config.media_items;
      delete config.filename;
    }

    if (node.node_type === 'book_appointment' && options === '') config.options = [];
    await db.updateNode(req.params.id, { nodeName: step_name, config });
    const updated = await db.getNodeById(req.params.id);
    respond(req, res, { success: true, node: updated }, flowId ? `/admin/flows?flowId=${flowId}` : '/admin/flows');
  } catch (err) { respond(req, res, { success: false, error: err.message }, '/admin/flows'); }
});
router.post('/flows/steps/:id/delete', async (req, res) => {
  try { await db.deleteNode(req.params.id); respond(req, res, { success: true }, '/admin/flows'); }
  catch (err) { respond(req, res, { success: false, error: err.message }, '/admin/flows'); }
});

// ── CRITICAL FIX: use the node's actual flow, not the active flow ──
router.post('/flows/connections', async (req, res) => {
  const { from_step, to_step, user_choice, outcome_name, action_type, action_field } = req.body;
  const fromNode = await db.getNodeById(from_step);
  if (!fromNode) return res.status(400).json({ success: false, error: 'From step not found' });
  const flowId = fromNode.flow_id;
  const conditionLogic = flowService.buildEdgeAction(action_type, { field: action_field });
  const userInputValue = (user_choice && String(user_choice).trim()) ? String(user_choice).trim() : null;
  const outcomeNameValue = (outcome_name && String(outcome_name).trim()) ? String(outcome_name).trim() : null;
  try {
    const edge = await db.createEdge({ flowId, fromNodeId: from_step, toNodeId: to_step, userInputValue, outcomeName: outcomeNameValue, conditionLogic, priority: 0 });
    respond(req, res, { success: true, edge }, '/admin/flows?flowId=' + flowId);
  } catch (err) { respond(req, res, { success: false, error: err.message }, '/admin/flows'); }
});

router.post('/flows/connections/:id/delete', async (req, res) => {
  try { await db.deleteEdge(req.params.id); respond(req, res, { success: true }, '/admin/flows'); }
  catch (err) { respond(req, res, { success: false, error: err.message }, '/admin/flows'); }
});

// ═════════════════ LEADS CRM ═════════════════
router.get('/leads', async (req, res) => {
  const clientId = resolveClientId(req);
  const { search, stage } = req.query;
  let sql = 'SELECT * FROM crm_leads_view WHERE client_id = $1';
  const params = [clientId];
  let idx = 2;
  if (search) { sql += ` AND (contact_name ILIKE $${idx} OR whatsapp_number ILIKE $${idx} OR lead_display_id ILIKE $${idx})`; params.push(`%${search}%`); idx++; }
  if (stage) { sql += ` AND current_pipeline_stage = $${idx++}`; params.push(stage); }
  sql += ' ORDER BY latest_contact_date DESC NULLS LAST LIMIT 100';
  const result = await pool.query(sql, params);
  render(req, res, 'admin/leads', { title: 'Leads', leads: result.rows, search, stage, clientId });
});

router.get('/leads/:id', async (req, res) => {
  const lead = await db.getLeadById(req.params.id);
  if (!lead) return res.status(404).send('Lead not found');
  const answers = await db.getLeadAnswers(req.params.id);
  const history = await pool.query('SELECT * FROM lead_history WHERE lead_id = $1 ORDER BY created_at DESC', [req.params.id]);
  const timeline = await db.getLeadTimeline(req.params.id);
  render(req, res, 'admin/lead-detail', { title: `Lead ${lead.lead_id}`, lead, answers, history: history.rows, timeline });
});

// ═════════════════ VISITS & CALLBACKS ═════════════════
router.get('/visits', async (req, res) => {
  const clientId = resolveClientId(req);
  const visitsRes = await pool.query(`SELECT * FROM crm_appointments_view WHERE client_id = $1 ORDER BY created_at DESC LIMIT 100`, [clientId]);
  const cbRes = await pool.query(`SELECT * FROM crm_callbacks_view WHERE client_id = $1 ORDER BY created_at DESC LIMIT 100`, [clientId]);
  render(req, res, 'admin/visits-callbacks', { title: 'Visits & Callbacks', visits: visitsRes.rows, callbacks: cbRes.rows, clientId });
});

router.post('/visits/:id/update', async (req, res) => {
  const { status, gate_pass_status, visit_outcome, agent_notes } = req.body;
  try { await pool.query(`UPDATE site_visits SET status=$1, gate_pass_status=$2, visit_outcome=$3, agent_notes=$4, updated_at=NOW() WHERE site_visit_id=$5`, [status, gate_pass_status, visit_outcome, agent_notes, req.params.id]); redirectWithQuery(res, req, '/admin/visits'); }
  catch (err) { res.status(500).send('Error: ' + err.message); }
});

router.post('/callbacks/:id/update', async (req, res) => {
  const { status } = req.body;
  try { await pool.query(`UPDATE callback_requests SET status=$1, resolved_at=CASE WHEN $1='RESOLVED' THEN NOW() ELSE resolved_at END WHERE callback_request_id=$2`, [status, req.params.id]); redirectWithQuery(res, req, '/admin/visits'); }
  catch (err) { res.status(500).send('Error: ' + err.message); }
});

// ═════════════════ CLIENTS ═════════════════
router.get('/clients', async (req, res, next) => { try { const clients = await clientService.listClients(req.query.search || ''); res.render('admin/clients', { title: 'Clients', clients, search: req.query.search || '', req }); } catch (err) { next(err); } });
router.get('/clients/new', (req, res) => { res.render('admin/client-form', { title: 'New Client', client: null, req }); });
router.post('/clients', async (req, res, next) => { try { await clientService.createClient({ businessName: req.body.business_name, metaWabaId: req.body.meta_waba_id || null, metaPhoneNumberId: req.body.meta_phone_number_id || null, metaAccessToken: req.body.meta_access_token || null }); redirectWithQuery(res, req, '/admin/clients'); } catch (err) { next(err); } });
router.get('/clients/:id', async (req, res, next) => { try { const client = await clientService.getClient(req.params.id); if (!client) return res.status(404).send('Client not found'); const stats = await clientService.getClientStats(req.params.id); const activity = await clientService.getClientRecentActivity(req.params.id); const allFlows = await db.getFlowsByClient(req.params.id); res.render('admin/client-detail', { title: client.business_name, client, stats, allFlows, ...activity, req }); } catch (err) { next(err); } });
router.get('/clients/:id/edit', async (req, res, next) => { try { const client = await clientService.getClient(req.params.id); if (!client) return res.status(404).send('Client not found'); res.render('admin/client-form', { title: 'Edit Client', client, req }); } catch (err) { next(err); } });
router.post('/clients/:id', async (req, res, next) => { try { await clientService.updateClient(req.params.id, { businessName: req.body.business_name, metaWabaId: req.body.meta_waba_id || null, metaPhoneNumberId: req.body.meta_phone_number_id || null, metaAccessToken: req.body.meta_access_token || null, active: req.body.active === 'true' || req.body.active === 'on' }); redirectWithQuery(res, req, '/admin/clients'); } catch (err) { next(err); } });
router.post('/clients/:id/toggle', async (req, res, next) => { try { await clientService.toggleClientActive(req.params.id); redirectWithQuery(res, req, '/admin/clients'); } catch (err) { next(err); } });

module.exports = router;