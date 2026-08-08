// db/repository.js
// Organized data access layer. Replaces scattered raw SQL + god-object queries.js
// for the engine layer. Admin routes can continue using db/queries.js.

const pool = require('./pool');

// ── INTERNAL HELPER ──
async function query(sql, params) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
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

// ═══════════════════════════════════════════════════════════════════════════════
// REPOSITORY CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class Repository {
  // ── CLIENTS ──
  async getClientById(clientId) {
    return queryOne(
      'SELECT * FROM clients WHERE client_id = $1 AND active = TRUE',
      [clientId]
    );
  }

  async getClientByPhoneNumberId(phoneNumberId) {
    return queryOne(
      'SELECT * FROM clients WHERE meta_phone_number_id = $1 AND active = TRUE',
      [phoneNumberId]
    );
  }

  // ── AGENTS ──
  async getActiveAgents(clientId) {
    return queryMany(
      'SELECT * FROM agents WHERE client_id = $1 AND active = TRUE ORDER BY agent_id',
      [clientId]
    );
  }

  async getAgentById(agentId) {
    return queryOne('SELECT * FROM agents WHERE agent_id = $1', [agentId]);
  }

  // ── FLOWS ──
  async getActiveFlowForClient(clientId) {
    return queryOne(
      'SELECT * FROM conversation_flows WHERE client_id = $1 AND is_active = TRUE LIMIT 1',
      [clientId]
    );
  }

  async getFlowById(flowId) {
    return queryOne('SELECT * FROM conversation_flows WHERE flow_id = $1', [flowId]);
  }

  async getFlowNodes(flowId) {
    return queryMany(
      `SELECT n.*, nt.node_type_name
       FROM flow_nodes n
       JOIN node_types nt ON n.node_type = nt.node_type_code
       WHERE n.flow_id = $1 AND n.active = TRUE
       ORDER BY n.order_index, n.node_id`,
      [flowId]
    );
  }

  // ── NODES ──
  async getNodeById(nodeId) {
    return queryOne(
      `SELECT n.*, nt.node_type_name, nt.description
       FROM flow_nodes n
       JOIN node_types nt ON n.node_type = nt.node_type_code
       WHERE n.node_id = $1 AND n.active = TRUE`,
      [nodeId]
    );
  }

  async getNodeByCode(flowId, nodeCode) {
    return queryOne(
      `SELECT n.*, nt.node_type_name, nt.description
       FROM flow_nodes n
       JOIN node_types nt ON n.node_type = nt.node_type_code
       WHERE n.flow_id = $1 AND n.node_code = $2 AND n.active = TRUE`,
      [flowId, nodeCode]
    );
  }

  // ── EDGES (CRITICAL: O(1) lookup via Map) ──
  async getEdgesFromNode(fromNodeId) {
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

  async getEdgesMap(fromNodeId) {
    const edges = await this.getEdgesFromNode(fromNodeId);
    const map = new Map();
    let defaultEdge = null;

    for (const edge of edges) {
      if (edge.user_input_value === null) {
        defaultEdge = edge;
      } else {
        map.set(String(edge.user_input_value).trim().toLowerCase(), edge);
      }
    }

    return { map, defaultEdge, all: edges };
  }

  // ── LEADS ──
  async findLeadByWhatsApp(whatsappNumber, clientId) {
    return queryOne(
      'SELECT * FROM leads WHERE whatsapp_number = $1 AND client_id = $2',
      [whatsappNumber, clientId]
    );
  }

  async createLead({ clientId, whatsappNumber, name, currentFlowId, currentNodeId }) {
    const res = await query(
      `INSERT INTO leads (client_id, whatsapp_number, name, current_flow_id, current_node_id, pipeline_stage)
       VALUES ($1, $2, $3, $4, $5, 'New Lead') RETURNING *`,
      [clientId, whatsappNumber, name, currentFlowId, currentNodeId]
    );
    return res.rows[0];
  }

  async getLeadById(leadId) {
    return queryOne('SELECT * FROM leads WHERE lead_id = $1', [leadId]);
  }

  async updateLeadNode(leadId, nodeId) {
    return query(
      'UPDATE leads SET current_node_id = $1, updated_at = NOW() WHERE lead_id = $2',
      [nodeId, leadId]
    );
  }

  async updateLeadFlow(leadId, flowId, startNodeId) {
    return query(
      'UPDATE leads SET current_flow_id = $1, current_node_id = $2, updated_at = NOW() WHERE lead_id = $3',
      [flowId, startNodeId, leadId]
    );
  }

  async updateLeadContext(leadId, contextData) {
    return query(
      'UPDATE leads SET context_data = $1, updated_at = NOW() WHERE lead_id = $2',
      [JSON.stringify(contextData), leadId]
    );
  }

  async updateLeadPipeline(leadId, stage) {
    return query(
      'UPDATE leads SET pipeline_stage = $1, updated_at = NOW() WHERE lead_id = $2',
      [stage, leadId]
    );
  }

  async assignAgentToLead(leadId, agentId) {
    return query(
      'UPDATE leads SET assigned_agent_id = $1, updated_at = NOW() WHERE lead_id = $2',
      [agentId, leadId]
    );
  }

  async updateLeadScore(leadId, score) {
    return query(
      'UPDATE leads SET ai_score = $1, updated_at = NOW() WHERE lead_id = $2',
      [score, leadId]
    );
  }

  async updateLeadName(leadId, name) {
    return query(
      'UPDATE leads SET name = $1, updated_at = NOW() WHERE lead_id = $2',
      [name, leadId]
    );
  }

  // ── LEAD ANSWERS (cached-friendly) ──
  async getLeadAnswers(leadId) {
    return queryMany(
      'SELECT field_name, field_value FROM lead_answers WHERE lead_id = $1',
      [leadId]
    );
  }

  async saveLeadAnswer(leadId, fieldName, fieldValue, nodeId) {
    return query(
      `INSERT INTO lead_answers (lead_id, field_name, field_value, node_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (lead_id, field_name)
       DO UPDATE SET field_value = EXCLUDED.field_value, node_id = EXCLUDED.node_id, created_at = NOW()`,
      [leadId, fieldName, fieldValue, nodeId]
    );
  }

  async deleteLeadAnswers(leadId) {
    return query('DELETE FROM lead_answers WHERE lead_id = $1', [leadId]);
  }

  // ── CONTEXT BUNDLE (single round-trip for lead + answers) ──
  async getLeadContextBundle(leadId) {
    const lead = await this.getLeadById(leadId);
    if (!lead) return null;
    const answers = await this.getLeadAnswers(leadId);
    const answersMap = {};
    for (const a of answers) answersMap[a.field_name] = a.field_value;
    return { lead, answers, answersMap, context: lead.context_data || {} };
  }

  // ── PROPERTIES ──
  async getPropertiesByClient(clientId) {
    return queryMany(
      'SELECT * FROM properties WHERE client_id = $1 AND active = TRUE ORDER BY property_id',
      [clientId]
    );
  }

  async getPropertyById(propertyId) {
    return queryOne('SELECT * FROM properties WHERE property_id = $1', [propertyId]);
  }

  async getPropertyByReferralCode(code) {
    return queryOne(
      'SELECT * FROM properties WHERE referral_code = $1 AND active = TRUE',
      [code]
    );
  }

  // ── MEDIA ASSETS ──
  async getPropertyAssets(propertyId) {
    return queryMany(
      'SELECT * FROM media_assets WHERE property_id = $1 ORDER BY created_at',
      [propertyId]
    );
  }

  // ── VISIT OPTIONS ──
  async getVisitOptionsForProperty(propertyId) {
    return queryMany(
      'SELECT * FROM property_visit_options WHERE property_id = $1 AND active = TRUE',
      [propertyId]
    );
  }

  // ── SITE VISITS ──
  async createSiteVisit({ leadId, propertyId, visitOptionId, agentId }) {
    const res = await query(
      `INSERT INTO site_visits (lead_id, property_id, visit_option_id, assigned_agent_id, status)
       VALUES ($1, $2, $3, $4, 'BOOKED') RETURNING *`,
      [leadId, propertyId, visitOptionId, agentId]
    );
    return res.rows[0];
  }

  async getSiteVisitsForLead(leadId) {
    return queryMany(
      'SELECT * FROM site_visits WHERE lead_id = $1 ORDER BY created_at DESC',
      [leadId]
    );
  }

  // ── CALLBACKS ──
  async createCallbackRequest({ leadId, assignedAgentId, slaMinutes }) {
    const res = await query(
      `INSERT INTO callback_requests (lead_id, assigned_agent_id, status, sla_deadline)
       VALUES ($1, $2, 'PENDING', NOW() + INTERVAL '${slaMinutes} minutes')
       RETURNING *`,
      [leadId, assignedAgentId]
    );
    return res.rows[0];
  }

  // ── HISTORY ──
  async addHistory(leadId, eventType, nodeId, details) {
    return query(
      'INSERT INTO lead_history (lead_id, event_type, node_id, details) VALUES ($1, $2, $3, $4)',
      [leadId, eventType, nodeId, JSON.stringify(details || {})]
    );
  }
}

// Singleton instance
module.exports = new Repository();