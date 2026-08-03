const db = require('../db/queries');
const contextResolver = require('./context-resolver');

const EXECUTORS = {
  send_message:      require('./node-executors/send-message'),
  collect_input:     require('./node-executors/collect-input'),
  show_list:         require('./node-executors/show-list'),
  send_document:     require('./node-executors/send-document'),
  book_appointment:  require('./node-executors/book-appointment'),
  request_callback:  require('./node-executors/request-callback'),
  assign_agent:      require('./node-executors/assign-agent'),
  calculate_score:   require('./node-executors/calculate-score'),
  property_welcome:  require('./node-executors/property-welcome'),
  end_conversation:  require('./node-executors/end-conversation'),
};

function getExecutor(nodeType) {
  const executor = EXECUTORS[nodeType];
  if (!executor) throw new Error(`No executor registered for node type: ${nodeType}`);
  return executor;
}

function nodeWaitsForInput(nodeType, config, result) {
  if (result && typeof result.wait_for_input === 'boolean') return result.wait_for_input;
  switch (nodeType) {
    case 'collect_input':
    case 'show_list':
    case 'book_appointment':
      return true;
    case 'send_message':
      return !!(config.buttons && config.buttons.length > 0);
    case 'send_document':
    case 'request_callback':
    case 'assign_agent':
    case 'calculate_score':
    case 'end_conversation':
      return false;
    default:
      return true;
  }
}

async function extractAndSaveContext(lead, userInput) {
  if (!userInput || typeof userInput !== 'string') return;
  
  if (userInput.startsWith('PROPERTY_')) {
    const propertyId = parseInt(userInput.replace('PROPERTY_', ''), 10);
    if (!isNaN(propertyId)) {
      const property = await db.getPropertyById(propertyId);
      if (property) {
        await db.saveLeadAnswer(lead.lead_id, 'selected_property_id', String(propertyId), lead.current_node_id);
        const ctx = lead.context_data || {};
        ctx.selected_property_id = propertyId;
        ctx.selected_property_name = property.property_name;
        await db.updateLeadContext(lead.lead_id, ctx);
      }
    }
  } else if (userInput.startsWith('VISIT_')) {
    const visitOptionId = parseInt(userInput.replace('VISIT_', ''), 10);
    if (!isNaN(visitOptionId)) {
      const ctx = lead.context_data || {};
      ctx.selected_visit_option_id = visitOptionId;
      await db.updateLeadContext(lead.lead_id, ctx);
    }
  }
}

