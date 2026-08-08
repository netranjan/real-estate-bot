const pool = require('./pool');

// ── HELPERS ──
async function query(sql, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res;
  } finally {
    client.release();
  }
}

async function queryOne(sql, params) {
  const res = await query(sql, params);
  return res.rows[0] || null;
}

async function queryMany(sql, params) {
  const res = await query(sql, params);
  return res.rows;
}

// ═══════════════════════════════════════
// CLIENTS
// ═══════════════════════════════════════

async function getAllClients(search) {
  let sql = 'SELECT * FROM clients';
  const params = [];
  if (search) {
    sql += ' WHERE business_name ILIKE $1';
    params.push(`%${search}%`);
  }
  sql += ' ORDER BY created_at DESC';
  return queryMany(sql, params);
}

async function getClientById(clientId) {
  return queryOne(
    'SELECT * FROM clients WHERE client_id = $1 AND active = TRUE',
    [clientId]
  );
}

async function getClientByIdIncludingInactive(clientId) {
  return queryOne('SELECT * FROM clients WHERE client_id = $1', [clientId]);
}

async function getClientByPhoneNumberId(phoneNumberId) {
  return queryOne(
    'SELECT * FROM clients WHERE meta_phone_number_id = $1 AND active = TRUE',
    [phoneNumberId]
  );
}

