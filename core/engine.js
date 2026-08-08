// core/engine.js
// Orchestrator. Iterative execution via while-loop. No recursion. No depth cap.
// [PASS1] Outcome-based routing replaces hardcoded edge matching.

const repo = require('../db/repository');
const { resolveConfig } = require('./context');
const { getHandler, nodeWaitsForInput, getOutcomes } = require('./registry');
const leadService = require('../services/lead-service');

// ── Stale button recovery map ──
const STALE_INTENTS = {
  BROCHURE: 'send_document',
  VISIT:    'book_appointment',
  CALL:     'request_callback',
  BUY:      'send_document',
  RENT:     'request_callback',
};

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE PARSING
// ═══════════════════════════════════════════════════════════════════════════════

function extractMessageData(body) {
  if (!body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) return null;

  const value = body.entry[0].changes[0].value;
  const msg = value.messages[0];
  const contact = value.contacts?.[0] || {};

  let userInput = '';
  if (msg.interactive?.button_reply?.id) {
    userInput = msg.interactive.button_reply.id;
  } else if (msg.interactive?.list_reply?.id) {
    userInput = msg.interactive.list_reply.id;
  } else if (msg.text?.body) {
    userInput = msg.text.body.trim();
  }

  return {
    wa_id: contact.wa_id || msg.from,
    profile_name: contact.profile?.name || '',
    message_text: msg.text?.body || '',
    user_input: userInput,
    referral_ref: msg.referral?.ref || '',
    phone_number_id: value.metadata?.phone_number_id || null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTEXT EXTRACTION (PROPERTY_ / VISIT_ prefixes)
// ═══════════════════════════════════════════════════════════════════════════════

async function extractContextFromInput(lead, userInput) {
  if (!userInput || typeof userInput !== 'string') return;

  if (userInput.startsWith('PROPERTY_')) {
    const propertyId = parseInt(userInput.replace('PROPERTY_', ''), 10);
    if (!isNaN(propertyId)) {
      const property = await repo.getPropertyById(propertyId);
      if (property) {
        await repo.saveLeadAnswer(lead.lead_id, 'selected_property_id', String(propertyId), lead.current_node_id);
        const ctx = lead.context_data || {};
        ctx.selected_property_id = propertyId;
        ctx.selected_property_name = property.property_name;
        await repo.updateLeadContext(lead.lead_id, ctx);
      }
    }
  } else if (userInput.startsWith('VISIT_')) {
    const visitOptionId = parseInt(userInput.replace('VISIT_', ''), 10);
    if (!isNaN(visitOptionId)) {
      const ctx = lead.context_data || {};
      ctx.selected_visit_option_id = visitOptionId;
      await repo.updateLeadContext(lead.lead_id, ctx);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STALE INTENT RECOVERY
// ═══════════════════════════════════════════════════════════════════════════════

async function recoverStaleIntent(lead, userInput) {
  const targetType = STALE_INTENTS[String(userInput).toUpperCase()];
  if (!targetType) return null;

  const nodes = await repo.getFlowNodes(lead.current_flow_id);
  const target = nodes.find(n => n.node_type === targetType);
  if (!target) return null;

  console.log(`🔄 Stale intent recovery: "${userInput}" → ${target.node_code}`);
  return { to_node_id: target.node_id };
}

async function recoverPropertySelection(lead, userInput) {
  if (!String(userInput).startsWith('PROPERTY_')) return null;

  const nodes = await repo.getFlowNodes(lead.current_flow_id);
  const target = nodes.find(n => n.node_type === 'property_welcome');
  if (!target) return null;

  console.log(`🔄 Property selection recovery: "${userInput}" → ${target.node_code}`);
  return { to_node_id: target.node_id };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE MATCHING [PASS1] — outcome first, then input, then default
// ═══════════════════════════════════════════════════════════════════════════════

async function findNextEdge(nodeId, result, userInput) {
  const edges = await repo.getEdgesFromNode(nodeId);
  if (!edges.length) return null;

  // Priority 1: outcome-based routing (natural situations)
  if (result?.outcome) {
    const byOutcome = edges.find(e => e.outcome_name === result.outcome);
    if (byOutcome) return byOutcome;
  }

  // Priority 2: user input matching (existing behavior)
  if (userInput) {
    const normalizedInput = String(userInput).trim().toLowerCase();
    const byInput = edges.find(e => {
      if (!e.user_input_value) return false;
      return String(e.user_input_value).trim().toLowerCase() === normalizedInput;
    });
    if (byInput) return byInput;
  }

  // Priority 3: default edge (no user_input_value, no outcome_name)
  const defaultEdge = edges.find(e => !e.user_input_value && !e.outcome_name);
  return defaultEdge || null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ITERATIVE FLOW RUNNER
// ═══════════════════════════════════════════════════════════════════════════════

async function runFlow(lead, startNode) {
  const queue = [startNode];
  const visited = new Set();

  while (queue.length > 0) {
    const node = queue.shift();

    if (visited.has(node.node_id)) {
      console.warn(`⚠️ Cycle detected at node ${node.node_code}, stopping`);
      break;
    }
    visited.add(node.node_id);

    const handler = getHandler(node.node_type);
    const resolvedConfig = await resolveConfig(node.config, lead.lead_id);

    console.log(`▶️ Executing node: ${node.node_code} (${node.node_type})`);
    const result = await handler.execute(lead, resolvedConfig);

    // [PASS1] Outcome routing
    const nextEdge = await findNextEdge(node.node_id, result, null);

    if (!nextEdge) {
      const waits = nodeWaitsForInput(node.node_type, result);
      if (waits) {
        console.log(`⏸️ Node ${node.node_code} waiting for user input`);
        await repo.updateLeadNode(lead.lead_id, node.node_id);
        break;
      }
      console.log(`🔚 No outgoing edge from ${node.node_code}, flow paused`);
      break;
    }

    console.log(`⏭️ ${node.node_code} → ${nextEdge.to_code || nextEdge.to_node_id} (outcome: ${result?.outcome || 'default'})`);

    await repo.updateLeadNode(lead.lead_id, nextEdge.to_node_id);
    lead = await repo.getLeadById(lead.lead_id);

    const nextNode = await repo.getNodeById(nextEdge.to_node_id);
    if (nextNode) queue.push(nextNode);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER INPUT PROCESSOR
// ═══════════════════════════════════════════════════════════════════════════════

async function processUserInput(lead, userInput) {
  const currentNode = await repo.getNodeById(lead.current_node_id);
  if (!currentNode) {
    console.error('❌ Lead has invalid current_node_id:', lead.current_node_id);
    return;
  }

  console.log(`📩 Input "${userInput}" at node ${currentNode.node_code} (type: ${currentNode.node_type})`);

  const handler = getHandler(currentNode.node_type);
  const resolvedConfig = await resolveConfig(currentNode.config, lead.lead_id);

  await extractContextFromInput(lead, userInput);

  // If handler has saveReply, validate first
  if (typeof handler.saveReply === 'function') {
    const saveResult = await handler.saveReply(lead, resolvedConfig, userInput);

    if (saveResult.valid) {
      const canonicalValue = saveResult.value || userInput;
      console.log(`✅ Valid reply. Canonical: "${canonicalValue}"`);

      // [PASS1] Check outcome-based edge first
      let edge = await findNextEdge(currentNode.node_id, saveResult, canonicalValue);

      // Fallback to input matching
      if (!edge) edge = await findNextEdge(currentNode.node_id, null, canonicalValue);
      if (!edge && (String(userInput).startsWith('PROPERTY_') || String(userInput).startsWith('VISIT_'))) {
        edge = await findNextEdge(currentNode.node_id, null, null);
      }

      if (!edge) {
        console.log('❌ No edge after valid reply');
        return;
      }

      await repo.updateLeadNode(lead.lead_id, edge.to_node_id);
      lead = await repo.getLeadById(lead.lead_id);
      const nextNode = await repo.getNodeById(edge.to_node_id);
      await runFlow(lead, nextNode);
      return;
    } else {
      console.log('❌ Current node rejected:', saveResult.error);
      return;
    }
  }

  // Direct input matching (for nodes without saveReply)
  let edge = await findNextEdge(currentNode.node_id, null, userInput);

  // Stale intent recovery before giving up
  if (!edge) {
    edge = await recoverStaleIntent(lead, userInput);
    if (!edge) edge = await recoverPropertySelection(lead, userInput);
  }

  if (edge) {
    await repo.updateLeadNode(lead.lead_id, edge.to_node_id);
    lead = await repo.getLeadById(lead.lead_id);
    const nextNode = await repo.getNodeById(edge.to_node_id);
    await runFlow(lead, nextNode);
    return;
  }

  console.log('❌ No matching edge for:', userInput);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

async function handleIncomingMessage(body) {
  const data = extractMessageData(body);
  if (!data) {
    console.log('⚠️ No message data in webhook');
    return;
  }

  const { wa_id, profile_name, user_input, referral_ref, phone_number_id } = data;
  console.log('📩 Incoming:', wa_id, '| Input:', user_input || '(text)');

  try {
    let clientId = parseInt(process.env.DEFAULT_CLIENT_ID, 10) || 1;

    if (phone_number_id) {
      const client = await repo.getClientByPhoneNumberId(phone_number_id);
      if (client) clientId = client.client_id;
    }

    let lead = await leadService.findOrCreateLead({
      whatsappNumber: wa_id,
      name: profile_name || null,
      clientId,
    });

    if (referral_ref && !lead.context_data?.selected_property_id) {
      const property = await repo.getPropertyByReferralCode(referral_ref);
      if (property && property.client_id === clientId) {
        await leadService.saveToContext(lead.lead_id, 'selected_property_id', property.property_id);
        await leadService.saveToContext(lead.lead_id, 'selected_property_name', property.property_name);
      }
    }

    lead = await repo.getLeadById(lead.lead_id);

    const flow = await repo.getActiveFlowForClient(clientId);
    if (!flow) {
      console.error('❌ No active flow for client', clientId);
      return;
    }

    const needsReset = !lead.current_flow_id || lead.current_flow_id !== flow.flow_id;
    if (!needsReset && lead.current_node_id) {
      const nodeCheck = await repo.getNodeById(lead.current_node_id);
      if (!nodeCheck || nodeCheck.flow_id !== flow.flow_id) {
        console.log(`🔄 Lead ${lead.lead_id} node ${lead.current_node_id} not in active flow ${flow.flow_id}, resetting`);
        await repo.updateLeadNode(lead.lead_id, flow.start_node_id);
        lead = await repo.getLeadById(lead.lead_id);
      }
    }
    if (needsReset) {
      console.log(`🔄 Lead ${lead.lead_id} flow mismatch (${lead.current_flow_id} vs ${flow.flow_id}), resetting to start`);
      await repo.updateLeadFlow(lead.lead_id, flow.flow_id, flow.start_node_id);
      await repo.deleteLeadAnswers(lead.lead_id);
      lead = await repo.getLeadById(lead.lead_id);
    }

    const answers = await repo.getLeadAnswers(lead.lead_id);
    const flowStarted = lead.context_data?.flow_started;

    if (answers.length === 0 && lead.current_node_id === flow.start_node_id && !flowStarted) {
      const startNode = await repo.getNodeById(lead.current_node_id);
      if (startNode) {
        console.log('🚀 First message – auto-starting flow');
        await runFlow(lead, startNode);
        await leadService.saveToContext(lead.lead_id, 'flow_started', true);
        return;
      }
    }

    if (user_input) {
      await processUserInput(lead, user_input);
    }

  } catch (error) {
    console.error('❌ Engine error:', error.message);
    console.error(error.stack);
  }
}

module.exports = { handleIncomingMessage };