async function findMatchingEdge(nodeId, userInput, includeDefault = false) {
  const allEdges = await db.getEdgesFromNode(nodeId);
  if (!allEdges || allEdges.length === 0) return null;

  const normalizedInput = userInput ? String(userInput).trim().toLowerCase() : null;

  for (const edge of allEdges) {
    if (edge.user_input_value === null) continue;
    if (String(edge.user_input_value).trim().toLowerCase() === normalizedInput) return edge;
  }

  if (includeDefault) {
    for (const edge of allEdges) {
      if (edge.user_input_value === null) return edge;
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════
// FIX: Recover stale welcome buttons (BROCHURE/VISIT/CALL)
// When user taps a button from an old message while at a different node
// ═══════════════════════════════════════════════════════
async function recoverStaleIntent(lead, userInput) {
  const intents = {
    BROCHURE: 'send_document',
    VISIT:    'book_appointment',
    CALL:     'request_callback',
    BUY:      'send_document',
    RENT:     'request_callback'
  };
  const targetType = intents[String(userInput).toUpperCase()];
  if (!targetType) return null;

  const nodes = await db.getFlowNodes(lead.current_flow_id);
  const target = nodes.find(n => n.node_type === targetType);
  if (!target) return null;

  console.log(`🔄 Stale intent recovery: "${userInput}" → ${target.node_code}`);
  return { to_node_id: target.node_id };
}

async function executeAndChain(lead, node, depth = 0) {
  if (depth > 5) {
    console.warn('⚠️ Max chain depth reached, stopping to prevent infinite loop');
    return;
  }
  if (!node) {
    console.error('❌ Cannot execute null node');
    return;
  }

  const executor = getExecutor(node.node_type);
  const resolvedConfig = await contextResolver.resolveConfig(node.config, lead.lead_id);

  console.log(`▶️ Executing node: ${node.node_code} (${node.node_type})`);

  const result = await executor.execute(lead, resolvedConfig);

  if (result && result.use_fallback && resolvedConfig.fallback_node_id) {
    console.log(`⏭️ Fallback: ${node.node_code} → fallback node ${resolvedConfig.fallback_node_id}`);
    await db.updateLeadNode(lead.lead_id, resolvedConfig.fallback_node_id);
    const updatedLead = await db.getLeadById(lead.lead_id);
    const fallbackNode = await db.getNodeById(resolvedConfig.fallback_node_id);
    await executeAndChain(updatedLead, fallbackNode, depth + 1);
    return;
  }

  const waits = nodeWaitsForInput(node.node_type, resolvedConfig, result);

  if (waits) {
    console.log(`⏸️ Node ${node.node_code} waiting for user input`);
    return;
  }

  const defaultEdge = await findMatchingEdge(node.node_id, null, true);

  if (!defaultEdge) {
    console.log(`🔚 No default edge from ${node.node_code}, flow paused`);
    return;
  }

  console.log(`⏭️ Auto-advancing: ${node.node_code} → ${defaultEdge.next_code || defaultEdge.to_node_id}`);

  await db.updateLeadNode(lead.lead_id, defaultEdge.to_node_id);
  const updatedLead = await db.getLeadById(lead.lead_id);

  const nextNode = await db.getNodeById(defaultEdge.to_node_id);
  await executeAndChain(updatedLead, nextNode, depth + 1);
}

async function processMessage(lead, userInput) {
  const currentNode = await db.getNodeById(lead.current_node_id);
  if (!currentNode) {
    console.error('❌ Lead has invalid current_node_id:', lead.current_node_id);
    return;
  }

  console.log(`📩 Input "${userInput}" at node ${currentNode.node_code} (type: ${currentNode.node_type})`);

  const executor = getExecutor(currentNode.node_type);
  const resolvedConfig = await contextResolver.resolveConfig(currentNode.config, lead.lead_id);

  await extractAndSaveContext(lead, userInput);

  let edge = null;

  if (typeof executor.saveReply === 'function') {
    const saveResult = await executor.saveReply(lead, resolvedConfig, userInput);

    if (saveResult.valid) {
      const canonicalValue = saveResult.value || userInput;
      console.log(`✅ Valid reply. Canonical value: "${canonicalValue}", raw: "${userInput}"`);

      edge = await findMatchingEdge(currentNode.node_id, canonicalValue);
      if (!edge) {
        console.log(`⚠️ No edge for canonical "${canonicalValue}", trying raw "${userInput}"`);
        edge = await findMatchingEdge(currentNode.node_id, userInput);
      }
      if (!edge && (String(userInput).startsWith('PROPERTY_') || String(userInput).startsWith('VISIT_'))) {
        edge = await findMatchingEdge(currentNode.node_id, null, true);
      }
      if (!edge) {
        console.log(`⚠️ No conditional edge matched, trying default edge`);
        edge = await findMatchingEdge(currentNode.node_id, null, true);
      }
      if (!edge) {
        const edges = await db.getEdgesFromNode(currentNode.node_id);
        console.log('❌ No edge after valid reply. Available edges:', edges.map(e => ({ to: e.to_code, input: e.user_input_value })));
        return;
      }

      await db.updateLeadNode(lead.lead_id, edge.to_node_id);
      const updatedLead = await db.getLeadById(lead.lead_id);
      const nextNode = await db.getNodeById(edge.to_node_id);
      await executeAndChain(updatedLead, nextNode);
      return;
    } else {
      console.log('❌ Current node rejected:', saveResult.error);
    }
  }

  edge = await findMatchingEdge(currentNode.node_id, userInput);
  if (!edge && (String(userInput).startsWith('PROPERTY_') || String(userInput).startsWith('VISIT_'))) {
    edge = await findMatchingEdge(currentNode.node_id, null, true);
  }

  // ═══════════════════════════════════════════════════════
  // FIX: Stale button recovery before giving up
  // ═══════════════════════════════════════════════════════
  if (!edge) {
    edge = await recoverStaleIntent(lead, userInput);
  }

  if (edge) {
    await db.updateLeadNode(lead.lead_id, edge.to_node_id);
    const updatedLead = await db.getLeadById(lead.lead_id);
    const nextNode = await db.getNodeById(edge.to_node_id);
    await executeAndChain(updatedLead, nextNode);
    return;
  }

  console.log('❌ No matching edge for:', userInput);
}

module.exports = {
  executeAndChain,
  processMessage,
};