const db = require('../db/queries');
const contextResolver = require('./context-resolver');

// Executor registry — maps node_type_code → executor module
const EXECUTORS = {
  send_message: require('./node-executors/send-message'),
  collect_input: require('./node-executors/collect-input'),
  show_list: require('./node-executors/show-list'),
  send_document: require('./node-executors/send-document'),
  book_appointment: require('./node-executors/book-appointment'),
  request_callback: require('./node-executors/request-callback'),
  assign_agent: require('./node-executors/assign-agent'),
  calculate_score: require('./node-executors/calculate-score'),
  property_welcome: require('./node-executors/property-welcome'),
  end_conversation: require('./node-executors/end-conversation'),
};

function getExecutor(nodeType) {
  const executor = EXECUTORS[nodeType];
  if (!executor) throw new Error(`No executor registered for node type: ${nodeType}`);
  return executor;
}

// Determine if a node expects user input after execution
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

// Extract and save special ID patterns (PROPERTY_123, VISIT_1) to context
async function extractAndSaveContext(lead, userInput) {
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

// ─── Out‑of‑order handler (global slot‑filling) ──────────────────
async function handleOutOfOrderInput(lead, userInput, activeFlow) {
  if (!activeFlow) return false;
  const nodes = await db.getFlowNodes(activeFlow.flow_id);
  if (!nodes || nodes.length === 0) return false;
  const input = String(userInput).trim().toLowerCase();
  if (!input) return false;

  for (const node of nodes) {
    if (node.node_type !== 'collect_input') continue;
    if (!node.config || !node.config.options) continue;

    const options = node.config.options;
    const matchedOption = options.find(opt => {
      const val = String(opt.value || opt).trim().toLowerCase();
      const label = String(opt.label || opt.value || opt).trim().toLowerCase();
      return val === input || label === input;
    });
    if (!matchedOption) continue;

    console.log(`🔄 Out‑of‑order: "${userInput}" matches node ${node.node_code} (${node.node_name})`);

    // Save/overwrite answer for that node's field
    if (node.config.field) {
      const valueToSave = String(matchedOption.value || matchedOption.label || matchedOption).trim();
      await db.saveLeadAnswer(lead.lead_id, node.config.field, valueToSave, node.node_id);
    }

    // Find edge (exact match first, then default)
    let edge = await findMatchingEdge(node.node_id, matchedOption.value || matchedOption.label, true);
    if (!edge) edge = await findMatchingEdge(node.node_id, null, true);
    if (!edge) {
      console.log('⚠️ No edge found for out‑of‑order node');
      return true;
    }

    // Move lead and execute next node
    await db.updateLeadNode(lead.lead_id, edge.to_node_id);
    const updatedLead = await db.getLeadById(lead.lead_id);
    const nextNode = await db.getNodeById(edge.to_node_id);
    await executeAndChain(updatedLead, nextNode);
    return true;
  }
  return false;
}

// ─── Case‑insensitive edge finder ──────────────────────────────
async function findMatchingEdge(nodeId, userInput, includeDefault = false) {
  const allEdges = await db.getEdgesFromNode(nodeId);
  if (!allEdges) return null;

  const normalizedInput = userInput ? String(userInput).trim().toLowerCase() : null;

  // Try exact (case‑insensitive) match first
  for (const edge of allEdges) {
    if (edge.user_input_value === null) continue;
    if (String(edge.user_input_value).trim().toLowerCase() === normalizedInput) return edge;
  }

  // If includeDefault and we haven't matched, return the default (null) edge
  if (includeDefault && userInput !== null) {
    for (const edge of allEdges) {
      if (edge.user_input_value === null) return edge;
    }
  }

  return null;
}

// ─── Execute a node and auto‑chain through default edges (max depth 5) ──
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

  const waits = nodeWaitsForInput(node.node_type, resolvedConfig, result);

  if (waits) {
    console.log(`⏸️ Node ${node.node_code} waiting for user input`);
    return;
  }

  // Find default edge (user_input_value IS NULL)
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

// ─── Main message processor ─────────────────────────────────────
async function processMessage(lead, userInput) {
  const currentNode = await db.getNodeById(lead.current_node_id);
  if (!currentNode) {
    console.error('❌ Lead has invalid current_node_id:', lead.current_node_id);
    return;
  }

  console.log(`📩 Input "${userInput}" at node ${currentNode.node_code}`);

  const executor = getExecutor(currentNode.node_type);
  const resolvedConfig = await contextResolver.resolveConfig(currentNode.config, lead.lead_id);

  // Save special IDs into context
  await extractAndSaveContext(lead, userInput);

  let edge = null;

  // 1. If the executor has saveReply, validate the input for the current node
  if (typeof executor.saveReply === 'function') {
    const saveResult = await executor.saveReply(lead, resolvedConfig, userInput);

    if (saveResult.valid) {
      // Valid reply – find the matching edge (case‑insensitive)
      edge = await findMatchingEdge(currentNode.node_id, userInput);
      if (!edge && (userInput.startsWith('PROPERTY_') || userInput.startsWith('VISIT_'))) {
        edge = await findMatchingEdge(currentNode.node_id, null, true);
      }
      if (!edge) {
        console.log('❌ No edge after valid reply');
        return;
      }

      await db.updateLeadNode(lead.lead_id, edge.to_node_id);
      const updatedLead = await db.getLeadById(lead.lead_id);
      const nextNode = await db.getNodeById(edge.to_node_id);
      await executeAndChain(updatedLead, nextNode);
      return;
    } else {
      // Invalid reply for current node – fall through to out‑of‑order
      console.log('❌ Current node rejected:', saveResult.error);
    }
  }

  // 2. For nodes without saveReply (send_message with buttons, property_welcome, etc.)
  edge = await findMatchingEdge(currentNode.node_id, userInput);
  if (!edge && (userInput.startsWith('PROPERTY_') || userInput.startsWith('VISIT_'))) {
    edge = await findMatchingEdge(currentNode.node_id, null, true);
  }

  if (edge) {
    await db.updateLeadNode(lead.lead_id, edge.to_node_id);
    const updatedLead = await db.getLeadById(lead.lead_id);
    const nextNode = await db.getNodeById(edge.to_node_id);
    await executeAndChain(updatedLead, nextNode);
    return;
  }

  // 3. Fallback to out‑of‑order (global slot‑filling)
  const activeFlow = await db.getActiveFlowForClient(lead.client_id);
  const handled = await handleOutOfOrderInput(lead, userInput, activeFlow);
  if (!handled) {
    console.log('❌ No matching edge or out‑of‑order for:', userInput);
  }
}

module.exports = {
  executeAndChain,
  processMessage,
};