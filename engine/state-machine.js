const db = require('../db/queries');
const contextResolver = require('./context-resolver');

// Executor registry
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

// Extract and save special IDs (PROPERTY_*, VISIT_*) to context
async function extractAndSaveContext(lead, userInput) {
  if (userInput.startsWith('PROPERTY_')) {
    const propertyId = parseInt(userInput.replace('PROPERTY_', ''), 10);
    if (!isNaN(propertyId)) {
      const property = await db.getPropertyById(propertyId);
      if (property) {
        await db.saveLeadAnswer(lead.lead_id, 'selected_property_id', String(propertyId), lead.current_node_id);
        const context = lead.context_data || {};
        context.selected_property_id = propertyId;
        context.selected_property_name = property.property_name;
        await db.updateLeadContext(lead.lead_id, context);
      }
    }
  } else if (userInput.startsWith('VISIT_')) {
    const visitOptionId = parseInt(userInput.replace('VISIT_', ''), 10);
    if (!isNaN(visitOptionId)) {
      const context = lead.context_data || {};
      context.selected_visit_option_id = visitOptionId;
      await db.updateLeadContext(lead.lead_id, context);
    }
  }
}

// ═══════════════════════════════════════════
// Out‑of‑order fallback (used only when current node fails)
// ═══════════════════════════════════════════

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

    // Save/overwrite answer
    if (node.config.field) {
      const valueToSave = String(matchedOption.value || matchedOption.label || matchedOption).trim();
      await db.saveLeadAnswer(lead.lead_id, node.config.field, valueToSave, node.node_id);
    }

    // Find edge (exact or default)
    let edge = await db.getEdgeByInput(node.node_id, matchedOption.value || matchedOption.label);
    if (!edge) edge = await db.getEdgeByInput(node.node_id, null);
    if (!edge) {
      console.log('⚠️ No edge found for matched node');
      return true;
    }

    await db.updateLeadNode(lead.lead_id, edge.to_node_id);
    const updatedLead = await db.getLeadById(lead.lead_id);
    const nextNode = await db.getNodeById(edge.to_node_id);
    await executeAndChain(updatedLead, nextNode);
    return true;
  }
  return false;
}

// Execute a node and auto‑chain (max depth 5)
async function executeAndChain(lead, node, depth = 0) {
  if (depth > 5) {
    console.warn('⚠️ Max chain depth reached');
    return;
  }
  if (!node) return;

  const executor = getExecutor(node.node_type);
  const resolvedConfig = await contextResolver.resolveConfig(node.config, lead.lead_id);

  console.log(`▶️ Executing node: ${node.node_code} (${node.node_type})`);
  const result = await executor.execute(lead, resolvedConfig);
  const waits = nodeWaitsForInput(node.node_type, resolvedConfig, result);

  if (waits) {
    console.log(`⏸️ Node ${node.node_code} waiting for input`);
    return;
  }

  const defaultEdge = await db.getEdgeByInput(node.node_id, null);
  if (!defaultEdge) {
    console.log(`🔚 No default edge from ${node.node_code}`);
    return;
  }

  await db.updateLeadNode(lead.lead_id, defaultEdge.to_node_id);
  const updatedLead = await db.getLeadById(lead.lead_id);
  const nextNode = await db.getNodeById(defaultEdge.to_node_id);
  await executeAndChain(updatedLead, nextNode, depth + 1);
}

// ═══════════════════════════════════════════
// Main message processing (normal → then fallback)
// ═══════════════════════════════════════════

async function processMessage(lead, userInput) {
  const currentNode = await db.getNodeById(lead.current_node_id);
  if (!currentNode) {
    console.error('❌ Lead has invalid current_node_id');
    return;
  }

  console.log(`📩 Input "${userInput}" at node ${currentNode.node_code}`);

  const executor = getExecutor(currentNode.node_type);
  const resolvedConfig = await contextResolver.resolveConfig(currentNode.config, lead.lead_id);

  // Save any special IDs into context
  await extractAndSaveContext(lead, userInput);

  // 1. Try to process as a valid answer for the CURRENT node
  let processed = false;

  if (typeof executor.saveReply === 'function') {
    const saveResult = await executor.saveReply(lead, resolvedConfig, userInput);
    if (saveResult.valid) {
      // Valid reply → find edge and proceed
      let edge = await db.getEdgeByInput(currentNode.node_id, userInput);
      if (!edge && (userInput.startsWith('PROPERTY_') || userInput.startsWith('VISIT_'))) {
        edge = await db.getEdgeByInput(currentNode.node_id, null);
      }
      if (!edge) {
        console.log('❌ No matching edge after valid reply');
        return;
      }
      await db.updateLeadNode(lead.lead_id, edge.to_node_id);
      const updatedLead = await db.getLeadById(lead.lead_id);
      const nextNode = await db.getNodeById(edge.to_node_id);
      await executeAndChain(updatedLead, nextNode);
      processed = true;
    } else {
      // Invalid reply for current node – maybe out‑of‑order?
      console.log('❌ Invalid reply for current node:', saveResult.error);
    }
  } else {
    // Nodes without saveReply (send_message with buttons, etc.)
    let edge = await db.getEdgeByInput(currentNode.node_id, userInput);
    if (!edge && (userInput.startsWith('PROPERTY_') || userInput.startsWith('VISIT_'))) {
      edge = await db.getEdgeByInput(currentNode.node_id, null);
    }
    if (edge) {
      await db.updateLeadNode(lead.lead_id, edge.to_node_id);
      const updatedLead = await db.getLeadById(lead.lead_id);
      const nextNode = await db.getNodeById(edge.to_node_id);
      await executeAndChain(updatedLead, nextNode);
      processed = true;
    }
  }

  // 2. If not processed yet, try out‑of‑order fallback
  if (!processed) {
    const activeFlow = await db.getActiveFlowForClient(lead.client_id);
    const handled = await handleOutOfOrderInput(lead, userInput, activeFlow);
    if (!handled) {
      console.log('❌ No matching edge or out‑of‑order match for input:', userInput);
      // Optionally send a generic “I didn’t understand” message
    }
  }
}

module.exports = {
  executeAndChain,
  processMessage,
};