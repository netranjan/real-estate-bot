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
  if (!executor) {
    throw new Error(`No executor registered for node type: ${nodeType}`);
  }
  return executor;
}

// Determine if a node expects user input after execution
function nodeWaitsForInput(nodeType, config, result) {
  if (result && typeof result.wait_for_input === 'boolean') {
    return result.wait_for_input;
  }

  switch (nodeType) {
    case 'collect_input':
      return true;
    case 'show_list':
      return true;
    case 'book_appointment':
      return true;
    case 'send_message':
      return !!(config.buttons && config.buttons.length > 0);
    case 'send_document':
    case 'request_callback':
    case 'assign_agent':
    case 'calculate_score':
      return false;
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

// Execute a node and auto-chain through default edges (max depth 5)
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
  const defaultEdge = await db.getEdgeByInput(node.node_id, null);

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

// Handle incoming user message / button click
async function processMessage(lead, userInput) {
  const currentNode = await db.getNodeById(lead.current_node_id);

  if (!currentNode) {
    console.error('❌ Lead has invalid current_node_id:', lead.current_node_id);
    return;
  }

  console.log(`📩 Processing input "${userInput}" at node ${currentNode.node_code}`);

  const executor = getExecutor(currentNode.node_type);
  const resolvedConfig = await contextResolver.resolveConfig(currentNode.config, lead.lead_id);

  // Step 1: Extract special IDs (PROPERTY_*, VISIT_*) into context
  await extractAndSaveContext(lead, userInput);

  // Step 2: If executor has saveReply, validate and save the answer
  if (typeof executor.saveReply === 'function') {
    const saveResult = await executor.saveReply(lead, resolvedConfig, userInput);

    if (!saveResult.valid) {
      console.log('❌ Input validation failed:', saveResult.error);
      if (saveResult.error) {
        const client = await db.getClientById(lead.client_id);
        const send = require('../whatsapp/send');
        const { textMessage } = require('../whatsapp/payloads');
        await send({
          phoneNumberId: client.meta_phone_number_id,
          accessToken: client.meta_access_token,
          payload: textMessage(lead.whatsapp_number, saveResult.error),
        });
      }
      return;
    }
  }

  // Step 3: Find matching edge (exact match first, then default)
  const edge = await db.getEdgeByInput(currentNode.node_id, userInput);

  if (!edge) {
    console.log('❌ No matching edge for input:', userInput, 'from node:', currentNode.node_code);
    return;
  }

  console.log(`↪️ Transition: ${currentNode.node_code} → ${edge.next_code || edge.to_node_id}`);

  // Step 4: Transition lead
  await db.updateLeadNode(lead.lead_id, edge.to_node_id);
  const updatedLead = await db.getLeadById(lead.lead_id);

  // Step 5: Execute next node (with auto-chaining)
  const nextNode = await db.getNodeById(edge.to_node_id);
  await executeAndChain(updatedLead, nextNode);
}

module.exports = {
  executeAndChain,
  processMessage,
};