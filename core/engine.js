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
  VISIT: 'book_appointment',
  CALL: 'request_callback',
  BUY: 'send_document',
  RENT: 'request_callback',
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

function parseCtx(lead) {
  let ctx = lead.context_data || {};
  if (typeof ctx === 'string') {
    try { ctx = JSON.parse(ctx); } catch (e) { ctx = {}; }
  }
  return ctx;
}

async function extractContextFromInput(lead, userInput) {
  if (!userInput || typeof userInput !== 'string') return;

  if (userInput.startsWith('PROPERTY_')) {
    const propertyId = parseInt(userInput.replace('PROPERTY_', ''), 10);
    if (!isNaN(propertyId)) {
      await flowService.selectPropertyForLead(lead.lead_id, propertyId, lead.current_node_id);
    }
  } else if (userInput.startsWith('VISIT_')) {
    const visitOptionId = parseInt(userInput.replace('VISIT_', ''), 10);
    if (!isNaN(visitOptionId)) {
      const ctx = parseCtx(lead);
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

  // Priority 1: specific user input (per-button routing)
  if (userInput) {
    const normalizedInput = String(userInput).trim().toLowerCase();
    const byInput = edges.find(e => {
      if (!e.user_input_value) return false;
      return String(e.user_input_value).trim().toLowerCase() === normalizedInput;
    });
    if (byInput) return byInput;
  }

  // Priority 2: outcome-based routing (generic situations)
  if (result?.outcome) {
    const byOutcome = edges.find(e => e.outcome_name === result.outcome);
    if (byOutcome) return byOutcome;
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

    const nextEdge = await findNextEdge(node.node_id, result, null);

    if (!nextEdge) {
      const waits = nodeWaitsForInput(node.node_type, result);
      console.log(`🔍 Node ${node.node_code} waitsForInput=${waits}`);
      if (waits) {
        console.log(`⏸️ Node ${node.node_code} waiting for user input`);
        await repo.updateLeadNode(lead.lead_id, node.node_id);

        // Bookmark this interactive node for stale button recovery
        let ctx = lead.context_data || {};
        if (typeof ctx === 'string') {
          try { ctx = JSON.parse(ctx); } catch (e) { ctx = {}; }
        }
        ctx.last_interactive_node_id = node.node_id;
        await repo.updateLeadContext(lead.lead_id, ctx);
        console.log(`🔖 Bookmarked interactive node ${node.node_code} (${node.node_id})`);

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
  console.log('🔧 DEBUG node:', currentNode?.node_code, 'type:', currentNode?.node_type);
  console.log('🔧 DEBUG input:', userInput);
  console.log('🔧 DEBUG context:', JSON.stringify(lead.context_data));
  const handler = getHandler(currentNode.node_type);
  console.log('🔧 DEBUG saveReply?', typeof handler.saveReply, handler.saveReply?.name || 'none');
  if (!currentNode) {
    console.error('❌ Lead has invalid current_node_id:', lead.current_node_id);
    return;
  }

  console.log(`📩 Input "${userInput}" at node ${currentNode.node_code} (type: ${currentNode.node_type})`);
  console.log(`🔍 Lead context_data:`, JSON.stringify(lead.context_data));

  const resolvedConfig = await resolveConfig(currentNode.config, lead.lead_id);

  await extractContextFromInput(lead, userInput);

  // If handler has saveReply, validate first
  if (typeof handler.saveReply === 'function') {
    const saveResult = await handler.saveReply(lead, resolvedConfig, userInput);

    if (saveResult.valid) {
      const canonicalValue = saveResult.value || userInput;
      console.log(`✅ Valid reply. Canonical: "${canonicalValue}"`);

      let edge = await findNextEdge(currentNode.node_id, saveResult, canonicalValue);

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
  console.log(`🔍 Direct match edge: ${edge ? edge.edge_id : 'null'}`);

  // >>> STALE BUTTON RECOVERY
  const waits = nodeWaitsForInput(currentNode.node_type, null);
  console.log(`🔍 Stale recovery check: edge=${edge ? 'found' : 'null'}, waits=${waits}, lastId=${lead.context_data?.last_interactive_node_id}`);

  if (!edge && !waits) {
    const lastId = lead.context_data?.last_interactive_node_id;
    if (lastId && lastId !== currentNode.node_id) {
      const lastNode = await repo.getNodeById(lastId);
      console.log(`🔍 lastNode: ${lastNode ? lastNode.node_code : 'null'}, flow_match=${lastNode ? lastNode.flow_id === lead.current_flow_id : 'n/a'}`);
      if (lastNode && lastNode.flow_id === lead.current_flow_id) {
        const lastHandler = getHandler(lastNode.node_type);
        const lastConfig = await resolveConfig(lastNode.config, lead.lead_id);

        // Call saveReply FIRST to get the outcome, then find the edge
        let saveResult = null;
        if (typeof lastHandler.saveReply === 'function') {
          saveResult = await lastHandler.saveReply(lead, lastConfig, userInput);
          console.log(`🔍 saveReply result: valid=${saveResult.valid}, outcome=${saveResult.outcome}`);
        }

        const testEdge = await findNextEdge(lastNode.node_id, saveResult, userInput);
        console.log(`🔍 testEdge from ${lastNode.node_code}: ${testEdge ? testEdge.edge_id : 'null'}`);

        if (testEdge) {
          console.log(`🔄 Stale button recovery: "${userInput}" from ${currentNode.node_code} → rewinding to ${lastNode.node_code}`);
          await repo.updateLeadNode(lead.lead_id, lastNode.node_id);
          lead = await repo.getLeadById(lead.lead_id);
          edge = testEdge;
        }
      }
    }
  }
  // <<< END STALE BUTTON RECOVERY

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