async function createClient({ businessName, metaWabaId, metaPhoneNumberId, metaAccessToken }) {
  const res = await query(
    `INSERT INTO clients (business_name, meta_waba_id, meta_phone_number_id, meta_access_token)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [businessName, metaWabaId || null, metaPhoneNumberId || null, metaAccessToken || null]
  );
  return res.rows[0];
}

async function updateClient(clientId, fields) {
  const setClause = [];
  const values = [];
  let idx = 1;

  if (fields.businessName !== undefined) {
    setClause.push(`business_name = $${idx++}`);
    values.push(fields.businessName);
  }
  if (fields.metaWabaId !== undefined) {
    setClause.push(`meta_waba_id = $${idx++}`);
    values.push(fields.metaWabaId);
  }
  if (fields.metaPhoneNumberId !== undefined) {
    setClause.push(`meta_phone_number_id = $${idx++}`);
    values.push(fields.metaPhoneNumberId);
  }
  if (fields.metaAccessToken !== undefined) {
    setClause.push(`meta_access_token = $${idx++}`);
    values.push(fields.metaAccessToken);
  }
  if (fields.active !== undefined) {
    setClause.push(`active = $${idx++}`);
    values.push(fields.active);
  }

  if (setClause.length === 0) return getClientByIdIncludingInactive(clientId);

  values.push(clientId);
  const sql = `UPDATE clients SET ${setClause.join(', ')} WHERE client_id = $${idx} RETURNING *`;
  const res = await query(sql, values);
  return res.rows[0];
}

async function deleteClient(clientId) {
  return query('DELETE FROM clients WHERE client_id = $1', [clientId]);
}

// ═══════════════════════════════════════
// AGENTS
// ═══════════════════════════════════════

async function getActiveAgents(clientId) {
  return queryMany(
    'SELECT * FROM agents WHERE client_id = $1 AND active = TRUE ORDER BY agent_id',
    [clientId]
  );
}

async function getAgentById(agentId) {
  return queryOne(
    'SELECT * FROM agents WHERE agent_id = $1',
    [agentId]
  );
}

// ═══════════════════════════════════════
// NODE TYPES
// ═══════════════════════════════════════

async function getAllNodeTypes() {
  return queryMany(
    'SELECT * FROM node_types ORDER BY node_type_name',
    []
  );
}

// ═══════════════════════════════════════
// FLOWS
// ═══════════════════════════════════════

async function getFlowsByClient(clientId) {
  return queryMany(
    'SELECT * FROM conversation_flows WHERE client_id = $1 ORDER BY created_at DESC',
    [clientId]
  );
}

async function getFlowById(flowId) {
  return queryOne('SELECT * FROM conversation_flows WHERE flow_id = $1', [flowId]);
}

async function getActiveFlowForClient(clientId) {
  return queryOne(
    'SELECT * FROM conversation_flows WHERE client_id = $1 AND is_active = TRUE LIMIT 1',
    [clientId]
  );
}

async function createFlow({ clientId, flowName, flowVersion, isActive, startNodeId }) {
  if (isActive) {
    await query(
      'UPDATE conversation_flows SET is_active = FALSE WHERE client_id = $1',
      [clientId]
    );
  }
  const res = await query(
    `INSERT INTO conversation_flows (client_id, flow_name, flow_version, is_active, start_node_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [clientId, flowName, flowVersion || 1, isActive || false, startNodeId || null]
  );
  return res.rows[0];
}

async function updateFlow(flowId, fields) {
  const setClause = [];
  const values = [];
  let idx = 1;

  if (fields.flowName !== undefined) {
    setClause.push(`flow_name = $${idx++}`);
    values.push(fields.flowName);
  }
  if (fields.flowVersion !== undefined) {
    setClause.push(`flow_version = $${idx++}`);
    values.push(fields.flowVersion);
  }
  if (fields.isActive !== undefined) {
    setClause.push(`is_active = $${idx++}`);
    values.push(fields.isActive);
  }
  if (fields.startNodeId !== undefined) {
    setClause.push(`start_node_id = $${idx++}`);
    values.push(fields.startNodeId);
  }

  if (setClause.length === 0) return getFlowById(flowId);

  values.push(flowId);
  const sql = `UPDATE conversation_flows SET ${setClause.join(', ')} WHERE flow_id = $${idx} RETURNING *`;
  const res = await query(sql, values);
  return res.rows[0];
}

async function deactivateOtherFlows(clientId, exceptFlowId) {
  return query(
    'UPDATE conversation_flows SET is_active = FALSE WHERE client_id = $1 AND flow_id != $2',
    [clientId, exceptFlowId]
  );
}

// ═══════════════════════════════════════
// FLOW NODES
// ═══════════════════════════════════════

async function getFlowNodes(flowId) {
  return queryMany(
    `SELECT n.*, nt.node_type_name
     FROM flow_nodes n
     JOIN node_types nt ON n.node_type = nt.node_type_code
     WHERE n.flow_id = $1 AND n.active = TRUE
     ORDER BY n.order_index, n.node_id`,
    [flowId]
  );
}

async function getNodeById(nodeId) {
  return queryOne(
    `SELECT n.*, nt.node_type_name, nt.description
     FROM flow_nodes n
     JOIN node_types nt ON n.node_type = nt.node_type_code
     WHERE n.node_id = $1 AND n.active = TRUE`,
    [nodeId]
  );
}

async function getNodeByCode(flowId, nodeCode) {
  return queryOne(
    `SELECT n.*, nt.node_type_name, nt.description
     FROM flow_nodes n
     JOIN node_types nt ON n.node_type = nt.node_type_code
     WHERE n.flow_id = $1 AND n.node_code = $2 AND n.active = TRUE`,
    [flowId, nodeCode]
  );
}

async function createNode({ flowId, nodeCode, nodeType, nodeName, config, orderIndex }) {
  const res = await query(
    `INSERT INTO flow_nodes (flow_id, node_code, node_type, node_name, config, order_index, active)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING *`,
    [flowId, nodeCode, nodeType, nodeName, JSON.stringify(config || {}), orderIndex || 0]
  );
  return res.rows[0];
}

async function updateNode(nodeId, fields) {
  const setClause = [];
  const values = [];
  let idx = 1;

  if (fields.nodeName !== undefined) {
    setClause.push(`node_name = $${idx++}`);
    values.push(fields.nodeName);
  }
  if (fields.config !== undefined) {
    setClause.push(`config = $${idx++}`);
    values.push(JSON.stringify(fields.config));
  }
  if (fields.orderIndex !== undefined) {
    setClause.push(`order_index = $${idx++}`);
    values.push(fields.orderIndex);
  }
  if (fields.active !== undefined) {
    setClause.push(`active = $${idx++}`);
    values.push(fields.active);
  }

  if (setClause.length === 0) return getNodeById(nodeId);

  values.push(nodeId);
  const sql = `UPDATE flow_nodes SET ${setClause.join(', ')} WHERE node_id = $${idx} RETURNING *`;
  const res = await query(sql, values);
  return res.rows[0];
}

async function updateNodeOrder(nodeId, orderIndex) {
  return query(
    'UPDATE flow_nodes SET order_index = $1 WHERE node_id = $2',
    [orderIndex, nodeId]
  );
}

async function deleteNode(nodeId) {
  return query('DELETE FROM flow_nodes WHERE node_id = $1', [nodeId]);
}

// ═══════════════════════════════════════
// FLOW EDGES
// ═══════════════════════════════════════

async function getFlowEdges(flowId) {
  return queryMany(
    `SELECT e.*, fn.node_name as from_name, tn.node_name as to_name
     FROM flow_edges e
     JOIN flow_nodes fn ON e.from_node_id = fn.node_id
     JOIN flow_nodes tn ON e.to_node_id = tn.node_id
     WHERE e.flow_id = $1 AND e.active = TRUE`,
    [flowId]
  );
}

async function getEdgesFromNode(fromNodeId) {
  return queryMany(
    `SELECT e.*, fn.node_code AS from_code, tn.node_code AS to_code
     FROM flow_edges e
     JOIN flow_nodes fn ON e.from_node_id = fn.node_id
     JOIN flow_nodes tn ON e.to_node_id = tn.node_id
     WHERE e.from_node_id = $1 AND e.active = TRUE
     ORDER BY e.priority DESC, e.edge_id ASC`,
    [fromNodeId]
  );
}

async function getEdgeByInput(fromNodeId, userInput) {
  return queryOne(
    `SELECT e.*, tn.node_id AS next_node_id, tn.node_code AS next_code
     FROM flow_edges e
     JOIN flow_nodes tn ON e.to_node_id = tn.node_id
     WHERE e.from_node_id = $1
       AND (LOWER(e.user_input_value) = LOWER($2) OR e.user_input_value IS NULL)
       AND e.active = TRUE
     ORDER BY
       CASE WHEN LOWER(e.user_input_value) = LOWER($2) THEN 0 ELSE 1 END,
       e.priority DESC
     LIMIT 1`,
    [fromNodeId, userInput]
  );
}

async function createEdge({ flowId, fromNodeId, toNodeId, userInputValue, outcomeName, conditionLogic, priority }) {
  const res = await query(
    `INSERT INTO flow_edges (flow_id, from_node_id, to_node_id, user_input_value, outcome_name, condition_logic, priority, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE) RETURNING *`,
    [flowId, fromNodeId, toNodeId, userInputValue || null, outcomeName || null, JSON.stringify(conditionLogic || {}), priority || 0]
  );
  return res.rows[0];
}

async function updateEdgeCondition(edgeId, conditionLogic) {
  return query(
    'UPDATE flow_edges SET condition_logic = $1 WHERE edge_id = $2',
    [JSON.stringify(conditionLogic), edgeId]
  );
}

async function deleteEdge(edgeId) {
  return query('DELETE FROM flow_edges WHERE edge_id = $1', [edgeId]);
}

// ═══════════════════════════════════════
// LEADS
// ═══════════════════════════════════════

async function findLeadByWhatsApp(whatsappNumber, clientId) {
  return queryOne(
    'SELECT * FROM leads WHERE whatsapp_number = $1 AND client_id = $2',
    [whatsappNumber, clientId]
  );
}

async function createLead({ clientId, whatsappNumber, name, currentFlowId, currentNodeId }) {
  const res = await query(
    `INSERT INTO leads (client_id, whatsapp_number, name, current_flow_id, current_node_id, pipeline_stage)
     VALUES ($1, $2, $3, $4, $5, 'New Lead')
     RETURNING *`,
    [clientId, whatsappNumber, name, currentFlowId, currentNodeId]
  );
  return res.rows[0];
}

async function getLeadById(leadId) {
  return queryOne('SELECT * FROM leads WHERE lead_id = $1', [leadId]);
}

async function getLeadContextData(leadId) {
  const lead = await getLeadById(leadId);
  return lead ? (lead.context_data || {}) : {};
}

async function updateLeadNode(leadId, nodeId) {
  return query(
    'UPDATE leads SET current_node_id = $1, updated_at = NOW() WHERE lead_id = $2',
    [nodeId, leadId]
  );
}

async function updateLeadContext(leadId, contextData) {
  return query(
    'UPDATE leads SET context_data = $1, updated_at = NOW() WHERE lead_id = $2',
    [JSON.stringify(contextData), leadId]
  );
}

async function updateLeadPipeline(leadId, stage) {
  return query(
    'UPDATE leads SET pipeline_stage = $1, updated_at = NOW() WHERE lead_id = $2',
    [stage, leadId]
  );
}

async function assignAgentToLead(leadId, agentId) {
  return query(
    'UPDATE leads SET assigned_agent_id = $1, updated_at = NOW() WHERE lead_id = $2',
    [agentId, leadId]
  );
}

async function updateLeadScore(leadId, score) {
  return query(
    'UPDATE leads SET ai_score = $1, updated_at = NOW() WHERE lead_id = $2',
    [score, leadId]
  );
}

async function updateLeadName(leadId, name) {
  return query(
    'UPDATE leads SET name = $1, updated_at = NOW() WHERE lead_id = $2',
    [name, leadId]
  );
}

// ═══════════════════════════════════════
// LEAD ANSWERS
// ═══════════════════════════════════════

async function saveLeadAnswer(leadId, fieldName, fieldValue, nodeId) {
  return query(
    `INSERT INTO lead_answers (lead_id, field_name, field_value, node_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (lead_id, field_name)
     DO UPDATE SET field_value = EXCLUDED.field_value, node_id = EXCLUDED.node_id, created_at = NOW()`,
    [leadId, fieldName, fieldValue, nodeId]
  );
}

async function getLeadAnswers(leadId) {
  return queryMany(
    'SELECT field_name, field_value FROM lead_answers WHERE lead_id = $1',
    [leadId]
  );
}

// ═══════════════════════════════════════
// LEAD HISTORY & TIMELINE
// ═══════════════════════════════════════

async function addHistory(leadId, eventType, nodeId, details) {
  return query(
    'INSERT INTO lead_history (lead_id, event_type, node_id, details) VALUES ($1, $2, $3, $4)',
    [leadId, eventType, nodeId, JSON.stringify(details || {})]
  );
}

async function getLeadTimeline(leadId) {
  return queryMany(
    `SELECT 
       lh.history_id,
       lh.event_type,
       lh.details,
       lh.created_at,
       fn.node_name,
       fn.node_type,
       nt.node_type_name
     FROM lead_history lh
     LEFT JOIN flow_nodes fn ON lh.node_id = fn.node_id
     LEFT JOIN node_types nt ON fn.node_type = nt.node_type_code
     WHERE lh.lead_id = $1
     ORDER BY lh.created_at ASC`,
    [leadId]
  );
}

async function logPropertySelection(leadId, oldPropertyId, newPropertyId, nodeId) {
  return addHistory(leadId, 'PROPERTY_SELECTED', nodeId, {
    old_property_id: oldPropertyId,
    new_property_id: newPropertyId
  });
}

// ═══════════════════════════════════════
// PROPERTIES
// ═══════════════════════════════════════

async function getPropertiesByClient(clientId) {
  return queryMany(
    'SELECT * FROM properties WHERE client_id = $1 AND active = TRUE ORDER BY property_id',
    [clientId]
  );
}

async function getPropertyById(propertyId) {
  return queryOne(
    'SELECT * FROM properties WHERE property_id = $1',
    [propertyId]
  );
}

async function getPropertyByReferralCode(code) {
  return queryOne(
    'SELECT * FROM properties WHERE referral_code = $1 AND active = TRUE',
    [code]
  );
}

async function filterProperties(clientId, configuration, budgetMin, budgetMax) {
  let sql = 'SELECT * FROM properties WHERE client_id = $1 AND active = TRUE';
  const params = [clientId];
  let idx = 2;

  if (configuration) {
    sql += ` AND configuration_types @> $${idx}::jsonb`;
    params.push(JSON.stringify([configuration]));
    idx++;
  }

  if (budgetMin !== null && budgetMax !== null) {
    sql += ` AND price_min >= $${idx} AND price_max <= $${idx + 1}`;
    params.push(budgetMin, budgetMax);
    idx += 2;
  }

  sql += ' ORDER BY price_min ASC';
  return queryMany(sql, params);
}

// ═══════════════════════════════════════
// MEDIA ASSETS
// ═══════════════════════════════════════

async function getMediaForProperty(propertyId, assetType) {
  return queryMany(
    'SELECT * FROM media_assets WHERE property_id = $1 AND asset_type = $2',
    [propertyId, assetType]
  );
}

// ═══════════════════════════════════════
// PROPERTY VISIT OPTIONS
// ═══════════════════════════════════════

async function getVisitOptionsForProperty(propertyId) {
  return queryMany(
    'SELECT * FROM property_visit_options WHERE property_id = $1 AND active = TRUE',
    [propertyId]
  );
}

// ═══════════════════════════════════════
// SITE VISITS
// ═══════════════════════════════════════

async function createSiteVisit({ leadId, propertyId, visitOptionId, agentId }) {
  const res = await query(
    `INSERT INTO site_visits (lead_id, property_id, visit_option_id, assigned_agent_id, status)
     VALUES ($1, $2, $3, $4, 'BOOKED')
     RETURNING *`,
    [leadId, propertyId, visitOptionId, agentId]
  );
  return res.rows[0];
}

async function getSiteVisitsForLead(leadId) {
  return queryMany(
    'SELECT * FROM site_visits WHERE lead_id = $1 ORDER BY created_at DESC',
    [leadId]
  );
}

// ═══════════════════════════════════════
// CALLBACK REQUESTS
// ═══════════════════════════════════════

async function createCallbackRequest({ leadId, assignedAgentId, slaMinutes }) {
  const res = await query(
    `INSERT INTO callback_requests (lead_id, assigned_agent_id, status, sla_deadline)
     VALUES ($1, $2, 'PENDING', NOW() + INTERVAL '${slaMinutes} minutes')
     RETURNING *`,
    [leadId, assignedAgentId]
  );
  return res.rows[0];
}

async function getPendingCallbacksForAgent(agentId) {
  return queryMany(
    `SELECT * FROM callback_requests
     WHERE assigned_agent_id = $1 AND status = 'PENDING'
     ORDER BY created_at ASC`,
    [agentId]
  );
}

// ═══════════════════════════════════════
// CLIENT STATS
// ═══════════════════════════════════════

async function countLeadsByClient(clientId) {
  const res = await query('SELECT COUNT(*) FROM leads WHERE client_id = $1', [clientId]);
  return parseInt(res.rows[0].count, 10);
}

async function countPropertiesByClient(clientId) {
  const res = await query('SELECT COUNT(*) FROM properties WHERE client_id = $1', [clientId]);
  return parseInt(res.rows[0].count, 10);
}

async function countFlowsByClient(clientId) {
  const res = await query('SELECT COUNT(*) FROM conversation_flows WHERE client_id = $1', [clientId]);
  return parseInt(res.rows[0].count, 10);
}

async function countAgentsByClient(clientId) {
  const res = await query('SELECT COUNT(*) FROM agents WHERE client_id = $1', [clientId]);
  return parseInt(res.rows[0].count, 10);
}

async function getLeadsByClient(clientId, limit = 10) {
  return queryMany(
    'SELECT * FROM leads WHERE client_id = $1 ORDER BY created_at DESC LIMIT $2',
    [clientId, limit]
  );
}

async function getRecentSiteVisitsByClient(clientId, limit = 10) {
  return queryMany(
    `SELECT sv.*, l.name as lead_name, l.whatsapp_number, p.property_name
     FROM site_visits sv
     JOIN leads l ON sv.lead_id = l.lead_id
     LEFT JOIN properties p ON sv.property_id = p.property_id
     WHERE l.client_id = $1
     ORDER BY sv.created_at DESC LIMIT $2`,
    [clientId, limit]
  );
}

async function getRecentCallbacksByClient(clientId, limit = 10) {
  return queryMany(
    `SELECT cr.*, l.name as lead_name, l.whatsapp_number
     FROM callback_requests cr
     JOIN leads l ON cr.lead_id = l.lead_id
     WHERE l.client_id = $1
     ORDER BY cr.created_at DESC LIMIT $2`,
    [clientId, limit]
  );
}

// ═══════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════

module.exports = {
  
   pool,
  // clients
  getAllClients,
  getClientById,
  getClientByIdIncludingInactive,
  getClientByPhoneNumberId,
  createClient,
  updateClient,
  deleteClient,

  // agents
  getActiveAgents,
  getAgentById,

  // node types
  getAllNodeTypes,

  // flows
  getFlowsByClient,
  getFlowById,
  getActiveFlowForClient,
  createFlow,
  updateFlow,
  deactivateOtherFlows,

  // nodes
  getFlowNodes,
  getNodeById,
  getNodeByCode,
  createNode,
  updateNode,
  updateNodeOrder,
  deleteNode,

  // edges
  getFlowEdges,
  getEdgesFromNode,
  getEdgeByInput,
  createEdge,
  updateEdgeCondition,
  deleteEdge,

  // leads
  findLeadByWhatsApp,
  createLead,
  getLeadById,
  getLeadContextData,
  updateLeadNode,
  updateLeadContext,
  updateLeadPipeline,
  assignAgentToLead,
  updateLeadScore,
  updateLeadName,

  // answers
  saveLeadAnswer,
  getLeadAnswers,

  // history & timeline
  addHistory,
  getLeadTimeline,
  logPropertySelection,

  // properties
  getPropertiesByClient,
  getPropertyById,
  getPropertyByReferralCode,
  filterProperties,

  // media
  getMediaForProperty,

  // visits
  getVisitOptionsForProperty,
  createSiteVisit,
  getSiteVisitsForLead,

  // callbacks
  createCallbackRequest,
  getPendingCallbacksForAgent,

  // client stats
  countLeadsByClient,
  countPropertiesByClient,
  countFlowsByClient,
  countAgentsByClient,
  getLeadsByClient,
  getRecentSiteVisitsByClient,
  getRecentCallbacksByClient,
};